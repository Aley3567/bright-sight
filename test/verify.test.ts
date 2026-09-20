import test from "node:test";
import assert from "node:assert/strict";
import { probeIdFor, verify } from "../src/verify.ts";
import { SEARCH_ENGINES } from "../src/config.ts";
import type { ExecResult } from "../src/types.ts";

const TAB = "Google Chrome.make-tab";
const SENT = "https://www.google.com/search?q=TypeScript";

function ok(readback: Record<string, string>): ExecResult {
  return { ok: true, readback, argv: [SENT], ms: 1 };
}

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
    exec: ok({ url: SENT, title: "TypeScript - Google 搜索" }),
    rawArgv: [SENT],
    pre: { windows: "1", tabs: "3" },
    post: { windows: "1", tabs: "4" },
    engine: SEARCH_ENGINES.google,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(names(r.checks), { exit_ok: true, tab_appeared: true, url_origin_match: true });
});

test("verify: 应用在运行却零窗口时，从无窗口变有窗口也算标签页出现了", async () => {
  // 实测状态：Chrome 进程在跑，count of windows 返回 0
  const r = await verify({
    actionId: TAB,
    exec: ok({ url: SENT }),
    rawArgv: [SENT],
    pre: { windows: "0", tabs: "0" },
    post: { windows: "1", tabs: "1" },
    engine: SEARCH_ENGINES.google,
  });
  assert.equal(names(r.checks).tab_appeared, true);
});

test("verify: 标签页数没变也没新开窗口时判负", async () => {
  const r = await verify({
    actionId: TAB,
    exec: ok({ url: SENT }),
    rawArgv: [SENT],
    pre: { windows: "1", tabs: "3" },
    post: { windows: "1", tabs: "3" },
    engine: SEARCH_ENGINES.google,
  });
  assert.equal(r.ok, false);
  assert.equal(names(r.checks).tab_appeared, false);
});

test("verify: 被送去了别的 origin 就判负——反爬验证码页会让加载看起来成功", async () => {
  // 实测：百度把请求重定向到 wappass.baidu.com 的验证码页，loading 一样会变 false
  const r = await verify({
    actionId: TAB,
    exec: ok({ url: "https://wappass.baidu.com/static/captcha/tuxing_v2.html" }),
    rawArgv: ["https://www.baidu.com/s?wd=TypeScript"],
    pre: { windows: "1", tabs: "1" },
    post: { windows: "1", tabs: "2" },
    engine: SEARCH_ENGINES.google,
  });
  assert.equal(r.ok, false);
  assert.equal(names(r.checks).url_origin_match, false);
});

test("verify: 搜索参数被重写但 origin 不变时仍然通过", async () => {
  // 实测 Google 会往 URL 上追加 &sei=... ——所以判据是 origin 而不是相等
  const r = await verify({
    actionId: TAB,
    exec: ok({ url: `${SENT}&sei=oUSvatTiabc` }),
    rawArgv: [SENT],
    pre: { windows: "1", tabs: "1" },
    post: { windows: "1", tabs: "2" },
    engine: SEARCH_ENGINES.google,
  });
  assert.equal(names(r.checks).url_origin_match, true);
});

test("verify: 引擎声明了会跳转到哪些 origin 时，跳过去也算通过", async () => {
  const r = await verify({
    actionId: TAB,
    exec: ok({ url: "https://cn.bing.com/search?q=TypeScript" }),
    rawArgv: ["https://www.bing.com/search?q=TypeScript"],
    pre: { windows: "1", tabs: "1" },
    post: { windows: "1", tabs: "2" },
    engine: SEARCH_ENGINES.bing,
  });
  assert.equal(names(r.checks).url_origin_match, true);
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
