import test from "node:test";
import assert from "node:assert/strict";
import { offersFrom, type AxFrameView } from "../src/surface.ts";
import { capabilityEffectOf } from "../src/scripts.ts";
import type { Surface } from "../src/actions.ts";
import type { AxActionOffer } from "../src/ax.ts";
import type { ScriptActionSpec } from "../src/types.ts";

/**
 * 动作面合并：脚本动作 × AX offers × 任务层动作。
 *
 * 这个文件此前不存在，`offersFrom` 因此一直没有直接测试覆盖——`test/loop.test.ts`
 * 用手搓的假选项集绕开了它（那是刻意的，循环测试要零 IO），于是「合并两类动作面」
 * 这一步没有任何对照物。所以下面第一件事是把**改造前的输出抄成期望值**：
 * 没有这份基准，「不传 axFrame 时逐字段相等」这条判据改了也看不出来。
 */

const TAB = "Google Chrome.make-tab";
const NOTE = "Notes.make-note";
const AX_ID = "01924f4c-0000-7000-8000-000000000abc";

function scriptSpec(over: Partial<ScriptActionSpec> & { id: string; app: string }): ScriptActionSpec {
  return { summary: over.id, kind: "script", params: [], risk: "safe", effect: "read", ...over };
}

/**
 * 一份固定的动作面：两条可执行（在冻结注册表里且白名单内）、
 * 一条注册表外的脚本动作、一条白名单外的应用动作。
 * 后两条是用来做阳性对照的——收窄确实发生了，不是因为动作面本来就空。
 */
const SURFACE: Surface = {
  actions: [
    scriptSpec({
      id: TAB,
      app: "Google Chrome",
      summary: "打开一个新标签页",
      params: [{ name: "url", type: "text", optional: false }],
      risk: "safe",
      // sdef 侧的初判（make → draft）故意写成一个会被覆盖的值，
      // 让「effect 以冻结模板为准」这条判据真的能被这条测试看见
      effect: "draft",
    }),
    scriptSpec({
      id: NOTE,
      app: "Notes",
      summary: "在 Notes 里新建一个 note：一条备忘录",
      params: [{ name: "name", type: "text", optional: true }, { name: "body", type: "text", optional: true }],
      risk: "safe",
      effect: "read",
    }),
    scriptSpec({ id: "Google Chrome.execute", app: "Google Chrome", summary: "执行任意 JavaScript" }),
    scriptSpec({ id: "Finder.delete", app: "Finder", summary: "删除", risk: "destructive" }),
  ],
  apps: ["Finder", "Google Chrome", "Notes"],
  scriptable: ["Google Chrome", "Notes"],
};

/** 任务层动作的固定文案，抄自改造前的输出。 */
const TASK_OFFERS = [
  { id: "ASK", summary: "信息不够，需要向用户追问" },
  { id: "WAIT", summary: "上一步还没生效，再等一下重新观察" },
  { id: "DONE", summary: "用户要求的事情已经全部做完了" },
  { id: "BLOCKED", summary: "做不下去了，需要人介入" },
  { id: "UNSUPPORTED", summary: "这件事当前系统不支持" },
];

// ── 钉现状：不传 axFrame 时，输出与引入 AX 之前逐字段相等 ──────────────────────

test("surface: 不传 axFrame 时输出与改造前逐字段相等", () => {
  const out = offersFrom(SURFACE);
  // 这段期望值是照着改造前的实测输出抄的，不是照着新代码反推的
  assert.deepEqual(out.offers, [
    { id: TAB, summary: "打开一个新标签页（参数：url）" },
    { id: NOTE, summary: "在 Notes 里新建一个 note：一条备忘录（参数：name、body）" },
    ...TASK_OFFERS,
  ]);
  assert.deepEqual(out.ids, [TAB, NOTE, "ASK", "WAIT", "DONE", "BLOCKED", "UNSUPPORTED"]);
  assert.equal(out.total, 4, "total 是全量动作面规模，不随收窄变化");
  assert.deepEqual(out.axSpecs, new Map(), "没有 frame 就没有 AX 动作面");
});

test("surface: 脚本 effect 到能力词表的映射是全覆盖的，同名项不变、只有 create 折成 draft", () => {
  // 逐条列出而不是断言「4 个键」，否则加了新词表却忘了补映射时这条测试照样全绿
  assert.deepEqual(
    (["create", "navigate", "read", "destroy"] as const).map(capabilityEffectOf),
    ["draft", "navigate", "read", "destroy"],
  );
});

test("surface: 脚本 spec 的 effect 以冻结模板为准，sdef 的初判被覆盖", () => {
  const out = offersFrom(SURFACE);
  assert.deepEqual(out.specs.get(TAB), {
    id: TAB,
    app: "Google Chrome",
    summary: "打开一个新标签页",
    kind: "script",
    params: [{ name: "url", type: "text", optional: false }],
    risk: "safe",
    effect: "navigate",
  });
  assert.deepEqual(out.specs.get(NOTE), {
    id: NOTE,
    app: "Notes",
    summary: "在 Notes 里新建一个 note：一条备忘录",
    kind: "script",
    params: [{ name: "name", type: "text", optional: true }, { name: "body", type: "text", optional: true }],
    risk: "safe",
    // Notes 的模板 effect 是 create，能力词表里是 draft
    effect: "draft",
  });
});

test("surface: 注册表外与白名单外的动作都不进选项集——阳性对照证明收窄真的发生了", () => {
  const out = offersFrom(SURFACE);
  assert.equal(out.specs.size, 2, "动作面里 4 条，收窄后只剩 2 条");
  assert.equal(out.specs.has("Google Chrome.execute"), false, "执行任意 JavaScript 从来不在选项集里");
  assert.equal(out.specs.has("Finder.delete"), false, "白名单外的应用不进选项集");
});

// ── 合并两类动作面：顺序即语义 ────────────────────────────────────────────────

function offer(over: Partial<AxActionOffer> & { id: string }): AxActionOffer {
  return {
    operation: "CLICK",
    target: { ref: "opaque-ref", role: "AXButton", label: "继续", state: { enabled: true, editable: false } },
    effect: "change",
    risk: "caution",
    ...over,
  };
}

function frame(offers: AxActionOffer[], over: Partial<AxFrameView> = {}): AxFrameView {
  return { frameId: "frame-1", pid: 4242, app: "Finder", offers, ...over };
}

test("surface: 同一条指令同时命中脚本动作与 AX 链接时，脚本在前、AX 在后、任务层最后", () => {
  const out = offersFrom(SURFACE, frame([offer({ id: AX_ID, operation: "OPEN", target: { ref: "r", role: "AXLink", label: "备忘录", state: { enabled: true, editable: false } }, effect: "navigate", risk: "safe" })]));

  assert.deepEqual(out.ids, [TAB, NOTE, AX_ID, "ASK", "WAIT", "DONE", "BLOCKED", "UNSUPPORTED"]);
  // 两类都真的在候选集里，所以上面那个顺序不是「只有脚本动作」的假象
  assert.equal(out.specs.has(TAB), true);
  assert.equal(out.axSpecs.has(AX_ID), true);
  const ax = out.axSpecs.get(AX_ID)!;
  assert.equal(ax.kind, "ax");
  assert.equal(ax.frameId, "frame-1");
  assert.equal(ax.operation, "OPEN");
  // app 取自本地快照（frame.app），不是远端 offer 里的任何东西
  assert.equal(ax.app, "Finder");
  assert.match(out.offers.find((o) => o.id === AX_ID)!.summary, /OPEN/);
  // operation 随 offer 一起进投影：judge 靠它折叠 action head、建 target head（阶段 5.4）
  assert.equal(out.offers.find((o) => o.id === AX_ID)!.operation, "OPEN");
  assert.equal(out.offers.find((o) => o.id === TAB)!.operation, undefined, "脚本动作没有 operation 这一维");
});

test("surface: AX 的 effect/risk 自算后与远端标签取更严的一侧", () => {
  const out = offersFrom(
    SURFACE,
    frame([
      // CLICK/AXButton 自算是 change/caution；远端谎报 read/safe，取更严
      offer({ id: AX_ID, effect: "read", risk: "safe" }),
      // TYPE_TEXT/AXTextField 自算是 draft/safe；远端报得比自算更严，同样取更严
      offer({
        id: "ax-type",
        operation: "TYPE_TEXT",
        effect: "submit",
        risk: "destructive",
        target: { ref: "r", role: "AXTextField", label: "搜索", state: { enabled: true, editable: true } },
      }),
    ]),
  );
  assert.equal(out.axSpecs.get(AX_ID)!.effect, "change");
  assert.equal(out.axSpecs.get(AX_ID)!.risk, "caution");
  assert.equal(out.axSpecs.get("ax-type")!.effect, "submit");
  assert.equal(out.axSpecs.get("ax-type")!.risk, "destructive");
});

test("surface: AX offerId 与脚本 id 撞车时脚本先认领，AX 那一条不进选项集", () => {
  // 顺序不是随便写的：脚本是冻结的精确匹配，AX 依赖本轮的 frame，必须先认领
  const out = offersFrom(SURFACE, frame([offer({ id: TAB })]));
  assert.equal(out.specs.has(TAB), true);
  assert.equal(out.axSpecs.has(TAB), false);
  assert.equal(out.ids.filter((id) => id === TAB).length, 1, "一个 id 不能同时以两种执行路径出现");
});

// ── 同名目标的区分文字 ────────────────────────────────────────────────────────
//
// 区分文字落在 summary 而不是 state 里：summary 就是模型那道单选题里每个选项的说明文字
// （官方文档所说的 criteria）。要把两个选项分开，描述得挂在选项上，不是堆在题干里。

test("surface: 撞名目标的区分文字进选项说明，模型看到的两条不再一模一样", () => {
  const a = "ax-dup-a";
  const b = "ax-dup-b";
  const out = offersFrom(
    SURFACE,
    frame([
      offer({ id: a, target: { ref: "r1", role: "AXButton", label: "删除", state: { enabled: true, editable: false }, context: "草稿 未命名 删除" } }),
      offer({ id: b, target: { ref: "r2", role: "AXButton", label: "删除", state: { enabled: true, editable: false }, context: "垃圾箱 3 个项目 删除" } }),
    ]),
  );

  const summaries = out.offers.filter((o) => o.id === a || o.id === b).map((o) => o.summary);
  assert.equal(summaries.length, 2);
  assert.notEqual(summaries[0], summaries[1], "两条同名 offer 的说明文字必须不同，否则模型无从选起");
  assert.equal(summaries[0], "AX CLICK：删除（草稿 未命名 删除）");
  assert.equal(summaries[1], "AX CLICK：删除（垃圾箱 3 个项目 删除）");
});

test("surface: 不撞名的目标说明一字不变——与引入区分文字之前逐字相等", () => {
  const id = "ax-unique";
  const out = offersFrom(SURFACE, frame([offer({ id })]));

  // 没有 context 的那条不能被顺手加上一对空括号：唯一选项不需要任何额外描述，
  // 而「加了个空壳」正是「大量不相关状态」这条失败模式的最小形态。
  assert.equal(out.offers.find((o) => o.id === id)?.summary, "AX CLICK：继续");
});

test("surface: 区分文字只剩空白时按没有处理，不产生一对空括号", () => {
  const id = "ax-blank";
  const out = offersFrom(
    SURFACE,
    frame([offer({ id, target: { ref: "r", role: "AXButton", label: "继续", state: { enabled: true, editable: false }, context: "   " } })]),
  );

  assert.equal(out.offers.find((o) => o.id === id)?.summary, "AX CLICK：继续");
});
