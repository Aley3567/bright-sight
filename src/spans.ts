import { LIMITS } from "./config.ts";

/**
 * 候选片段提取：过度生成，交给模型 pick，再由代码逐字复制。
 *
 * 这个结构是从 jev-voice-browser 继承的——模型永远不生成文本，只在若干个
 * 从用户原话里切出来的片段之间选一个。但它的实现不能继承：voice-browser 的
 * spans.js 全靠 \b 词边界和 t.indexOf(" ")，中文里没有空格，右边界根本没有标记。
 * 「搜一下typescript装饰器把链接存进备忘录」里，"把"是边界还是内容，正则判不了。
 *
 * 所以这里不猜边界，而是枚举边界：收集锚点，对每个动词锚点的结束位置，
 * 向后枚举每一个锚点的起始位置，产出所有可能的切法。锚点通常 3–6 个，
 * 候选是十几个而不是 O(n²) 爆炸，让模型在里面挑一个。
 */

/**
 * 引出载荷的动词短语。
 *
 * 用正则不用固定串表，是因为中文动词带可选的前后缀：「帮我查一下」是一个整体，
 * 拿固定串表匹配会同时命中「帮我查」和「查一下」两个重叠锚点，
 * 于是切出「一下「Node 原生 TS」」这种把后缀当载荷的候选。
 * 正则的最左最长匹配天然不重叠，前后缀各自可选，这才是中文形态的正确建模。
 */
const VERB_RE =
  /(?:帮我|给我|替我|麻烦你?|你)?(?:搜索|搜一搜|搜|查找|查询|查一查|查|找一找|找|谷歌|google|百度|必应)(?:一下|下)?/gi;

/** 引出目标位置的动词，载荷通常在它之前结束。 */
const TARGET_RE = /(?:存|保存|记|写|加|放|发|贴|粘贴|收藏|同步)(?:进|到|在|入|给|下来|下)?/g;

/** 结构词与标点：它们本身不是载荷，但是载荷的天然边界。 */
const STRUCT_RE =
  /把|的|然后|接着|再|并且|并|顺便|以及|和|[，。、；：！？""''「」『』《》（）,.;:!?"'()]/g;

type Anchor = { start: number; end: number; kind: "verb" | "target" | "struct" };

/** 连续的拉丁字母 / 数字段。中文语料里这种段落几乎必然是载荷本身。 */
const ASCII_RUN = /[A-Za-z0-9][A-Za-z0-9 ._\-+#/]*/g;

function findAll(text: string, re: RegExp, kind: Anchor["kind"]): Anchor[] {
  const out: Anchor[] = [];
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue;
    out.push({ start: m.index, end: m.index + m[0].length, kind });
  }
  return out;
}

/** 首尾修剪：只删首尾的空白和标点，所以结果仍然是原话的逐字子串。 */
function trimSpan(s: string): string {
  return s.replace(/^[\s，。、；：！？,.;:!?"'“”‘’「」（）()]+/, "")
    .replace(/[\s，。、；：！？,.;:!?"'“”‘’「」（）()]+$/, "");
}

function push(out: string[], utterance: string, raw: string): void {
  const v = trimSpan(raw);
  if (!v || v.length > LIMITS.maxSpanChars) return;
  if (!utterance.includes(v)) return; // 不该发生，但这是逐字不变式的守卫
  if (out.includes(v)) return;
  out.push(v);
}

/**
 * 切出可能的查询词 / 正文片段，最可能的排前面。
 *
 * 返回空数组代表"一个锚点都没找到"，调用方必须走 ASK 让用户自己说清楚，
 * 不许退化成"整句当载荷"那种看起来能跑的猜测。
 */
export function extractSpans(utterance: string): string[] {
  const t = utterance.trim();
  if (!t) return [];

  const verbs = findAll(t, VERB_RE, "verb");
  const boundaries = [...findAll(t, TARGET_RE, "target"), ...findAll(t, STRUCT_RE, "struct")]
    .sort((a, b) => a.start - b.start);

  const out: string[] = [];

  // 1. 引号内的内容：用户自己标出了边界，最可信
  for (const m of t.matchAll(/["“‘'「『]([^"“”‘’'「」『』]{1,120})["”’'」』]/g)) {
    push(out, t, m[1]);
  }

  // 2. 动词之后到某个边界锚点之前——边界不猜，全枚举
  for (const v of verbs) {
    for (const b of boundaries) {
      if (b.start > v.end) push(out, t, t.slice(v.end, b.start));
    }
    push(out, t, t.slice(v.end)); // 到句尾也是一种切法
  }

  // 3. 最长的拉丁/数字连续段，按长度降序
  const runs = [...t.matchAll(ASCII_RUN)].map((m) => m[0]).sort((a, b) => b.length - a.length);
  for (const r of runs.slice(0, 3)) push(out, t, r);

  return out.slice(0, LIMITS.maxSpans);
}

/**
 * 逐字子串校验。
 *
 * 模型返回的必须是我们给过的选项之一，而选项必须是原话里原封不动的一段。
 * 改一个字就拒绝——这是"模型不生成文本"这条立意在代码里唯一的落点，
 * 没有这道校验，前面所有关于"只 pick 不生成"的说法都只是约定而非保证。
 */
export function isVerbatim(utterance: string, span: string): boolean {
  return span.length > 0 && utterance.includes(span);
}
