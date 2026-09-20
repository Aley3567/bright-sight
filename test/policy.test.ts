import test from "node:test";
import assert from "node:assert/strict";
import { THRESHOLDS, freshnessMark, policy, staleness } from "../src/policy.ts";
import { REGISTRY } from "../src/scripts.ts";
import type { AxActionSpec, Judgement, ProfileGate, ScriptActionSpec, Snapshot } from "../src/types.ts";

const NOTE = "Notes.make-note";
const OFFERED = [NOTE, "Google Chrome.make-tab", "ASK", "WAIT", "DONE", "BLOCKED", "UNSUPPORTED"];

function judgement(over: Partial<Judgement> = {}): Judgement {
  return {
    action: NOTE,
    probabilities: { [NOTE]: 0.9 },
    confidence: 0.9,
    complete: 0.9,
    destructive: 0.02,
    backend: "test",
    latency_ms: 1,
    ...over,
  };
}

function spec(over: Partial<ScriptActionSpec> = {}): ScriptActionSpec {
  return { id: NOTE, app: "Notes", summary: "新建笔记", kind: "script", params: [], risk: "safe", effect: "draft", ...over };
}

const ok = { offered: OFFERED, spec: spec(), template: REGISTRY[NOTE] };

test("policy: 置信度与完整度都够、白名单内、有模板才放行执行", () => {
  const r = policy({ judgement: judgement(), ...ok });
  assert.equal(r.kind, "execute");
  assert.equal(r.actionId, NOTE);
});

test("policy: 模型返回没给过的选项，整条判断作废且不产生动作", () => {
  const r = policy({ judgement: judgement({ action: "Finder.delete" }), ...ok });
  assert.equal(r.kind, "ignore");
  assert.equal(r.actionId, null, "被作废的判断不许把动作 id 漏给下游");
});

test("policy: 静态风险为 destructive 时必然拦截，模型的低破坏性概率救不了它", () => {
  const r = policy({ judgement: judgement({ destructive: 0 }), ...ok, spec: spec({ risk: "destructive" }) });
  assert.equal(r.kind, "confirm");
});

test("policy: 模型的破坏性概率只能加码，能把 safe 动作抬进确认", () => {
  const r = policy({ judgement: judgement({ destructive: THRESHOLDS.destructive + 0.01 }), ...ok });
  assert.equal(r.kind, "confirm");
});

test("policy: 模板声明 destroy 时拦截，哪怕动作面把它标成 safe", () => {
  const destroy = { ...REGISTRY[NOTE], id: "Notes.delete-note", effect: "destroy" as const };
  const r = policy({ judgement: judgement(), ...ok, template: destroy });
  assert.equal(r.kind, "confirm");
});

test("policy: 硬闸优先于置信度——置信度再低也不会把 destructive 降级成温和的追问", () => {
  const r = policy({ judgement: judgement({ confidence: 0.01, complete: 0.01 }), ...ok, spec: spec({ risk: "destructive" }) });
  assert.equal(r.kind, "confirm", "confirm 要人确认，ask/wait 不要，降级等于放松");
});

test("policy: 白名单外的应用即使有模板也不执行", () => {
  const r = policy({ judgement: judgement(), ...ok, spec: spec({ app: "Finder" }) });
  assert.equal(r.kind, "ignore");
});

test("policy: 动作面有但没有执行模板时不执行", () => {
  const r = policy({ judgement: judgement(), offered: OFFERED, spec: spec(), template: undefined });
  assert.equal(r.kind, "ignore");
  assert.match(r.reasons.join(""), /没有执行模板/);
});

test("policy: 五个任务层动作各自映射到固定的处置", () => {
  const kinds = ["ASK", "WAIT", "DONE", "BLOCKED", "UNSUPPORTED"].map(
    (a) => policy({ judgement: judgement({ action: a }), ...ok }).kind,
  );
  assert.deepEqual(kinds, ["ask", "wait", "ignore", "ignore", "ignore"]);
});

test("policy: 指令没说完时等待，不抢跑", () => {
  const r = policy({ judgement: judgement({ complete: THRESHOLDS.complete - 0.01 }), ...ok });
  assert.equal(r.kind, "wait");
});

test("policy: 置信度不足时转为追问而不是执行", () => {
  const r = policy({ judgement: judgement({ confidence: THRESHOLDS.execute - 0.01 }), ...ok });
  assert.equal(r.kind, "ask");
});

test("policy: 任意随机判断下，destructive 静态风险都不出现一次放行（属性测试）", () => {
  // 线性同余，种子固定——失败可复现，不靠 Math.random 碰运气
  let seed = 20260920;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const actions = [...OFFERED, "Finder.delete", "none", ""];
  for (let i = 0; i < 1000; i++) {
    const j = judgement({
      action: actions[Math.floor(rnd() * actions.length)],
      confidence: rnd(),
      complete: rnd(),
      destructive: rnd(),
    });
    const r = policy({ judgement: j, offered: OFFERED, spec: spec({ risk: "destructive" }), template: REGISTRY[NOTE] });
    // 答案非法时整条作废（ignore，且不产生动作）；只要选项合法，destructive 必然 confirm
    const allowed = OFFERED.includes(j.action) ? "confirm" : "ignore";
    assert.equal(r.kind, allowed, `第 ${i} 个反例: ${JSON.stringify(j)}`);
    assert.notEqual(r.kind, "execute");
  }
});

test("policy: 阈值之间的大小关系没有被改坏", () => {
  assert.ok(THRESHOLDS.execute > THRESHOLDS.complete, "执行门槛应当严于完整度门槛");
  assert.ok(THRESHOLDS.destructive < 0.5, "破坏性阈值必须明显偏保守，宁可多问一次");
});

// ── 第四道闸：Chrome profile ──
// 它和前三道在同一条路径上，且位置在最末尾。只测「陌生 profile 被拦下」这条顺风路径，
// 会让「闸装错了位置」「把 Notes 也拦了」「置信度不足却报成 profile 问题」全绿通过。

const TAB = "Google Chrome.make-tab";
const tabOk = {
  offered: OFFERED,
  spec: spec({ id: TAB, app: "Google Chrome", summary: "新建标签页" }),
  template: REGISTRY[TAB],
};

test("policy: 省略 profile 等于没探测，Chrome 动作一律要确认", () => {
  const r = policy({ judgement: judgement({ action: TAB }), ...tabOk });
  assert.equal(r.kind, "confirm", "安全边界的缺省值必须站在保守那一边");
  assert.equal(r.actionId, TAB);
});

test("policy: profile 在允许名单内才放行执行", () => {
  const r = policy({
    judgement: judgement({ action: TAB }),
    ...tabOk,
    profile: { kind: "allowed", dir: "Default", via: "settings" },
  });
  assert.equal(r.kind, "execute");
});

test("policy: 人当场拍板放行与名单里本来就有，效力相同", () => {
  const r = policy({
    judgement: judgement({ action: TAB }),
    ...tabOk,
    profile: { kind: "allowed", dir: "Profile 3", via: "prompt" },
  });
  assert.equal(r.kind, "execute");
});

test("policy: 陌生 profile 走确认，理由里点出是哪个目录", () => {
  const r = policy({
    judgement: judgement({ action: TAB }),
    ...tabOk,
    profile: { kind: "unknown", dir: "Profile 7" },
  });
  assert.equal(r.kind, "confirm");
  assert.match(r.reasons.join(""), /Profile 7/);
});

test("policy: 探测不出 profile 时也要确认，且说清楚是探测不出来", () => {
  const r = policy({
    judgement: judgement({ action: TAB }),
    ...tabOk,
    profile: { kind: "undetectable", detail: "读不到 Local State" },
  });
  assert.equal(r.kind, "confirm");
  assert.match(r.reasons.join(""), /读不到 Local State/);
});

test("policy: profile 闸不影响 Notes——profile 是 Chrome 独有的概念", () => {
  // 连一个刻意构造的坏 gate 都不该让 Notes 停下来
  const r = policy({ judgement: judgement(), ...ok, profile: { kind: "unknown", dir: "Profile 7" } });
  assert.equal(r.kind, "execute");
});

test("policy: 置信度不足优先于 profile——先回答该不该做，再回答在哪做", () => {
  const r = policy({
    judgement: judgement({ action: TAB, confidence: THRESHOLDS.execute - 0.1 }),
    ...tabOk,
    profile: { kind: "unknown", dir: "Profile 7" },
  });
  assert.equal(r.kind, "ask", "问题是模型没想清楚，不是落在哪个 profile");
  assert.match(r.reasons.join(""), /置信度/);
});

test("policy: 破坏性硬闸优先于 profile 闸，理由不被顶掉", () => {
  const r = policy({
    judgement: judgement({ action: TAB, destructive: 0.99 }),
    ...tabOk,
    profile: { kind: "allowed", dir: "Default", via: "settings" },
  });
  assert.equal(r.kind, "confirm");
  assert.match(r.reasons.join(""), /破坏性/);
});

test("policy: dry-run 这一轮不发 Apple Event，profile 闸不适用", () => {
  // 拦住它的唯一效果是让人连 argv 都看不到，而看见完整 argv 正是 dry-run 存在的理由
  const r = policy({ judgement: judgement({ action: TAB }), ...tabOk, profile: { kind: "dry-run" } });
  assert.equal(r.kind, "execute");
});

test("policy: dry-run 不是万能通行证——前三道硬闸照样拦", () => {
  const r = policy({
    judgement: judgement({ action: TAB, destructive: 0.99 }),
    ...tabOk,
    profile: { kind: "dry-run" },
  });
  assert.equal(r.kind, "confirm");
  assert.match(r.reasons.join(""), /破坏性/);
});

// ── AX 动作面：第四道硬闸与按 kind 分流 ──────────────────────────────────────
//
// AX 动作没有 ScriptTemplate，此前会直接落进 `if (!template)` 那条 ignore——
// 也就是「静默放过」。新判据和旧判据在同一条路径上（policy 的第 128-134 行一带），
// 所以除了「新分支拦得住」，还要压住「它不越界到脚本动作」和「两条同时可能命中时的优先级」。

const AX_ID = "01924f4c-0000-7000-8000-000000000abc";
const AX_OFFERED = [AX_ID, ...OFFERED];

function axSpec(over: Partial<AxActionSpec> = {}): AxActionSpec {
  return {
    kind: "ax",
    id: AX_ID,
    app: "Finder",
    summary: "AX CLICK：继续",
    params: [],
    risk: "safe",
    effect: "change",
    frameId: "frame-1",
    operation: "CLICK",
    ...over,
  };
}

test("policy: AX 动作的写档一律确认——change / submit / destroy 三条都拦得住", () => {
  for (const effect of ["change", "submit", "destroy"] as const) {
    const r = policy({ judgement: judgement({ action: AX_ID }), offered: AX_OFFERED, spec: axSpec({ effect }) });
    assert.equal(r.kind, "confirm", `effect=${effect} 应当确认`);
    assert.equal(r.actionId, AX_ID);
  }
});

test("policy: 不越界——AX 的读/导航/草稿档不被第四道闸误伤，照样自动执行", () => {
  // 阳性对照：闸确实在按 effect 判档，而不是「AX 一律确认」
  for (const effect of ["read", "navigate", "draft"] as const) {
    const r = policy({ judgement: judgement({ action: AX_ID }), offered: AX_OFFERED, spec: axSpec({ effect }) });
    assert.equal(r.kind, "execute", `effect=${effect} 不该被拦`);
  }
});

test("policy: 不越界——AX 动作的应用名不在 Apple Event 白名单内也照样可以执行", () => {
  // ALLOWED_APPS 管的是「哪些应用允许发 Apple Event」，AX 不发 Apple Event。
  // 目标通常是前台应用（Finder、任意第三方 App），它们永远不在名单里。
  const ax = policy({ judgement: judgement({ action: AX_ID }), offered: AX_OFFERED, spec: axSpec({ app: "Finder", effect: "navigate" }) });
  assert.equal(ax.kind, "execute");
  // 不越界不等于放水：同一份判断换成脚本动作，白名单这道闸仍然拦得住
  const script = policy({ judgement: judgement({ action: NOTE }), offered: OFFERED, spec: spec({ app: "Finder" }), template: REGISTRY[NOTE] });
  assert.equal(script.kind, "ignore");
  assert.match(script.reasons.join(""), /白名单/);
});

test("policy: AX 动作不受 Chrome profile 闸影响——它不发 Apple Event，就没有登录态可问", () => {
  const unknown: ProfileGate = { kind: "unknown", dir: "Profile 7" };
  const ax = policy({
    judgement: judgement({ action: AX_ID }),
    offered: AX_OFFERED,
    spec: axSpec({ effect: "navigate" }),
    profile: unknown,
  });
  assert.equal(ax.kind, "execute", "AX 路径上不该出现一大片无意义的确认气泡");
  // 不越界也不等于把闸拆了：同一个 profile 下 Chrome 脚本动作仍然要确认
  const chrome = policy({ judgement: judgement({ action: TAB }), ...tabOk, profile: unknown });
  assert.equal(chrome.kind, "confirm");
});

test("policy: AX 动作的低置信度转成追问而不是确认——先问清该不该做", () => {
  const r = policy({
    judgement: judgement({ action: AX_ID, confidence: THRESHOLDS.execute - 0.1 }),
    offered: AX_OFFERED,
    spec: axSpec({ effect: "navigate" }),
  });
  assert.equal(r.kind, "ask");
  assert.match(r.reasons.join(""), /置信度/);
});

test("policy: 硬闸优先于置信度——AX 的写档即便置信度极低也仍是确认，不被降级成追问", () => {
  const r = policy({
    judgement: judgement({ action: AX_ID, confidence: 0.01, complete: 0.01 }),
    offered: AX_OFFERED,
    spec: axSpec({ effect: "change" }),
  });
  assert.equal(r.kind, "confirm", "confirm 要人确认，ask 不要，降级等于放松");
});

test("policy: 两个现存脚本动作的 effect 换了词表之后行为逐字不变", () => {
  // make-tab 的模板 effect 是 navigate、Notes 的是 create→draft，两条都仍然自动执行
  const tab = policy({
    judgement: judgement({ action: TAB }),
    ...tabOk,
    profile: { kind: "allowed", dir: "Default", via: "settings" },
  });
  assert.equal(tab.kind, "execute");

  const note = policy({ judgement: judgement({ action: NOTE }), ...ok });
  assert.equal(note.kind, "execute");
});

// ── freshness：挂起与恢复之间那段时间 ──
// 这几条判据和上面四道闸装在同一条路径上（policy 拦成 confirm → 挂起 → 恢复前再查这里），
// 所以除了「变了就拦得住」，还要压住「不该管的别管」和「一点没变时真的放行」。

const AT = "2026-09-20T00:00:00.000Z";

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    at: AT,
    front: "Google Chrome",
    window: "example.com — 某个标签页",
    windowView: { kind: "window", title: "example.com — 某个标签页" },
    running: ["Google Chrome"],
    elements: [],
    selection: null,
    ...over,
  };
}

const UNKNOWN_7: ProfileGate = { kind: "unknown", dir: "Profile 7" };

test("freshness: 一点没变就放行——阳性对照，否则下面几条「拦住了」什么都不说明", () => {
  const mark = freshnessMark(snap(), UNKNOWN_7);
  assert.deepEqual(staleness({ mark, now: freshnessMark(snap(), UNKNOWN_7), app: "Google Chrome" }), []);
  // 而且这份指纹确实取到了东西，不是三个 undefined 互相相等
  assert.equal(mark.front, "Google Chrome");
  assert.equal(mark.profile, "unknown:Profile 7");
});

test("freshness: 前台应用、窗口标题、profile 各自都拦得住", () => {
  const mark = freshnessMark(snap(), UNKNOWN_7);
  const cases: [string, Snapshot, ProfileGate, string][] = [
    ["front", snap({ front: "Notes" }), UNKNOWN_7, "front"],
    ["window", snap({ window: "换了个标签页" }), UNKNOWN_7, "window"],
    ["window 关掉了", snap({ window: null }), UNKNOWN_7, "window"],
    ["profile", snap(), { kind: "unknown", dir: "Profile 9" }, "profile"],
    ["探测不到了", snap(), { kind: "undetectable", detail: "读不到 Local State" }, "profile"],
  ];
  for (const [name, now, gate, field] of cases) {
    const hit = staleness({ mark, now: freshnessMark(now, gate), app: "Google Chrome" });
    assert.deepEqual(hit.map((h) => h.field), [field], name);
  }
});

test("freshness: unknown 与 allowed 是两回事——目录名相同也算变了", () => {
  // 挂起时人批准的是「在一个不在名单里的 profile 上做这件事」。名单中途被改了，
  // 那就不再是他批准的那件事了。宁可再问一次
  const mark = freshnessMark(snap(), UNKNOWN_7);
  const now = freshnessMark(snap(), { kind: "allowed", dir: "Profile 7", via: "settings" });
  assert.deepEqual(staleness({ mark, now, app: "Google Chrome" }).map((h) => h.field), ["profile"]);
});

test("freshness: profile 判据只管 Chrome，不越界到 Notes", () => {
  const mark = freshnessMark(snap(), UNKNOWN_7);
  const now = freshnessMark(snap(), { kind: "unknown", dir: "Profile 9" });
  assert.deepEqual(staleness({ mark, now, app: "Notes" }), [], "profile 是 Chrome 独有的概念");
  // 不越界不等于放水：同一次漂移在 Chrome 上照样拦
  assert.equal(staleness({ mark, now, app: "Google Chrome" }).length, 1);
});

test("freshness: 不知道是哪个应用时，profile 判据照样适用——缺省即保守", () => {
  const mark = freshnessMark(snap(), UNKNOWN_7);
  const now = freshnessMark(snap(), { kind: "unknown", dir: "Profile 9" });
  assert.deepEqual(staleness({ mark, now }).map((h) => h.field), ["profile"]);
});

test("freshness: 变了好几项就逐项说清楚，不是一句「变了」", () => {
  const mark = freshnessMark(snap(), UNKNOWN_7);
  const now = freshnessMark(snap({ front: "Notes", window: null }), { kind: "undetectable", detail: "x" });
  const hit = staleness({ mark, now });
  assert.deepEqual(hit.map((h) => h.field), ["front", "window", "profile"]);
  for (const h of hit) assert.ok(h.detail.length > 0, h.field);
});

test("freshness: undetectable 的 detail 变了不算世界变了——它是给人看的一句话", () => {
  const mark = freshnessMark(snap(), { kind: "undetectable", detail: "读不到 Local State" });
  const now = freshnessMark(snap(), { kind: "undetectable", detail: "Preferences 也读不到" });
  assert.deepEqual(staleness({ mark, now }), []);
});
