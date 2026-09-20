import test from "node:test";
import assert from "node:assert/strict";
import { probeIdFor, verify, type Probe, type ProbeRunner } from "../src/verify.ts";
import { SEARCH_ENGINES } from "../src/config.ts";
import type { AxExecFact, ExecResult } from "../src/types.ts";

const TAB = "Google Chrome.make-tab";
const SENT = "https://www.google.com/search?q=TypeScript";
const TID = "1734";

function ok(readback: Record<string, string>): ExecResult {
  return { ok: true, readback, argv: [SENT], ms: 1 };
}

/**
 * 假的定向回读。
 *
 * 在它出现之前，这套测试只能靠「故意不给 id」绕开真实的 Apple Event，
 * 于是「回读到了但内容不对」——最该被测的那条路径——反而一条都没覆盖。
 */
function probes(table: Record<string, Probe | null>): ProbeRunner {
  return (id) => Promise.resolve(table[id] ?? null);
}

/** 标签页还在、URL 就是发出去的那个。 */
const FOUND: Probe = { tab_id: TID, found: "yes", url: SENT, title: "TypeScript - Google 搜索", loading: "no" };

function names(checks: { name: string; ok: boolean }[]): Record<string, boolean> {
  return Object.fromEntries(checks.map((c) => [c.name, c.ok]));
}

test("verify: 执行失败时直接判负，不再往下做任何检查", async () => {
  const r = await verify({
    actionId: TAB,
    exec: { ok: false, errors: ["超时"], argv: [], ms: 1 },
    rawArgv: [],
    pre: null,
    post: null,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.checks.map((c) => c.name), ["exit_ok"]);
});

test("verify: 多了一个标签页且落点 origin 不变，判定通过", async () => {
  const r = await verify({
    actionId: TAB,
    exec: ok({ tab_id: TID, url: SENT, title: "TypeScript - Google 搜索" }),
    rawArgv: [SENT],
    pre: { windows: "1", tabs: "3" },
    post: { windows: "1", tabs: "4" },
    engine: SEARCH_ENGINES.google,
    probe: probes({ "probe.chrome-tab": FOUND }),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(names(r.checks), {
    exit_ok: true,
    tab_appeared: true,
    tab_id_readback: true,
    url_origin_match: true,
  });
});

test("verify: 应用在运行却零窗口时，从无窗口变有窗口也算标签页出现了", async () => {
  // 实测状态：Chrome 进程在跑，count of windows 返回 0
  const r = await verify({
    actionId: TAB,
    exec: ok({ tab_id: TID, url: SENT }),
    rawArgv: [SENT],
    pre: { windows: "0", tabs: "0" },
    post: { windows: "1", tabs: "1" },
    engine: SEARCH_ENGINES.google,
    probe: probes({ "probe.chrome-tab": { ...FOUND, url: "" } }),
  });
  assert.equal(names(r.checks).tab_appeared, true);
});

test("verify: 标签页数没变也没新开窗口时判负", async () => {
  const r = await verify({
    actionId: TAB,
    exec: ok({ tab_id: TID, url: SENT }),
    rawArgv: [SENT],
    pre: { windows: "1", tabs: "3" },
    post: { windows: "1", tabs: "3" },
    engine: SEARCH_ENGINES.google,
    probe: probes({ "probe.chrome-tab": { ...FOUND, url: "" } }),
  });
  assert.equal(r.ok, false);
  assert.equal(names(r.checks).tab_appeared, false);
});

test("verify: 被送去了别的 origin 就判负——反爬验证码页会让加载看起来成功", async () => {
  // 实测：百度把请求重定向到 wappass.baidu.com 的验证码页，loading 一样会变 false
  const r = await verify({
    actionId: TAB,
    exec: ok({ tab_id: TID, url: "https://wappass.baidu.com/static/captcha/tuxing_v2.html" }),
    rawArgv: ["https://www.baidu.com/s?wd=TypeScript"],
    pre: { windows: "1", tabs: "1" },
    post: { windows: "1", tabs: "2" },
    engine: SEARCH_ENGINES.google,
    probe: probes({ "probe.chrome-tab": { ...FOUND, url: "" } }),
  });
  assert.equal(r.ok, false);
  assert.equal(names(r.checks).url_origin_match, false);
});

test("verify: 搜索参数被重写但 origin 不变时仍然通过", async () => {
  // 实测 Google 会往 URL 上追加 &sei=... ——所以判据是 origin 而不是相等
  const r = await verify({
    actionId: TAB,
    exec: ok({ tab_id: TID, url: `${SENT}&sei=oUSvatTiabc` }),
    rawArgv: [SENT],
    pre: { windows: "1", tabs: "1" },
    post: { windows: "1", tabs: "2" },
    engine: SEARCH_ENGINES.google,
    probe: probes({ "probe.chrome-tab": { ...FOUND, url: "" } }),
  });
  assert.equal(names(r.checks).url_origin_match, true);
});

test("verify: 引擎声明了会跳转到哪些 origin 时，跳过去也算通过", async () => {
  const r = await verify({
    actionId: TAB,
    exec: ok({ tab_id: TID, url: "https://cn.bing.com/search?q=TypeScript" }),
    rawArgv: ["https://www.bing.com/search?q=TypeScript"],
    pre: { windows: "1", tabs: "1" },
    post: { windows: "1", tabs: "2" },
    engine: SEARCH_ENGINES.bing,
    probe: probes({ "probe.chrome-tab": { ...FOUND, url: "" } }),
  });
  assert.equal(names(r.checks).url_origin_match, true);
});

test("verify: 标签页被关掉时判负——脚本返回成功不等于对象还在", async () => {
  const r = await verify({
    actionId: TAB,
    exec: ok({ tab_id: TID, url: SENT }),
    rawArgv: [SENT],
    pre: { windows: "1", tabs: "1" },
    post: { windows: "1", tabs: "2" },
    engine: SEARCH_ENGINES.google,
    probe: probes({ "probe.chrome-tab": { tab_id: TID, found: "no", url: "", title: "", loading: "no" } }),
  });
  assert.equal(r.ok, false);
  assert.equal(names(r.checks).tab_id_readback, false);
});

test("verify: 脚本没回读到 tab id 时判负，不因为拿不到就跳过", async () => {
  const r = await verify({
    actionId: TAB,
    exec: ok({ url: SENT }),
    rawArgv: [SENT],
    pre: { windows: "1", tabs: "1" },
    post: { windows: "1", tabs: "2" },
    engine: SEARCH_ENGINES.google,
    probe: probes({}),
  });
  assert.equal(names(r.checks).tab_id_readback, false, "查不了不等于查过了");
});

test("verify: origin 判据以定向回读为准——跳转可能在脚本返回之后才完成", async () => {
  // 脚本返回时还停在发出去的地址上，等按 id 回读时已经被送去了验证码页。
  // 只看脚本返回值的话，这次失败会被判成成功。
  const r = await verify({
    actionId: TAB,
    exec: ok({ tab_id: TID, url: "https://www.baidu.com/s?wd=TypeScript" }),
    rawArgv: ["https://www.baidu.com/s?wd=TypeScript"],
    pre: { windows: "1", tabs: "1" },
    post: { windows: "1", tabs: "2" },
    engine: SEARCH_ENGINES.google,
    probe: probes({
      "probe.chrome-tab": { ...FOUND, url: "https://wappass.baidu.com/static/captcha/tuxing_v2.html" },
    }),
  });
  assert.equal(names(r.checks).tab_id_readback, true);
  assert.equal(names(r.checks).url_origin_match, false, "定向回读比脚本返回值晚，以它为准");
});

test("verify: 标签页落在别的窗口也算出现了——tabs 是全部窗口的总数", async () => {
  // window 1 不一定是我们写入的那个窗口：profile 一换，新窗口就排在后面。
  // 只数 window 1 的话，这次完全正常的执行会被判失败。
  const r = await verify({
    actionId: TAB,
    exec: ok({ tab_id: TID, url: SENT }),
    rawArgv: [SENT],
    pre: { windows: "2", tabs: "9" },
    post: { windows: "3", tabs: "10" },
    engine: SEARCH_ENGINES.google,
    probe: probes({ "probe.chrome-tab": FOUND }),
  });
  assert.equal(r.ok, true);
  assert.equal(names(r.checks).tab_appeared, true);
});

test("verify: 定向回读按笔记 id 走，回读不到内容时判负", async () => {
  const r = await verify({
    actionId: "Notes.make-note",
    exec: ok({ count: "9", folder: "备忘录", account: "iCloud", id: "x-coredata://n/p38" }),
    rawArgv: ["标题", "正文"],
    pre: { count: "8" },
    post: { count: "9" },
    probe: probes({
      "probe.notes-note": { id: "x-coredata://n/p38", name: "标题", folder: "备忘录", account: "iCloud", contains: "no", len: "0" },
    }),
  });
  assert.equal(names(r.checks).body_contains_payload, false);
  assert.equal(names(r.checks).container_readback, true);
});

test("verify: 回读缺少笔记 id 时如实判负，而不是跳过这条检查", async () => {
  const r = await verify({
    actionId: "Notes.make-note",
    exec: ok({ count: "9", folder: "Notes", account: "iCloud" }),
    rawArgv: ["标题", "正文"],
    pre: { count: "8" },
    post: { count: "9" },
  });
  assert.equal(r.ok, false);
  assert.equal(names(r.checks).body_contains_payload, false, "查不了不等于查过了");
});

test("verify: 笔记数没有恰好加一时判负", async () => {
  const r = await verify({
    actionId: "Notes.make-note",
    exec: ok({ count: "8", folder: "Notes", account: "iCloud" }),
    rawArgv: ["标题", "正文"],
    pre: { count: "8" },
    post: { count: "8" },
  });
  assert.equal(names(r.checks).note_delta, false);
});

test("verify: 回读不出容器时判负——本机存在两个同名 Notes 文件夹", async () => {
  const r = await verify({
    actionId: "Notes.make-note",
    exec: ok({ count: "9", folder: "", account: "" }),
    rawArgv: ["标题", "正文"],
    pre: { count: "8" },
    post: { count: "9" },
  });
  assert.equal(names(r.checks).container_match, false);
});

test("verify: 每个可执行动作都有配套的前后对照探针", () => {
  assert.equal(probeIdFor(TAB), "probe.chrome-counts");
  assert.equal(probeIdFor("Notes.make-note"), "probe.notes-count");
  assert.equal(probeIdFor("DONE"), null);
});

// ── AX 分支与未知动作判负 ─────────────────────────────────────────────────────
//
// AX 动作没有 argv、没有脚本回读、没有前后 diff，唯一的证据是 Swift 执行前后复验目标状态
// 得出的结论。下面逐条钉住四种 status 到 check 的映射，以及「认不出的动作不再默认通过」。

const AX_ID = "01924f4c-0000-7000-8000-000000000abc";

function axExec(status: AxExecFact["status"], verifyOk = status === "executed"): ExecResult {
  return { ok: true, readback: {}, argv: [], ms: 1, ax: { status, verify: { ok: verifyOk, detail: `Swift 复验：${status}` } } };
}

test("verify: AX 四条 status 逐条映射到 ax_target_state——只有 executed 且复验通过才算成功", async () => {
  const cases: Array<{ status: AxExecFact["status"]; expect: boolean }> = [
    { status: "executed", expect: true },
    { status: "rejected_stale", expect: false },
    { status: "failed", expect: false },
    // effect_unknown 尤其不能判成通过：它的语义是「副作用可能已经发生，禁止自动重试」
    { status: "effect_unknown", expect: false },
  ];
  for (const c of cases) {
    const r = await verify({ actionId: AX_ID, exec: axExec(c.status), rawArgv: [], pre: null, post: null });
    assert.deepEqual(r.checks.map((x) => x.name), ["exit_ok", "ax_target_state"], `status=${c.status}`);
    assert.equal(names(r.checks).ax_target_state, c.expect, `status=${c.status} 的映射`);
    assert.equal(r.ok, c.expect, `status=${c.status} 的整体结论`);
  }
});

test("verify: executed 但 Swift 复验没过同样判负——两半都成立才算成功", async () => {
  const r = await verify({ actionId: AX_ID, exec: axExec("executed", false), rawArgv: [], pre: null, post: null });
  assert.equal(names(r.checks).ax_target_state, false);
  assert.equal(r.ok, false);
});

test("verify: 未知 actionId 即使执行成功也判负，不再等于默认通过", async () => {
  const r = await verify({
    actionId: "SomeApp.do-something",
    exec: { ok: true, readback: {}, argv: [], ms: 1 },
    rawArgv: [],
    pre: null,
    post: null,
  });
  assert.equal(r.ok, false);
  assert.equal(names(r.checks).unknown_action, false);
});

test("verify: 已知动作不被未知判据误伤——脚本、AX、任务层动作三条都不产生 unknown_action", async () => {
  // 脚本：阳性对照，同一份 exec 换成 Notes.make-note 时走的是老判据
  const note = await verify({
    actionId: "Notes.make-note",
    exec: ok({ count: "9", folder: "Notes", account: "iCloud", id: "x" }),
    rawArgv: ["标题", "正文"],
    pre: { count: "8" },
    post: { count: "9" },
    probe: probes({ "probe.notes-note": { contains: "yes", len: "2", folder: "Notes", account: "iCloud" } }),
  });
  assert.equal("unknown_action" in names(note.checks), false, "已知脚本动作不该被判成未知");

  // AX：带 exec.ax 的动作走 AX 分支，也不该被判成未知
  const ax = await verify({ actionId: AX_ID, exec: axExec("executed"), rawArgv: [], pre: null, post: null });
  assert.equal("unknown_action" in names(ax.checks), false, "AX 动作由 exec.ax 认领，不该被判成未知");

  // 任务层动作：即使被直接送进 verify（正常路径到不了这里），也不该产生未知判负——
  // 「不误伤任务层动作」不靠「policy 恰好先分流了」这一个隐含前提
  const task = await verify({
    actionId: "ASK",
    exec: { ok: true, readback: {}, argv: [], ms: 1 },
    rawArgv: [],
    pre: null,
    post: null,
  });
  assert.equal("unknown_action" in names(task.checks), false, "任务层动作不是「未知动作」");
});
