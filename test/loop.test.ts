import test from "node:test";
import assert from "node:assert/strict";
import { resumeLoop, runLoop, type LoopDeps, type LoopOptions } from "../src/loop.ts";
import type { Decision } from "../src/decide.ts";
import type { OfferSet } from "../src/surface.ts";
import type { ExecOutcome } from "../src/execute.ts";
import type { ActionSpec, Judgement, ProfileGate, Snapshot, VerifyResult } from "../src/types.ts";

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
