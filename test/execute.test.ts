import test from "node:test";
import assert from "node:assert/strict";
import { ARTIFACT_PREFIX, SPAN_SOURCE, execute, resolveArgs, type ExecContext } from "../src/execute.ts";
import { REGISTRY, type ScriptTemplate } from "../src/scripts.ts";
import { SEARCH_ENGINES } from "../src/config.ts";
import type { Artifact } from "../src/types.ts";

const TAB = REGISTRY["Google Chrome.make-tab"];
const NOTE = REGISTRY["Notes.make-note"];

function ctx(over: Partial<ExecContext> = {}): ExecContext {
  return { span: null, bodySource: null, artifacts: [], ...over };
}

function artifact(key: string, value: string): Artifact {
  return { key, value, from: { step: 1, actionId: "Google Chrome.make-tab", field: "url" } };
}

test("execute: 片段是查询词时走固定的搜索模板，模型全程没有生成过 URL", () => {
  const r = resolveArgs(TAB, ctx({ span: "TypeScript erasableSyntaxOnly", engine: SEARCH_ENGINES.google }));
  assert.ok(r.ok);
  assert.match(r.argv[0], /^https:\/\/www\.google\.com\/search\?q=/);
  assert.match(r.argv[0], /TypeScript/);
});

test("execute: 片段本身是合法网址时直接用，不再套一层搜索", () => {
  const r = resolveArgs(TAB, ctx({ span: "https://example.com/a?b=1" }));
  assert.ok(r.ok);
  assert.equal(r.argv[0], "https://example.com/a?b=1");
});

test("execute: 没有片段就明确失败，不拿整句或空串去开页面", () => {
  const r = resolveArgs(TAB, ctx({ span: null }));
  assert.ok(!r.ok);
  const blank = resolveArgs(TAB, ctx({ span: "   " }));
  assert.ok(!blank.ok);
});

test("execute: 笔记正文取自上一步产物时，值逐字来自回读", () => {
  const url = "https://www.google.com/search?q=TypeScript";
  const r = resolveArgs(NOTE, ctx({
    span: "TypeScript 的 erasableSyntaxOnly",
    bodySource: `${ARTIFACT_PREFIX}chrome.active_url`,
    artifacts: [artifact("chrome.active_url", url)],
  }));
  assert.ok(r.ok);
  assert.deepEqual(r.argv, ["TypeScript 的 erasableSyntaxOnly", url]);
});

test("execute: 正文来源还没产出值时失败，不静默写个空笔记", () => {
  const r = resolveArgs(NOTE, ctx({ span: "标题", bodySource: `${ARTIFACT_PREFIX}chrome.active_url`, artifacts: [] }));
  assert.ok(!r.ok);
  assert.match(r.errors.join(""), /还没有产出值/);
});

test("execute: 无法识别的正文来源被拒绝", () => {
  const r = resolveArgs(NOTE, ctx({ span: "标题", bodySource: "随便写的" }));
  assert.ok(!r.ok);
});

test("execute: 回读来的值像地址但 scheme 不安全时拒绝写进笔记", () => {
  // 页面回读由网页控制，是唯一一条从外部世界流进系统的通道
  for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd"]) {
    const r = resolveArgs(NOTE, ctx({
      span: "标题",
      bodySource: `${ARTIFACT_PREFIX}chrome.active_url`,
      artifacts: [artifact("chrome.active_url", bad)],
    }));
    assert.ok(!r.ok, `${bad} 没有被拦下`);
    assert.match(r.errors.join(""), /scheme 白名单/);
  }
});

test("execute: 正文取自原话片段时与标题同源，不引入任何生成文本", () => {
  const r = resolveArgs(NOTE, ctx({ span: "开会要点", bodySource: SPAN_SOURCE }));
  assert.ok(r.ok);
  assert.deepEqual(r.argv, ["开会要点", "开会要点"]);
});

test("execute: 不在注册表里的动作返回失败而不是抛异常", async () => {
  const out = await execute("Google Chrome.execute", ctx({ span: "alert(1)" }), 1, { dryRun: true });
  assert.equal(out.result.ok, false);
  assert.ok(!out.result.ok && out.result.errors.join("").includes("不在执行模板注册表"));
});

test("execute: dry-run 解析出完整参数但不产出任何产物", async () => {
  const out = await execute("Google Chrome.make-tab", ctx({ span: "TypeScript" }), 1, { dryRun: true });
  assert.ok(out.result.ok);
  assert.equal(out.result.argv.length, 1);
  assert.deepEqual(out.artifacts, [], "没执行就没有回读，产物必须是空的");
});

test("execute: 写进备忘录的正文经过 HTML 转义，但验证用的原值保持原样", async () => {
  // Notes 强制把 body 当 HTML 解析：不转义的话 <tag> 会被整个吞掉
  const raw = "a<b>&c";
  const out = await execute(
    "Notes.make-note",
    ctx({ span: "标题", bodySource: SPAN_SOURCE, artifacts: [] }),
    1,
    { dryRun: true },
  );
  assert.ok(out.result.ok);
  const out2 = await execute(
    "Notes.make-note",
    ctx({ span: raw, bodySource: SPAN_SOURCE }),
    1,
    { dryRun: true },
  );
  assert.ok(out2.result.ok);
  assert.equal(out2.result.argv[1], "a&lt;b&gt;&amp;c", "发出去的正文要转义");
  assert.equal(out2.rawArgv[1], raw, "验证要拿转义前的原值去比对回读的纯文本");
  assert.equal(out2.result.argv[0], raw, "标题不转义——实测 Notes 的 name 原样保留标记字符");
});

test("execute: 注册表之外的动作没有参数解析规则，删除类动作连参数都拼不出来", () => {
  // execute() 里 effect === "destroy" 那道闸在这里测不到：它从 REGISTRY 查模板，
  // 而运行时注册表按设计没有任何 destroy 条目，注入不进去。那道闸由
  // policy.test.ts 的「模板声明 destroy 时拦截」覆盖——policy 接受 template 参数。
  // 这里验的是更外层的一条：解析规则本身是按 id 白名单写的，没列出的动作拼不出 argv。
  const destroy: ScriptTemplate = { ...NOTE, id: "Notes.delete-note", effect: "destroy" };
  const r = resolveArgs(destroy, ctx({ span: "x", bodySource: SPAN_SOURCE }));
  assert.ok(!r.ok);
  assert.match(r.errors.join(""), /没有参数解析规则/);
});
