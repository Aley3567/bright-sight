import test from "node:test";
import assert from "node:assert/strict";
import { JOURNAL_ENV, fingerprint, makeRedactor, resolveRedactMode, type Fingerprint } from "../src/redact.ts";

const SALT = "0123456789abcdef";

function fp(v: unknown): Fingerprint {
  assert.ok(v && typeof v === "object" && "h" in v && "len" in v, `${JSON.stringify(v)} 不是一个指纹`);
  return v as Fingerprint;
}

/** 递归找出结构里所有还能读出内容的字符串值。 */
function leakedStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) leakedStrings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) leakedStrings(x, out);
  return out;
}

test("redact: 只有逐字的 full 才关闭脱敏，拼错一律落回安全侧", () => {
  assert.equal(resolveRedactMode("full"), "full");
  for (const bad of ["Full", "FULL", "ful", "1", "true", "", undefined]) {
    assert.equal(resolveRedactMode(bad), "hash", `${JSON.stringify(bad)} 不该被当成 full`);
  }
});

test("redact: 默认值是脱敏——环境变量没设时不该落原文", () => {
  const saved = process.env[JOURNAL_ENV];
  delete process.env[JOURNAL_ENV];
  try {
    assert.equal(resolveRedactMode(), "hash");
  } finally {
    if (saved !== undefined) process.env[JOURNAL_ENV] = saved;
  }
});

test("redact: 同一个值指纹稳定，不同值指纹不同", () => {
  const a = fingerprint("https://example.com/x", SALT);
  assert.deepEqual(a, fingerprint("https://example.com/x", SALT));
  assert.notEqual(a.h, fingerprint("https://example.com/y", SALT).h);
});

test("redact: 换一把盐，同一个值的指纹就对不上——这才挡得住彩虹表", () => {
  const v = "https://www.google.com/search?q=TypeScript";
  assert.notEqual(fingerprint(v, SALT).h, fingerprint(v, "另一台机器的盐").h);
});

test("redact: 长度按字符数算，中文不被当成三个字节", () => {
  assert.equal(fingerprint("你好", SALT).len, 2);
  assert.equal(fingerprint("", SALT).len, 0);
});

test("redact: observe 抹掉窗口标题，保留前台应用名", () => {
  const r = makeRedactor("hash", SALT);
  const out = r.event("observe", { front: "Notes", window: "无标题.txt — 记事本" }) as Record<string, unknown>;
  assert.equal(out.front, "Notes", "应用名是结构，抹掉它留痕就没法读了");
  assert.equal(fp(out.window).len, 13);
});

test("redact: observe 的 window 为 null 时原样保留，不编一个假指纹", () => {
  const r = makeRedactor("hash", SALT);
  const out = r.event("observe", { front: "Finder", window: null }) as Record<string, unknown>;
  assert.equal(out.window, null);
});

test("redact: judge 保留概率与判据，只抹掉从原话切出来的片段", () => {
  const r = makeRedactor("hash", SALT);
  const out = r.event("judge", {
    judgement: { action: "Notes.make-note", confidence: 0.92, backend: "fake" },
    span: "erasableSyntaxOnly",
    bodySource: "artifact:chrome.active_url",
    violations: [],
  }) as Record<string, unknown>;
  assert.deepEqual(out.judgement, { action: "Notes.make-note", confidence: 0.92, backend: "fake" });
  assert.equal(out.bodySource, "artifact:chrome.active_url", "产物 key 是本系统自己的常量");
  assert.equal(fp(out.span).len, 18);
});

test("redact: act 抹掉 argv 与回读值，保留字段名与结构", () => {
  const r = makeRedactor("hash", SALT);
  const out = r.event("act", {
    ok: true,
    ms: 1234,
    argv: ["https://www.google.com/search?q=X"],
    readback: { tab_id: "1734", url: "https://www.google.com/search?q=X", windows: "2" },
  }) as Record<string, unknown>;
  assert.equal(out.ok, true);
  assert.equal(out.ms, 1234);
  const rb = out.readback as Record<string, unknown>;
  assert.deepEqual(Object.keys(rb).sort(), ["tab_id", "url", "windows"], "字段名来自模板，是代码常量");
  assert.equal(fp((out.argv as unknown[])[0]).len, 33);
  // 同一个 URL 在 argv 和回读里应当得到同一个指纹——「发出去的和回读到的是不是同一个」
  // 正是留痕要回答的问题，脱敏不能把它一起抹掉
  assert.equal(fp((out.argv as unknown[])[0]).h, fp(rb.url).h);
});

test("redact: verify 保留判据名与通过与否，只抹掉 detail", () => {
  const r = makeRedactor("hash", SALT);
  const out = r.event("verify", {
    ok: false,
    checks: [{ name: "url_origin_match", ok: false, detail: "origin 从 https://a 变成了 https://b" }],
  }) as Record<string, unknown>;
  const c = (out.checks as Record<string, unknown>[])[0];
  assert.equal(c.name, "url_origin_match", "哪条判据没过必须读得出来");
  assert.equal(c.ok, false);
  assert.ok(fp(c.detail).len > 0);
});

test("redact: run.start 抹掉用户原话，保留步数上限与选项数", () => {
  const r = makeRedactor("hash", SALT);
  const out = r.event("run.start", { utterance: "搜一下 X 存进备忘录", maxSteps: 6, offers: 3 }) as Record<string, unknown>;
  assert.equal(out.maxSteps, 6);
  assert.equal(out.offers, 3);
  assert.ok(fp(out.utterance).len > 0);
});

test("redact: suspend 保留结构，但不放行任何待确认的理由文本", () => {
  const r = makeRedactor("hash", SALT);
  const out = r.event("suspend", {
    confirmId: "01J0000000000000000000",
    actionId: "Google Chrome.make-tab",
    gate: "unknown",
    // 白名单之外的字段：哪怕将来有人顺手把 reasons 塞进来，也只能落成指纹
    reasons: ["Chrome profile Profile 7 不在允许名单内，需要当场确认"],
  }) as Record<string, unknown>;
  assert.equal(out.confirmId, "01J0000000000000000000", "对不上「哪一次挂起」的留痕等于没有");
  assert.equal(out.actionId, "Google Chrome.make-tab");
  assert.equal(out.gate, "unknown");
  for (const leaked of leakedStrings(out.reasons)) {
    assert.equal(leaked.includes("Profile 7"), false, "profile 目录名不进留痕");
  }
});

test("redact: resume 保留 approved 与陈旧判据名，但判据的 detail 进不去", () => {
  const r = makeRedactor("hash", SALT);
  const out = r.event("resume", {
    confirmId: "01J0000000000000000000",
    approved: true,
    stale: ["front", "window"],
    detail: "前台窗口标题从 我的私密文档 变成了 别的",
  }) as Record<string, unknown>;
  assert.equal(out.approved, true);
  assert.deepEqual(out.stale, ["front", "window"], "「哪条判据判它陈旧」必须读得出来");
  assert.ok(fp(out.detail).len > 0);
  // 阳性对照：同一个串确实在原始 data 里，所以「读不到」不是因为压根没写过它
  assert.equal(leakedStrings(out).some((x) => x.includes("我的私密文档")), false);
});

test("redact: 没见过的 phase 一律全量指纹化——忘了加规则的后果是过度脱敏", () => {
  const r = makeRedactor("hash", SALT);
  const out = r.event("某个将来才有的阶段", { anything: "一段敏感内容", n: 3 }) as Record<string, unknown>;
  assert.ok(fp(out.anything).len > 0);
  assert.equal(out.n, 3);
});

test("redact: 脱敏后的留痕里不存在任何可读的外部字符串", () => {
  const r = makeRedactor("hash", SALT);
  const secret = "我的私密查询词";
  const payload = {
    ok: true,
    argv: [secret],
    readback: { url: `https://example.com/?q=${secret}`, title: secret },
  };
  const out = r.event("act", payload);
  for (const s of leakedStrings(out)) {
    assert.ok(!s.includes(secret), `脱敏后仍能读到原文：${s}`);
  }
});

test("redact: full 模式原样透传——逃生阀必须真的能看见原文", () => {
  const r = makeRedactor("full", SALT);
  const data = { front: "Notes", window: "无标题" };
  assert.equal(r.event("observe", data), data, "full 模式不该复制或改写任何东西");
  assert.equal(r.value("原文"), "原文");
});

test("redact: 递归深度有上限，环状或畸形结构不会把留痕拖死", () => {
  const r = makeRedactor("hash", SALT);
  let deep: Record<string, unknown> = { v: "底" };
  for (let i = 0; i < 20; i++) deep = { v: deep };
  const out = r.event("未知阶段", deep);
  assert.ok(JSON.stringify(out).length < 2000);
});
