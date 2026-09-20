import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * 与 osascript 之间唯一的出入口。
 *
 * 整个执行层只有一条不变式要守：**标识符可以拼进脚本文本，值永远不行。**
 *
 * 标识符（note / body / window 这类 AppleScript 关键字）是语言结构的一部分，
 * 无法经 argv 传递，所以必须插值；但它们只来自 sdef 和代码常量，不受用户输入
 * 与模型输出影响，再加一道字符集校验作纵深防御。
 *
 * 值走且只走 argv。两层保护叠加使转义需求归零：execFile 不经过 shell，
 * 所以 shell 元字符无意义；`on run argv` 让值落在 AppleScript 的参数列表里
 * 而非字符串字面量里，所以引号和反斜杠也无意义。本机实测 12 组恶意值
 * （含 `" & (do shell script "echo pwned") & "`）全部逐字返回，无一被求值。
 *
 * 之所以要有这个文件而不是把 execFile 散落在各处：安全评审需要一个单一的
 * 可审计对象。只要没有第二处 spawn osascript，这条不变式就只需在这里证明一次。
 */

/**
 * 回读字段分隔符：ASCII 记录分隔符（0x1E）。
 *
 * 刻意不在 AppleScript 里拼 JSON——值里的引号会直接毁掉它，而回读的内容
 * （URL、网页标题）恰恰经常带引号。记录分隔符在正文里不会自然出现。
 *
 * 注意：脚本模板里必须把它写成字面量 `ASCII character 30`，不能插值这个常量。
 * 模板保持纯字面量，才能用纯字符串测试断言「模板里不存在插值」。
 */
export const RS = "\x1e";

/** 回读格式版本前缀。格式损坏时能被立即发现，而不是解析出一堆垃圾。 */
export const READBACK_TAG = "RB1";

/**
 * 标识符字符集：小写字母与空格。
 *
 * 允许空格是因为 AppleScript 有多词类名（`bookmark folder`、`bookmark item`）。
 */
const IDENTIFIER = /^[a-z][a-z ]{0,30}$/;

/**
 * 标识符白名单校验。
 *
 * 这不是在防用户——标识符本就不来自用户——而是防某个第三方应用的 sdef 里
 * 出现带引号或换行的类名时被原样拼进脚本文本。违反它属于编程或环境错误，
 * 所以抛出而非返回 Result：调用方没有任何合理的降级处理方式。
 */
export function assertIdentifier(value: string, what: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`非法标识符（${what}）：${JSON.stringify(value)}`);
  }
  return value;
}

export type OsaOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type OsaResult =
  | { ok: true; raw: string }
  | { ok: false; errors: string[] };

/**
 * 执行一段 AppleScript，值全部经 argv 传入。
 *
 * `--` 不能省：值可能以短横开头（用户说「搜一下 -v 参数」），没有它
 * osascript 会把值当成自己的选项解析。
 *
 * 返回 Result 而不抛错，因为绝大多数失败都是业务期望内的：应用没开、
 * 窗口不存在、对象已被删除。这些情况闭环要能降级处理，不该中断。
 */
export async function osa(
  script: string,
  args: string[] = [],
  opts: OsaOptions = {},
): Promise<OsaResult> {
  try {
    const { stdout } = await run("osascript", ["-e", script, "--", ...args], {
      timeout: opts.timeoutMs ?? 8000,
      signal: opts.signal,
      maxBuffer: 1024 * 1024,
    });
    // osascript 的 return 总会在末尾补一个换行，它不属于值本身
    return { ok: true, raw: stdout.replace(/\n$/, "") };
  } catch (err) {
    return { ok: false, errors: [describeOsaError(err)] };
  }
}

/** 把 execFile 抛出的异常压成一行人能读的话。 */
function describeOsaError(err: unknown): string {
  const e = err as { killed?: boolean; stderr?: string; message?: string };
  if (e.killed) return "osascript 超时";
  const stderr = (e.stderr ?? "").trim();
  if (stderr) return stderr.split("\n")[0] || stderr;
  return e.message ?? String(err);
}

export type ReadbackResult =
  | { ok: true; values: Record<string, string> }
  | { ok: false; errors: string[] };

/**
 * 解析脚本回读。
 *
 * 字段数必须与模板声明的完全一致。少一个字段通常意味着某个属性取值失败
 * 被 AppleScript 静默跳过，这时后续字段的偏移全是错的——宁可判失败，
 * 也不能让错位的值流进 verify 和产物。
 */
export function parseReadback(raw: string, fields: readonly string[]): ReadbackResult {
  const parts = raw.split(RS);
  if (parts[0] !== READBACK_TAG) {
    return {
      ok: false,
      errors: [`回读缺少 ${READBACK_TAG} 前缀：${JSON.stringify(raw.slice(0, 80))}`],
    };
  }
  const values = parts.slice(1);
  if (values.length !== fields.length) {
    return {
      ok: false,
      errors: [`回读字段数不符：期望 ${fields.length}，实得 ${values.length}`],
    };
  }
  const out: Record<string, string> = {};
  fields.forEach((name, i) => {
    out[name] = values[i] ?? "";
  });
  return { ok: true, values: out };
}

/**
 * Notes 的 body 值转义。
 *
 * 实测：Notes 强制把 body 当 HTML 解析，即便传入的是纯文本——`<tag>` 会被
 * 当标签整个吞掉，`&` 会被写成畸形实体 `&amp`（丢了分号）。所以不存在
 * 「不构造 HTML」这个选项，写入前必须转义。
 *
 * 转义发生在 TS 侧、针对 argv 的内容做，不改变「值不拼进脚本文本」这一不变式。
 * `&` 必须最先替换，否则会把后面几条产生的实体再转义一遍。
 */
export function escapeNotesHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
