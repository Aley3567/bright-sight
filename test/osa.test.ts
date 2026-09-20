import test from "node:test";
import assert from "node:assert/strict";
import {
  osa,
  assertIdentifier,
  parseReadback,
  escapeNotesHtml,
  RS,
  READBACK_TAG,
} from "../src/osa.ts";

/** 无害回显模板：只把第一个参数原样送回，不碰任何应用。 */
const ECHO = 'on run argv\nreturn item 1 of argv\nend run';

/**
 * 整个执行层的安全性都压在这一条上：值经 argv 传递时不会被求值。
 * 用真实子进程和真实 osascript 证明它，不用 mock——mock 掉子进程就等于
 * 把要证明的东西假设成立了。
 */
test("osa: 恶意值经 argv 原样往返，不被 shell 或 AppleScript 求值", async () => {
  const cases: Array<[string, string]> = [
    ["双引号", 'say "hello"'],
    ["反斜杠", "C:\\path\\to\\file"],
    ["换行", "line1\nline2"],
    ["制表符", "a\tb"],
    ["中文", "搜一下 TypeScript 的用法"],
    ["emoji", "test 🎉 done"],
    ["shell 注入", '\'; do shell script "echo pwned"; --'],
    ["命令替换", "$(whoami) `id`"],
    ["格式符", "%s %d %@"],
    ["短横开头", "-not-a-flag"],
    ["AppleScript 注入", '" & (do shell script "echo pwned") & "'],
    ["空字符串", ""],
  ];

  for (const [name, value] of cases) {
    const r = await osa(ECHO, [value]);
    if (!r.ok) assert.fail(`${name} 应当执行成功，实际失败：${r.errors.join("; ")}`);
    assert.equal(r.raw, value, `${name} 应当逐字返回`);
  }
});

test("osa: 标识符校验只放行小写字母与空格", () => {
  // AppleScript 有多词类名，空格必须允许
  assert.equal(assertIdentifier("note", "class"), "note");
  assert.equal(assertIdentifier("bookmark folder", "class"), "bookmark folder");

  // 带引号或换行的类名一旦拼进脚本就是注入，即使它来自 sdef
  for (const bad of ['no"te', "note\n", "note;", "note1", "Note", "", "note-x"]) {
    assert.throws(
      () => assertIdentifier(bad, "class"),
      /非法标识符/,
      `应当拒绝 ${JSON.stringify(bad)}`,
    );
  }
});

test("osa: 回读解析要求前缀与字段数完全匹配", () => {
  const good = [READBACK_TAG, "x-coredata://p33", "标题里有\"引号\""].join(RS);
  const r = parseReadback(good, ["id", "title"]);
  if (!r.ok) assert.fail(`应当解析成功：${r.errors.join("; ")}`);
  assert.equal(r.values.id, "x-coredata://p33");
  // 记录分隔符切分不受值里的引号影响，这正是不拼 JSON 的理由
  assert.equal(r.values.title, '标题里有"引号"');

  // 缺前缀说明脚本根本没跑到 return，不能当成空结果
  const noTag = parseReadback(["id-1"].join(RS), ["id"]);
  assert.equal(noTag.ok, false);

  // 字段数不符意味着后续偏移全错，宁可判失败也不能错位使用
  const short = parseReadback([READBACK_TAG, "only-one"].join(RS), ["id", "title"]);
  assert.equal(short.ok, false);
  const long = parseReadback([READBACK_TAG, "a", "b", "c"].join(RS), ["id", "title"]);
  assert.equal(long.ok, false);
});

test("osa: Notes body 转义顺序正确，& 不会被二次转义", () => {
  assert.equal(escapeNotesHtml("a&b"), "a&amp;b");
  assert.equal(escapeNotesHtml("<tag>"), "&lt;tag&gt;");
  assert.equal(escapeNotesHtml('"q"'), "&quot;q&quot;");
  // & 必须最先替换：否则 < 产生的 &lt; 会被再转义成 &amp;lt;
  assert.equal(escapeNotesHtml("<a&b>"), "&lt;a&amp;b&gt;");
  // 实测中会被 Notes 吞掉的搜索 URL 形态
  assert.equal(
    escapeNotesHtml("https://x.com/s?q=a&form=b"),
    "https://x.com/s?q=a&amp;form=b",
  );
});

test("osa: 超时与脚本错误都返回 Result，不抛出", async () => {
  const timedOut = await osa("on run argv\ndelay 5\nend run", [], { timeoutMs: 300 });
  assert.equal(timedOut.ok, false);

  // 应用报错是业务期望内的失败（对象不存在、窗口没开），闭环要能降级
  const errored = await osa('on run argv\nerror "boom"\nend run', []);
  assert.equal(errored.ok, false);
});
