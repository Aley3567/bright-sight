import test from "node:test";
import assert from "node:assert/strict";
import { runLoop, type LoopDeps } from "../src/loop.ts";
import type { Decision } from "../src/decide.ts";
import type { OfferSet } from "../src/surface.ts";
import type { ExecOutcome } from "../src/execute.ts";
import type { ActionSpec, Judgement, Snapshot, VerifyResult } from "../src/types.ts";

const TAB = "Google Chrome.make-tab";
const NOTE = "Notes.make-note";

const SNAP: Snapshot = {
  at: "2026-09-20T00:00:00.000Z",
  front: "Terminal",
  window: "zsh",
  running: ["Terminal", "Google Chrome", "Notes"],
  elements: [],
  selection: null,
};

function specOf(id: string, app: string): ActionSpec {
  return { id, app, summary: id, kind: "script", params: [], risk: "safe" };
}

/** 假的选项集：手搓而不是走 loadOffers，这套测试零 IO 零网络。 */
const OFFERS: OfferSet = {
  offers: [
    { id: TAB, summary: "新建标签页" },
    { id: NOTE, summary: "新建笔记" },
    { id: "DONE", summary: "做完了" },
  ],
  specs: new Map([
    [TAB, specOf(TAB, "Google Chrome")],
    [NOTE, specOf(NOTE, "Notes")],
  ]),
  ids: [TAB, NOTE, "ASK", "WAIT", "DONE", "BLOCKED", "UNSUPPORTED"],
  total: 751,
};

function judgement(action: string, over: Partial<Judgement> = {}): Judgement {
  return {
    action,
    probabilities: { [action]: 0.95 },
    confidence: 0.95,
    complete: 0.95,
    destructive: 0.01,
    backend: "fake",
    latency_ms: 1,
    ...over,
  };
}

function decision(action: string, over: Partial<Decision> = {}): Decision {
  return { judgement: judgement(action), span: "TypeScript", bodySource: null, violations: [], ...over };
}

function outcome(over: Partial<ExecOutcome["result"]> = {}, artifacts: ExecOutcome["artifacts"] = []): ExecOutcome {
  const argv = ["https://www.google.com/search?q=TypeScript"];
  return {
    result: { ok: true, readback: { url: argv[0] }, argv, ms: 1, ...over } as ExecOutcome["result"],
    artifacts,
    rawArgv: argv,
  };
}

const GREEN: VerifyResult = { ok: true, checks: [{ name: "fake", ok: true, detail: "" }] };
const RED: VerifyResult = { ok: false, checks: [{ name: "fake", ok: false, detail: "没通过" }] };

/** 依赖全部是函数参数：假 backend 和假 executor 就是普通闭包，不需要 mock 框架。 */
function deps(over: Partial<LoopDeps> & { script?: Decision[] } = {}): LoopDeps & { acted: string[][] } {
  const script = over.script ?? [];
  let i = 0;
  const acted: string[][] = [];
  const base: LoopDeps = {
    observe: () => Promise.resolve(SNAP),
    decide: () => Promise.resolve(script[i++] ?? decision("DONE")),
    act: (actionId, ctx) => {
      acted.push([actionId, String(ctx.span), String(ctx.artifacts.length)]);
      return Promise.resolve(outcome());
    },
    probe: () => Promise.resolve(null),
    checkStep: () => Promise.resolve(GREEN),
  };
  const { script: _s, ...rest } = over;
  return Object.assign(base, rest, { acted });
}

test("loop: 跨应用两步——第一步的产物流进第二步的上下文", async () => {
  const d = deps({
    script: [decision(TAB), decision(NOTE, { bodySource: "artifact:chrome.active_url" }), decision("DONE")],
    act: (actionId, ctx) => {
      const art = actionId === TAB
        ? [{ key: "chrome.active_url", value: "https://example.com/x", from: { step: 1, actionId, field: "url" } }]
        : [];
      // 第二步必须能看见第一步的产物，否则"跨应用两步"只是两次独立的单步
      if (actionId === NOTE) assert.equal(ctx.artifacts[0]?.key, "chrome.active_url");
      return Promise.resolve(outcome({}, art));
    },
  });
  const state = await runLoop("搜一下 TypeScript，存进备忘录", OFFERS, d);
  assert.equal(state.status, "done");
  assert.deepEqual(state.steps.map((s) => s.actionId), [TAB, NOTE, "DONE"]);
  assert.equal(state.artifacts.length, 1);
  assert.equal(state.artifacts[0].value, "https://example.com/x");
});

test("loop: 模型说 DONE 但有步骤验证没过，判定为 blocked 而不是 done", async () => {
  const d = deps({ script: [decision(TAB), decision("DONE")], checkStep: () => Promise.resolve(RED) });
  const state = await runLoop("搜一下 X", OFFERS, d);
  assert.equal(state.status, "blocked");
});

test("loop: 一个动作都没执行就说 DONE，不算完成", async () => {
  const d = deps({ script: [decision("DONE")] });
  const state = await runLoop("你好", OFFERS, d);
  assert.equal(state.status, "blocked");
  assert.match(state.steps.at(-1)!.reasons.join(""), /一个动作都没有执行过/);
});

test("loop: 同一动作配同一组参数被第二次提议，强制停下", async () => {
  const d = deps({ script: [decision(TAB), decision(TAB), decision("DONE")] });
  const state = await runLoop("搜一下 TypeScript", OFFERS, d);
  assert.equal(state.status, "blocked");
  assert.equal(d.acted.length, 1, "重复的动作绝不能被执行第二次");
  assert.match(state.steps.at(-1)!.reasons.join(""), /第二次提议/);
});

test("loop: 答案校验没过时整条判断作废，不执行任何动作", async () => {
  const d = deps({ script: [decision(TAB, { violations: ["span 不是原话的逐字子串"] })] });
  const state = await runLoop("搜一下 X", OFFERS, d);
  assert.equal(state.status, "blocked");
  assert.equal(d.acted.length, 0);
  assert.match(state.steps[0].reasons.join(""), /逐字子串/);
});

test("loop: 置信度不足转成追问，停在 needs_input 且不执行", async () => {
  const d = deps({ script: [decision(TAB, { judgement: judgement(TAB, { confidence: 0.1 }) })] });
  const state = await runLoop("搜点东西", OFFERS, d);
  assert.equal(state.status, "needs_input");
  assert.equal(d.acted.length, 0);
});

test("loop: 破坏性判断走确认，停在 needs_input 且不执行", async () => {
  const d = deps({ script: [decision(NOTE, { judgement: judgement(NOTE, { destructive: 0.9 }) })] });
  const state = await runLoop("把备忘录清空", OFFERS, d);
  assert.equal(state.status, "needs_input");
  assert.equal(d.acted.length, 0);
});

test("loop: 连续 WAIT 超过容忍次数就停下，不会原地空转", async () => {
  const waiting = decision("WAIT");
  const d = deps({ script: [waiting, waiting, waiting, waiting] });
  const state = await runLoop("搜一下", OFFERS, d, { maxConsecutiveWaits: 2 });
  assert.equal(state.status, "blocked");
  assert.equal(state.steps.length, 3, "第三次 WAIT 就该收手");
});

test("loop: 验证不通过立即停，不继续往下做", async () => {
  const d = deps({ script: [decision(TAB), decision(NOTE), decision("DONE")], checkStep: () => Promise.resolve(RED) });
  const state = await runLoop("搜一下 X 存进备忘录", OFFERS, d);
  assert.equal(state.status, "blocked");
  assert.equal(d.acted.length, 1, "第一步没验过就不该有第二步");
});

test("loop: 步数上限兜底，模型一直提新动作也会停", async () => {
  let n = 0;
  // 每次给不同的 span，绕开重复守卫，专门测步数上限这一条
  const d = deps({ decide: () => Promise.resolve(decision(TAB, { span: `查询词${n++}` })) });
  const state = await runLoop("搜一下", OFFERS, d, { maxSteps: 3 });
  assert.equal(state.status, "blocked");
  assert.equal(state.steps.length, 3);
});

test("loop: 探针或验证崩掉时，已经真实发生的动作仍然留在记录里", async () => {
  const d = deps({
    script: [decision(TAB)],
    checkStep: () => Promise.reject(new Error("Notes 没有响应")),
  });
  const state = await runLoop("搜一下 X", OFFERS, d);
  assert.equal(state.status, "blocked");
  assert.equal(state.steps.length, 1);
  assert.ok(state.steps[0].exec?.ok, "动作发生过，记录不能因为后续异常而消失");
  assert.match(state.steps[0].verify!.checks[0].detail, /没有响应/);
});

test("loop: 执行失败时步骤记录里保留失败原因", async () => {
  const d = deps({
    script: [decision(TAB)],
    act: () => Promise.resolve(outcome({ ok: false, errors: ["超时"], argv: [], ms: 1 } as never)),
    checkStep: () => Promise.resolve(RED),
  });
  const state = await runLoop("搜一下 X", OFFERS, d);
  assert.equal(state.status, "blocked");
  assert.equal(state.steps[0].exec?.ok, false);
});

test("loop: 四步事件都进了留痕", async () => {
  const phases: string[] = [];
  const d = deps({
    script: [decision(TAB), decision("DONE")],
    record: (phase, step) => {
      phases.push(`${step}:${phase}`);
      return Promise.resolve();
    },
  });
  await runLoop("搜一下 X", OFFERS, d);
  assert.deepEqual(phases, ["1:observe", "1:judge", "1:act", "1:verify", "2:observe", "2:judge"]);
});
