import test from "node:test";
import assert from "node:assert/strict";
import { resumeLoop, runLoop, type LoopDeps, type LoopOptions } from "../src/loop.ts";
import { runAction } from "../src/capability.ts";
import { SEARCH_ENGINES } from "../src/config.ts";
import { SPAN_SOURCE } from "../src/execute.ts";
import type { AxActionOffer, AxActionStatus, AxPeer } from "../src/ax.ts";
import type { Decision, JudgeInput } from "../src/decide.ts";
import type { AxFrameView, OfferSet } from "../src/surface.ts";
import type { ExecOutcome } from "../src/execute.ts";
import type { AxActionSpec, Judgement, ProfileGate, ScriptActionSpec, Snapshot, VerifyResult } from "../src/types.ts";

const TAB = "Google Chrome.make-tab";
const NOTE = "Notes.make-note";

const SNAP: Snapshot = {
  at: "2026-09-20T00:00:00.000Z",
  front: "Terminal",
  window: "zsh",
  windowView: { kind: "window", title: "zsh" },
  running: ["Terminal", "Google Chrome", "Notes"],
  elements: [],
  selection: null,
};

function specOf(id: string, app: string): ScriptActionSpec {
  return { id, app, summary: id, kind: "script", params: [], risk: "safe", effect: "navigate" };
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
  axSpecs: new Map(),
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
  return { judgement: judgement(action), span: "TypeScript", bodySource: null, targetId: null, violations: [], ...over };
}

function outcome(over: Partial<ExecOutcome["result"]> = {}, artifacts: ExecOutcome["artifacts"] = []): ExecOutcome {
  const argv = ["https://www.google.com/search?q=TypeScript"];
  return {
    result: { ok: true, readback: { url: argv[0] }, argv, ms: 1, ...over } as ExecOutcome["result"],
    artifacts,
    rawArgv: argv,
  };
}

/**
 * 一个已经放行的 profile。
 *
 * 下面绝大多数用例测的是控制流，不是 profile 闸；不给这个值的话每条含 Chrome 动作的
 * 用例都会先撞在闸上，测出来的就不是它们想测的东西了。闸本身的行为单独测（见文件末尾）。
 */
const ALLOWED: ProfileGate = { kind: "allowed", dir: "Default", via: "settings" };

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

function run(utterance: string, d: LoopDeps, opts: LoopOptions = {}) {
  return runLoop(utterance, OFFERS, d, { profile: ALLOWED, ...opts });
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
  const state = await run("搜一下 TypeScript，存进备忘录", d);
  assert.equal(state.status, "done");
  assert.deepEqual(state.steps.map((s) => s.actionId), [TAB, NOTE, "DONE"]);
  assert.equal(state.artifacts.length, 1);
  assert.equal(state.artifacts[0].value, "https://example.com/x");
});

test("loop: 模型说 DONE 但最近的验证失败尚未恢复，判定为 blocked", async () => {
  const d = deps({
    script: [decision(TAB), decision("DONE")],
    checkStep: () => Promise.resolve(RED),
  });
  const state = await run("搜一下 X", d);
  assert.equal(state.status, "blocked");
  assert.match(state.steps.at(-1)!.reasons.join(""), /最近的失败/);
});

test("loop: 一个动作都没执行就说 DONE，不算完成", async () => {
  const d = deps({ script: [decision("DONE")] });
  const state = await run("你好", d);
  assert.equal(state.status, "blocked");
  assert.match(state.steps.at(-1)!.reasons.join(""), /一个动作都没有执行过/);
});

test("loop: 同一动作配同一组参数被第二次提议，强制停下", async () => {
  const d = deps({ script: [decision(TAB), decision(TAB), decision("DONE")] });
  const state = await run("搜一下 TypeScript", d);
  assert.equal(state.status, "blocked");
  assert.equal(d.acted.length, 1, "重复的动作绝不能被执行第二次");
  assert.match(state.steps.at(-1)!.reasons.join(""), /第二次提议/);
});

test("loop: 答案校验没过时整条判断作废，不执行任何动作", async () => {
  const d = deps({ script: [decision(TAB, { violations: ["span 不是原话的逐字子串"] })] });
  const state = await run("搜一下 X", d);
  assert.equal(state.status, "blocked");
  assert.equal(d.acted.length, 0);
  assert.match(state.steps[0].reasons.join(""), /逐字子串/);
});

test("loop: 置信度不足转成追问，停在 needs_input 且不执行", async () => {
  const d = deps({ script: [decision(TAB, { judgement: judgement(TAB, { confidence: 0.1 }) })] });
  const state = await run("搜点东西", d);
  assert.equal(state.status, "needs_input");
  assert.equal(d.acted.length, 0);
});

test("loop: 破坏性判断挂起等人拍板，挂起时一个 Apple Event 都没发", async () => {
  const d = deps({ script: [decision(NOTE, { judgement: judgement(NOTE, { destructive: 0.9 }) })] });
  const state = await run("把备忘录清空", d);
  assert.equal(state.status, "waiting_for_confirmation");
  assert.equal(d.acted.length, 0);
  // 挂起不是「丢掉上下文」：待确认的是哪个动作、参数取自哪里，都还在
  assert.equal(state.pending?.actionId, NOTE);
  assert.equal(state.pending?.step, 1);
  assert.ok(state.pending!.confirmId.length > 0);
});

test("loop: 连续 WAIT 超过容忍次数就停下，不会原地空转", async () => {
  const waiting = decision("WAIT");
  const d = deps({ script: [waiting, waiting, waiting, waiting] });
  const state = await run("搜一下", d, { maxConsecutiveWaits: 2 });
  assert.equal(state.status, "blocked");
  assert.equal(state.steps.length, 3, "第三次 WAIT 就该收手");
});

test("loop: 验证不通过会重新观察并改走另一条路径", async () => {
  let checks = 0;
  const d = deps({
    script: [decision(TAB), decision(NOTE), decision("DONE")],
    checkStep: () => Promise.resolve(checks++ === 0 ? RED : GREEN),
  });
  const state = await run("搜一下 X 存进备忘录", d);
  assert.equal(state.status, "done");
  assert.deepEqual(d.acted.map((a) => a[0]), [TAB, NOTE]);
  assert.match(state.steps[0].reasons.join(""), /重新观察并改走其他路径/);
});

test("loop: 未验证的产物不能流入恢复路径", async () => {
  let checks = 0;
  const d = deps({
    script: [decision(TAB), decision(NOTE), decision("DONE")],
    act: (actionId, ctx) => {
      if (actionId === NOTE) assert.equal(ctx.artifacts.length, 0);
      return Promise.resolve(outcome({}, actionId === TAB
        ? [{ key: "chrome.active_url", value: "https://wrong.example", from: { step: 1, actionId, field: "url" } }]
        : []));
    },
    checkStep: () => Promise.resolve(checks++ === 0 ? RED : GREEN),
  });
  const state = await run("搜一下 X 存进备忘录", d);
  assert.equal(state.status, "done");
  assert.equal(state.artifacts.length, 0);
});

test("loop: 恢复次数有上限，不会在不同失败动作间无限兜圈", async () => {
  const d = deps({
    decide: (() => {
      let i = 0;
      return () => Promise.resolve(decision(i++ % 2 === 0 ? TAB : NOTE, { span: `路径${i}` }));
    })(),
    checkStep: () => Promise.resolve(RED),
  });
  const state = await run("完成任务", d, { maxRecoveries: 1, maxSteps: 5 });
  assert.equal(state.status, "blocked");
  assert.equal(d.acted.length, 2);
  assert.match(state.steps.at(-1)!.reasons.join(""), /超过恢复预算/);
});

test("loop: 步数上限兜底，模型一直提新动作也会停", async () => {
  let n = 0;
  // 每次给不同的 span，绕开重复守卫，专门测步数上限这一条
  const d = deps({ decide: () => Promise.resolve(decision(TAB, { span: `查询词${n++}` })) });
  const state = await run("搜一下", d, { maxSteps: 3 });
  assert.equal(state.status, "blocked");
  assert.equal(state.steps.length, 3);
});

test("loop: 探针或验证崩掉时，已经真实发生的动作仍然留在记录里", async () => {
  const d = deps({
    script: [decision(TAB)],
    checkStep: () => Promise.reject(new Error("Notes 没有响应")),
  });
  const state = await run("搜一下 X", d);
  assert.equal(state.status, "blocked");
  assert.equal(state.steps.length, 2, "验证异常后应重新观察一次，再由 DONE 收束为未恢复");
  assert.ok(state.steps[0].exec?.ok, "动作发生过，记录不能因为后续异常而消失");
  assert.match(state.steps[0].verify!.checks[0].detail, /没有响应/);
});

test("loop: 执行失败时步骤记录里保留失败原因", async () => {
  const d = deps({
    script: [decision(TAB)],
    act: () => Promise.resolve(outcome({ ok: false, errors: ["超时"], argv: [], ms: 1 } as never)),
    checkStep: () => Promise.resolve(RED),
  });
  const state = await run("搜一下 X", d);
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
  await run("搜一下 X", d);
  assert.deepEqual(phases, [
    "0:run.start",
    "1:observe",
    "1:judge",
    "1:act",
    "1:verify",
    "2:observe",
    "2:judge",
    "2:run.end",
  ]);
});

// ── profile 闸 ──
// 这道闸是后加的，而它与既有的白名单、模板、阈值三道判据在同一条路径上。
// 只测新逻辑的顺风路径，会让「闸装错了位置」这类缺陷全绿通过，所以下面三条
// 分别压住：新分支拦得住、旧分支不受影响、两者在同一次运行里同时命中。

test("loop: 没提供 profile 探测结果时，Chrome 动作被拦成确认——缺省即保守", async () => {
  const d = deps({ script: [decision(TAB)] });
  // 刻意绕开 run()：这里要的就是「调用方忘了传」这个场景
  const state = await runLoop("搜一下 X", OFFERS, d);
  assert.equal(state.status, "waiting_for_confirmation");
  assert.equal(d.acted.length, 0, "不知道会落在谁的登录态里，就不能发出去");
  assert.match(state.steps[0].reasons.join(""), /profile/);
});

test("loop: profile 闸只管 Chrome，Notes 动作不受它影响", async () => {
  const d = deps({ script: [decision(NOTE, { bodySource: "span" }), decision("DONE")] });
  const state = await runLoop("记一条备忘", OFFERS, d);
  assert.equal(state.status, "done");
  assert.deepEqual(d.acted.map((a) => a[0]), [NOTE], "profile 是 Chrome 独有的概念");
});

test("loop: 同一次运行里 Notes 先过、Chrome 后被闸拦下", async () => {
  // 新旧分支同时可能命中的那条路径：闸放在 policy 的末尾，它不能把前面已经
  // 判过的动作一起拖下水，也不能因为前一步成功了就对后一步放水
  const d = deps({ script: [decision(NOTE, { bodySource: "span" }), decision(TAB), decision("DONE")] });
  const state = await runLoop("记一条备忘，再搜一下 X", OFFERS, d);
  assert.equal(state.status, "waiting_for_confirmation");
  assert.deepEqual(d.acted.map((a) => a[0]), [NOTE]);
  assert.match(state.steps.at(-1)!.reasons.join(""), /profile/);
});

test("loop: 陌生 profile 与探测失败都拦，理由各自说清楚", async () => {
  const unknown = await runLoop("搜一下 X", OFFERS, deps({ script: [decision(TAB)] }), {
    profile: { kind: "unknown", dir: "Profile 7" },
  });
  assert.equal(unknown.status, "waiting_for_confirmation");
  assert.match(unknown.steps[0].reasons.join(""), /Profile 7 不在允许名单/);

  const blind = await runLoop("搜一下 X", OFFERS, deps({ script: [decision(TAB)] }), {
    profile: { kind: "undetectable", detail: "读不到 Local State" },
  });
  assert.equal(blind.status, "waiting_for_confirmation");
  assert.match(blind.steps[0].reasons.join(""), /读不到 Local State/);
});

test("loop: 人当场拍板放行的 profile 与名单里的一样能执行", async () => {
  const d = deps({ script: [decision(TAB), decision("DONE")] });
  const state = await runLoop("搜一下 X", OFFERS, d, {
    profile: { kind: "allowed", dir: "Profile 3", via: "prompt" },
  });
  assert.equal(state.status, "done");
  assert.equal(d.acted.length, 1);
});

// ── 挂起与恢复 ──
// 这一组和上面的「恢复预算」是**两条不同的恢复路径**，而且会在同一次 runSteps 里共存：
//   机器自己恢复：验证失败 → 重新观察 → 模型改走别的动作，不问人
//   人来拍板：policy 要求确认 → 挂起 → 人回答 → 从中断处继续
// 所以下面每一条都要么压住新路径本身，要么压住两条路径同时命中时的交互。

/** 挂起时的 profile 闸门：探测不到，于是 Chrome 动作一律要人确认。 */
const BLIND: ProfileGate = { kind: "undetectable", detail: "读不到 Local State" };

/** 把一条挂起的 run 恢复掉。恢复时传回**同一套**动作面，与生产路径一致。 */
function resume(state: Awaited<ReturnType<typeof runLoop>>, approved: boolean, d: LoopDeps, opts: LoopOptions = {}) {
  return resumeLoop(state, OFFERS, approved, d, opts);
}

test("挂起: 人确认之后从中断处继续，而不是把历史重新解释成一条新命令", async () => {
  const d = deps({ script: [decision(TAB)] });
  const paused = await runLoop("搜一下 TypeScript", OFFERS, d, { profile: BLIND });
  assert.equal(paused.status, "waiting_for_confirmation");
  assert.equal(d.acted.length, 0, "挂起那一刻什么都不该发出去");

  const done = await resume(paused, true, d, { profile: BLIND });
  assert.equal(done.status, "done");
  assert.deepEqual(d.acted.map((a) => a[0]), [TAB], "人批准的那个动作，恰好执行一次");
  // 同一步继续，不是新开一步：第 1 步从「没执行」变成「执行且验证通过」
  assert.equal(done.steps[0].step, 1);
  assert.equal(done.steps[0].actionId, TAB);
  assert.ok(done.steps[0].exec?.ok);
  assert.equal(done.steps[0].verify?.ok, true);
  assert.equal(done.pending, undefined, "恢复过就不再有挂起点");
});

test("挂起: 恢复只认一次——挂起点在第一次恢复时就被消费掉", async () => {
  const d = deps({ script: [decision(TAB)] });
  const paused = await runLoop("搜一下 TypeScript", OFFERS, d, { profile: BLIND });
  const first = await resume(paused, true, d, { profile: BLIND });
  assert.equal(d.acted.length, 1);

  // 用户连点两次 / Swift 重发：同一个 state 再恢复一遍，绝不能再发一次 Apple Event
  const second = await resume(first, true, d, { profile: BLIND });
  assert.equal(second.status, "blocked");
  assert.equal(d.acted.length, 1, "一个决定最多执行一次");
});

test("挂起: 恢复一个从来没挂起过的 run 一律拦住——缺省即保守", async () => {
  const d = deps({ script: [decision(TAB), decision("DONE")] });
  const finished = await run("搜一下 X", d);
  assert.equal(finished.status, "done");
  const again = await resume(finished, true, d, { profile: ALLOWED });
  assert.equal(again.status, "blocked");
  assert.equal(d.acted.length, 1, "没有挂起点就没有「人批准过的那一步」");
});

test("挂起: 用户取消——不执行、不消耗恢复预算、artifacts 里不留痕迹", async () => {
  const d = deps({
    script: [decision(TAB)],
    act: (actionId) => Promise.resolve(outcome({}, [
      { key: "chrome.active_url", value: "https://example.com/x", from: { step: 1, actionId, field: "url" } },
    ])),
  });
  const paused = await runLoop("搜一下 X", OFFERS, d, { profile: BLIND });
  const cancelled = await resume(paused, false, d, { profile: BLIND });

  assert.equal(cancelled.status, "blocked");
  assert.equal(d.acted.length, 0, "取消之后一个 Apple Event 都不该发出去");
  assert.equal(cancelled.artifacts.length, 0, "没执行过的动作不可能产出任何东西");
  assert.match(cancelled.steps[0].reasons.join(""), /用户取消/);
  // 阳性对照：同一套 deps 在批准时确实会产出 artifact，所以上面那个 0 不是
  // 因为这条路径根本就不产出东西
  const control = deps({ script: [decision(TAB)], act: d.act });
  const approved = await resume(
    await runLoop("搜一下 X", OFFERS, control, { profile: BLIND }),
    true,
    control,
    { profile: BLIND },
  );
  assert.equal(approved.artifacts.length, 1);
  assert.equal(approved.steps[0].exec?.ok, true);
});

test("挂起: 确认期间窗口换了就不执行——批准的是他当时看到的那件事", async () => {
  let moved = false;
  const d = deps({
    script: [decision(TAB)],
    observe: () => Promise.resolve(moved ? { ...SNAP, window: "别的标签页" } : SNAP),
  });
  const paused = await runLoop("搜一下 X", OFFERS, d, { profile: BLIND });
  moved = true;
  const stale = await resume(paused, true, d, { profile: BLIND });

  assert.equal(stale.status, "blocked");
  assert.equal(d.acted.length, 0);
  assert.match(stale.steps[0].reasons.join(""), /窗口标题/);
  assert.match(stale.steps[0].reasons.join(""), /确认期间世界变了/);
});

test("挂起: 确认期间 profile 被切走就不执行，而 Notes 动作不受它影响", async () => {
  // 新分支拦得住
  const chrome = deps({ script: [decision(TAB)] });
  const pausedTab = await runLoop("搜一下 X", OFFERS, chrome, { profile: { kind: "unknown", dir: "Profile 7" } });
  const drifted = await resume(pausedTab, true, chrome, { profile: { kind: "unknown", dir: "Profile 9" } });
  assert.equal(drifted.status, "blocked");
  assert.equal(chrome.acted.length, 0);
  assert.match(drifted.steps[0].reasons.join(""), /profile/i);

  // 不越界：profile 是 Chrome 独有的概念，同样的漂移不该把一条笔记也拦下来
  const notes = deps({ script: [decision(NOTE, { judgement: judgement(NOTE, { destructive: 0.9 }), bodySource: "span" })] });
  const pausedNote = await runLoop("记一条备忘", OFFERS, notes, { profile: { kind: "unknown", dir: "Profile 7" } });
  assert.equal(pausedNote.status, "waiting_for_confirmation");
  const okNote = await resume(pausedNote, true, notes, { profile: { kind: "unknown", dir: "Profile 9" } });
  assert.deepEqual(notes.acted.map((a) => a[0]), [NOTE]);
  assert.equal(okNote.status, "done");
});

test("挂起: 人点了确认也绕不过重复守卫", async () => {
  // 第 1 步已经用同样的参数做过一次，第 2 步模型又提议它、并且因破坏性被挂起。
  // 人说「好」之后仍然必须撞在重复守卫上——确认回答的是「要不要做」，不是「能不能重做」
  const d = deps({
    script: [decision(TAB), decision(TAB, { judgement: judgement(TAB, { destructive: 0.9 }) })],
  });
  const paused = await run("搜一下 X", d);
  assert.equal(paused.status, "waiting_for_confirmation");
  const after = await resume(paused, true, d, { profile: ALLOWED });
  assert.equal(after.status, "blocked");
  assert.equal(d.acted.length, 1);
  assert.match(after.steps.at(-1)!.reasons.join(""), /第二次提议/);
});

test("挂起: 恢复预算原样穿过挂起——等人回答不是一次失败", async () => {
  // 两条恢复路径同时在场：第 1 步验证失败用掉 1 次机器恢复，第 2 步要人拍板。
  // 人回答之后如果又失败，剩下的预算必须是「减掉第 1 步那次」的，不能被挂起洗成满格
  let checks = 0;
  const d = deps({
    script: [decision(TAB), decision(NOTE, { judgement: judgement(NOTE, { destructive: 0.9 }), bodySource: "span" })],
    checkStep: () => {
      checks++;
      return Promise.resolve(RED);
    },
  });
  const paused = await run("搜一下 X 再记一条", d, { maxRecoveries: 1 });
  assert.equal(paused.status, "waiting_for_confirmation");
  assert.equal(paused.pending?.checkpoint.recoveries, 1, "挂起前已经用掉 1 次");
  assert.equal(paused.pending?.checkpoint.unresolvedFailure, true);

  const after = await resume(paused, true, d, { profile: ALLOWED, maxRecoveries: 1 });
  assert.equal(after.status, "blocked");
  assert.equal(checks, 2);
  assert.match(after.steps.at(-1)!.reasons.join(""), /超过恢复预算/);
});

test("挂起: 上一步失败未恢复时遇到要确认的动作，先问人而不是先改路", async () => {
  // 机器恢复路径与人确认路径在同一步相撞。挂起优先：policy 已经对这一步下了
  // 「不经人不能做」的结论，绕过它去让模型另选一条，等于把安全判据换成了重试策略
  const script = [
    decision(TAB),
    decision(NOTE, { judgement: judgement(NOTE, { destructive: 0.9 }), bodySource: "span" }),
    decision("DONE"),
  ];
  let checks = 0;
  const mk = () => deps({ script: script.slice(), checkStep: () => Promise.resolve(checks++ === 0 ? RED : GREEN) });

  checks = 0;
  const a = mk();
  const paused = await run("搜一下 X 再记一条", a);
  assert.equal(paused.status, "waiting_for_confirmation", "要确认的那一步不该被恢复路径顶掉");
  assert.equal(paused.pending?.actionId, NOTE);

  // 取消：第 1 步那次失败仍然没被恢复，于是 DONE 也仍然不能成立
  const cancelled = await resume(paused, false, a, { profile: ALLOWED });
  assert.equal(cancelled.status, "blocked");
  assert.match(cancelled.steps.at(-1)!.reasons.join(""), /用户取消/);

  // 批准：人拍板的这一步验证通过，它就是那条「已验证路径」，DONE 可以成立
  checks = 0;
  const b = mk();
  const paused2 = await run("搜一下 X 再记一条", b);
  const done = await resume(paused2, true, b, { profile: ALLOWED });
  assert.equal(done.status, "done");
  assert.deepEqual(b.acted.map((x) => x[0]), [TAB, NOTE]);
});

test("挂起: 留痕里有 suspend / resume，且一次都不会缺 run.end", async () => {
  const events: [string, number][] = [];
  const d = deps({
    script: [decision(TAB)],
    record: (phase, step) => {
      events.push([phase, step]);
      return Promise.resolve();
    },
  });
  const paused = await runLoop("搜一下 X", OFFERS, d, { profile: BLIND });
  assert.deepEqual(events.map((e) => e[0]), ["run.start", "observe", "judge", "suspend", "run.end"]);

  events.length = 0;
  await resume(paused, true, d, { profile: BLIND });
  // 恢复不再落 run.start：它不是一条新 run。observe 排在 resume 之前——
  // 先看清楚世界，才谈得上判定陈旧与否
  assert.deepEqual(events.map((e) => e[0]), ["observe", "resume", "act", "verify", "observe", "judge", "run.end"]);
  assert.deepEqual(events.filter((e) => e[0] === "suspend"), []);
});

// ── stop 收手与 ASK 分流：两条都不该被当成失败的执行 ───────────────────────────

test("loop: 执行层报 stop 时置 needs_input 收手，不消耗恢复预算也不跑 verify", async () => {
  const d = deps({
    script: [decision(TAB)],
    act: () =>
      Promise.resolve({
        result: { ok: false, errors: ["缺少正文来源"], argv: [], ms: 1 },
        artifacts: [],
        rawArgv: [],
        stop: "needs_more_input",
      }),
  });
  const state = await run("搜一下 TypeScript 存进备忘录", d);
  assert.equal(state.status, "needs_input");
  assert.equal(state.steps.length, 1);
  assert.equal(state.steps[0].verify, null, "缺输入没有可验证的东西，不该跑 verify");
  // stop 不是失败：不该出现「重新观察改走其他路径」这类恢复预算的提示
  assert.equal(state.steps[0].reasons.join("").includes("恢复"), false);
});

test("loop: 模型选 ASK 时不进入执行与验证——未知动作判负不该误伤任务层动作", async () => {
  let verified = 0;
  const d = deps({
    script: [decision("ASK")],
    checkStep: () => {
      verified++;
      return Promise.resolve(GREEN);
    },
  });
  const state = await run("信息不够，你再说清楚点", d);
  assert.equal(state.status, "needs_input");
  assert.equal(verified, 0, "追问不产生任何执行，也就不该进入 verify");
  const checks = state.steps.flatMap((s) => s.verify?.checks ?? []);
  assert.equal(checks.some((c) => c.name === "unknown_action"), false, "任务层动作不该出现 unknown_action 判负");
});

// ── AX 动作的重复守卫与恢复重认领（阶段 5.5） ───────────────────────────────
//
// 这一组用**真的 runAction + 真的 AX 适配器**，只把 AX peer 换成假的：判据之一是
// 「ax.perform 零调用」，只有让调用真的走到 performAX，那个 0 才有意义。假 peer 是
// `test/capability.test.ts` 的 peerCalling 的加强版——它记下每次反向调用的方法名与参数。

const AX_APP = "Finder";

/** 一个 AX offer。OPEN 只认 AXLink（effect navigate → policy 放行），CLICK 走兜底（change → 挂起确认）。 */
function axOffer(id: string, operation: AxActionOffer["operation"], label: string, role = "AXButton"): AxActionOffer {
  const link = role === "AXLink";
  return {
    id,
    operation,
    target: { ref: "opaque", role, label, state: { enabled: true, editable: false } },
    // effect/risk 与 `AXOfferFactory` 对这两个 role 的取值一致，只为让 policy 走到该走的分支
    effect: link ? "navigate" : "change",
    risk: link ? "safe" : "caution",
  };
}

function axFrame(frameId: string, offers: AxActionOffer[]): AxFrameView {
  return { frameId, pid: 42, app: AX_APP, offers };
}

/** 只有 AX 半边的选项集：脚本那半与 AX 的守卫/重认领无关，不掺进来。 */
function axOfferSet(frameId: string, offers: AxActionOffer[]): OfferSet {
  const axSpecs = new Map<string, AxActionSpec>(
    offers.map((o) => [
      o.id,
      {
        kind: "ax",
        id: o.id,
        app: AX_APP,
        summary: `AX ${o.operation}`,
        params: [],
        risk: o.risk,
        effect: o.effect,
        frameId,
        operation: o.operation,
      } as AxActionSpec,
    ]),
  );
  return {
    offers: offers.map((o) => ({ id: o.id, summary: `AX ${o.operation}`, operation: o.operation })),
    specs: new Map(),
    axSpecs,
    ids: [...offers.map((o) => o.id), "ASK", "WAIT", "DONE", "BLOCKED", "UNSUPPORTED"],
    total: 0,
  };
}

type Seen = Array<{ method: string; params: unknown }>;

function axPeer(seen: Seen): AxPeer {
  return {
    call: async <T>(method: string, params?: unknown): Promise<T> => {
      seen.push({ method, params });
      return { status: "executed", artifacts: [], verify: { ok: true, detail: "ok" } } as T;
    },
  };
}

function performs(seen: Seen): Seen {
  return seen.filter((s) => s.method === "ax.perform");
}

function axOpt(frame: AxFrameView, peer: AxPeer): LoopOptions {
  return {
    ax: {
      peer,
      frameId: frame.frameId,
      offers: frame.offers,
      app: frame.app,
      truncated: frame.truncated,
      nextOffset: frame.nextOffset,
    },
  };
}

/** act 走真的 runAction，于是 AX 动作真的经过适配器与 performAX。 */
function axDeps(script: Decision[] = []): LoopDeps {
  let i = 0;
  return {
    observe: () => Promise.resolve(SNAP),
    decide: () => Promise.resolve(script[i++] ?? decision("DONE")),
    act: (id, ctx, step) => runAction(id, { ...ctx, engine: SEARCH_ENGINES.google }, { step }),
    probe: () => Promise.resolve(null),
    checkStep: () => Promise.resolve(GREEN),
  };
}

test("5.5: 两级 head 的答案被合成一个动作 id——选了 AX 代表项也能真的执行", async () => {
  // judge 给的是 action="AX:OPEN" + targetId=<offerId> 两半。执行层只认一个 id，
  // 少了这一步合成，AX:OPEN 不在动作面里，会被 policy 当成「未提供的选项」整条拦掉。
  const seen: Seen = [];
  const open = axOffer("open-1", "OPEN", "打开", "AXLink");
  const d = axDeps([decision("AX:OPEN", { targetId: open.id }), decision("DONE")]);

  const state = await runLoop("打开那个链接", axOfferSet("frame-1", [open]), d, axOpt(axFrame("frame-1", [open]), axPeer(seen)));

  assert.equal(state.status, "done");
  assert.deepEqual(
    performs(seen).map((p) => (p.params as { offerId: string }).offerId),
    ["open-1"],
    "执行的是 targetId 指的那个 offer，不是代表项字符串",
  );
});

test("5.5: 目标身份相同的两个 offer（不同 offerId）——第二次提议被重复守卫拦下", async () => {
  // 同一个窗口里两个都叫「打开」的链接：identity 相同，offerId 不同。
  // 单看 id 它们毫无关系（旧键正是拿 id 当键，这里会漏拦），按目标身份才是同一个目标。
  const seen: Seen = [];
  const a = axOffer("offer-a", "OPEN", "打开", "AXLink");
  const b = axOffer("offer-b", "OPEN", "打开", "AXLink");
  const d = axDeps([decision(a.id), decision(b.id), decision("DONE")]);

  const state = await runLoop("打开那个链接", axOfferSet("frame-1", [a, b]), d, axOpt(axFrame("frame-1", [a, b]), axPeer(seen)));

  assert.equal(state.status, "blocked");
  assert.match(state.steps.at(-1)!.reasons.join(""), /第二次提议/);
  assert.equal(performs(seen).length, 1, "同一个目标只允许发出去一次");
});

test("5.5: 目标身份不同时不误伤——两个不同的按钮各执行一次", async () => {
  // 阳性对照：上面的拦截不是「AX 动作一律只放行一次」这种过宽行为
  const seen: Seen = [];
  const a = axOffer("offer-a", "OPEN", "打开", "AXLink");
  const b = axOffer("offer-b", "OPEN", "取消", "AXLink");
  const d = axDeps([decision(a.id), decision(b.id), decision("DONE")]);

  const state = await runLoop("打开再取消", axOfferSet("frame-1", [a, b]), d, axOpt(axFrame("frame-1", [a, b]), axPeer(seen)));

  assert.equal(state.status, "done");
  assert.equal(performs(seen).length, 2, "身份不同，两个目标都该放行");
});

test("5.5: 跨挂起两次观察给出不同 offerId 却同一目标——第二次提议仍被拦下", async () => {
  // 第一次观察（frame-1）里 OPEN「打开」执行过一次；挂起后重新观察（frame-2）给了同一个目标
  // 一个**新的 offerId**。键要是 offerId，这一次就会被当成全新动作放行——正是这条判据要堵的洞：
  // 多步 AX 每步刷新 frame 时，同一个按钮会被点第二次。这里用挂起-恢复模拟「两次观察」，
  // 因为本阶段一个 run 只观察一次（设计 §6），两次观察只可能跨在挂起两侧。
  const seen1: Seen = [];
  const open1 = axOffer("open-1", "OPEN", "打开", "AXLink");
  const click1 = axOffer("click-1", "CLICK", "确定");
  const paused = await runLoop(
    "打开再点确定",
    axOfferSet("frame-1", [open1, click1]),
    axDeps([decision(open1.id), decision(click1.id)]),
    axOpt(axFrame("frame-1", [open1, click1]), axPeer(seen1)),
  );
  assert.equal(paused.status, "waiting_for_confirmation");
  assert.equal(performs(seen1).length, 1, "第一个 OPEN 已经执行过一次");

  const seen2: Seen = [];
  const open2 = axOffer("open-2", "OPEN", "打开", "AXLink");
  const click2 = axOffer("click-2", "CLICK", "确定");
  // 恢复先认领挂起的 CLICK（新的 click-2），下一步模型又提议 OPEN——新的 open-2
  const after = await resumeLoop(
    paused,
    axOfferSet("frame-2", [open2, click2]),
    true,
    axDeps([decision(open2.id)]),
    axOpt(axFrame("frame-2", [open2, click2]), axPeer(seen2)),
  );

  assert.equal(after.status, "blocked");
  assert.match(after.steps.at(-1)!.reasons.join(""), /第二次提议/);
  assert.deepEqual(
    performs(seen2).map((p) => (p.params as { offerId: string }).offerId),
    ["click-2"],
    "只发过恢复那一次的 click-2；同目标的 open-2 即便换了新 id 也被拦下",
  );
});

test("5.5: 恢复时目标消失——blocked，且 ax.perform 零调用", async () => {
  const seen1: Seen = [];
  const click = axOffer("offer-old", "CLICK", "确定");
  const offers1 = axOfferSet("frame-1", [click]);
  const paused = await runLoop("点确定", offers1, axDeps([decision(click.id)]), axOpt(axFrame("frame-1", [click]), axPeer(seen1)));
  assert.equal(paused.status, "waiting_for_confirmation");
  assert.equal(performs(seen1).length, 0, "挂起那一刻什么都不发");
  assert.deepEqual(
    [paused.pending?.target?.operation, paused.pending?.target?.app, paused.pending?.target?.role, paused.pending?.target?.label],
    ["CLICK", AX_APP, "AXButton", "确定"],
    "挂起时把目标身份记下来，恢复要靠它重新认领",
  );

  // 恢复：新 frame 里没有这个目标
  const seen2: Seen = [];
  const other = axOffer("offer-other", "CLICK", "取消");
  const after = await resumeLoop(
    paused,
    axOfferSet("frame-2", [other]),
    true,
    axDeps(),
    axOpt(axFrame("frame-2", [other]), axPeer(seen2)),
  );

  assert.equal(after.status, "blocked");
  assert.match(after.steps.at(-1)!.reasons.join(""), /目标已经不在当前界面上/);
  assert.equal(performs(seen2).length, 0, "目标不在，一次都不执行");
});

test("5.5: 恢复时同身份命中不止一个——无法确定批准的是哪一个，blocked 且零执行", async () => {
  const click = axOffer("offer-old", "CLICK", "确定");
  const paused = await runLoop(
    "点确定",
    axOfferSet("frame-1", [click]),
    axDeps([decision(click.id)]),
    axOpt(axFrame("frame-1", [click]), axPeer([])),
  );

  const seen: Seen = [];
  const t1 = axOffer("t-1", "CLICK", "确定");
  const t2 = axOffer("t-2", "CLICK", "确定");
  const after = await resumeLoop(
    paused,
    axOfferSet("frame-2", [t1, t2]),
    true,
    axDeps(),
    axOpt(axFrame("frame-2", [t1, t2]), axPeer(seen)),
  );

  assert.equal(after.status, "blocked");
  assert.match(after.steps.at(-1)!.reasons.join(""), /目标已经不在当前界面上/);
  assert.equal(performs(seen).length, 0, "认领不唯一就当成「批准的东西不在了」");
});

test("5.5: 恢复时目标还在（新 offerId）——按身份重新认领，perform 收到新 frame + 新 offer", async () => {
  const click = axOffer("offer-old", "CLICK", "确定");
  const paused = await runLoop(
    "点确定",
    axOfferSet("frame-1", [click]),
    axDeps([decision(click.id)]),
    axOpt(axFrame("frame-1", [click]), axPeer([])),
  );
  assert.equal(paused.status, "waiting_for_confirmation");

  const seen: Seen = [];
  const clickNew = axOffer("offer-new", "CLICK", "确定");
  const after = await resumeLoop(
    paused,
    axOfferSet("frame-2", [clickNew]),
    true,
    axDeps(),
    axOpt(axFrame("frame-2", [clickNew]), axPeer(seen)),
  );

  assert.equal(after.status, "done");
  assert.deepEqual(
    performs(seen),
    [{ method: "ax.perform", params: { frameId: "frame-2", offerId: "offer-new", operation: "CLICK" } }],
    "执行的是新 frame 里的新 offer，不是挂起时那对必然过期的 id",
  );
  assert.equal(after.steps[0].actionId, "offer-new", "账上记的是实际执行的那个 offer");
});

// ── 5.6 切片路径：TYPE_TEXT 的 text 与「缺输入」收手 ─────────────────────────
//
// 这一组同样走**真的 runAction**，判据里的「ax.perform 零调用」才是有意义的 0。
// 两条合起来压住一件事的两面：有值就逐字发出去、没值就收手去问用户，绝不发半条动作。

/** 一个可编辑文本框的 TYPE_TEXT offer：draft/safe，policy 会放行它自动执行。 */
function textOffer(id: string): AxActionOffer {
  return {
    id,
    operation: "TYPE_TEXT",
    target: { ref: "opaque", role: "AXTextField", label: "内容", state: { enabled: true, editable: true } },
    effect: "draft",
    risk: "safe",
  };
}

test("5.6: span 有值时逐字进 ax.perform 的 value，一步走完", async () => {
  const seen: Seen = [];
  const field = textOffer("type-1");
  const d = axDeps([decision(field.id, { span: "开会要点", bodySource: SPAN_SOURCE }), decision("DONE")]);

  const state = await runLoop("把开会要点打进那个框", axOfferSet("frame-1", [field]), d, axOpt(axFrame("frame-1", [field]), axPeer(seen)));

  assert.equal(state.status, "done");
  assert.deepEqual(
    performs(seen).map((p) => (p.params as { value?: string }).value),
    ["开会要点"],
    "发出去的就是用户原话里那一段，逐字",
  );
});

test("5.6: 切不出文本时收手为 needs_input，且 ax.perform 零调用", async () => {
  // 没有 bodySource 就没有文本来源。用 span:null + bodySource:null 模拟「模型挑不出可用的片段」
  const seen: Seen = [];
  const field = textOffer("type-1");
  const d = axDeps([decision(field.id, { span: null, bodySource: null }), decision("DONE")]);

  const state = await runLoop("打点字进去", axOfferSet("frame-1", [field]), d, axOpt(axFrame("frame-1", [field]), axPeer(seen)));

  assert.equal(state.status, "needs_input");
  assert.deepEqual(performs(seen), [], "缺输入就不该发出任何动作");
  // 缺输入不是失败：不该出现「重新观察改走其他路径」这类恢复预算的提示
  assert.equal(state.steps[0].reasons.join("").includes("恢复"), false);
});


// ── 对抗性复核补测（阶段 5 收口）──────────────────────────────────────────

test("复核: AX 动作恢复时不被 Chrome profile 闸误伤——它的 app 不是 Chrome", async () => {
  // resumeLoop 要判「确认期间世界变了没有」，其中 profile 那条判据**只对 Chrome 生效**。
  // 判定依据是待执行动作归属的 app。AX 动作的 app 只能从挂起时记下的目标身份里取：
  // 恢复时的 offerSet 是拿**新 frame** 重建的，挂起时那个 offerId 在里面必然查不到。
  // 去 offerSet 里查旧 id 的话 app 恒为 undefined，staleness 的缺省会把它当 Chrome，
  // 于是一次与 Chrome 毫无关系的 Finder 点击，会因为 Chrome profile 探测结果变了而被拦死。
  const seen: Seen = [];
  const click1 = axOffer("click-1", "CLICK", "确定");
  const paused = await runLoop(
    "点确定",
    axOfferSet("frame-1", [click1]),
    axDeps([decision(click1.id), decision("DONE")]),
    { ...axOpt(axFrame("frame-1", [click1]), axPeer(seen)), profile: ALLOWED },
  );
  assert.equal(paused.status, "waiting_for_confirmation", "change 档的 AX 动作要先问人");

  // 恢复这一刻 Chrome profile 探测不出来了（用户关掉了 Chrome）。前台还是 Finder，
  // 窗口标题也没变——对一次 Finder 点击来说，世界没有任何相关的变化。
  const seen2: Seen = [];
  const click2 = axOffer("click-2", "CLICK", "确定");
  const after = await resumeLoop(
    paused,
    axOfferSet("frame-2", [click2]),
    true,
    axDeps([decision("DONE")]),
    { ...axOpt(axFrame("frame-2", [click2]), axPeer(seen2)), profile: BLIND },
  );

  assert.equal(after.status, "done", "Chrome 的 profile 变没变，与一次 Finder 点击无关");
  assert.deepEqual(
    performs(seen2).map((p) => (p.params as { offerId: string }).offerId),
    ["click-2"],
    "人批准的那个目标在新 frame 里被重新认领并执行",
  );
});

test("复核: 挂起留痕不原样落下 AX 的 offerId——它和 judge 里的 targetId 是同一个东西", async () => {
  // judge 事件里这个值叫 targetId，被明确指纹化（redact.ts：Swift 现铸、外部来源）。
  // 同一个值经 suspend 事件的 actionId 字段落盘时若走白名单原样保留，等于换个字段名就绕开了脱敏。
  // 脚本动作的 actionId（`Notes.make-note`）是本系统常量，不受这条影响。
  const events: { phase: string; data: unknown }[] = [];
  const click = axOffer("click-1", "CLICK", "确定");
  const d = axDeps([decision(click.id)]);
  d.record = (phase, _step, data) => {
    events.push({ phase, data });
    return Promise.resolve();
  };

  await runLoop("点确定", axOfferSet("frame-1", [click]), d, axOpt(axFrame("frame-1", [click]), axPeer([])));

  const suspend = events.find((e) => e.phase === "suspend")!.data as Record<string, unknown>;
  assert.equal(suspend.actionId, undefined, "AX 的 offerId 不该占用「本系统常量」那个字段名");
  assert.equal(suspend.targetId, "click-1", "它该走 targetId——redact 对这个字段名一律指纹化");
});

// ── 截断与翻页信息透传（remaining-work §2.1） ────────────────────────────────
//
// `cli.ts` 此前把 observe 返回的 truncated / nextOffset 全丢了。下面两条压住「透传到了」与
// 「没有 AX 时不冒新字段」两面：只测有截断的顺风路径，会让「忘了给某个分支接上」全绿通过。

test("A2: 被截断的 frame 把完整度同时送进 decide 与 observe 留痕", async () => {
  const events: { phase: string; data: unknown }[] = [];
  const click = axOffer("click-1", "CLICK", "确定");
  const truncated: AxFrameView = {
    frameId: "frame-1",
    pid: 42,
    app: AX_APP,
    offers: [click],
    truncated: { reason: "depth", depth: 6, nodes: 120, ms: 20 },
    nextOffset: 80,
  };
  let seen: JudgeInput | null = null;
  const d = axDeps([decision("DONE")]);
  d.decide = (input) => {
    seen = input;
    return Promise.resolve(decision("DONE"));
  };
  d.record = (phase, _step, data) => {
    events.push({ phase, data });
    return Promise.resolve();
  };

  await runLoop("点确定", axOfferSet("frame-1", [click]), d, axOpt(truncated, axPeer([])));

  assert.equal(seen!.truncated?.reason, "depth", "截断信息必须到决策层——模型靠它知道列表是残缺的");
  assert.equal(seen!.nextOffset, 80, "nextOffset 不能被丢掉，类型留出了位置就要一路带过去");

  const observe = events.find((e) => e.phase === "observe")!.data as Record<string, unknown>;
  assert.equal(observe.axTruncated, "depth", "留痕要能看出这次观察被截断了");
  assert.equal(observe.axNodes, 120);
  assert.equal(observe.axNextOffset, 80);
});

test("A2: 没有 AX 的那一轮，observe 留痕形状与引入 AX 之前逐字段相等", async () => {
  const events: { phase: string; data: unknown }[] = [];
  const d = deps({
    script: [decision(TAB)],
    record: (phase, _step, data) => {
      events.push({ phase, data });
      return Promise.resolve();
    },
  });
  await run("搜一下 X", d);

  const observe = events.find((e) => e.phase === "observe")!.data as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(observe).sort(),
    ["front", "window"],
    "降级为仅脚本动作时不该多出任何字段——新判据不能越界到没有 AX 的那条路径",
  );
});
