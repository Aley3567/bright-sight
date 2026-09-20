import test from "node:test";
import assert from "node:assert/strict";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { judge, JevBackend, type JudgeInput } from "../src/decide.ts";
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

/**
 * 0.1 用：能按脚本依次失败/成功、且尊重传入 signal 的假 client。
 *
 * 真实的 429/503/529 走 SDK 的 APIError 子类，但那几个类带私有字段，构造需要
 * 完整的 Response/Headers——为了不把测试绑死在 SDK 内部结构上，这里只造一个
 * 带 `status` 的裸 Error。decide.ts 的重试判定只看 `err.status`，鸭子类型足够。
 */
type ScriptStep = { status: number } | { answers: Record<string, unknown> } | "hang";
type CallOpts = { signal?: AbortSignal; timeout?: number; retry?: { maxRetries?: number } };
type CallWithOpts = Call & { opts?: CallOpts };

function scriptedClient(script: ScriptStep[], calls: CallWithOpts[] = []): TypeSafeClient {
  let i = 0;
  return {
    systemOne(req: Call, opts?: CallOpts) {
      calls.push({ ...req, opts });
      const step = script[Math.min(i, script.length - 1)];
      i++;
      if (step === "hang") {
        // 模拟挂起：只有 signal 被中止才会有个结果，否则永远 pending
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new Error("挂起被中止")));
        });
      }
      if ("status" in step) {
        const err = Object.assign(new Error(`模拟 ${step.status}`), { status: step.status });
        return Promise.reject(err);
      }
      return Promise.resolve(step);
    },
  } as unknown as TypeSafeClient;
}

const TAB = "Google Chrome.make-tab";
const NOTE = "Notes.make-note";
const UTTERANCE = "搜一下 TypeScript 的 erasableSyntaxOnly，把链接存进备忘录";
/** 单独一个候选片段时 askSpan 为 false，judge 直接代填——0.1/0.2 的测试不关心
 * span 这一问，用它把 input 收窄成只有 action 一个 head，减少无关变量。 */
const SPAN1 = "TypeScript 的 erasableSyntaxOnly";

const SNAP: Snapshot = {
  at: "2026-09-20T00:00:00.000Z",
  front: "Terminal",
  window: "zsh",
  windowView: { kind: "window", title: "zsh" },
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

/* ────────────────────────────────────────────────────────────────────────── *
 * 0.1：超时与重试
 * ────────────────────────────────────────────────────────────────────────── */

test("decide: 模拟挂起时在超时预算内抛错，而不是永远等待", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: CallWithOpts[] = [];
  const client = scriptedClient(["hang"], calls);
  const p = judge(client, input({ spans: [SPAN1] }));
  await Promise.resolve();
  t.mock.timers.tick(25_000); // 推进到超时预算耗尽——不必真等 25 秒
  await assert.rejects(p);
  assert.equal(calls.length, 1, "挂起不带状态码，不属于可重试错误，不该被当成 429/503/529 处理");
});

test("decide: 429 连续失败超过重试上限后仍然抛出", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: CallWithOpts[] = [];
  const client = scriptedClient(
    [{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }],
    calls,
  );
  const p = judge(client, input({ spans: [SPAN1] }));
  const rejected = assert.rejects(p, /429/);
  for (let i = 0; i < 5 && calls.length < 4; i++) {
    await Promise.resolve();
    t.mock.timers.tick(5000); // 退避延迟上限是 5 s，推进足够让每一轮重试都触发
  }
  await rejected;
  assert.equal(calls.length, 4, "最多重试 3 次，加上首次调用共 4 次");
});

test("decide: 503 重试两次后成功，不多打也不少打", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: CallWithOpts[] = [];
  const client = scriptedClient(
    [{ status: 503 }, { status: 503 }, { answers: { action: choiceAnswer(NOTE) } }],
    calls,
  );
  const p = judge(client, input({ spans: [SPAN1] }));
  for (let i = 0; i < 5 && calls.length < 3; i++) {
    await Promise.resolve();
    t.mock.timers.tick(5000);
  }
  const d = await p;
  assert.equal(calls.length, 3, "失败两次、第三次成功，不该再多打一次");
  assert.equal(d.judgement.action, NOTE);
});

test("decide: 401 这类配置错误立即抛出，不做退避重试", async () => {
  const calls: CallWithOpts[] = [];
  const client = scriptedClient([{ status: 401 }], calls);
  await assert.rejects(judge(client, input({ spans: [SPAN1] })), /401/);
  assert.equal(calls.length, 1, "凭证问题重试没有意义，只会拖长故障发现时间");
});

test("decide: 调用方中途取消，不必等满超时预算就返回，也不会触发重试", async () => {
  const calls: CallWithOpts[] = [];
  // 故意让它一直挂起：如果取消没有真正合流进内部超时的 controller，
  // 这个假 client 永远不会结算，测试会挂住而不是通过或失败
  const client = scriptedClient(["hang"], calls);
  const controller = new AbortController();
  const p = judge(client, input({ spans: [SPAN1] }), controller.signal);
  controller.abort();
  await assert.rejects(p);
  assert.equal(calls.length, 1, "调用方主动取消是「不要了」，不是「再试一次」");
});

/**
 * 防的是"以后有人重构调用点时把 retry: NO_SDK_RETRY 悄悄弄丢"：SDK 自带
 * maxRetries: 2，弄丢了不会报错，只会在生产限流时和 callModel 自己的重试叠加，
 * 一次 judge()/route()/pick() 打出十余次真实请求——这种回归不测参数就看不见。
 * 三处调用点分开断言，避免只改了一处也能骗过测试。
 */
test("decide: judge 传给 systemOne 的 options 关掉了 SDK 自带的重试", async () => {
  const calls: CallWithOpts[] = [];
  const client = scriptedClient([{ answers: { action: choiceAnswer(NOTE) } }], calls);
  await judge(client, input({ spans: [SPAN1] }));
  assert.equal(calls[0].opts?.retry?.maxRetries, 0);
});

test("decide: JevBackend.route 传给 systemOne 的 options 关掉了 SDK 自带的重试", async () => {
  const calls: CallWithOpts[] = [];
  const client = scriptedClient(
    [{ answers: { app: choiceAnswer("Google Chrome"), complete: { noul: 1 }, destructive: { noul: 0 } } }],
    calls,
  );
  const backend = new JevBackend(client);
  await backend.route({ utterance: UTTERANCE, snapshot: SNAP, candidates: ["Google Chrome", "Notes"] });
  assert.equal(calls[0].opts?.retry?.maxRetries, 0);
});

test("decide: JevBackend.pick 传给 systemOne 的 options 关掉了 SDK 自带的重试", async () => {
  const calls: CallWithOpts[] = [];
  const client = scriptedClient(
    [{ answers: { action: choiceAnswer(TAB), destructive: { noul: 0 } } }],
    calls,
  );
  const backend = new JevBackend(client);
  const spec: ActionSpec = { id: TAB, app: "Google Chrome", summary: "新建标签页", kind: "script", params: [], risk: "safe" };
  await backend.pick({ utterance: UTTERANCE, snapshot: SNAP, actions: [spec] });
  assert.equal(calls[0].opts?.retry?.maxRetries, 0);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 0.2：checkDistribution 加严——键必须与选项集合相等、选中项必须是众数
 * ────────────────────────────────────────────────────────────────────────── */

test("decide: 概率分布比选项集合多出一个键，判为违规", async () => {
  const d = await judge(
    fakeClient({
      action: choiceAnswer(NOTE, { [NOTE]: 0.5, [TAB]: 0.2, ASK: 0.1, DONE: 0.1, 编造的键: 0.1 }),
    }),
    input({ spans: [SPAN1] }),
  );
  assert.ok(
    d.violations.some((v) => v.includes("键与选项集合不符") && v.includes("多出")),
    `实际违规: ${JSON.stringify(d.violations)}`,
  );
});

test("decide: 概率分布比选项集合少一个键，判为违规", async () => {
  const d = await judge(
    fakeClient({
      action: choiceAnswer(NOTE, { [NOTE]: 0.5, [TAB]: 0.3, ASK: 0.2 }), // 漏了 DONE
    }),
    input({ spans: [SPAN1] }),
  );
  assert.ok(
    d.violations.some((v) => v.includes("键与选项集合不符") && v.includes("缺少")),
    `实际违规: ${JSON.stringify(d.violations)}`,
  );
});

test("decide: 选中项不是概率最大的那个，判为违规", async () => {
  const d = await judge(
    fakeClient({
      action: choiceAnswer(NOTE, { [NOTE]: 0.3, [TAB]: 0.4, ASK: 0.2, DONE: 0.1 }), // TAB 才是众数
    }),
    input({ spans: [SPAN1] }),
  );
  assert.ok(
    d.violations.some((v) => v.includes("不是概率最大的选项")),
    `实际违规: ${JSON.stringify(d.violations)}`,
  );
});

test("decide: 键与选项集合一致、选中项确是众数——合法输入不被误伤", async () => {
  const d = await judge(
    fakeClient({
      action: choiceAnswer(NOTE, { [NOTE]: 0.7, [TAB]: 0.1, ASK: 0.1, DONE: 0.1 }),
      // 不给就按最保守的 1 取值（见 judge 里那条"缺失的安全信号不能默认成安全"），
      // 这里要测的是分布校验本身，破坏性得显式给低值，否则会被 profile 之外的
      // 另一道闸拦成 confirm，混进这条测试要隔离的变量里
      destructive: { noul: 0.02 },
    }),
    input({ spans: [SPAN1] }),
  );
  assert.deepEqual(d.violations, [], "键对得上、选中项也是众数，不该被新判据误伤");
  const spec: ActionSpec = { id: NOTE, app: "Notes", summary: "新建笔记", kind: "script", params: [], risk: "safe" };
  const g = policy({ judgement: d.judgement, offered: [TAB, NOTE, "ASK", "DONE"], spec, template: REGISTRY[NOTE] });
  assert.equal(g.kind, "execute", "不该把没问题的答案也拦下来");
});
