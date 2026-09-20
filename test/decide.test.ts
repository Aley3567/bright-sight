import test from "node:test";
import assert from "node:assert/strict";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { judge, type JudgeInput } from "../src/decide.ts";
import { policy } from "../src/policy.ts";
import { REGISTRY } from "../src/scripts.ts";
import { ALLOWED_APPS } from "../src/config.ts";
import type { ActionSpec, Snapshot } from "../src/types.ts";

/**
 * 注入的是 client 而不是 fetch。
 *
 * plan 里写的是注入 fetch，实际写的时候换成了 client：断言的东西一模一样（问题集、
 * state、答案校验），但不用照着 SDK 的 HTTP 编码造假报文——那会让这组测试绑死在
 * SDK 的 wire 格式上，升一次版全碎。两种写法都不打网络，这一点没有让步。
 */
type Call = { state: Record<string, unknown>; questions: Record<string, unknown> };

function fakeClient(answers: Record<string, unknown>, calls: Call[] = []): TypeSafeClient {
  return {
    systemOne(req: Call) {
      calls.push(req);
      return Promise.resolve({ answers });
    },
  } as unknown as TypeSafeClient;
}

function choiceAnswer(choice: string, probabilities?: Record<string, number>) {
  return { choice, confidence: 0.9, probabilities: probabilities ?? { [choice]: 1 } };
}

const TAB = "Google Chrome.make-tab";
const NOTE = "Notes.make-note";
const UTTERANCE = "搜一下 TypeScript 的 erasableSyntaxOnly，把链接存进备忘录";

const SNAP: Snapshot = {
  at: "2026-09-20T00:00:00.000Z",
  front: "Terminal",
  window: "zsh",
  running: ["Terminal", "Google Chrome"],
  elements: [],
  selection: null,
};

function input(over: Partial<JudgeInput> = {}): JudgeInput {
  return {
    utterance: UTTERANCE,
    snapshot: SNAP,
    offers: [
      { id: TAB, summary: "新建标签页" },
      { id: NOTE, summary: "新建笔记" },
      { id: "ASK", summary: "追问" },
      { id: "DONE", summary: "做完了" },
    ],
    spans: ["TypeScript 的 erasableSyntaxOnly", "TypeScript 的 erasableSyntaxOnly，把链接"],
    bodySources: [],
    history: [],
    ...over,
  };
}

test("decide: 请求里的问题集恰好是三个固定 head 加上按需生成的 span", async () => {
  const calls: Call[] = [];
  await judge(fakeClient({ action: choiceAnswer(TAB), span: choiceAnswer("TypeScript 的 erasableSyntaxOnly") }, calls), input());
  assert.deepEqual(Object.keys(calls[0].questions).sort(), ["action", "complete", "destructive", "span"]);
});

test("decide: 只有一个候选片段时不问 span，代码直接填", async () => {
  const calls: Call[] = [];
  const only = "TypeScript 的 erasableSyntaxOnly";
  const d = await judge(fakeClient({ action: choiceAnswer(TAB) }, calls), input({ spans: [only] }));
  assert.ok(!("span" in calls[0].questions), "少一个 head 就少一条失败路径");
  assert.equal(d.span, only);
});

test("decide: 正文来源候选不足两个时不问 body", async () => {
  const calls: Call[] = [];
  await judge(fakeClient({ action: choiceAnswer(NOTE) }, calls), input({ bodySources: [{ key: "span", hint: "原话片段" }] }));
  assert.ok(!("body" in calls[0].questions));
});

test("decide: 递给模型的动作选项不含白名单以外的应用", async () => {
  const calls: Call[] = [];
  await judge(fakeClient({ action: choiceAnswer(TAB), span: choiceAnswer("TypeScript 的 erasableSyntaxOnly") }, calls), input());
  const q = calls[0].questions.action as { criteria: Record<string, unknown> };
  // 不给 criteria 缺失留兜底：结构一变就该红，而不是让 for 循环空转成假通过
  assert.ok(q.criteria && Object.keys(q.criteria).length > 0, "action 的选项集为空");
  for (const id of Object.keys(q.criteria)) {
    if (!id.includes(".")) continue; // 任务层动作没有应用前缀
    const app = id.slice(0, id.lastIndexOf("."));
    assert.ok((ALLOWED_APPS as readonly string[]).includes(app), `${id} 的应用不在白名单内`);
  }
});

test("decide: 递给模型的每个片段都是用户原话的逐字子串", async () => {
  const calls: Call[] = [];
  const inp = input();
  await judge(fakeClient({ action: choiceAnswer(TAB), span: choiceAnswer(inp.spans[0]) }, calls), inp);
  const q = calls[0].questions.span as { criteria: Record<string, unknown> };
  assert.equal(Object.keys(q.criteria).length, inp.spans.length);
  for (const s of Object.keys(q.criteria)) {
    assert.ok(inp.utterance.includes(s), `片段 ${JSON.stringify(s)} 不在原话里`);
  }
});

test("decide: state 里带上了已做完的步骤，模型能看见上下文", async () => {
  const calls: Call[] = [];
  await judge(
    fakeClient({ action: choiceAnswer(NOTE), span: choiceAnswer("TypeScript 的 erasableSyntaxOnly") }, calls),
    input({ history: ["第 1 步：Google Chrome.make-tab — 验证通过"] }),
  );
  assert.match(JSON.stringify(calls[0].state), /make-tab/);
});

test("decide: 模型选了没给过的动作，判断带上违规记录", async () => {
  const d = await judge(fakeClient({ action: choiceAnswer("Finder.delete"), span: choiceAnswer("TypeScript 的 erasableSyntaxOnly") }), input());
  // judge 只记录事实，是否放行由 policy 决定——两层各管一件事
  const g = policy({ judgement: d.judgement, offered: [TAB, NOTE, "ASK", "DONE"] });
  assert.equal(g.kind, "ignore");
  assert.equal(g.actionId, null);
});

test("decide: 模型编造了没给过的片段，整条判断作废", async () => {
  const d = await judge(
    fakeClient({ action: choiceAnswer(TAB), span: choiceAnswer("TypeScript 的装饰器") }),
    input(),
  );
  assert.ok(d.violations.length > 0);
  assert.equal(d.span, null, "没通过校验的片段不许流到执行层");
});

test("decide: 概率和明显不是 1 时记为违规", async () => {
  const d = await judge(
    fakeClient({
      action: choiceAnswer(TAB, { [TAB]: 0.9, [NOTE]: 0.6 }),
      span: choiceAnswer("TypeScript 的 erasableSyntaxOnly"),
    }),
    input(),
  );
  assert.ok(d.violations.some((v) => v.includes("不是一个分布")), `实际违规: ${JSON.stringify(d.violations)}`);
});

test("decide: 模型完全没返回 action 时，破坏性按最保守取值", async () => {
  const d = await judge(fakeClient({}), input());
  assert.equal(d.judgement.destructive, 1, "缺失的安全信号不能默认成安全");
  const spec: ActionSpec = { id: TAB, app: "Google Chrome", summary: "", kind: "script", params: [], risk: "safe" };
  const g = policy({ judgement: d.judgement, offered: [TAB, "none"], spec, template: REGISTRY[TAB] });
  assert.notEqual(g.kind, "execute");
});

test("decide: 违规的判断即使置信度很高，也不会被 policy 放行成执行", async () => {
  const d = await judge(fakeClient({ action: choiceAnswer("Google Chrome.execute"), span: choiceAnswer("TypeScript 的 erasableSyntaxOnly") }), input());
  const g = policy({ judgement: d.judgement, offered: [TAB, NOTE, "ASK", "DONE"] });
  assert.equal(g.kind, "ignore");
});
