import test from "node:test";
import assert from "node:assert/strict";
import { execute, SPAN_SOURCE, type ExecContext } from "../src/execute.ts";
import { runProbe, verify } from "../src/verify.ts";
import { osa } from "../src/osa.ts";

/**
 * 真发 Apple Event 的那一档。
 *
 * 默认跳过：别的机器跑 `npm test` 不该被要求先去系��设置里授自动化权限，
 * 也不该在别人的备忘录里凭空多出几条笔记。BRIGHTSIGHT_LIVE=1 才启用。
 */
const LIVE = process.env.BRIGHTSIGHT_LIVE === "1";

/**
 * 只存在于测试代码里的删除模板。
 *
 * 运行时注册表按设计没有任何 effect:"destroy" 的条目，所以清理必须自带一段。
 * 它照样走 argv——测试代码不是不变式的例外。
 */
const DELETE_BY_ID = `on run argv
  tell application "Notes"
    set target to note id (item 1 of argv)
    delete target
  end tell
end run`;

function ctx(over: Partial<ExecContext> = {}): ExecContext {
  return { span: null, bodySource: null, artifacts: [], ...over };
}

test("execute.live: 真实建一条笔记，四路检查全绿，再把它删掉", { skip: !LIVE && "设 BRIGHTSIGHT_LIVE=1 才跑" }, async () => {
  // 随机标题，避免和用户已有的笔记撞名，也方便出事时人工找回来
  const tag = `BrightSight-test-${Math.random().toString(36).slice(2, 10)}`;
  const payload = `${tag} https://example.com/a?b=1&c=<x>`;

  const pre = await runProbe("probe.notes-count");
  assert.ok(pre, "取不到执行前的笔记数");

  let noteId = "";
  try {
    const out = await execute("Notes.make-note", ctx({ span: payload, bodySource: SPAN_SOURCE }), 1);
    assert.ok(out.result.ok, `执行失败: ${!out.result.ok ? out.result.errors.join("；") : ""}`);
    noteId = out.result.readback.id ?? "";
    assert.notEqual(noteId, "", "没有回读到笔记 id");

    const post = await runProbe("probe.notes-count");
    const v = await verify({ actionId: "Notes.make-note", exec: out.result, rawArgv: out.rawArgv, pre, post });
    for (const c of v.checks) assert.ok(c.ok, `检查 ${c.name} 没通过: ${c.detail}`);
    assert.equal(v.ok, true);

    // 尖括号和 & 必须在正文里活下来：Notes 强制按 HTML 解析，不转义就整段吞掉
    assert.equal(out.rawArgv[1], payload);
    assert.notEqual(out.result.argv[1], payload, "发出去的应当是转义后的版本");
  } finally {
    if (noteId) {
      // 按 id 删一次就够，绝不循环「删到报错为止」：实测 delete 是异步的，
      // 对同一条重复删除不报错，那种写法会把删除次数虚报成 10 次
      const r = await osa(DELETE_BY_ID, [noteId], { timeoutMs: 15_000 });
      if (!r.ok) console.error(`清理失败，请手动删除笔记「${tag}」: ${r.errors.join("；")}`);
    }
  }
});

test("execute.live: 真实开一个标签页并验证落点，再关掉它", { skip: !LIVE && "设 BRIGHTSIGHT_LIVE=1 才跑" }, async () => {
  const pre = await runProbe("probe.chrome-counts");
  assert.ok(pre, "取不到执行前的窗口与标签页数");

  let opened = false;
  try {
    const out = await execute("Google Chrome.make-tab", ctx({ span: "https://example.com/" }), 1);
    assert.ok(out.result.ok, `执行失败: ${!out.result.ok ? out.result.errors.join("；") : ""}`);
    opened = true;

    const post = await runProbe("probe.chrome-counts");
    const v = await verify({ actionId: "Google Chrome.make-tab", exec: out.result, rawArgv: out.rawArgv, pre, post });
    for (const c of v.checks) assert.ok(c.ok, `检查 ${c.name} 没通过: ${c.detail}`);

    assert.equal(out.artifacts.find((a) => a.key === "chrome.active_url")?.value, "https://example.com/");
  } finally {
    if (opened) {
      // 只关当前这个标签页，不碰用户其它的
      const r = await osa(
        `on run argv
  tell application "Google Chrome"
    set t to active tab of window 1
    set u to URL of t
    if u contains (item 1 of argv) then close t
  end tell
end run`,
        ["example.com"],
        { timeoutMs: 10_000 },
      );
      if (!r.ok) console.error(`清理失败，请手动关闭 example.com 标签页: ${r.errors.join("；")}`);
    }
  }
});
