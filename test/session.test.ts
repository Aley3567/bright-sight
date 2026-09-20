import test from "node:test";
import assert from "node:assert/strict";
import { capabilitiesFrom, makeSessionMethods, parseCancelParams, parseConfirmParams, parseHandleParams, reasonsFrom, sessionUpdateFrom, type SessionDeps, type SessionRunInput, type SessionRunOutput } from "../src/session.ts";
import { RpcFailure } from "../src/rpc.ts";
import { RESERVED_CLIENT_METHODS, type SessionDescription, type SessionUpdate } from "../src/protocol.ts";
import type { OfferSet } from "../src/surface.ts";
import type { ActionSpec, ExecResult, Judgement, PendingConfirmation, RunState, RunStatus, Snapshot, StepRecord, VerifyResult } from "../src/types.ts";

const TAB = "Google Chrome.make-tab";
const NOTE = "Notes.make-note";

const SNAP: Snapshot = {
  at: "2026-09-20T00:00:00.000Z",
  front: "System Settings",
  window: null,
  windowView: { kind: "none" },
  running: ["System Settings"],
  elements: [],
  selection: null,
};

function specOf(id: string, app: string, risk: ActionSpec["risk"] = "safe"): ActionSpec {
  return { id, app, summary: `${id} 的一句话说明`, kind: "script", params: [], risk };
}

/** 手搓选项集，零 IO：和 `test/loop.test.ts` 同一套路数。 */
const OFFERS: OfferSet = {
  offers: [{ id: TAB, summary: "新建标签页" }, { id: NOTE, summary: "新建笔记" }],
  specs: new Map([[TAB, specOf(TAB, "Google Chrome")], [NOTE, specOf(NOTE, "Notes")]]),
  ids: [TAB, NOTE, "ASK", "WAIT", "DONE", "BLOCKED", "UNSUPPORTED"],
  total: 751,
};

function judgement(over: Partial<Judgement> = {}): Judgement {
  return { action: "DONE", probabilities: {}, confidence: 0.95, complete: 0.95, destructive: 0.01, backend: "fake", latency_ms: 1, ...over };
}

function step(over: Partial<StepRecord> = {}): StepRecord {
  return { step: 1, observe: SNAP, judgement: judgement(), actionId: "DONE", exec: null, verify: null, reasons: [], ...over };
}

function state(status: RunStatus, steps: StepRecord[], over: Partial<RunState> = {}): RunState {
  return { runId: "RUN1", utterance: "…", status, steps, artifacts: [], ...over };
}

const JOURNAL = { path: "/tmp/RUN1.jsonl", redacted: true, failures: 0 };

function update(s: RunState, mode: SessionUpdate["mode"] = "execute"): SessionUpdate {
  return sessionUpdateFrom(s, { mode, journal: JOURNAL, capabilities: capabilitiesFrom(OFFERS) });
}

// ── 能力清单 ────────────────────────────────────────────────────────────────

test("capabilities: 只有真能执行的动作进清单，任务层动作不算能力", () => {
  const caps = capabilitiesFrom(OFFERS);
  assert.deepEqual(caps.map((c) => c.id).sort(), [TAB, NOTE].sort());
  // 阳性对照：清单确实取到了东西，所以下面「任务层不在里面」不是因为清单是空的
  assert.equal(caps.length, 2);
  for (const id of ["DONE", "ASK", "UNSUPPORTED"]) {
    assert.equal(caps.some((c) => c.id === id), false, id);
  }
  const tab = caps.find((c) => c.id === TAB)!;
  // effect 与 argv 来自冻结模板，不是 sdef 的形参表——argv 才是真正会发出去的东西
  assert.equal(tab.effect, "navigate");
  assert.deepEqual([...tab.argv], ["url"]);
  assert.equal(tab.app, "Google Chrome");
  assert.equal(tab.risk, "safe");
});

test("capabilities: 动作面里有 spec 但没有冻结模板的，不算能力", () => {
  const withGhost: OfferSet = {
    ...OFFERS,
    specs: new Map([...OFFERS.specs, ["Notes.delete-everything", specOf("Notes.delete-everything", "Notes", "destructive")]]),
  };
  assert.equal(capabilitiesFrom(withGhost).some((c) => c.id === "Notes.delete-everything"), false);
});

// ── 0.5：status / reasons 如实呈现 ──────────────────────────────────────────

/**
 * 回归基准：留痕里那 4 次真实的 UNSUPPORTED
 * （哈希 e51dda38 / d79c4e59 / 1019cc2f / 8c724ebf）。
 *
 * 四次的形状一样：1 步、`blocked`、`actionId` 是 UNSUPPORTED、complete≈0.94（听懂了）、
 * destructive≈0.03（不是安全闸）、profile=allowed（不是 profile 闸）。
 * 置信度是四次的实际取值，一并跑一遍，免得判据不小心挂在某个阈值上。
 */
for (const conf of [0.34, 0.58, 0.32, 0.45]) {
  test(`0.5: UNSUPPORTED（置信 ${conf}）回的是「我不会做」而不是「执行没有完成」`, () => {
    const u = update(
      state("blocked", [step({ actionId: "UNSUPPORTED", judgement: judgement({ action: "UNSUPPORTED", confidence: conf, complete: 0.94, destructive: 0.03 }), reasons: ["模型给出终止意图 UNSUPPORTED"] })]),
    );
    assert.equal(u.status, "blocked");
    assert.deepEqual(u.reasons.map((r) => r.code), ["unsupported"]);
    assert.equal(u.reasons[0].detail, "模型给出终止意图 UNSUPPORTED");
    assert.equal(u.reasons[0].step, 1);
    // 「我目前只会 X 和 Y」必须是结构化事实，UI 才能在动作面变化时跟着变
    assert.ok(u.capabilities);
    assert.deepEqual(u.capabilities!.map((c) => c.id).sort(), [TAB, NOTE].sort());
  });
}

test("0.5: needs_input 分得开——追问是追问，确认是确认", () => {
  const ask = update(state("needs_input", [step({ actionId: "ASK", reasons: ["模型认为信息不足，需要追问"] })]));
  assert.equal(ask.status, "needs_input");
  assert.deepEqual(ask.reasons.map((r) => r.code), ["needs_clarification"]);

  // profile 闸：动作本身没问题，缺的是人拍板。阶段 3 的确认气泡接的就是这条
  const confirm = update(
    state("needs_input", [step({ actionId: TAB, reasons: ["Chrome profile Default 不在允许名单内，需要当场确认"] })]),
  );
  assert.deepEqual(confirm.reasons.map((r) => r.code), ["needs_confirmation"]);
  // detail 原样保留 policy 的话；UI 显示它，但不要拿它做分支
  assert.match(confirm.reasons[0].detail, /不在允许名单内/);
  assert.equal(confirm.capabilities, undefined, "能不能做不是问题，别拿能力清单岔开话题");
});

test("0.5: 破坏性闸与 profile 闸都落在 needs_confirmation，detail 区分二者", () => {
  const destructive = update(
    state("needs_input", [step({ actionId: NOTE, reasons: ["模型判定破坏性 0.81 超过阈值 0.3"] })]),
  );
  assert.deepEqual(destructive.reasons.map((r) => r.code), ["needs_confirmation"]);
  assert.match(destructive.reasons[0].detail, /破坏性/);
});

test("0.5: 模型说 BLOCKED / 没验证就说 DONE / 原地打转，三种结局各有各的 code", () => {
  const cases: [string, string][] = [
    ["BLOCKED", "model_declined"],
    ["DONE", "done_unverified"],
    ["WAIT", "stuck_waiting"],
  ];
  for (const [actionId, code] of cases) {
    const u = update(state("blocked", [step({ actionId, reasons: [`模型给出终止意图 ${actionId}`] })]));
    assert.deepEqual(u.reasons.map((r) => r.code), [code], actionId);
  }
});

test("0.5: 执行失败与验证失败分开，而且把没过的判据带出来", () => {
  const failedExec: ExecResult = { ok: false, errors: ["osascript 超时"], argv: ["https://example.com"], ms: 12 };
  const red: VerifyResult = { ok: false, checks: [{ name: "url_origin_match", ok: false, detail: "回读 origin 对不上" }] };

  const e = update(state("blocked", [step({ actionId: TAB, exec: failedExec, verify: red, reasons: ["置信度 0.95…"] })]));
  assert.deepEqual(e.reasons.map((r) => r.code), ["exec_failed", "exec_failed", "exec_failed"]);
  assert.deepEqual(e.reasons.map((r) => r.detail), ["置信度 0.95…", "osascript 超时", "url_origin_match: 回读 origin 对不上"]);

  const green: ExecResult = { ok: true, readback: {}, argv: [], ms: 1 };
  const v = update(state("blocked", [step({ actionId: TAB, exec: green, verify: red, reasons: ["连续 3 次验证失败，超过恢复预算 2"] })]));
  assert.deepEqual(v.reasons.map((r) => r.code), ["verify_failed", "verify_failed"]);
});

/**
 * 「新旧分支同时可能命中」的那一组。
 *
 * 走完步数预算是唯一一条「最后一步真的执行了、而且验证通过，结局却是 blocked」的路径。
 * 判据要是写成「有执行成功的步骤就算做完了」，这条会被误判成 done；
 * 写成「blocked 就是 not_executable」，这条又会被说成「这个动作不能执行」——
 * 而它恰恰执行成功了。三条都要对：认得出、不越界、和相邻分支不串。
 */
test("0.5: 走完步数预算 → step_budget，不会被误判成 done 也不会被说成不能执行", () => {
  const green: ExecResult = { ok: true, readback: { url: "https://example.com" }, argv: [], ms: 5 };
  const okVerify: VerifyResult = { ok: true, checks: [{ name: "url_origin_match", ok: true, detail: "一致" }] };
  const steps = [1, 2, 3].map((n) => step({ step: n, actionId: TAB, exec: green, verify: okVerify, reasons: ["置信度 0.95…"] }));
  const u = update(state("blocked", steps));
  assert.equal(u.status, "blocked");
  assert.deepEqual(u.reasons.map((r) => r.code), ["step_budget"]);
  assert.equal(u.capabilities, undefined, "能力是有的，只是步数用完了");

  // 相邻分支：同样是 blocked、同样最后一步是真实动作，但没执行 → not_executable
  const notRun = update(state("blocked", [step({ actionId: TAB, reasons: ["Google Chrome 不在执行白名单内"] })]));
  assert.deepEqual(notRun.reasons.map((r) => r.code), ["not_executable"]);
  assert.ok(notRun.capabilities, "「这个做不了」才需要回答「那你会什么」");

  // 再相邻一步：同样三步、同样执行成功，但 status 是 done → completed
  const done = update(state("done", [...steps, step({ step: 4, actionId: "DONE", reasons: ["模型给出终止意图 DONE"] })]));
  assert.deepEqual(done.reasons.map((r) => r.code), ["completed"]);
  assert.equal(done.status, "done");
});

test("0.5: 一步都没有产生时也给得出结论，reasons 永不为空", () => {
  const u = update(state("blocked", []));
  assert.deepEqual(u.reasons.map((r) => r.code), ["no_steps"]);
  assert.equal(u.reasons[0].step, undefined);
});

test("0.5: running 不是合法结局，只能当 blocked 报，绝不报成 done", () => {
  const u = update(state("running", [step({ actionId: TAB })]));
  assert.equal(u.status, "blocked");
});

test("0.5: reasons 恒非空——对每一种结局都过一遍", () => {
  const all: RunState[] = [
    state("done", [step({ actionId: "DONE" })]),
    state("blocked", [step({ actionId: "UNSUPPORTED" })]),
    state("needs_input", [step({ actionId: "ASK" })]),
    state("blocked", []),
  ];
  for (const s of all) assert.ok(reasonsFrom(s).length > 0, s.status);
});

test("0.5: steps 不回传 argv——真正发出去的值没有必要跨进程流动", () => {
  const green: ExecResult = { ok: true, readback: { url: "https://example.com/secret" }, argv: ["https://example.com/secret"], ms: 5 };
  const u = update(state("done", [step({ actionId: TAB, exec: green, verify: { ok: true, checks: [] } })]));
  assert.deepEqual(u.steps, [
    { step: 1, actionId: TAB, executed: true, verified: true, confidence: 0.95, complete: 0.95, destructive: 0.01, reasons: [] },
  ]);
  // 阳性对照：同一个串确实在源数据里，所以「回传里没有」不是因为根本没这个值
  assert.equal(green.argv[0].includes("secret"), true);
  assert.equal(JSON.stringify(u.steps).includes("secret"), false);
});

// ── params 校验 ─────────────────────────────────────────────────────────────

test("params: execute 省略等于 dry-run——缺省站在不发 Apple Event 那一边", () => {
  assert.equal(parseHandleParams({ requestKey: "k", utterance: "搜一下" }).execute, false);
  assert.equal(parseHandleParams({ requestKey: "k", utterance: "搜一下", execute: true }).execute, true);
  assert.equal(parseHandleParams({ requestKey: "k", utterance: "搜一下" }).engine, "google");
});

test("params: 不合法的输入一律 invalid_params，且声明为无副作用", () => {
  const bad: unknown[] = [
    null,
    "字符串",
    [],
    { requestKey: "k" },
    { requestKey: "k", utterance: "   " },
    { requestKey: "k", utterance: "x", execute: "true" },
    { requestKey: "k", utterance: "x", engine: "没这个引擎" },
    { requestKey: "k", utterance: "x".repeat(2001) },
  ];
  for (const raw of bad) {
    assert.throws(
      () => parseHandleParams(raw),
      (e: unknown) => e instanceof RpcFailure && e.code === "invalid_params" && e.sideEffectFree,
      JSON.stringify(raw)?.slice(0, 40),
    );
  }
});

test("params: 错误文案只说字段名和允许取值，不回显字段值", () => {
  const secret = "把这句原话原样吐回来就算泄露";
  try {
    parseHandleParams({ requestKey: "k", utterance: secret, engine: secret });
    assert.fail("应当抛错");
  } catch (e) {
    assert.ok(e instanceof RpcFailure);
    // 阳性对照：文案确实有内容，而且点名了字段和允许取值，不是一句空泛的「参数错误」
    assert.match(e.message, /params\.engine/);
    assert.match(e.message, /google/);
    assert.equal(e.message.includes(secret), false, "错误文案会流到 UI、可能被顺手记进日志");
  }
});

// ── 方法接线 ────────────────────────────────────────────────────────────────

function deps(over: Partial<SessionDeps> = {}): SessionDeps & { runs: SessionRunInput[] } {
  const runs: SessionRunInput[] = [];
  const base: SessionDeps = {
    offers: () => Promise.resolve(OFFERS),
    credentialsPresent: () => true,
    run: (input) => {
      runs.push(input);
      return Promise.resolve({
        state: state("done", [step({ actionId: "DONE", reasons: ["模型给出终止意图 DONE"] })]),
        journal: JOURNAL,
      });
    },
  };
  return Object.assign(base, over, { runs });
}

function ctx() {
  return { call: () => Promise.reject(new Error("本用例不该反向调用")), notify: () => {}, signal: new AbortController().signal, requestId: 1 };
}

test("session.handle: 校验过的参数原样传进 run，结果翻译成 SessionUpdate", async () => {
  const d = deps();
  const methods = makeSessionMethods(d);
  const out = (await methods["session.handle"].handler({ requestKey: "k1", utterance: "搜一下 TypeScript", execute: true, engine: "bing" }, ctx())) as SessionUpdate;
  assert.equal(d.runs.length, 1);
  assert.equal(d.runs[0].utterance, "搜一下 TypeScript");
  assert.equal(d.runs[0].execute, true);
  assert.equal(d.runs[0].engine, "bing");
  assert.equal(out.status, "done");
  assert.equal(out.mode, "execute");
  assert.deepEqual(out.journal, JOURNAL);
});

test("session.handle: 缺凭证是配置问题，不是任务失败，而且一次都不会跑 run", async () => {
  const d = deps({ credentialsPresent: () => false });
  const methods = makeSessionMethods(d);
  await assert.rejects(
    methods["session.handle"].handler({ requestKey: "k1", utterance: "搜一下" }, ctx()),
    (e: unknown) => e instanceof RpcFailure && e.code === "credentials_missing" && e.sideEffectFree,
  );
  assert.deepEqual(d.runs, []);
});

test("session.handle: 声明了 once——它会开标签页、写笔记，不去重就等于重复执行", () => {
  assert.equal(makeSessionMethods(deps())["session.handle"].once, true);
  // 阳性对照：只读方法不该被打上 once，否则 Swift 每次探活都得造一个键
  assert.equal(makeSessionMethods(deps())["session.describe"].once, undefined);
});

test("session.handle: run 炸了不声明无副作用——跑到一半没人保证 Apple Event 还没发出去", async () => {
  const d = deps({ run: () => Promise.reject(new Error("osascript 挂了")) });
  await assert.rejects(
    makeSessionMethods(d)["session.handle"].handler({ requestKey: "k1", utterance: "x" }, ctx()),
    (e: unknown) => e instanceof Error && !(e instanceof RpcFailure && e.sideEffectFree),
  );
});

test("session.handle: 动作面建不起来时什么都还没发生，键可以放回去", async () => {
  const d = deps({ offers: () => Promise.reject(new Error("缓存目录读不了")) });
  await assert.rejects(
    makeSessionMethods(d)["session.handle"].handler({ requestKey: "k1", utterance: "x" }, ctx()),
    (e: unknown) => e instanceof RpcFailure && e.code === "internal_error" && e.sideEffectFree,
  );
});

test("session.describe: 只读探针，给出协议版本与能力清单", async () => {
  const out = (await makeSessionMethods(deps())["session.describe"].handler({}, ctx())) as SessionDescription;
  assert.equal(out.protocol, 1);
  assert.equal(out.surfaceTotal, 751);
  assert.deepEqual(out.capabilities.map((c) => c.id).sort(), [TAB, NOTE].sort());
});

// ── 接上 RPC 之后，不变量仍然成立 ───────────────────────────────────────────

/**
 * 「一个决定最多执行一次」是端到端的性质，不是 rpc.ts 一个文件的性质。
 *
 * 上面 `test/rpc.test.ts` 用假处理器证明了去重机制本身；这里换成真正的
 * `makeSessionMethods`，证明 `session.handle` 确实被打上了 once、
 * 而且 requestKey 是从它的 params 里取的——两件事任一处接错，机制再对也没用。
 */
test("端到端: session.handle 在超时重发下只执行一次，第二次是回放", async () => {
  const { createPeer } = await import("../src/rpc.ts");
  const d = deps();
  const wire: string[] = [];
  const peer = createPeer({ write: (c) => void wire.push(c), idParity: "even", methods: makeSessionMethods(d) });

  const line = (id: number) =>
    `${JSON.stringify({ id, method: "session.handle", params: { requestKey: "同一条指令", utterance: "搜一下 TypeScript", execute: true } })}\n`;

  peer.ingest(line(1));
  await peer.drain();
  peer.ingest(line(3)); // Swift 侧超时重发，原样复用 requestKey
  await peer.drain();

  assert.equal(d.runs.length, 1, "Apple Event 只能发一轮");
  const results = wire.map((l) => JSON.parse(l) as { id: number; result: SessionUpdate });
  assert.deepEqual(results.map((r) => r.id), [1, 3]);
  assert.equal(results[0].result.replayed, undefined);
  assert.equal(results[1].result.replayed, true, "回放要说出来，Swift 才知道副作用没有再发生一次");
  assert.equal(results[1].result.runId, results[0].result.runId);
});

test("端到端: 换一个 requestKey 就是另一条指令——阳性对照", async () => {
  const { createPeer } = await import("../src/rpc.ts");
  const d = deps();
  const peer = createPeer({ write: () => {}, idParity: "even", methods: makeSessionMethods(d) });
  for (const [id, key] of [[1, "第一条"], [3, "第二条"]] as const) {
    peer.ingest(`${JSON.stringify({ id, method: "session.handle", params: { requestKey: key, utterance: "x", execute: true } })}\n`);
    await peer.drain();
  }
  assert.equal(d.runs.length, 2);
});

// ── 阶段 3：挂起、确认、取消 ─────────────────────────────────────────────────
//
// 这一组守的是「一个决定最多执行一次」在会话层的那一半。`rpc.ts` 的 once 只认
// requestKey，挡得住「超时重发同一条」，挡不住「用户连点两次、UI 各生成了一个 key」。
// 所以每条用例都要能回答同一个问题：那个待确认的动作，到底被执行了几次。

const CONFIRM = "session.confirm";
const CANCEL = "session.cancel";

function pendingOf(confirmId: string): PendingConfirmation {
  return {
    confirmId,
    step: 1,
    actionId: TAB,
    reasons: ["Chrome profile Profile 7 不在允许名单内，需要当场确认"],
    checkpoint: {
      proposed: [],
      waits: 0,
      recoveries: 0,
      unresolvedFailure: false,
      span: "TypeScript",
      bodySource: null,
      freshness: { front: "Google Chrome", window: "某个标签页", profile: "unknown:Profile 7" },
    },
  };
}

function paused(confirmId: string, runId = "RUN1"): RunState {
  return state(
    "waiting_for_confirmation",
    [step({ actionId: TAB, reasons: ["Chrome profile Profile 7 不在允许名单内，需要当场确认"] })],
    { runId, pending: pendingOf(confirmId) },
  );
}

const DONE_STATE = state("done", [
  step({ actionId: TAB, exec: { ok: true, readback: {}, argv: [], ms: 1 }, verify: { ok: true, checks: [] } }),
  step({ step: 2, actionId: "DONE", reasons: ["模型给出终止意图 DONE"] }),
]);

const CANCELLED_STATE = state("blocked", [
  step({ actionId: TAB, reasons: ["Chrome profile …", "用户取消了确认，这一步没有执行"] }),
]);

/**
 * 一个会挂起的 deps。`resume` 记下每一次调用与它拿到的答案——
 * 「执行了几次」这个问题，答案就在 `answers.length` 里。
 */
function pausingDeps(over: { after?: (approved: boolean) => SessionRunOutput; gate?: () => Promise<void> } = {}) {
  const answers: boolean[] = [];
  const resume = async (approved: boolean): Promise<SessionRunOutput> => {
    answers.push(approved);
    await over.gate?.();
    return over.after
      ? over.after(approved)
      : { state: approved ? DONE_STATE : CANCELLED_STATE, journal: JOURNAL };
  };
  const d = deps({
    run: () => Promise.resolve({ state: paused("C1"), journal: JOURNAL, resume }),
  });
  return Object.assign(d, { answers });
}

async function handle(methods: Record<string, { handler: (p: unknown, c: ReturnType<typeof ctx>) => Promise<unknown> }>, key = "k1") {
  return (await methods["session.handle"].handler({ requestKey: key, utterance: "搜一下 TypeScript", execute: true }, ctx())) as SessionUpdate;
}

test("阶段3: 协议里预留的两个方法都接上了（配阳性对照）", () => {
  const methods = makeSessionMethods(deps());
  for (const m of RESERVED_CLIENT_METHODS) {
    assert.ok(methods[m], `${m} 没有实现，Swift 发过来会收到 method_not_found`);
  }
  // 阳性对照：这张表不是「什么名字都说有」
  assert.equal(methods["session.rollback"], undefined);
  // confirm 会真的把那个动作发出去，所以必须有幂等键；cancel 的 params 里根本没有 requestKey
  assert.equal(methods[CONFIRM].once, true);
  assert.equal(methods[CANCEL].once, undefined);
});

test("阶段3: 挂起如实报 waiting_for_confirmation，code 是 needs_confirmation", async () => {
  const d = pausingDeps();
  const out = await handle(makeSessionMethods(d));
  assert.equal(out.status, "waiting_for_confirmation");
  assert.deepEqual(out.reasons.map((r) => r.code), ["needs_confirmation"]);
  assert.match(out.reasons[0].detail, /不在允许名单内/);
  assert.equal(out.capabilities, undefined, "能不能做不是问题，缺的是一个人点头");
  assert.deepEqual(d.answers, [], "光挂起不该调到恢复");
  assert.equal(out.confirmId, "C1", "挂起时现铸的那个 id，原样带给 Swift");
});

test("阶段3: 确认之后从挂起处继续，resume 恰好被调一次", async () => {
  const d = pausingDeps();
  const methods = makeSessionMethods(d);
  const up = await handle(methods);
  const out = (await methods[CONFIRM].handler(
    { requestKey: "c1", runId: up.runId, confirmId: "C1", approved: true },
    ctx(),
  )) as SessionUpdate;
  assert.equal(out.status, "done");
  assert.deepEqual(d.answers, [true]);
});

test("阶段3: SessionUpdate.confirmId 与 session.confirm 认的是同一个值——不是两处各铸一份、字面量恰好对上", async () => {
  // 关键在于不要硬编码 "C1" 去回传：用 up.confirmId 本身发起确认，
  // 只有它和 answer() 里 pending Map 存的那份真的同源，这条请求才会被接受
  const d = pausingDeps();
  const methods = makeSessionMethods(d);
  const up = await handle(methods);
  assert.ok(up.confirmId, "阳性对照：挂起态确实带出了 confirmId，不是这条用例本身没测到东西");

  const out = (await methods[CONFIRM].handler(
    { requestKey: "c1", runId: up.runId, confirmId: up.confirmId, approved: true },
    ctx(),
  )) as SessionUpdate;
  assert.equal(out.status, "done");
  assert.deepEqual(d.answers, [true], "confirmId 对上号，动作才真的被执行");
});

test("阶段3: done / blocked 结局不带 confirmId——那个动作已经执行完，或者这个 id 已经作废", () => {
  const done = update(DONE_STATE);
  assert.equal(done.status, "done");
  assert.equal("confirmId" in done, false);

  const blocked = update(CANCELLED_STATE);
  assert.equal(blocked.status, "blocked");
  assert.equal("confirmId" in blocked, false);
});

test("阶段3: 用户连点两次（两个不同的 requestKey）只会执行一次", async () => {
  // rpc.ts 的 once 在这里帮不上忙——两条请求的键本来就不同，都是合法请求。
  // 挡住它的是会话层：挂起点在第一个 await 之前就被同步摘走了
  let release = () => {};
  const barrier = new Promise<void>((r) => { release = r; });
  const d = pausingDeps({ gate: () => barrier });
  const methods = makeSessionMethods(d);
  const up = await handle(methods);

  const a = methods[CONFIRM].handler({ requestKey: "c1", runId: up.runId, confirmId: "C1", approved: true }, ctx());
  const b = methods[CONFIRM].handler({ requestKey: "c2", runId: up.runId, confirmId: "C1", approved: true }, ctx());
  release();
  const [ra, rb] = (await Promise.all([a, b])) as SessionUpdate[];

  assert.deepEqual(d.answers, [true], "在飞的那次必须被复用，绝不并起第二次执行");
  assert.equal(ra.status, "done");
  assert.deepEqual(rb, ra, "第二次拿到的是同一份结果");
});

test("阶段3: 落定之后再确认一次，回放同一份结果，不会再跑一遍", async () => {
  const d = pausingDeps();
  const methods = makeSessionMethods(d);
  const up = await handle(methods);
  const first = await methods[CONFIRM].handler({ requestKey: "c1", runId: up.runId, confirmId: "C1", approved: true }, ctx());
  const again = await methods[CONFIRM].handler({ requestKey: "c2", runId: up.runId, confirmId: "C1", approved: true }, ctx());
  assert.deepEqual(d.answers, [true]);
  assert.deepEqual(again, first);
});

test("阶段3: confirmId 对不上就拦住，而且不会把那个还没被回答的挂起点烧掉", async () => {
  const d = pausingDeps();
  const methods = makeSessionMethods(d);
  const up = await handle(methods);
  await assert.rejects(
    methods[CONFIRM].handler({ requestKey: "c1", runId: up.runId, confirmId: "猜的", approved: true }, ctx()),
    (e: unknown) => e instanceof RpcFailure && e.code === "invalid_params" && e.sideEffectFree,
  );
  assert.deepEqual(d.answers, [], "对不上号就什么都不执行");
  // 真正那次确认仍然有效：拦住一个错的不等于把对的一起废掉
  const ok = (await methods[CONFIRM].handler({ requestKey: "c2", runId: up.runId, confirmId: "C1", approved: true }, ctx())) as SessionUpdate;
  assert.equal(ok.status, "done");
  assert.deepEqual(d.answers, [true]);
});

test("阶段3: 没有待确认动作的 runId 一律拦住——core 重启后旧 confirmId 全部作废", async () => {
  const methods = makeSessionMethods(pausingDeps());
  await assert.rejects(
    methods[CONFIRM].handler({ requestKey: "c1", runId: "从来没有过的 run", confirmId: "C1", approved: true }, ctx()),
    (e: unknown) => e instanceof RpcFailure && e.code === "invalid_params" && e.sideEffectFree,
  );
});

test("阶段3: 取消——resume 收到 false，第二次取消不会再跑一遍", async () => {
  const d = pausingDeps();
  const methods = makeSessionMethods(d);
  const up = await handle(methods);
  const out = (await methods[CANCEL].handler({ runId: up.runId }, ctx())) as SessionUpdate;
  assert.equal(out.status, "blocked");
  assert.deepEqual(d.answers, [false]);
  const again = await methods[CANCEL].handler({ runId: up.runId }, ctx());
  assert.deepEqual(d.answers, [false], "取消是幂等的");
  assert.deepEqual(again, out);
});

test("阶段3: 取消之后再点确认也不会执行——决定已经落定了", async () => {
  const d = pausingDeps();
  const methods = makeSessionMethods(d);
  const up = await handle(methods);
  await methods[CANCEL].handler({ runId: up.runId }, ctx());
  const out = (await methods[CONFIRM].handler({ requestKey: "c1", runId: up.runId, confirmId: "C1", approved: true }, ctx())) as SessionUpdate;
  assert.deepEqual(d.answers, [false], "取消不是 undo，反过来也一样：已经取消的不能再被批准");
  assert.equal(out.status, "blocked");
});

test("阶段3: 恢复之后又要确认一次，旧 confirmId 立刻作废", async () => {
  // 一条 run 里可以有好几个挂起点。confirmId 每次现铸，正是为了让「上一次的回答」
  // 不会被当成「这一次的回答」——那是挂起-恢复最容易开出来的重放口子
  const second = paused("C2");
  const d = pausingDeps({ after: () => ({ state: second, journal: JOURNAL, resume: async () => ({ state: DONE_STATE, journal: JOURNAL }) }) });
  const methods = makeSessionMethods(d);
  const up = await handle(methods);

  const mid = (await methods[CONFIRM].handler({ requestKey: "c1", runId: up.runId, confirmId: "C1", approved: true }, ctx())) as SessionUpdate;
  assert.equal(mid.status, "waiting_for_confirmation");
  assert.equal(mid.confirmId, "C2", "这一轮带出去的必须是新铸的那个，不是刚被消费掉的 C1");

  await assert.rejects(
    methods[CONFIRM].handler({ requestKey: "c2", runId: up.runId, confirmId: "C1", approved: true }, ctx()),
    (e: unknown) => e instanceof RpcFailure && e.code === "invalid_params",
    "旧的 confirmId 不能回答新的那次挂起",
  );
  const done = (await methods[CONFIRM].handler({ requestKey: "c3", runId: up.runId, confirmId: "C2", approved: true }, ctx())) as SessionUpdate;
  assert.equal(done.status, "done");
});

test("阶段3: 接线没给出恢复入口时降级成 blocked，绝不弹一个点了没反应的气泡", async () => {
  // 缺省 fail-closed：报 waiting_for_confirmation 而没人能恢复，
  // 表现就是「点了确认没反应」——protocol.ts 点名要避免的那类缺陷
  const d = deps({ run: () => Promise.resolve({ state: paused("C1"), journal: JOURNAL }) });
  const methods = makeSessionMethods(d);
  const out = await handle(methods);
  assert.equal(out.status, "blocked");
  assert.match(out.reasons.map((r) => r.detail).join(""), /没有给出恢复入口/);
  // 这条最容易漏：输入的 state.pending.confirmId 确实是 "C1"（paused("C1") 造的），
  // 但最终报出去的 status 是降级后的 blocked，confirmId 判据要跟着 status 走，不能跟着 state.pending 走，
  // 否则会带出去一个 Swift 拿着也没用（甚至去 confirm 会撞 invalid_params）的失效 id
  assert.equal("confirmId" in out, false);
  await assert.rejects(
    methods[CONFIRM].handler({ requestKey: "c1", runId: out.runId, confirmId: "C1", approved: true }, ctx()),
    (e: unknown) => e instanceof RpcFailure && e.code === "invalid_params",
  );
});

test("阶段3: 端到端——同一个 requestKey 重发 confirm，走的是 rpc 的回放", async () => {
  const { createPeer } = await import("../src/rpc.ts");
  const d = pausingDeps();
  const wire: string[] = [];
  const peer = createPeer({ write: (c) => void wire.push(c), idParity: "even", methods: makeSessionMethods(d) });

  peer.ingest(`${JSON.stringify({ id: 1, method: "session.handle", params: { requestKey: "k1", utterance: "搜一下", execute: true } })}\n`);
  await peer.drain();
  const line = (id: number) =>
    `${JSON.stringify({ id, method: CONFIRM, params: { requestKey: "同一次确认", runId: "RUN1", confirmId: "C1", approved: true } })}\n`;
  peer.ingest(line(3));
  await peer.drain();
  peer.ingest(line(5));
  await peer.drain();

  assert.deepEqual(d.answers, [true], "重发不能让那个动作再发生一次");
  const results = wire.map((l) => JSON.parse(l) as { id: number; result: SessionUpdate });
  assert.equal(results.find((r) => r.id === 3)!.result.replayed, undefined);
  assert.equal(results.find((r) => r.id === 5)!.result.replayed, true);
});

test("阶段3: confirm / cancel 的参数校验——approved 没有缺省值", () => {
  assert.deepEqual(parseConfirmParams({ runId: "R", confirmId: "C", approved: false }), { runId: "R", confirmId: "C", approved: false });
  assert.deepEqual(parseCancelParams({ runId: "R" }), { runId: "R" });

  const bad: unknown[] = [
    null,
    "字符串",
    [],
    { runId: "R", confirmId: "C" },
    { runId: "R", confirmId: "C", approved: "true" },
    { runId: "R", confirmId: "C", approved: 1 },
    { runId: "", confirmId: "C", approved: true },
    { runId: "R", confirmId: "", approved: true },
    { runId: "R".repeat(129), confirmId: "C", approved: true },
  ];
  for (const raw of bad) {
    assert.throws(
      () => parseConfirmParams(raw),
      (e: unknown) => e instanceof RpcFailure && e.code === "invalid_params" && e.sideEffectFree,
      JSON.stringify(raw)?.slice(0, 40),
    );
  }
  assert.throws(() => parseCancelParams({}), (e: unknown) => e instanceof RpcFailure && e.code === "invalid_params");
});

test("阶段3: 挂起的 SessionUpdate 不夹带 checkpoint，但带着 confirmId——前者是恢复用的现场信息，不该跨进程流动；后者是标识符，Swift 要靠它发起确认", () => {
  // 恢复位置里有用户原话的片段、窗口标题指纹、profile 目录名。它们是**内存里**
  // 恢复所需的东西，没有任何理由跨进程流动，和 steps 不回传 argv 是同一条理由。
  // confirmId 不是现场信息，是一个不透明 id，protocol.ts 明说了它要由 SessionUpdate 带给 Swift。
  const u = update(paused("C1"));
  const wire = JSON.stringify(u);
  const src = JSON.stringify(paused("C1"));
  assert.equal(u.status, "waiting_for_confirmation");
  assert.equal(u.confirmId, "C1");
  for (const inner of ["TypeScript", "unknown:Profile 7", "某个标签页"]) {
    // 阳性对照：这些串确实在源 state 里，所以「线上没有」不是因为根本没这些值
    assert.equal(src.includes(inner), true, inner);
    assert.equal(wire.includes(inner), false, `${inner} 不该出现在 SessionUpdate 里`);
  }
});
