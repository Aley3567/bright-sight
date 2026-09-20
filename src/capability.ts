import { isAllowedApp } from "./config.ts";
import { escapeNotesHtml, osa, parseReadback } from "./osa.ts";
import { REGISTRY, type ScriptTemplate } from "./scripts.ts";
import { resolveArgs, sourceValue, type ExecContext, type ExecOutcome } from "./execute.ts";
import { performAX, type AxActionOffer, type AxOperation, type AxPerformParams, type AxPerformResult } from "./ax.ts";
import type { Artifact } from "./types.ts";

/**
 * 能力适配器：把「一个动作怎么解析、怎么执行」收敛到唯一一处。
 *
 * 阶段 5.0 只做搬家——把现有的两个冻结脚本动作原样包进 scriptAdapter，
 * 分派、措辞、投递路径全部逐字不变，先用一条表驱动断言证明「搬家没改行为」。
 * 阶段 5.1 replace-don't-layer：ADAPTERS 多一个 axAdapter、Resolved 多一个 ax 分支，
 * 而这条分派逻辑本身没有动。
 *
 * 分两步的理由：同时做「改分派」和「搬动作」的话，出问题时分不清是哪一侧错的。
 */

/**
 * 动作的来源。
 *
 * 5.0 只有 "script" 真正落地；5.1 起 "ax" 也由一个适配器认领（见 axAdapter），
 * 认领与否取决于本轮 observe 出来的 frame，而不是任何模块级常量。
 */
export type ActionKind = "script" | "ax";

/**
 * 解析结果。纯数据：可留痕、可比较、可逐字段断言——
 * 5.0 的判据正是拿它与 resolveArgs 的输出做逐字段比对。
 *
 * ax 分支刻意不含 argv：AX 动作不发 Apple Event，没有 argv 可解析。它携带的是执行 AX 所需的
 * frame 身份与目标 offer——`offerId` 只在 `frameId` 那个 frame 里有效，两者必须一起走到底。
 *
 * 失败分支上的 `stop` 是 5.6 的切片路径：TYPE_TEXT 切不出文本时，它不是「这条路走不通」，
 * 而是「缺输入」。这个信号必须自带，否则调用方只看 `ok: false` 就会按失败收场。
 */
export type Resolved =
  | { ok: true; kind: "script"; template: ScriptTemplate; argv: string[] }
  | { ok: true; kind: "ax"; frameId: string; offerId: string; operation: AxOperation; value?: string }
  | { ok: false; errors: string[]; stop?: "needs_more_input" };

/** perform 需要的全部执行参数。step 单列是因为产物 provenance 要靠它，别处取不到。 */
export type ExecOptions = {
  step: number;
  dryRun?: boolean;
  signal?: AbortSignal;
};

export type CapabilityAdapter = {
  readonly kind: ActionKind;
  /**
   * 认不认这个动作。
   *
   * `ctx` 只在需要看本轮动作面的适配器上用——脚本注册表是冻结的全局表，一个 id 就够判断；
   * AX 的 offer 每次 observe 现铸，认领与否只能看这一轮的上下文，所以它由 ctx 决定。
   * 缺省（或没有 ctx.ax）一律不认领，fail-closed。
   */
  owns(actionId: string, ctx?: ExecContext): boolean;
  /** 把上下文解析成可执行计划。纯函数，只读 ctx，不产生任何副作用。 */
  plan(actionId: string, ctx: ExecContext): Resolved;
  /** 发出去。这是本模块唯一产生副作用的地方。 */
  perform(resolved: Resolved, ctx: ExecContext, opts: ExecOptions): Promise<ExecOutcome>;
};

/**
 * 「这个 id 没有可执行路径」的统一措辞。
 *
 * planOf 的兜底与 scriptAdapter 的防御性重查共用同一个函数：既有测试正是按这句话的
 * 片段断言的，两处各写一遍迟早会漂移。
 */
function noScriptPath(actionId: string): string {
  return `${actionId} 不在执行模板注册表里，本轮不支持执行它`;
}

/** AX 动作没有可执行路径时的措辞。与 noScriptPath 分开，是因为「不在注册表」和「不在本 frame」是两回事。 */
function noAxPath(actionId: string): string {
  return `${actionId} 不在本轮的 AX 动作面里，没有可执行的 AX 路径`;
}

/**
 * 脚本适配器：包住冻结的 REGISTRY。
 *
 * plan 里的三道重查（注册表 / 白名单 / 破坏性）是从 execute() 原样搬过来的，顺序与措辞
 * 都没动。它们必须发生在解析 argv **之前**：被拦下的动作不该先拼出一份看起来能用的参数。
 * 注册表存在性的判据是 REGISTRY[id]——它是冻结的普通对象，不是 Map。
 */
export const scriptAdapter: CapabilityAdapter = {
  kind: "script",
  owns: (actionId) => REGISTRY[actionId] !== undefined,
  plan: (actionId, ctx) => {
    const t = REGISTRY[actionId];
    // 经 planOf 进来时 owns 已经保证 t 存在；直接调 plan 时这条兜住，保持 fail-closed
    if (!t) return { ok: false, errors: [noScriptPath(actionId)] };
    if (!isAllowedApp(t.app)) return { ok: false, errors: [`${t.app} 不在执行白名单内`] };
    if (t.effect === "destroy") return { ok: false, errors: [`${actionId} 声明了破坏性副作用，执行层不提供这条路径`] };

    const r = resolveArgs(t, ctx);
    if (!r.ok) return { ok: false, errors: r.errors };
    return { ok: true, kind: "script", template: t, argv: r.argv };
  },
  perform: performScript,
};

/**
 * AX 适配器：把本 frame 里的一条 offer 变成一次 `ax.perform`。
 *
 * 它认领与否只能看这一轮的 `ctx.ax`——offer 是每次 observe 现铸的，不像脚本注册表那样冻结。
 * `plan` 只做「从 ctx 里把 frame / offer / operation 取出来」这件事，不生成任何脚本文本；
 * `perform` 调 `performAX`，**不发 Apple Event**。
 */
export const axAdapter: CapabilityAdapter = {
  kind: "ax",
  owns: (actionId, ctx) => ctx?.ax?.offers.some((o) => o.id === actionId) ?? false,
  plan: (actionId, ctx) => {
    const ax = ctx.ax;
    if (!ax) return { ok: false, errors: [noAxPath(actionId)] };
    const offer = ax.offers.find((o) => o.id === actionId);
    if (!offer) return { ok: false, errors: [noAxPath(actionId)] };
    if (offer.operation === "TYPE_TEXT") return planTypeText(ax.frameId, offer, ctx);
    return { ok: true, kind: "ax", frameId: ax.frameId, offerId: actionId, operation: offer.operation };
  },
  perform: performAx,
};

/**
 * TYPE_TEXT 的切片路径：文本只从 `ctx.span` / `ctx.bodySource` 取，与脚本动作共用
 * `sourceValue` 那一套取值语法（`span` / `artifact:<key>`）。
 *
 * 切不出值时返回带 `stop` 的失败，而**不是**普通的 `ok: false`：缺输入不是失败，
 * 重试多少次还是缺。runAction 会把 `stop` 原样交给 loop，让它置 `needs_input` 去问用户。
 * 也刻意不拿空串顶替——空串会让「输入框被清空」看起来像一次成功的文本输入。
 *
 * 认不出的来源同样收手，不静默回退到 `ctx.span`：来源是模型从候选里挑的 key，
 * 挑了个我们没给过的，说明这次判断已经失准，不该顺着它猜一个「大概是这个」。
 */
function planTypeText(frameId: string, offer: AxActionOffer, ctx: ExecContext): Resolved {
  const stop = (errors: string[]): Resolved => ({ ok: false, errors, stop: "needs_more_input" });
  const src = ctx.bodySource;
  if (!src) return stop([`${offer.id} 需要文本，但没有指定文本来源`]);
  const picked = sourceValue(ctx, src, ctx.span ?? undefined);
  if (!picked.ok) {
    return stop([
      picked.reason === "unknown"
        ? `无法识别的文本来源 ${JSON.stringify(src)}`
        : `文本来源 ${src} 还没有产出值`,
    ]);
  }
  if (picked.value.length === 0) return stop([`文本来源 ${src} 取到的内容是空的`]);
  return { ok: true, kind: "ax", frameId, offerId: offer.id, operation: offer.operation, value: picked.value };
}

/**
 * 统一优先级：精确（冻结脚本）→ 特化（AX）→ 兜底。
 * 顺序即语义：脚本 id 与 AX offerId 此刻不会撞，但先认领者胜这条性质要由测试钉住。
 */
export const ADAPTERS: readonly CapabilityAdapter[] = [scriptAdapter, axAdapter];

function adapterFor(actionId: string, ctx: ExecContext): CapabilityAdapter | undefined {
  return ADAPTERS.find((a) => a.owns(actionId, ctx));
}

/**
 * 分派：找到认领这个动作的适配器，交给它 plan。
 *
 * 「没有适配器」= 既不在冻结注册表里，也不在本轮 AX 动作面里。兜底措辞沿用搬家前
 * execute() 的那一句（既有测试按它的片段断言），因为最常走到它的是「注册表外的脚本动作」。
 */
export function planOf(actionId: string, ctx: ExecContext): Resolved {
  const adapter = adapterFor(actionId, ctx);
  if (!adapter) return { ok: false, errors: [noScriptPath(actionId)] };
  return adapter.plan(actionId, ctx);
}

/** 失败结局的统一构造。argv 恒为空——还没走到投递那一步。 */
function failed(errors: string[]): ExecOutcome {
  return { result: { ok: false, errors, argv: [], ms: 0 }, artifacts: [], rawArgv: [] };
}

/**
 * 收手结局：没有发出任何动作，但也不是一次失败。
 *
 * `result.ok` 仍是 false——`ExecResult` 的 ok 分支不带 `errors` 字段，缺什么的说明只能挂在
 * 失败分支上。真正区分「缺输入」与「失败」的是 `stop`，loop 见到它就置 `needs_input` 收手，
 * 既不消耗恢复预算、也不触发「换条路重试」。空的 argv / readback 是「这次什么都没发出去」
 * 的准确表达，不为了字段好看编一个。
 */
function stopped(errors: string[]): ExecOutcome {
  return { result: { ok: false, errors, argv: [], ms: 0 }, artifacts: [], rawArgv: [], stop: "needs_more_input" };
}

/**
 * 从 id 到真实投递的唯一一条路：先 planOf 拿计划，再由认领它的适配器 perform。
 *
 * cli.ts 的 act 依赖与 execute.ts 的 execute() 都经由它，所以不存在
 * 「两条路都能执行同一个脚本动作」的并列分支——这是搬家的目的，不是新增后备。
 */
export async function runAction(actionId: string, ctx: ExecContext, opts: ExecOptions): Promise<ExecOutcome> {
  const adapter = adapterFor(actionId, ctx);
  if (!adapter) return failed([noScriptPath(actionId)]);
  const resolved = adapter.plan(actionId, ctx);
  if (!resolved.ok) {
    // 计划带 stop 的失败其实是「缺输入」：把 stop 原样交给 loop，让它置 needs_input 收手。
    // 折成普通失败的话，loop 会当成「这条路走不通」，消耗恢复预算去重试——而缺输入重试多少次还是缺。
    return resolved.stop === "needs_more_input" ? stopped(resolved.errors) : failed(resolved.errors);
  }
  return adapter.perform(resolved, ctx, opts);
}

/**
 * 真正把冻结脚本投递出去。
 *
 * 与 plan 分开的理由不是「职责好看」：plan 可以被穷举断言，perform 一旦发出 Apple Event
 * 就收不回来。dryRun 停在投递之前，于是演练与真跑共用这一段，差别只在最后一步发不发。
 */
async function performScript(resolved: Resolved, _ctx: ExecContext, opts: ExecOptions): Promise<ExecOutcome> {
  const t0 = Date.now();
  const fail = (errors: string[], argv: string[] = []): ExecOutcome => ({
    result: { ok: false, errors, argv, ms: Date.now() - t0 },
    artifacts: [],
    rawArgv: argv,
  });
  // perform 正常只会拿到 plan 成功的结果；真拿到失败结果时如实报错，不断言——
  // 「没有计划」和「计划说不能做」都该是失败，不是崩溃
  if (!resolved.ok) return fail(resolved.errors);
  // Resolved 现在多了一个 ax 分支。分派保证 scriptAdapter 只会拿到自己的 script 计划，
  // 真拿到别的就如实失败，不去断言「不可能发生」
  if (resolved.kind !== "script") return fail([`脚本适配器收到了非脚本计划：${resolved.kind}`]);

  const t = resolved.template;
  const rawArgv = resolved.argv.slice();
  const argv = resolved.argv.slice();
  // argv 个数是模板契约：解析多一个少一个都说明 resolveArgs 与模板脱节了
  if (argv.length !== t.argv.length) {
    return fail([`参数个数不符：模板要 ${t.argv.length} 个，解析出 ${argv.length} 个`], argv);
  }
  // Notes 强制把 body 当 HTML 解析——实测传纯文本时 <tag> 会被整个吞掉、& 变成畸形实体。
  // 转义的是 argv 的内容，不改变「值不拼进脚本文本」这条不变式。
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
    artifacts.push({ key, value, from: { step: opts.step, actionId: t.id, field } });
  }
  return { result: { ok: true, readback: rb.values, argv, ms }, artifacts, rawArgv };
}

/**
 * 真正发出一条 AX 动作。
 *
 * 与 performScript 的根本差别：这里**不生成脚本文本、不发 Apple Event**，只把 frame / offer /
 * operation 原样交给 Swift 的 `ax.perform`。因此 argv 恒为 `[]`——它没有 argv，`[]` 就是
 * 「这次没有 Apple Event 发出去」的准确表达。`readback` 同样为空：AX 的可观测变化由 Swift
 * 在执行前后复验，结论放在 `result.ax.verify` 里，不在这里编造回读字段。
 *
 * `result.ok` 说的是「这次调用走完了」，不是「动作成功了」。业务结局全在 `result.ax.status`：
 * 一个 `failed` / `rejected_stale` / `effect_unknown` 的 perform 同样是 ok 的调用，
 * 该不该算成功由 `verify.ts` 按 `ax.status` 判负。
 */
async function performAx(resolved: Resolved, ctx: ExecContext, opts: ExecOptions): Promise<ExecOutcome> {
  const t0 = Date.now();
  const fail = (errors: string[]): ExecOutcome => ({
    result: { ok: false, errors, argv: [], ms: Date.now() - t0 },
    artifacts: [],
    rawArgv: [],
  });
  if (!resolved.ok) return fail(resolved.errors);
  if (resolved.kind !== "ax") return fail([`AX 适配器收到了非 AX 计划：${resolved.kind}`]);
  const ax = ctx.ax;
  if (!ax) return fail([noAxPath(resolved.offerId)]);

  if (opts.dryRun) {
    // dry-run 连一次反向调用都不发出去。status 记 executed 是为了让「计划长什么样」能被打印出来，
    // detail 里如实写明没有执行。
    return {
      result: {
        ok: true,
        readback: {},
        argv: [],
        ms: Date.now() - t0,
        ax: { status: "executed", verify: { ok: true, detail: "dry-run 未执行" } },
      },
      artifacts: [],
      rawArgv: [],
    };
  }

  const params: AxPerformParams = { frameId: resolved.frameId, offerId: resolved.offerId, operation: resolved.operation };
  if (resolved.value !== undefined) params.value = resolved.value;

  let r: AxPerformResult;
  try {
    r = await performAX(ax.peer, params, { signal: opts.signal });
  } catch (err) {
    // 传输层错误（peer 断了、响应畸形）在这里收成一次失败，不让异常带走整条 state
    return fail([err instanceof Error ? err.message : String(err)]);
  }
  return {
    result: { ok: true, readback: {}, argv: [], ms: Date.now() - t0, ax: { status: r.status, verify: r.verify } },
    artifacts: [],
    rawArgv: [],
  };
}
