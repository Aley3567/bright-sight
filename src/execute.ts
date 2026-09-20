import { runAction } from "./capability.ts";
import type { AxExecContext } from "./ax.ts";
import { isSafeUrl, searchUrl, type SearchEngine } from "./config.ts";
import type { ScriptTemplate } from "./scripts.ts";
import type { Artifact, ExecResult } from "./types.ts";

/**
 * 执行层：把一个决策变成真实的 Apple Event。
 *
 * 阶段 5.0 起，这个模块只保留两件底层事：把上下文解析成这个模板的 argv（resolveArgs），
 * 以及把 argv 投递出去（capability.ts 的 scriptAdapter.perform）。分派与独立重查
 * （注册表 / 白名单 / 破坏性）搬进了 capability 的统一路径，所以这里不再自己拼一条路——
 * 「两条路都能执行同一个脚本动作」是明确不允许的。
 *
 * 搬家之前，"独立重查"写在 execute() 里，理由是"安全检查写在唯一一个地方，它就有唯一
 * 一个出错的地方"。搬完之后那个唯一的地方变成了 capability.ts 的 plan，这条理由没变。
 */

export type ExecContext = {
  /** 模型从用户原话里挑中的片段，逐字，未经任何改写。 */
  span: string | null;
  /** 模型选中的正文来源 key。 */
  bodySource: string | null;
  /** 此前步骤产出的全部产物。 */
  artifacts: readonly Artifact[];
  engine?: SearchEngine;
  /**
   * 这一轮可执行的 AX 动作面与反向调用通道。
   *
   * **省略等于「本轮没有 AX」**：kind 为 ax 的动作于是没有任何执行路径，fail-closed，
   * 与 profile 闸同一个缺省哲学。AX 的 offer 是每次 observe 现铸的，不像脚本注册表那样冻结，
   * 所以它只能随上下文进来，不能做成模块级常量。
   */
  ax?: AxExecContext;
};

/**
 * resolveArgs 的结果。
 *
 * 5.0 之前它叫 Resolved，与 capability.ts 新增的判别联合同名。两者含义不同——
 * 这里只回答「argv 是什么」，那边的 Resolved 还携带 kind 与 template 供分派和投递使用——
 * 重名会让调用方分不清拿到的是哪一份，故改名。
 */
export type ArgsResolved = { ok: true; argv: string[] } | { ok: false; errors: string[] };

/** 产物 key 在 bodySource 里的前缀，与"直接用原话片段"区分开。 */
export const ARTIFACT_PREFIX = "artifact:";
export const SPAN_SOURCE = "span";

function artifactValue(artifacts: readonly Artifact[], key: string): string | undefined {
  return artifacts.find((a) => a.key === key)?.value;
}

/**
 * `bodySource` 的取值语法：把「值从哪来」收成一个函数。
 *
 * 只有两种合法形态——`span`（用户原话里挑中的那个片段）与 `artifact:<key>`（此前某一步的产物）。
 * 脚本动作的正文与 AX 的 TYPE_TEXT 文本共用这一套：两处各写一遍的话，边界（来源为空、key
 * 认不出、产物还没产出值）迟早会在其中一边被漏掉一个。
 *
 * `spanValue` 由调用方传入，而不是在这里现取 `ctx.span`：Notes 的正文来源是**修剪过的标题**
 * （它同时就是笔记标题），AX 要的是片段本身，两者对 span 的口径不同。把这个差异留在调用方，
 * 这个函数就只回答「按这个 key 找不找得到值」。
 *
 * `reason` 区分「来源认不出」与「来源还没有值」：脚本动作两者都是失败，AX 的 TYPE_TEXT
 * 两者都是「收手去问用户」，分流相同、措辞不同。
 */
export function sourceValue(
  ctx: ExecContext,
  src: string,
  spanValue: string | undefined,
): { ok: true; value: string } | { ok: false; reason: "unknown" | "no_value" } {
  if (src === SPAN_SOURCE) {
    return spanValue === undefined ? { ok: false, reason: "no_value" } : { ok: true, value: spanValue };
  }
  if (src.startsWith(ARTIFACT_PREFIX)) {
    const v = artifactValue(ctx.artifacts, src.slice(ARTIFACT_PREFIX.length));
    return v === undefined ? { ok: false, reason: "no_value" } : { ok: true, value: v };
  }
  return { ok: false, reason: "unknown" };
}

/**
 * 把上下文解析成这个模板的 argv。
 *
 * Phase 1 每个模板一段固定解析，因为"通用构建器的输出该长什么样"还没被钉死——
 * 先把手写版本当规格写出来，Phase 3 再让 sdef 参数化的构建器去对齐它。
 * 两个分支是规格，不是终点。
 */
export function resolveArgs(t: ScriptTemplate, ctx: ExecContext): ArgsResolved {
  if (t.id === "Google Chrome.make-tab") {
    const span = ctx.span?.trim();
    if (!span) return { ok: false, errors: ["没有可用的片段，无法决定要打开什么"] };
    // 片段本身就是个合法网址就直接用；否则当查询词交给搜索模板。
    // 模型全程没有见过也没有生成过任何 URL——拼 URL 的是 config.ts 里那段固定模板。
    const url = isSafeUrl(span) ? span : searchUrl(span, ctx.engine);
    if (!isSafeUrl(url)) return { ok: false, errors: [`拼出的地址没通过 scheme 白名单：${url}`] };
    return { ok: true, argv: [url] };
  }

  if (t.id === "Notes.make-note") {
    const name = ctx.span?.trim();
    if (!name) return { ok: false, errors: ["没有可用的片段，无法决定笔记标题"] };

    const src = ctx.bodySource;
    if (!src) return { ok: false, errors: ["没有指定正文来源"] };
    // 正文与标题同源：来源是 span 时，正文就是那个已经修剪过的片段本身
    const picked = sourceValue(ctx, src, name);
    if (!picked.ok) {
      return {
        ok: false,
        errors: [
          picked.reason === "unknown"
            ? `无法识别的正文来源 ${JSON.stringify(src)}`
            : `正文来源 ${src} 还没有产出值`,
        ],
      };
    }
    const body = picked.value;
    // 页面回读是不可信数据：它由网页控制，是唯一一条从外部世界流进系统的通道。
    // 进笔记正文可以（走 argv、纯文本），但如果它长得像个网址，就必须过 scheme 白名单，
    // 免得把 javascript: 之类的东西存成一条用户随手会点的笔记。
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(body) && !isSafeUrl(body)) {
      return { ok: false, errors: [`正文看起来是个地址但没通过 scheme 白名单：${body}`] };
    }
    return { ok: true, argv: [name, body] };
  }

  return { ok: false, errors: [`${t.id} 没有参数解析规则`] };
}

export type ExecOutcome = {
  result: ExecResult;
  /** 本次执行产出的产物，已带 provenance。 */
  artifacts: Artifact[];
  /**
   * HTML 转义之前的 argv。
   *
   * verify 要拿它去和回读的 plaintext 做包含判断：写进 Notes 的是 `&amp;`，
   * 读回来的 plaintext 是还原后的 `&`，拿转义后的值去比必然不匹配。
   * result.argv 记的是实际发出去的（转义后），那是审计要的；这个是验证要的。
   */
  rawArgv: string[];
  /**
   * 非失败的中止信号，目前只有一种取值：切片切不出动作需要的内容，收手去问用户。
   *
   * 它不是失败，所以不能折进 `result.ok`——失败会消耗恢复预算、触发「换条路重试」，
   * 而缺输入重试多少次还是缺。loop 见到它就置 `needs_input` 就地收手。
   */
  stop?: "needs_more_input";
};

/**
 * 真发出去。
 *
 * dryRun 打印计划但不投递 Apple Event，`bright-sight run` 默认就是这个模式——
 * 让人先看见完整的 argv，再决定要不要加 --execute。
 *
 * 解析、分派、独立重查都收敛到 capability.ts 的 runAction 里，这里只是那条路径的
 * 一个稳定入口（cli.ts 已经直接走 runAction，这个函数保留给库调用方与既有测试）。
 */
export async function execute(
  actionId: string,
  ctx: ExecContext,
  step: number,
  opts: { dryRun?: boolean; signal?: AbortSignal } = {},
): Promise<ExecOutcome> {
  return runAction(actionId, ctx, { step, dryRun: opts.dryRun, signal: opts.signal });
}
