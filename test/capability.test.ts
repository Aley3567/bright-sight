import test from "node:test";
import assert from "node:assert/strict";
import { ADAPTERS, axAdapter, planOf, runAction, scriptAdapter, type Resolved } from "../src/capability.ts";
import { ARTIFACT_PREFIX, SPAN_SOURCE, resolveArgs, type ArgsResolved, type ExecContext } from "../src/execute.ts";
import type { AxActionOffer, AxPeer } from "../src/ax.ts";
import { REGISTRY } from "../src/scripts.ts";
import { SEARCH_ENGINES } from "../src/config.ts";
import type { Artifact } from "../src/types.ts";

const TAB = "Google Chrome.make-tab";
const NOTE = "Notes.make-note";

function ctx(over: Partial<ExecContext> = {}): ExecContext {
  return { span: null, bodySource: null, artifacts: [], ...over };
}

function artifact(key: string, value: string): Artifact {
  return { key, value, from: { step: 1, actionId: TAB, field: "url" } };
}

/** 只取两个函数真正共享的字段，断言报错时能直接看出是哪一项不同。 */
function shared(r: Resolved | ArgsResolved): { ok: boolean; argv?: string[]; errors?: string[] } {
  if (!r.ok) return { ok: false, errors: r.errors };
  // AX 分支没有 argv（它不发 Apple Event）。本用例只喂脚本动作，真出现 ax 就把 argv 缺失暴露出来
  if ("kind" in r && r.kind === "ax") return { ok: true };
  return { ok: true, argv: r.argv };
}

/**
 * 6 组以上上下文：span 为空 / span 是合法网址 / span 是查询词 /
 * bodySource 为 span / bodySource 为 artifact:<key> / bodySource 非法。
 *
 * 判据是「搬家没改行为」：planOf 与 resolveArgs 的输出必须逐字段相等。
 */
const CASES: Array<{ name: string; id: string; ctx: ExecContext }> = [
  { name: "span 为空", id: TAB, ctx: ctx({ span: null }) },
  { name: "span 是合法网址", id: TAB, ctx: ctx({ span: "https://example.com/a?b=1" }) },
  { name: "span 是查询词", id: TAB, ctx: ctx({ span: "TypeScript erasableSyntaxOnly", engine: SEARCH_ENGINES.google }) },
  { name: "bodySource 为 span", id: NOTE, ctx: ctx({ span: "开会要点", bodySource: SPAN_SOURCE }) },
  {
    name: "bodySource 为 artifact:<key>",
    id: NOTE,
    ctx: ctx({ span: "标题", bodySource: `${ARTIFACT_PREFIX}chrome.active_url`, artifacts: [artifact("chrome.active_url", "https://example.com/")] }),
  },
  { name: "bodySource 为 artifact 但还没产出值", id: NOTE, ctx: ctx({ span: "标题", bodySource: `${ARTIFACT_PREFIX}chrome.active_url` }) },
  { name: "bodySource 非法", id: NOTE, ctx: ctx({ span: "标题", bodySource: "随便写的" }) },
];

test("capability: planOf 与 resolveArgs 在 6 组以上上下文下逐字段相等（搬家没改行为）", () => {
  assert.ok(CASES.length >= 6, "至少 6 组上下文");
  for (const c of CASES) {
    const viaPlan = planOf(c.id, c.ctx);
    const viaResolve = resolveArgs(REGISTRY[c.id], c.ctx);
    assert.deepEqual(shared(viaPlan), shared(viaResolve), `上下文「${c.name}」下 planOf 与 resolveArgs 不一致`);
    // 成功时还必须是脚本分支，并原样带上模板——perform 要靠它投递，缺了这一步后面的调用全落空
    if (viaPlan.ok) {
      assert.equal(viaPlan.kind, "script", `上下文「${c.name}」下 kind 应为 script`);
      assert.ok(
        viaPlan.kind === "script" && viaPlan.template === REGISTRY[c.id],
        `上下文「${c.name}」下模板应原样来自注册表`,
      );
    }
  }
});

// ── 分派的边界：拦得住 / 不越界 / 优先级 ─────────────────────────────────────

test("capability: 拦得住——不在冻结注册表里的 id 在 planOf 与 runAction 两处都失败", async () => {
  // Chrome 的 execute（执行任意 JavaScript）正是被注册表结构性排除的那种动作
  assert.equal(scriptAdapter.owns("Google Chrome.execute"), false);
  const planned = planOf("Google Chrome.execute", ctx({ span: "alert(1)" }));
  assert.equal(planned.ok, false);
  assert.ok(!planned.ok && planned.errors.join("").includes("不在执行模板注册表"));
  // dry-run 也不该为它拼出任何 argv，更不该走到投递
  const ran = await runAction("Google Chrome.execute", ctx({ span: "alert(1)" }), { step: 1, dryRun: true });
  assert.equal(ran.result.ok, false);
  assert.deepEqual(ran.result.argv, []);
  assert.deepEqual(ran.rawArgv, []);
});

test("capability: 不越界——注册表里的动作被认领，任务层动作不落入脚本适配器", () => {
  assert.equal(scriptAdapter.owns(TAB), true);
  assert.equal(scriptAdapter.owns(NOTE), true);
  // 任务层动作不对应任何应用命令，脚本适配器不该把 ASK 之类当成自己的动作
  assert.equal(scriptAdapter.owns("ASK"), false);
  assert.equal(planOf("ASK", ctx()).ok, false);
});

test("capability: 优先级——ADAPTERS 顺序即语义，脚本在前 AX 在后，先认领者胜", () => {
  assert.equal(ADAPTERS[0], scriptAdapter);
  assert.equal(ADAPTERS[1], axAdapter);
  // 顺序不是随便写的：脚本是冻结的精确匹配，AX 依赖本轮的 frame，必须排在脚本之后。
  // 只断言每一支单独能命中不够——顺序反了会让 AX 抢走脚本 id，这条钉住顺序本身。
  assert.deepEqual(ADAPTERS.map((a) => a.kind), ["script", "ax"]);
});

// ── AX 适配器：认领看这一轮的 frame，执行走 performAX，argv 恒为空 ─────────────

const AX_ID = "01924f4c-0000-7000-8000-000000000abc";

/** 一个 CLICK 的 offer。frame / offer 都是 Swift 现铸的，这里手搓只为了零 IO。 */
function axOffer(id: string, operation = "CLICK"): AxActionOffer {
  return {
    id,
    operation: operation as AxActionOffer["operation"],
    target: { ref: "opaque-ref", role: "AXButton", label: "继续", state: { enabled: true, editable: false } },
    effect: "change",
    risk: "caution",
  };
}

function axCtx(offers: AxActionOffer[], frameId = "frame-1", peer?: AxPeer, app = "Finder"): ExecContext {
  return ctx({ ax: { peer: peer ?? peerCalling(), frameId, offers, app } });
}

function peerCalling(seen: Array<{ method: string; params: unknown }> = []): AxPeer {
  return {
    call: async <T>(method: string, params?: unknown): Promise<T> => {
      seen.push({ method, params });
      return { status: "executed", artifacts: [], verify: { ok: true, detail: "ok" } } as T;
    },
  };
}

test("capability: axAdapter 只认领本 frame 的 offer，缺 ctx.ax 一律不认领（fail-closed）", () => {
  const withAx = axCtx([axOffer(AX_ID)]);
  assert.equal(axAdapter.owns(AX_ID, withAx), true);
  // 同一个 id，没有 ctx.ax 时不认领——「忘了接线」的后果必须是「没有执行路径」
  assert.equal(axAdapter.owns(AX_ID, ctx()), false);
  // 不在本 frame 里的 id 不认领
  assert.equal(axAdapter.owns("另一个-offer", withAx), false);
  // 不越界：脚本 id 不是 AX 的事，AX 也不认领任务层动作
  assert.equal(axAdapter.owns(TAB, withAx), false);
  assert.equal(axAdapter.owns("ASK", withAx), false);
});

test("capability: planOf 在给定 frame 下把 AX offer 解析成 ax 分支", () => {
  const r = planOf(AX_ID, axCtx([axOffer(AX_ID)]));
  assert.ok(r.ok);
  assert.equal(r.kind, "ax");
  assert.equal(r.kind === "ax" && r.frameId, "frame-1");
  assert.equal(r.kind === "ax" && r.offerId, AX_ID);
  assert.equal(r.kind === "ax" && r.operation, "CLICK");
});

test("capability: axAdapter.perform 发的是 ax.perform，不是脚本；argv 恒为 []", async () => {
  const seen: Array<{ method: string; params: unknown }> = [];
  const out = await runAction(AX_ID, axCtx([axOffer(AX_ID)], "frame-1", peerCalling(seen)), { step: 3 });
  assert.equal(out.result.ok, true);
  assert.deepEqual(out.result.argv, [], "AX 动作没有 argv，不许编一个");
  assert.deepEqual(out.rawArgv, []);
  assert.equal(out.result.ax?.status, "executed");
  assert.deepEqual(seen, [{ method: "ax.perform", params: { frameId: "frame-1", offerId: AX_ID, operation: "CLICK" } }]);
});

test("capability: TYPE_TEXT 切不出文本时收手（stop），不编空串顶替也不当失败", async () => {
  const seen: Array<{ method: string; params: unknown }> = [];
  const out = await runAction(AX_ID, axCtx([axOffer(AX_ID, "TYPE_TEXT")], "frame-1", peerCalling(seen)), { step: 1 });
  assert.equal(out.result.ok, false);
  assert.deepEqual(seen, [], "解析都没过，绝不该发出任何调用");
  // 缺输入不是失败：走到这里必须是 stop，而不是一个普通的 ok:false——
  // 后者会让 loop 当成「这条路走不通」，消耗恢复预算去重试
  assert.equal(out.stop, "needs_more_input");
});

// ── 5.6 切片路径：TYPE_TEXT 的 value 只从 span / artifact 取 ───────────────────
//
// 三条一起钉住：span 有值时逐字进 value（顺风）、切不出值时收手（拦得住 + 零调用）、
// 非 TYPE_TEXT 的动作不碰这条路径（不越界）。只测第一条的话，「判据装错了位置、
// 把不该管的也管了」这类缺陷会全绿通过。

const TEXT_ID = "01924f4c-0000-7000-8000-000000000def";

/** 一个可编辑文本框的 TYPE_TEXT offer：role 与 editable 都与真实工厂一致。 */
function textOffer(id: string): AxActionOffer {
  return {
    id,
    operation: "TYPE_TEXT",
    target: { ref: "opaque-ref", role: "AXTextField", label: "内容", state: { enabled: true, editable: true } },
    effect: "draft",
    risk: "safe",
  };
}

test("5.6: span 有值时逐字进入 ax.perform 的 value", async () => {
  const seen: Array<{ method: string; params: unknown }> = [];
  const base = axCtx([textOffer(TEXT_ID)], "frame-7", peerCalling(seen));
  const out = await runAction(TEXT_ID, { ...base, span: "开会要点", bodySource: SPAN_SOURCE }, { step: 1 });
  assert.equal(out.result.ok, true);
  assert.equal(out.stop, undefined, "切得出值就不该收手");
  assert.deepEqual(seen, [
    { method: "ax.perform", params: { frameId: "frame-7", offerId: TEXT_ID, operation: "TYPE_TEXT", value: "开会要点" } },
  ]);
});

test("5.6: 文本来源是上一步产物时按 artifact:<key> 取，值逐字来自回读", async () => {
  const seen: Array<{ method: string; params: unknown }> = [];
  const base = axCtx([textOffer(TEXT_ID)], "frame-7", peerCalling(seen));
  const out = await runAction(
    TEXT_ID,
    { ...base, bodySource: `${ARTIFACT_PREFIX}chrome.active_url`, artifacts: [artifact("chrome.active_url", "https://example.com/?q=a&b=1")] },
    { step: 2 },
  );
  assert.equal(out.result.ok, true);
  const params = seen[0]?.params as { value?: string } | undefined;
  assert.equal(params?.value, "https://example.com/?q=a&b=1", "值原样来自产物，不加工");
});

test("5.6: 来源以 bodySource 为准——artifact 与 span 同时存在时不越过 bodySource 取 span", async () => {
  // 优先级判据：取值来源只有一个决定者。若实现顺手用了 ctx.span，这条会拿到「开会要点」
  const seen: Array<{ method: string; params: unknown }> = [];
  const base = axCtx([textOffer(TEXT_ID)], "frame-7", peerCalling(seen));
  const out = await runAction(
    TEXT_ID,
    { ...base, span: "开会要点", bodySource: `${ARTIFACT_PREFIX}chrome.active_url`, artifacts: [artifact("chrome.active_url", "https://example.com/")] },
    { step: 2 },
  );
  assert.equal(out.result.ok, true);
  const params = seen[0]?.params as { value?: string } | undefined;
  assert.equal(params?.value, "https://example.com/");
});

test("5.6: 认不出的文本来源收手，不静默回退到 span", async () => {
  const seen: Array<{ method: string; params: unknown }> = [];
  const base = axCtx([textOffer(TEXT_ID)], "frame-7", peerCalling(seen));
  const out = await runAction(TEXT_ID, { ...base, span: "开会要点", bodySource: "随便写的" }, { step: 1 });
  assert.equal(out.stop, "needs_more_input");
  assert.match(out.result.ok === false ? out.result.errors.join("") : "", /无法识别的文本来源/);
  assert.deepEqual(seen, [], "来源认不出就收手，不顺手续着一个别的值");
});

test("5.6: 产物还没有产出值时收手，不拿空串顶上", async () => {
  const seen: Array<{ method: string; params: unknown }> = [];
  const base = axCtx([textOffer(TEXT_ID)], "frame-7", peerCalling(seen));
  const out = await runAction(TEXT_ID, { ...base, bodySource: `${ARTIFACT_PREFIX}chrome.active_url`, artifacts: [] }, { step: 1 });
  assert.equal(out.stop, "needs_more_input");
  assert.deepEqual(seen, []);
});

test("5.6: 不越界——非 TYPE_TEXT 的动作即便带着文本来源也不进 value", async () => {
  const seen: Array<{ method: string; params: unknown }> = [];
  const base = axCtx([axOffer(AX_ID)], "frame-1", peerCalling(seen));
  const out = await runAction(AX_ID, { ...base, span: "开会要点", bodySource: SPAN_SOURCE }, { step: 1 });
  assert.equal(out.result.ok, true);
  assert.deepEqual(seen, [{ method: "ax.perform", params: { frameId: "frame-1", offerId: AX_ID, operation: "CLICK" } }]);
});

// ── runAction 是唯一一条投递路径，与 execute() 同一行为 ──────────────────────

test("capability: runAction 的 dry-run 解析出完整 argv 但不产出任何产物", async () => {
  const out = await runAction(TAB, ctx({ span: "TypeScript" }), { step: 2, dryRun: true });
  assert.ok(out.result.ok);
  assert.equal(out.result.argv.length, 1);
  assert.deepEqual(out.artifacts, [], "没执行就没有回读，产物必须是空的");
});

test("capability: runAction 的失败理由与 planOf 同源，解析失败就不该有 argv", async () => {
  const bad = ctx({ span: "标题", bodySource: "随便写的" });
  const planned = planOf(NOTE, bad);
  const ran = await runAction(NOTE, bad, { step: 7, dryRun: true });
  assert.equal(planned.ok, false);
  assert.equal(ran.result.ok, false);
  assert.deepEqual(ran.result.errors, planned.ok === false ? planned.errors : []);
  assert.deepEqual(ran.result.argv, [], "解析失败就没有 argv");
});
