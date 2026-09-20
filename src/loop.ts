import { randomUUID } from "node:crypto";
import type { AxActionOffer, AxExecContext } from "./ax.ts";
import { LIMITS } from "./config.ts";
import { executionActionId, type BodySource, type Decision, type JudgeInput } from "./decide.ts";
import { ARTIFACT_PREFIX, SPAN_SOURCE, resolveArgs, type ExecContext, type ExecOutcome } from "./execute.ts";
import { freshnessMark, policy, staleness, type PolicyResult } from "./policy.ts";
import { REGISTRY } from "./scripts.ts";
import { extractSpans } from "./spans.ts";
import type { OfferSet } from "./surface.ts";
import { probeIdFor, type Probe, type VerifyInput } from "./verify.ts";
import { isTaskAction, type Artifact, type AxTargetIdentity, type PendingConfirmation, type ProfileGate, type RunState, type Snapshot, type StepRecord, type VerifyResult } from "./types.ts";

/**
 * 四步闭环的编排：observe → judge → act → verify，反复直到收手。
 *
 * 循环存在的理由不是"模型不生成文本所以没法预先规划"——那个理由是从
 * 网页智能体那边继承来的，在静态的 sdef 上并不成立。真实理由有三条：
 * 后一步要用前一步的产物、某一步可能失败需要换条路、步数事先不定。
 *
 * 所有依赖都是函数参数。测试注入假 backend 和假 executor 就能把整个控制流
 * 跑完，不碰网络也不碰应用——这比 mock 框架直白，也不会在重构时悄悄失效。
 *
 * ── 两条恢复路径，别把它们混成一条 ──
 * 机器自己恢复：验证失败 → 重新观察 → 模型改走别的动作（`maxRecoveries`）。不问人。
 * 人来拍板：policy 要求确认 → 挂起（`waiting_for_confirmation`）→ `resumeLoop` 从那一步继续。
 * 前者是「这条路走不通」，后者是「这条路要不要走」。两者会在同一次 run 里交替出现，
 * 所以恢复预算原样穿过挂起：等人回答不是一次失败，取消也不是。
 */

export type LoopDeps = {
  observe: () => Promise<Snapshot>;
  decide: (input: JudgeInput) => Promise<Decision>;
  act: (actionId: string, ctx: ExecContext, step: number) => Promise<ExecOutcome>;
  probe: (id: string, argv?: string[]) => Promise<Probe | null>;
  checkStep: (input: VerifyInput) => Promise<VerifyResult>;
  /** 留痕，失败不影响主流程。 */
  record?: (
    phase: "run.start" | "observe" | "judge" | "act" | "verify" | "suspend" | "resume" | "run.end",
    step: number,
    data: unknown,
  ) => Promise<void>;
};

export type LoopOptions = {
  maxSteps?: number;
  runId?: string;
  /** 连续 WAIT 的容忍次数。超过说明模型在原地打转，不是真的在等。 */
  maxConsecutiveWaits?: number;
  /**
   * 验证失败后允许重新观察并改走其他路径的次数。
   *
   * 失败动作仍留在 proposed 集合里，因此这不是自动重放副作用；模型只能根据
   * 新快照选择另一条动作，或明确收手。超过预算才真正 blocked。
   */
  maxRecoveries?: number;
  /**
   * Chrome profile 闸门状态，原样透传给 policy。
   *
   * loop 不探测也不解释它——探测要读磁盘，而 loop 的全部依赖都是函数参数，
   * 这是它能被纯内存测试跑完整个控制流的原因。
   *
   * **恢复时必须重新探测后再传进来。** 沿用挂起那一刻的值等于跳过 freshness 检查。
   */
  profile?: ProfileGate;
  /**
   * 铸一个 confirmId。可注入只为让测试拿到确定性，与 `journal.ts` 的 `ulid` 同一个路数。
   *
   * 默认走 `randomUUID`：它不是「依赖」，是取一个不可预测的值，
   * 没有它就只能用步数之类可预测的东西当 id，而那样的 id 挡不住重放。
   */
  mintConfirmId?: () => string;
  /**
   * 这一轮的 AX 动作面与反向调用通道。省略等于「本轮没有 AX」，AX 动作于是没有任何执行路径。
   *
   * 它是一个 run 级的常量，不是每步刷新——Swift 的 frame 是单次消费的，一段指令只观察一次
   * （本阶段的能力上限，见设计 §6）。恢复时必须换一份**重新观察**出来的（`cli.ts` 的恢复闭包负责），
   * 沿用挂起那一刻的 frame 等于拿一个必然过期的 offer 去执行。
   */
  ax?: AxExecContext;
};

/** 产物值可能很长（网页标题、URL），给模型看摘要就够，完整值只在代码里流转。 */
function brief(v: string, n = 80): string {
  return v.length <= n ? v : `${v.slice(0, n)}…`;
}

/**
 * `observe` 事件里关于 AX 动作面完整度的那几个字段。
 *
 * 全是数字 / 枚举 / null，**不含任何用户内容**——所以在 `redact.ts` 的 observe 分支里按结构
 * 原样放行（窗口标题那种来路不明的字符串仍然走指纹化）。没有 AX 的那一轮（降级为仅脚本动作）
 * 一个字段都不加，事件形状与引入 AX 之前逐字段相等。
 */
function axObservationFields(ax: AxExecContext | undefined): Record<string, unknown> {
  if (!ax) return {};
  return {
    axTruncated: ax.truncated?.reason ?? null,
    axNodes: ax.truncated?.nodes ?? null,
    axNextOffset: ax.nextOffset ?? null,
  };
}

/**
 * 构造"正文可以取自哪里"的候选。
 *
 * 产物值来自页面回读，是不可信数据。把它放进 state 给模型看是安全的：
 * 模型只回答选择题、只返回概率分布，它的输出还要过白名单和逐字校验才可能变成动作。
 * 不安全的是把它拼进脚本文本——那条路在 osa.ts 里根本不存在。
 */
function bodySourcesFrom(artifacts: readonly Artifact[], span: string | null): BodySource[] {
  const out: BodySource[] = artifacts.map((a) => ({
    key: `${ARTIFACT_PREFIX}${a.key}`,
    hint: `第 ${a.from.step} 步得到的 ${a.key}：${brief(a.value)}`,
  }));
  if (span) out.push({ key: SPAN_SOURCE, hint: `用户原话里的片段：${brief(span)}` });
  return out;
}

/**
 * 一个 AX offer 的目标身份。role / label 取自 offer，app 取自这一帧归属的前台应用。
 * offer 不在这一帧里时返回 undefined——它就不是一个能认领的 AX 目标。
 */
function axTargetOf(ax: AxExecContext | undefined, offer: AxActionOffer | undefined): AxTargetIdentity | undefined {
  if (!ax || !offer) return undefined;
  return { operation: offer.operation, app: ax.app, role: offer.target.role, label: offer.target.label };
}

/**
 * 目标身份的规范串。
 *
 * 用 JSON 数组而不是拼 `|`：label 是用户界面上的文字，完全可能自带分隔符，拼串会让两个
 * 不同的目标（例如 `a|b` 与 `a` + `b`）得到同一个键。JSON 转义把这件事堵死在编码层。
 */
function axTargetKey(t: AxTargetIdentity): string {
  return `AX|${JSON.stringify([t.operation, t.app, t.role, t.label])}`;
}

/** 在 `ax.offers` 里按 offerId 找出目标身份。 */
function axTargetById(ax: AxExecContext | undefined, offerId: string): AxTargetIdentity | undefined {
  return axTargetOf(ax, ax?.offers.find((o) => o.id === offerId));
}

/**
 * 在新 frame 里按目标身份重新认领一个 offer，返回它的 id。
 *
 * 宁可漏认不认错：命中数不等于 1（0 个或 ≥2 个）时返回 null，调用方据此 blocked。
 * 「≥2 个」不是理论情形——同一窗口里两个都叫「确定」的按钮就是命中两个，
 * 此时无法确定人批准的是哪一个，唯一安全的答案是「不执行」。
 */
function claimTarget(ax: AxExecContext | undefined, target: AxTargetIdentity): string | null {
  if (!ax) return null;
  const want = axTargetKey(target);
  const hits = ax.offers.filter((o) => axTargetKey(axTargetOf(ax, o)!) === want);
  return hits.length === 1 ? hits[0].id : null;
}

/**
 * 重复守卫的键：同一个动作配同一组解析结果，第二次提议就说明在原地打转。
 *
 * 脚本动作按 actionId + 解析出的 argv 做键。AX 动作没有 argv，而 offerId 每次 observe 都变——
 * 拿 id 当键等于没有守卫（同一个按钮换一帧就是新键，多步刷新 frame 会直接击穿）。
 * 所以换成**目标身份**（operation + app + role + label），刻意不含 offerId 与 frameId。
 * 代价是两个同名按钮被当成同一个目标；这是「宁可漏做，不可重做」的保守方向，
 * 也是第 7 节里「按 label 重新认领目标」被否掉的同一个理由。
 */
function guardKey(actionId: string, ctx: ExecContext): string {
  const t = REGISTRY[actionId];
  if (t) {
    const r = resolveArgs(t, ctx);
    return `${actionId}|${r.ok ? JSON.stringify(r.argv) : "<解析失败>"}`;
  }
  const target = axTargetById(ctx.ax, actionId);
  if (target) return axTargetKey(target);
  return `${actionId}|<无模板>`;
}

function summarize(rec: StepRecord): string {
  const v = rec.verify ? (rec.verify.ok ? "验证通过" : "验证未过") : "未验证";
  return `第 ${rec.step} 步：${rec.actionId} — ${v}`;
}

/**
 * 一次 run 里会被跨步骤改写的那些量。
 *
 * 做成一个对象而不是散落的局部变量，是为了让挂起能把它们整份存下来、恢复能整份装回去。
 * 少带一个，恢复出来的就是一个预算被悄悄清零的 run。
 */
type Runtime = {
  state: RunState;
  proposed: Set<string>;
  waits: number;
  recoveries: number;
  unresolvedFailure: boolean;
};

type Limits = { maxSteps: number; maxWaits: number; maxRecoveries: number };

function limitsOf(opts: LoopOptions): Limits {
  return {
    maxSteps: opts.maxSteps ?? LIMITS.maxSteps,
    maxWaits: opts.maxConsecutiveWaits ?? 2,
    maxRecoveries: opts.maxRecoveries ?? 2,
  };
}

/**
 * 记一条 run.start、跑完、再记一条 run.end。
 *
 * 包在外面而不是散进 runSteps 的每个 return：那里有七条返回路径，
 * 漏掉任何一条都会让留痕里出现一条永远没有结局的 run。挂起也算一种结局，
 * 所以 `waiting_for_confirmation` 同样落 run.end——一条等着人回答的 run
 * 可能永远等不到回答，留痕不能因此停在半截。恢复是另一段，它自己再落一条。
 */
export async function runLoop(
  utterance: string,
  offerSet: OfferSet,
  deps: LoopDeps,
  opts: LoopOptions = {},
): Promise<RunState> {
  await deps.record?.("run.start", 0, {
    utterance,
    maxSteps: opts.maxSteps ?? LIMITS.maxSteps,
    offers: offerSet.offers.length,
    profile: opts.profile?.kind ?? "absent",
  });
  const state = await runSteps(utterance, offerSet, deps, opts);
  await endRun(state, deps);
  return state;
}

/**
 * 从挂起处继续，**不把历史重新解释成一条新命令**。
 *
 * `offerSet` 由调用方传回同一套：换一套动作面，那个待确认动作的 spec 与 risk 都可能变了，
 * 于是人批准的和即将执行的就不是同一件事。
 *
 * `approved === false`（用户取消）不是一次失败：它既不消耗恢复预算，也不改 `unresolvedFailure`，
 * 只是让这条 run 就地收手。理由是取消之后继续循环的话，模型多半会再提议同一个动作，
 * 气泡就会反复弹——把人训练成闭眼点「确认」，那比不问还危险。
 */
export async function resumeLoop(
  state: RunState,
  offerSet: OfferSet,
  approved: boolean,
  deps: LoopDeps,
  opts: LoopOptions = {},
): Promise<RunState> {
  const out = await resumeSteps(state, offerSet, approved, deps, opts);
  await endRun(out, deps);
  return out;
}

function endRun(state: RunState, deps: LoopDeps): Promise<void> | undefined {
  return deps.record?.("run.end", state.steps.length, {
    status: state.status,
    steps: state.steps.length,
    artifacts: state.artifacts.length,
  });
}

async function runSteps(
  utterance: string,
  offerSet: OfferSet,
  deps: LoopDeps,
  opts: LoopOptions,
): Promise<RunState> {
  const rt: Runtime = {
    state: { runId: opts.runId ?? "", utterance, status: "running", steps: [], artifacts: [] },
    proposed: new Set<string>(),
    waits: 0,
    recoveries: 0,
    unresolvedFailure: false,
  };
  await drive(rt, 1, offerSet, deps, opts, limitsOf(opts));
  return rt.state;
}

async function resumeSteps(
  state: RunState,
  offerSet: OfferSet,
  approved: boolean,
  deps: LoopDeps,
  opts: LoopOptions,
): Promise<RunState> {
  const pending = state.pending;
  // 没有挂起点就没有「人批准过的那一步」可执行。恢复第二次、恢复一个没挂起过的 run，
  // 都落在这里：缺省必须等于拦住，不能因为调用方说了「同意」就去跑点什么
  if (!pending || state.status !== "waiting_for_confirmation") {
    state.pending = undefined;
    state.status = "blocked";
    return state;
  }
  // 早于任何 await 就把挂起点消费掉：两次 session.confirm 竞争时，
  // 第二次进来看到的只能是上面那条已经没有 pending 的路径
  state.pending = undefined;
  state.status = "running";

  const limits = limitsOf(opts);
  const cp = pending.checkpoint;
  const rt: Runtime = {
    state,
    proposed: new Set(cp.proposed),
    waits: cp.waits,
    recoveries: cp.recoveries,
    unresolvedFailure: cp.unresolvedFailure,
  };

  // 挂起那一刻这条记录就已经在账上了（否则 UI 拿不到「卡在哪一步、为什么」）。
  // 对不上号说明传进来的不是当初挂起的那条 run
  const rec = state.steps.find((s) => s.step === pending.step);
  if (!rec || rec.actionId !== pending.actionId) {
    state.status = "blocked";
    return state;
  }

  if (!approved) {
    rec.reasons.push("用户取消了确认，这一步没有执行");
    state.status = "blocked";
    await deps.record?.("resume", pending.step, { confirmId: pending.confirmId, approved: false, stale: [] });
    return state;
  }

  // 重新观察，而不是拿挂起时那份快照。人可能盯着气泡看了五分钟
  const snapshot = await deps.observe();
  // 留痕要能看出这次观察是不是被截断的：AX 完整度那几个字段随事件一起落盘（都是结构，见 redact.ts）
  await deps.record?.("observe", pending.step, {
    front: snapshot.front,
    window: snapshot.window,
    ...axObservationFields(opts.ax),
  });
  const drift = staleness({
    mark: cp.freshness,
    now: freshnessMark(snapshot, opts.profile),
    // AX 动作的 app 只能从挂起时记下的目标身份里取，去 offerSet 里查是查不到的：
    // 这里的 offerSet 是拿**新 frame** 重建的，挂起时那个 offerId 在新 frame 里已经不存在。
    // 查不到就是 undefined，而 staleness 的缺省把 undefined 当 Chrome（缺省收紧），
    // 于是一次与 Chrome 毫无关系的点击，会因为 Chrome profile 探测结果变了而被拦死。
    // 脚本动作没有 target，仍按 id 查 specs——它的 id 是冻结常量，跨挂起有效。
    app: pending.target?.app ?? offerSet.specs.get(pending.actionId)?.app,
  });
  // observe 必须排在这条之前（先看清楚才谈得上判定），所以留痕里的顺序是 observe → resume
  await deps.record?.("resume", pending.step, {
    confirmId: pending.confirmId,
    approved: true,
    stale: drift.map((s) => s.field),
  });
  if (drift.length > 0) {
    rec.reasons.push(...drift.map((s) => s.detail), "确认期间世界变了，人批准的不是现在这件事");
    state.status = "blocked";
    return state;
  }
  // 这一步实际执行时面对的是新快照，账上就该记新的那份
  rec.observe = snapshot;

  // AX 目标的重认领。挂起时那对 (frameId, offerId) 到这一刻必然作废——frame 是单次消费的，
  // 换一次观察就是新 id。但人批准的是「那一刻那个东西」，不是那个 id，所以在新 frame 里按
  // (operation, app, role, label) 重新找它。要求**恰好唯一**命中：找不到（目标没了）或
  // 找到不止一个（两个同名按钮），都当成「他批准的那个东西不在了」，就地 blocked，绝不执行。
  // 刻意否掉「直接拿挂起时那对 id 去执行」：它要么必然 rejected_stale，
  // 要么要求 frame TTL 长到覆盖人的思考时间——后者等于取消 freshness。
  let actionId = pending.actionId;
  if (pending.target) {
    const claimed = claimTarget(opts.ax, pending.target);
    if (!claimed) {
      rec.reasons.push("目标已经不在当前界面上，没有执行");
      state.status = "blocked";
      return state;
    }
    // 账上记的是**实际执行的那个** offer：旧 offerId 从没被发出去过
    actionId = claimed;
    rec.actionId = claimed;
  }

  const ctx: ExecContext = { span: cp.span, bodySource: cp.bodySource, artifacts: state.artifacts, ax: opts.ax };
  const verdict = await performAction(rt, deps, limits, {
    step: pending.step,
    rec,
    actionId,
    ctx,
    recorded: true,
  });
  if (verdict === "stop") return state;
  await drive(rt, pending.step + 1, offerSet, deps, opts, limits);
  return state;
}

/** observe → judge → policy → 分支，从 `from` 步跑到步数上限。 */
async function drive(
  rt: Runtime,
  from: number,
  offerSet: OfferSet,
  deps: LoopDeps,
  opts: LoopOptions,
  limits: Limits,
): Promise<void> {
  const { state } = rt;
  const mint = opts.mintConfirmId ?? randomUUID;

  for (let step = from; step <= limits.maxSteps; step++) {
    const snapshot = await deps.observe();
    await deps.record?.("observe", step, {
      front: snapshot.front,
      window: snapshot.window,
      ...axObservationFields(opts.ax),
    });

    const spans = extractSpans(state.utterance);
    // 先用最可能的片段构造正文候选；模型改选了别的片段，下一轮自然会跟着变
    const bodySources = bodySourcesFrom(state.artifacts, spans[0] ?? null);

    const decision = await deps.decide({
      utterance: state.utterance,
      snapshot,
      offers: offerSet.offers,
      spans,
      bodySources,
      history: state.steps.map(summarize),
      // 动作面的完整度随 frame 一起来（`opts.ax`）。它不属于 Snapshot——那是"屏幕上现在是什么"，
      // 而这是"我们这一轮看到了多少"。少了它，模型无从知道目标列表是不是残缺的。
      truncated: opts.ax?.truncated,
      nextOffset: opts.ax?.nextOffset,
    });
    await deps.record?.("judge", step, decision);

    // 决策消费一次：判断已经产生，后面无论走哪条分支都不会再用这一份
    const j = decision.judgement;
    // 执行层只认一个动作 id：AX 的两级 head 在这里合成——action 说「用哪类能力」，
    // targetId 说「对谁做」。少了这一步，模型选了 AX 动作也会被 policy 当成未提供的选项拦掉。
    const actionId = executionActionId(decision);

    let p: PolicyResult;
    if (decision.violations.length > 0) {
      // 答案校验没过就整条作废，绝不 act。模型返回了我们没给过的东西，
      // 说明这次交互本身不可信，挑出"看起来还行的那部分"继续用是错的
      p = { kind: "ignore", actionId: null, reasons: decision.violations };
    } else {
      p = policy({
        // 交给 policy 的是合成后的 id（判断其余字段不变），它按这个 id 查动作面、算 spec
        judgement: { ...j, action: actionId },
        offered: offerSet.ids,
        // 两类 spec 分开存：脚本动作在 specs，AX 动作在 axSpecs。漏掉后一支，AX 动作
        // 走到 policy 时 spec 就成了 undefined，会被「动作面里没有这个 id」静默拦死。
        spec: offerSet.specs.get(actionId) ?? offerSet.axSpecs.get(actionId),
        template: REGISTRY[actionId],
        profile: opts.profile,
      });
    }

    const rec: StepRecord = {
      step,
      observe: snapshot,
      judgement: j,
      actionId: p.actionId ?? actionId,
      exec: null,
      verify: null,
      reasons: p.reasons,
    };

    if (p.kind === "wait") {
      rt.waits++;
      state.steps.push(rec);
      if (rt.waits > limits.maxWaits) {
        rec.reasons.push(`连续 ${rt.waits} 次 WAIT，判定为原地打转`);
        state.status = "blocked";
        return;
      }
      continue;
    }
    rt.waits = 0;

    // confirm 却拿不出动作 id 是不该出现的组合。真出现了就当追问处理：
    // 没有「待确认的那一步」，挂起之后也无从恢复，不如如实说信息不够
    if (p.kind === "ask" || (p.kind === "confirm" && p.actionId === null)) {
      state.steps.push(rec);
      state.status = "needs_input";
      return;
    }

    if (p.kind === "confirm" && p.actionId !== null) {
      // 挂起而不是丢掉上下文：已执行步骤与 artifacts 留在 state 里，
      // 待确认动作的参数与恢复预算存进 checkpoint，恢复时从这一步接着跑
      const pending: PendingConfirmation = {
        confirmId: mint(),
        step,
        actionId: p.actionId,
        // AX 动作记下目标身份，恢复时靠它在新 frame 里重新认领；脚本动作这里恒为 undefined
        target: axTargetById(opts.ax, p.actionId),
        reasons: [...p.reasons],
        checkpoint: {
          // 待确认动作刻意**不**进 proposed：它还没执行过，先记上的话恢复时会被
          // 重复守卫拦住自己
          proposed: [...rt.proposed],
          waits: rt.waits,
          recoveries: rt.recoveries,
          unresolvedFailure: rt.unresolvedFailure,
          span: decision.span,
          bodySource: decision.bodySource,
          freshness: freshnessMark(snapshot, opts.profile),
        },
      };
      state.steps.push(rec);
      state.status = "waiting_for_confirmation";
      state.pending = pending;
      // 只记结构：confirmId 是本轮现铸的、actionId 是动作 id、gate 是枚举值。
      // policy 的 reasons 不记——那串文本里可能带 Chrome profile 目录名
      await deps.record?.("suspend", step, {
        confirmId: pending.confirmId,
        // 脚本 / 任务层动作的 id 是本系统的冻结常量，不含用户内容，按 actionId 原样留痕；
        // AX 的 offerId 是 Swift 每次观察现铸的外部串，与 judge 事件里的 targetId 是同一个值，
        // 必须走同一个字段名，否则它就靠「换了个在白名单里的字段名」绕开了脱敏。
        // 判据用 pending.target 而不是猜 id 的形状：有目标身份的必然是 AX 动作。
        ...(pending.target ? { targetId: pending.actionId } : { actionId: pending.actionId }),
        gate: opts.profile?.kind ?? "absent",
      });
      return;
    }

    if (p.kind === "ignore") {
      state.steps.push(rec);
      // 终止不信任 DONE：模型说完成了，还得每一步都验证通过才算数
      if (actionId === "DONE") {
        const executed = state.steps.filter((s) => s.exec !== null);
        const hasVerifiedAction = executed.some((s) => s.verify?.ok === true);
        if (hasVerifiedAction && !rt.unresolvedFailure) {
          state.status = "done";
        } else {
          state.status = "blocked";
          rec.reasons.push(
            executed.length === 0
              ? "模型声称完成，但一个动作都没有执行过"
              : "模型声称完成，但最近的失败还没有被另一条已验证路径恢复",
          );
        }
        return;
      }
      state.status = "blocked";
      return;
    }

    // ── p.kind === "execute" ──
    const ctx: ExecContext = {
      span: decision.span,
      bodySource: decision.bodySource,
      artifacts: state.artifacts,
      ax: opts.ax,
    };
    const verdict = await performAction(rt, deps, limits, {
      step,
      rec,
      actionId: p.actionId!,
      ctx,
      recorded: false,
    });
    if (verdict === "stop") return;
  }

  // 走完 maxSteps 还没收手。步数上限按"最坏情况用户能接受几次误操作"定，不是按 token
  state.status = "blocked";
}

/**
 * 真的把一个动作发出去，然后验证它。
 *
 * 抽出来是因为它有两个入口：正常循环里的 execute 分支，和人确认之后的恢复。
 * 两条路必须共用同一段代码——重复守卫、pre/post 探针、「验证通过才入账 artifacts」
 * 这三条要是只有一条路上有，那条没有的路就是一个静默的安全漏洞。
 *
 * `recorded` 说的是 `rec` 在不在 `state.steps` 里了：挂起时已经推过一次，
 * 恢复时再推就会让同一步在账上出现两遍。
 */
async function performAction(
  rt: Runtime,
  deps: LoopDeps,
  limits: Limits,
  plan: { step: number; rec: StepRecord; actionId: string; ctx: ExecContext; recorded: boolean },
): Promise<"continue" | "stop"> {
  const { state } = rt;
  const { step, rec, actionId, ctx } = plan;
  const push = () => {
    if (!plan.recorded) state.steps.push(rec);
    plan.recorded = true;
  };

  const key = guardKey(actionId, ctx);
  if (rt.proposed.has(key)) {
    rec.reasons.push(`同一个动作配同一组参数被第二次提议：${key}`);
    push();
    state.status = "blocked";
    return "stop";
  }
  rt.proposed.add(key);

  const probeId = probeIdFor(actionId);
  const pre = probeId ? await deps.probe(probeId) : null;

  const outcome = await deps.act(actionId, ctx, step);
  rec.exec = outcome.result;
  // 执行后先记录再观察：万一取快照或验证炸了，这次真实发生过的动作也不能从账上消失
  push();
  await deps.record?.("act", step, outcome.result);

  // 执行层报 stop：切片切不出动作需要的内容，连调用都没发生。它不是失败——
  // 缺输入重试多少次还是缺，所以既不消耗恢复预算、也不触发「换条路重试」，
  // 就地收手去问用户缺什么。
  if (outcome.stop === "needs_more_input") {
    rec.reasons.push("这一步需要更多信息才能执行，没有发出任何动作");
    state.status = "needs_input";
    return "stop";
  }

  // 观察与验证都可能抛：探针是另一次 Apple Event，应用随时可能没响应。
  // 但动作已经真实发生了，异常不能把它连同整条 state 一起带走——
  // 「执行后先记录再观察」只有在这里兜住异常时才真的成立
  try {
    const post = probeId ? await deps.probe(probeId) : null;
    rec.verify = await deps.checkStep({
      actionId,
      exec: outcome.result,
      rawArgv: outcome.rawArgv,
      pre,
      post,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    rec.verify = { ok: false, checks: [{ name: "verify_crashed", ok: false, detail }] };
  }
  await deps.record?.("verify", step, rec.verify);

  if (!rec.verify.ok) {
    rt.unresolvedFailure = true;
    rt.recoveries++;
    if (rt.recoveries > limits.maxRecoveries) {
      rec.reasons.push(`连续 ${rt.recoveries} 次验证失败，超过恢复预算 ${limits.maxRecoveries}`);
      state.status = "blocked";
      return "stop";
    }
    rec.reasons.push(`验证未通过；重新观察并改走其他路径（恢复 ${rt.recoveries}/${limits.maxRecoveries}）`);
    return "continue";
  }

  // 只有验证通过的产物才能进入后续步骤。否则一次未确认成功的网页地址或对象 id
  // 会污染下一步，让“恢复”沿着错误事实继续执行。
  state.artifacts.push(...outcome.artifacts);
  rt.unresolvedFailure = false;
  return "continue";
}

export { isTaskAction };
export type { PendingConfirmation };
