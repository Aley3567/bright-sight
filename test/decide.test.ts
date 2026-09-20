import test from "node:test";
import assert from "node:assert/strict";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { readFile } from "node:fs/promises";
import { judge, JevBackend, JEV_MODEL, type JudgeInput } from "../src/decide.ts";
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
// `model` 是对面回给我们的版本号。带上它才能测出「留痕记的是响应里的那个、不是我们请求的那个」。
type ScriptStep = { status: number } | { answers: Record<string, unknown>; model?: string } | "hang";
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

/** 脚本动作 + 任务层动作，不含 AX。默认用它把绝大多数用例收窄到与 AX 无关。 */
const BASE_OFFERS = [
  { id: TAB, summary: "新建标签页" },
  { id: NOTE, summary: "新建笔记" },
  { id: "ASK", summary: "追问" },
  { id: "DONE", summary: "做完了" },
];

function input(over: Partial<JudgeInput> = {}): JudgeInput {
  return {
    utterance: UTTERANCE,
    snapshot: SNAP,
    offers: BASE_OFFERS,
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
  const spec: ActionSpec = { id: TAB, app: "Google Chrome", summary: "", kind: "script", params: [], risk: "safe", effect: "navigate" };
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
  const spec: ActionSpec = { id: TAB, app: "Google Chrome", summary: "新建标签页", kind: "script", params: [], risk: "safe", effect: "navigate" };
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
  const spec: ActionSpec = { id: NOTE, app: "Notes", summary: "新建笔记", kind: "script", params: [], risk: "safe", effect: "draft" };
  const g = policy({ judgement: d.judgement, offered: [TAB, NOTE, "ASK", "DONE"], spec, template: REGISTRY[NOTE] });
  assert.equal(g.kind, "execute", "不该把没问题的答案也拦下来");
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 5.4：两级 head——一个 operation head + 每种 operation 一个 target head
 *
 * AX 的 offerId 每次 observe 都变。放进 action head 会让单题上下文随目标数量膨胀，
 * 也让概率键集每次都不一样。折叠成「每种 operation 一个代表项」之后，能力与目标分成两问。
 * ────────────────────────────────────────────────────────────────────────── */

const AX_CLICK_A = "01924f4c-0000-7000-8000-000000000001";
const AX_CLICK_B = "01924f4c-0000-7000-8000-000000000002";
const AX_OPEN_A = "01924f4c-0000-7000-8000-000000000003";

type AxOffer = { id: string; summary: string; operation: "CLICK" | "OPEN" | "TYPE_TEXT" | "SELECT" };

/** 两个 CLICK（要问那一问）、一个 OPEN（单候选，不问）。 */
const AX_CLICKS: AxOffer[] = [
  { id: AX_CLICK_A, summary: "AX CLICK：继续", operation: "CLICK" },
  { id: AX_CLICK_B, summary: "AX CLICK：取消", operation: "CLICK" },
];
const AX_OPEN: AxOffer[] = [{ id: AX_OPEN_A, summary: "AX OPEN：备忘录", operation: "OPEN" }];

function axInput(extra: AxOffer[]): JudgeInput {
  // 只用单候选片段，收窄掉 span head，让这组用例只盯 action / target 两级
  return input({ offers: [...BASE_OFFERS, ...extra], spans: [SPAN1] });
}

function criteriaOf(q: unknown): Record<string, unknown> {
  const c = (q as { criteria?: Record<string, unknown> }).criteria;
  assert.ok(c && Object.keys(c).length > 0, "选项集为空，结构变了就该红而不是空转通过");
  return c;
}

/** axInput 下 action head 的全部键；checkDistribution 要求概率键集与它完全相等。 */
const ACTION_KEYS = [TAB, NOTE, "ASK", "DONE", "AX:CLICK", "AX:OPEN"];

/** 让 selected 成为众数的完整分布——不给全会被键集相等那条拦下，混进要测的变量里。 */
function majority(selected: string): Record<string, number> {
  const p: Record<string, number> = {};
  for (const k of ACTION_KEYS) p[k] = 0.05;
  p[selected] = 1 - (ACTION_KEYS.length - 1) * 0.05;
  return p;
}

test("decide: AX offers 折叠成每种 operation 一个代表项，具体目标落到 target head", async () => {
  const calls: Call[] = [];
  await judge(
    fakeClient(
      {
        action: choiceAnswer("AX:CLICK", majority("AX:CLICK")),
        target_CLICK: choiceAnswer(AX_CLICK_A, { [AX_CLICK_A]: 0.7, [AX_CLICK_B]: 0.3 }),
      },
      calls,
    ),
    axInput([...AX_CLICKS, ...AX_OPEN]),
  );
  const actionKeys = Object.keys(criteriaOf(calls[0].questions.action));
  assert.ok(actionKeys.includes("AX:CLICK"), `action head 缺 CLICK 代表项：${JSON.stringify(actionKeys)}`);
  assert.ok(actionKeys.includes("AX:OPEN"), "action head 缺 OPEN 代表项");
  assert.ok(!actionKeys.includes(AX_CLICK_A), "具体 offerId 不进 action head");
  assert.ok(!actionKeys.includes(AX_CLICK_B), "具体 offerId 不进 action head");
  // target head 的键是那个 operation 下的 offerId
  assert.deepEqual(Object.keys(criteriaOf(calls[0].questions.target_CLICK)), [AX_CLICK_A, AX_CLICK_B]);
});

test("decide: 在被选中的 target head 里编 id，判为违规且不流向执行层", async () => {
  const d = await judge(
    fakeClient({ action: choiceAnswer("AX:CLICK", majority("AX:CLICK")), target_CLICK: choiceAnswer("编造的目标 id") }),
    axInput([...AX_CLICKS, ...AX_OPEN]),
  );
  assert.deepEqual(
    d.violations,
    [`模型返回了未提供的目标 ${JSON.stringify("编造的目标 id")}`],
    "只该报编目标这一条，别的 head 不许牵连",
  );
  assert.equal(d.targetId, null, "没通过校验的目标不许流到执行层");
});

test("decide: 在未被选中的 target head 里编 id，不算违规", async () => {
  const d = await judge(
    fakeClient({
      action: choiceAnswer("AX:CLICK", majority("AX:CLICK")),
      target_CLICK: choiceAnswer(AX_CLICK_A, { [AX_CLICK_A]: 0.7, [AX_CLICK_B]: 0.3 }),
      // 这一问压根没被要求（OPEN 单候选），模型顺手编一个不该牵连整条判断
      target_OPEN: choiceAnswer("编造的目标 id"),
    }),
    axInput([...AX_CLICKS, ...AX_OPEN]),
  );
  assert.deepEqual(d.violations, [], "没被选中的 head 与这次执行无关");
  assert.equal(d.targetId, AX_CLICK_A);
});

test("decide: 选中的不是 AX 动作时，任何 target head 都不参与校验", async () => {
  const d = await judge(
    fakeClient({ action: choiceAnswer(TAB, majority(TAB)), target_CLICK: choiceAnswer("编造的目标 id") }),
    axInput([...AX_CLICKS, ...AX_OPEN]),
  );
  assert.deepEqual(d.violations, [], "选了脚本动作，target head 就不该被校验");
  assert.equal(d.targetId, null);
});

test("decide: 某个 operation 只有一个 offer 时，那一问不被发出，代码直接采用", async () => {
  const calls: Call[] = [];
  const d = await judge(
    fakeClient(
      // 同时给一个乱写的 target_OPEN：代码直接采用唯一目标，优先于模型乱写
      {
        action: choiceAnswer("AX:OPEN", majority("AX:OPEN")),
        target_OPEN: choiceAnswer("编造的目标 id"),
        target_CLICK: choiceAnswer(AX_CLICK_A, { [AX_CLICK_A]: 0.7, [AX_CLICK_B]: 0.3 }),
      },
      calls,
    ),
    axInput([...AX_CLICKS, ...AX_OPEN]),
  );
  assert.ok(!("target_OPEN" in calls[0].questions), "单候选的 head 少问一题");
  assert.ok("target_CLICK" in calls[0].questions, "多候选的 head 仍要问");
  assert.equal(d.targetId, AX_OPEN_A, "唯一的目标直接采用");
  assert.deepEqual(d.violations, [], "代码直接采用优先于模型乱写的那一问");
});

test("decide: 被选中的 target head 也要满足概率键集与候选集相等，不放宽成超集", async () => {
  const d = await judge(
    fakeClient({
      action: choiceAnswer("AX:CLICK", majority("AX:CLICK")),
      // AX_CLICK_A / AX_CLICK_B 之外多编一个键
      target_CLICK: choiceAnswer(AX_CLICK_A, { [AX_CLICK_A]: 0.7, [AX_CLICK_B]: 0.2, 编造的键: 0.1 }),
    }),
    axInput([...AX_CLICKS, ...AX_OPEN]),
  );
  assert.ok(
    d.violations.some((v) => v.includes("target_CLICK 的概率分布键与选项集合不符") && v.includes("多出")),
    `实际违规: ${JSON.stringify(d.violations)}`,
  );
});

test("decide: 没有 AX offer 时 head 结构与改造前一致——不走两级", async () => {
  const calls: Call[] = [];
  await judge(fakeClient({ action: choiceAnswer(TAB), span: choiceAnswer(SPAN1) }, calls), input());
  const keys = Object.keys(calls[0].questions).sort();
  assert.deepEqual(keys, ["action", "complete", "destructive", "span"], `实际 head: ${JSON.stringify(keys)}`);
  const actionKeys = Object.keys(criteriaOf(calls[0].questions.action));
  assert.ok(!actionKeys.some((k) => k.startsWith("AX:")), "没有 AX offer 就不该冒出 AX 代表项");
});


// ── 模型版本钉死 ──────────────────────────────────────────────────────────────
//
// SDK 不传 model 时落到 `jev-latest`，那是个会往前滚的别名。漂移的后果不是报错而是行为变化：
// 同一句话、同一个动作面，某天开始选另一个目标，留痕里看不出任何异常。

test("decide: 每次问模型都带上钉死的版本，不落到会漂移的 jev-latest 别名", async () => {
  const calls: CallWithOpts[] = [];
  const client = scriptedClient(
    [
      { answers: { app: choiceAnswer("Google Chrome"), complete: { noul: 1 }, destructive: { noul: 0 } } },
      { answers: { action: choiceAnswer(TAB), destructive: { noul: 0 } } },
    ],
    calls,
  );
  const backend = new JevBackend(client);
  const spec: ActionSpec = { id: TAB, app: "Google Chrome", summary: "新建标签页", kind: "script", params: [], risk: "safe", effect: "navigate" };

  await backend.route({ utterance: UTTERANCE, snapshot: SNAP, candidates: ["Google Chrome", "Notes"] });
  await backend.pick({ utterance: UTTERANCE, snapshot: SNAP, actions: [spec] });

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal((call as { model?: string }).model, JEV_MODEL, "每个调用点都要带 model");
  }
});

test("decide: 留痕里的 backend 记的是对面实际用的版本，不是我们请求的那个", async () => {
  const client = scriptedClient([
    { model: "jev-1.14.0", answers: { app: choiceAnswer("Google Chrome"), complete: { noul: 1 }, destructive: { noul: 0 } } },
  ]);
  const judgement = await new JevBackend(client).route({
    utterance: UTTERANCE,
    snapshot: SNAP,
    candidates: ["Google Chrome", "Notes"],
  });

  // pin 了不等于对面一定照办。两个值不一致时，backend 是唯一能看出来的地方——
  // 所以这里刻意让假客户端回一个**与请求不同**的版本号。
  assert.equal(judgement.backend, "jev/jev-1.14.0");
});

test("decide: 源码里每个 systemOne 调用点都 pin 了版本——新加一个忘了 pin 会在这里红", async () => {
  // 上面那条只覆盖 JevBackend 的两个方法，`judge()` 里还有第三个调用点，
  // 而且以后随时可能出现第四个。数调用点是唯一能挡住「新加的那个忘了」的办法。
  const source = await readFile(new URL("../src/decide.ts", import.meta.url), "utf8");
  const callSites = source.match(/\.systemOne\(/g)?.length ?? 0;
  const pinned = source.match(/model: JEV_MODEL/g)?.length ?? 0;

  assert.ok(callSites >= 3, `至少该有 3 个调用点，实际 ${callSites}——正则失效了`);
  assert.equal(pinned, callSites, `${callSites} 个 systemOne 调用点里只有 ${pinned} 个 pin 了版本`);
});
