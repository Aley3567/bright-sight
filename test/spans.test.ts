import test from "node:test";
import assert from "node:assert/strict";
import { extractSpans, isVerbatim } from "../src/spans.ts";
import { LIMITS } from "../src/config.ts";

/** 每条候选都必须是原话��逐字子串——这是整个取值路径的地基，任何语料都不例外。 */
function assertAllVerbatim(utterance: string, spans: string[]): void {
  for (const s of spans) {
    assert.ok(isVerbatim(utterance, s), `候选 ${JSON.stringify(s)} 不是原话的逐字子串`);
  }
}

const CORPUS = [
  "搜一下 TypeScript 的 erasableSyntaxOnly，把链接存进备忘录",
  "帮我查 Node 原生 TS 支持，记到备忘录里",
  "搜索 AppleScript argv 转义",
  "谷歌一下 osascript on run argv",
  // 无标点，voice-browser 的 indexOf(" ") 兜底在这里结构性失效
  "搜一下typescript装饰器把链接存进备忘录",
  "查询 Jev System One 模型",
];

test("spans: 中文语料都能切出候选，且每条都是原话的逐字子串", () => {
  for (const u of CORPUS) {
    const spans = extractSpans(u);
    assert.ok(spans.length > 0, `切不出任何候选: ${u}`);
    assertAllVerbatim(u, spans);
  }
});

test("spans: 典型指令的搜索词在候选里，边界被穷举而不是被猜", () => {
  const spans = extractSpans("搜一下 TypeScript 的 erasableSyntaxOnly，把链接存进备忘录");
  assert.ok(
    spans.includes("TypeScript 的 erasableSyntaxOnly"),
    `期望切出搜索词，实际候选: ${JSON.stringify(spans)}`,
  );
});

test("spans: 无标点输入也能枚举出正确边界", () => {
  const spans = extractSpans("搜一下typescript装饰器把链接存进备忘录");
  assert.ok(spans.includes("typescript装饰器"), `实际候选: ${JSON.stringify(spans)}`);
});

test("spans: 引号内容优先，用户显式划定的边界不该被二次猜测", () => {
  const spans = extractSpans("搜一下「Node 原生 TS」然后存进备忘录");
  assert.equal(spans[0], "Node 原生 TS");
});

test("spans: 中文动词短语整体匹配，不会切出「一下」这种残片", () => {
  // 曾经的真实缺陷：固定串表里「帮我查」和「查一下」位置重叠，双双命中产出垃圾候选
  for (const s of extractSpans("帮我查一下 Node 原生 TS")) {
    assert.notEqual(s, "一下");
    assert.ok(!s.startsWith("一下"), `残片候选: ${JSON.stringify(s)}`);
  }
});

test("spans: 拉丁数字连续段被单独提取——中文语料里它几乎必然是载荷", () => {
  const spans = extractSpans("查一下 erasableSyntaxOnly 这个选项");
  assert.ok(spans.some((s) => s.includes("erasableSyntaxOnly")));
});

test("spans: 一个锚点都没有时返回空数组，不退化成把整句当载荷", () => {
  const spans = extractSpans("今天天气不错");
  assert.deepEqual(spans, [], "空数组是明确信号：调用方必须走 ASK，而不是拿整句去执行");
});

test("spans: 空输入不抛异常", () => {
  assert.deepEqual(extractSpans(""), []);
  assert.deepEqual(extractSpans("   "), []);
});

test("spans: 候选数量与长度都有上限，不会因为长输入爆炸", () => {
  const long = `搜一下${"甲乙丙丁戊己庚辛".repeat(60)}，把链接存进备忘录`;
  const spans = extractSpans(long);
  assert.ok(spans.length <= LIMITS.maxSpans, `候选 ${spans.length} 条超过上限`);
  for (const s of spans) assert.ok(s.length <= LIMITS.maxSpanChars, `候选长 ${s.length} 超过上限`);
  assertAllVerbatim(long, spans);
});

test("spans: 候选之间不重复", () => {
  const spans = extractSpans("搜一下 A，然后搜一下 A");
  assert.equal(new Set(spans).size, spans.length);
});

test("isVerbatim: 改动一个字就拒绝", () => {
  const u = "搜一下 TypeScript 的 erasableSyntaxOnly";
  assert.ok(isVerbatim(u, "TypeScript 的 erasableSyntaxOnly"));
  assert.ok(!isVerbatim(u, "TypeScript 的 erasableSyntaxOnlyX"));
  assert.ok(!isVerbatim(u, "typescript 的 erasableSyntaxOnly"), "大小写不同也算改动");
  assert.ok(!isVerbatim(u, ""), "空串不是有效载荷");
});
