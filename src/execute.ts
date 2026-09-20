import { isAllowedApp, isSafeUrl, searchUrl, type SearchEngine } from "./config.ts";
import { escapeNotesHtml, osa, parseReadback } from "./osa.ts";
import { REGISTRY, type ScriptTemplate } from "./scripts.ts";
import type { Artifact, ExecResult } from "./types.ts";

/**
 * 执行层：把一个决策变成真实的 Apple Event。
 *
 * 这个模块只有一个出口函数，它做三件事，顺序不能换：
 * 先独立重查一遍能不能执行（不信任调用方查过了），再把值解析成 argv，最后才发出去。
 *
 * "独立重查"不是冗余。surface.ts 靠注册表过滤选项集，policy.ts 靠模板存在性拦截，
 * 这里再查一次白名单——三处依赖的是不同的表，任何一处改错了，另外两处还拦得住。
 * 安全检查写在唯一一个地方，它就有唯一一个出错的地方。
 */

export type ExecContext = {
  /** 模型从用户原话里挑中的片段，逐字，未经任何改写。 */
  span: string | null;
  /** 模型选中的正文来源 key。 */
  bodySource: string | null;
  /** 此前步骤产出的全部产物。 */
  artifacts: readonly Artifact[];
  engine?: SearchEngine;
};

export type Resolved = { ok: true; argv: string[] } | { ok: false; errors: string[] };

/** 产物 key 在 bodySource 里的前缀，与"直接用原话片段"区分开。 */
export const ARTIFACT_PREFIX = "artifact:";
export const SPAN_SOURCE = "span";

function artifactValue(artifacts: readonly Artifact[], key: string): string | undefined {
  return artifacts.find((a) => a.key === key)?.value;
}

/**
 * 把上下文解析成这个模板的 argv。
 *
 * Phase 1 每个模板一段固定解析，因为"通用构建器的输出该长什么样"还没被钉死——
 * 先把手写版本当规格写出来，Phase 3 再让 sdef 参数化的构建器去对齐它。
 * 两个分支是规格，不是终点。
 */
export function resolveArgs(t: ScriptTemplate, ctx: ExecContext): Resolved {
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
    let body: string | undefined;
    if (src === SPAN_SOURCE) body = name;
    else if (src.startsWith(ARTIFACT_PREFIX)) body = artifactValue(ctx.artifacts, src.slice(ARTIFACT_PREFIX.length));
    else return { ok: false, errors: [`无法识别的正文来源 ${JSON.stringify(src)}`] };

    if (body === undefined) return { ok: false, errors: [`正文来源 ${src} 还没有产出值`] };
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
};

/**
 * 真正发出去。
 *
 * dryRun 打印计划但不投递 Apple Event，`bright-sight run` 默认就是这个模式——
 * 让人先看见完整的 argv，再决定要不要加 --execute。
 */
export async function execute(
  actionId: string,
  ctx: ExecContext,
  step: number,
  opts: { dryRun?: boolean; signal?: AbortSignal } = {},
): Promise<ExecOutcome> {
  const t0 = Date.now();
  const fail = (errors: string[], argv: string[] = []): ExecOutcome => ({
    result: { ok: false, errors, argv, ms: Date.now() - t0 },
    artifacts: [],
    rawArgv: argv,
  });

  // ── 独立重查，不信任调用方 ──
  const t: ScriptTemplate | undefined = REGISTRY[actionId];
  if (!t) return fail([`${actionId} 不在执行模板注册表里，本轮不支持执行它`]);
  if (!isAllowedApp(t.app)) return fail([`${t.app} 不在执行白名单内`]);
  if (t.effect === "destroy") return fail([`${actionId} 声明了破坏性副作用，执行层不提供这条路径`]);

  const resolved = resolveArgs(t, ctx);
  if (!resolved.ok) return fail(resolved.errors);

  const rawArgv = resolved.argv.slice();
  const argv = resolved.argv.slice();
  if (argv.length !== t.argv.length) {
    return fail([`参数个数不符：模板要 ${t.argv.length} 个，解析出 ${argv.length} 个`], argv);
  }
  // Notes 强制把 body 当 HTML 解析——实测传纯文本时 <tag> 会被整个吞掉、& 变成畸形实体。
  // 转义的是 argv 的内容，不改变"值不拼进脚本文本"这条不变式。
  for (const i of t.htmlArgs ?? []) argv[i] = escapeNotesHtml(argv[i]);

  if (opts.dryRun) {
    return { result: { ok: true, readback: {}, argv, ms: Date.now() - t0 }, artifacts: [], rawArgv };
  }

  const r = await osa(t.src, argv, { timeoutMs: t.timeoutMs, signal: opts.signal });
  const ms = Date.now() - t0;
  if (!r.ok) return { result: { ok: false, errors: r.errors, argv, ms }, artifacts: [], rawArgv };

  const rb = parseReadback(r.raw, t.fields);
  if (!rb.ok) return { result: { ok: false, errors: rb.errors, argv, ms }, artifacts: [], rawArgv };

  // 产物与 verify 的判据来自同一次回读的同一个字段，不是两套逻辑碰巧一致
  const artifacts: Artifact[] = [];
  for (const [key, field] of Object.entries(t.produces ?? {})) {
    const value = rb.values[field];
    if (value === undefined) continue;
    artifacts.push({ key, value, from: { step, actionId, field } });
  }
  return { result: { ok: true, readback: rb.values, argv, ms }, artifacts, rawArgv };
}
