import { DEFAULT_ENGINE, SEARCH_ENGINES } from "./config.ts";
import {
  METHOD_SESSION_DESCRIBE,
  METHOD_SESSION_HANDLE,
  PROTOCOL_VERSION,
  RESERVED_CLIENT_METHODS,
  type CapabilityDescriptor,
  type SessionDescription,
  type SessionHandleParams,
  type SessionReason,
  type SessionReasonCode,
  type SessionStatus,
  type SessionStep,
  type SessionUpdate,
} from "./protocol.ts";
import { RpcFailure, type RpcMethodSpec } from "./rpc.ts";
import { REGISTRY, capabilityEffectOf } from "./scripts.ts";
import type { OfferSet } from "./surface.ts";
import { isTaskAction, type RunState } from "./types.ts";

/**
 * `session.handle` / `session.describe` 的实现。
 *
 * 这一层只做两件事：把 params 校验成结构化输入，把 `RunState` 翻译成 `SessionUpdate`。
 * 真正跑闭环的那一堆接线（SDK、留痕、profile 预检、execute）在 `cli.ts` 里，
 * 通过 `SessionDeps` 注入——理由和 `loop.ts` 一样：全部依赖都是函数参数，
 * 这一层才能在内存里测完，包括「UNSUPPORTED 该回什么」这种必须逐条对照留痕的判据。
 *
 * ── 挂起状态存在哪里 ──
 * 存在这个模块的一个 Map 里，键是 runId，值里装着 `loop.ts` 交回来的那个 `resume` 闭包。
 * 不落盘、不进全局：进程一重启，「那条指令到底执行没执行」就再也没人能回答，
 * 此时唯一安全的答案是「什么都别继续」，而一个只活在内存里的 Map 天然就是这个语义
 * （`server.ready` 的 serverId 变了，Swift 也就知道旧的 confirmId 全部作废）。
 *
 * 三态与 `rpc.ts` 的幂等缓存同构，理由也一样——「一个决定最多执行一次」：
 *   pending   挂着，等人回答
 *   resuming  有人回答了，正在跑。第二个回答挂到同一个 promise 上，绝不并起第二次执行
 *   settled   跑完了，回放最终结果。副作用不会因为再问一次而发生第二次
 */

export type SessionRunInput = {
  utterance: string;
  execute: boolean;
  /** 引擎名，已经校验过在 `SEARCH_ENGINES` 里。 */
  engine: string;
  offers: OfferSet;
  signal: AbortSignal;
};

export type SessionRunOutput = {
  state: RunState;
  journal: { path: string; redacted: boolean; failures: number };
  /**
   * 从挂起处继续。**只在 `state.status === "waiting_for_confirmation"` 时给出。**
   *
   * 做成闭包而不是让这一层自己去拼一次 `resumeLoop`：恢复必须落在同一条 run 上——
   * 同一个 journal 句柄、同一套动作面、同一个 runId。这些东西都在 `cli.ts` 的接线里，
   * 让 session 层重新凑一份，凑出来的就是「把历史重新解释成一条新命令」。
   *
   * 闭包内部负责**重新探测** profile 闸门：挂起期间用户可能切过 profile。
   */
  resume?: (approved: boolean) => Promise<SessionRunOutput>;
};

export type SessionDeps = {
  /**
   * 取本轮动作面。每次 handle 都重新取，不在启动时缓存成常量。
   * 今天重取的仍是同一张冻结白名单（REGISTRY ∩ sdef）；阶段 4 之后动作面才是当前界面的函数，
   * 现在缓存它只是少一次磁盘读，到那时缓存才等于回到「编译期常量动作面」那个根因。
   */
  offers: () => Promise<OfferSet>;
  run: (input: SessionRunInput) => Promise<SessionRunOutput>;
  /**
   * 模型凭证在不在。
   *
   * 只回答存在性，不读值也不传值（`CLAUDE.md` 一、排查凭证问题时不要读 key 的值）。
   * 单列一条是因为「缺凭证」不是任务失败——它是配置问题，Swift 该显示的话完全不同。
   */
  credentialsPresent: () => boolean;
};

function invalidParams(detail: string): RpcFailure {
  // sideEffectFree：校验发生在任何执行之前，什么都没做，所以这个 requestKey 可以原样再来
  return new RpcFailure("invalid_params", detail, { sideEffectFree: true });
}

/** 一条指令的字数上限。超长的转写多半是 ASR 抽风，不该被当成一句话喂进模型。 */
const MAX_UTTERANCE_CHARS = 2000;

/**
 * params 校验。
 *
 * 错误文案只说**字段名和允许的取值**，不回显字段值——值来自用户原话，
 * 而错误文案会一路流到 UI、可能被顺手记进日志。这条规则有测试守着。
 */
export function parseHandleParams(raw: unknown): Required<SessionHandleParams> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalidParams("params 必须是 JSON 对象");
  }
  const p = raw as Record<string, unknown>;

  // requestKey 由 rpc.ts 的 once 机制校验并消费，这里不重复一遍：
  // 去重键属于 RPC 层的不变量，两处各校验一次迟早会分叉
  const utterance = p.utterance;
  if (typeof utterance !== "string" || utterance.trim() === "") {
    throw invalidParams("params.utterance 必须是非空字符串");
  }
  if ([...utterance].length > MAX_UTTERANCE_CHARS) {
    throw invalidParams(`params.utterance 超过 ${MAX_UTTERANCE_CHARS} 字`);
  }

  const execute = p.execute ?? false;
  if (typeof execute !== "boolean") {
    throw invalidParams("params.execute 必须是布尔值；省略等于 dry-run，不会发出任何 Apple Event");
  }

  const engine = p.engine ?? DEFAULT_ENGINE;
  if (typeof engine !== "string" || !Object.hasOwn(SEARCH_ENGINES, engine)) {
    throw invalidParams(`params.engine 必须是以下之一：${Object.keys(SEARCH_ENGINES).join(" / ")}`);
  }

  return { requestKey: String(p.requestKey ?? ""), utterance, execute, engine };
}

/**
 * 「我目前只会什么」的结构化事实。
 *
 * 取的是 `specs`（已过白名单）与 `REGISTRY`（有冻结模板）的交集。两个条件独立查，
 * 与 `surface.ts` 的做法一致：改错一个，另一个还拦得住。
 * 任务层动作（ASK/WAIT/DONE/…）不在其中——它们是循环的控制动作，不是能力。
 */
export function capabilitiesFrom(offers: OfferSet): CapabilityDescriptor[] {
  const out: CapabilityDescriptor[] = [];
  for (const [id, spec] of offers.specs) {
    const t = REGISTRY[id];
    if (!t) continue;
    out.push({ id, app: spec.app, summary: spec.summary, effect: capabilityEffectOf(t.effect), risk: spec.risk, argv: t.argv });
  }
  return out;
}

/**
 * 结局分类。
 *
 * 全部从 `RunState` 的**结构**推导，不去 match `reasons` 里的中文。
 * 旧的 spawn + `contains("…")` 路径已经不在；Swift 现在按 `reasons[].code` 分支。
 *
 * 「走完步数预算」这一支值得单说：`loop.ts` 的七条返回路径里，只有它会在
 * 「最后一步真的执行了、而且验证通过」的情况下仍然给出 `blocked`。其余 blocked 分支
 * 要么没执行（exec 为 null），要么验证没过。所以这个判据不是猜的，是穷举出来的。
 */
function terminalCode(state: RunState): SessionReasonCode {
  const last = state.steps[state.steps.length - 1];
  if (!last) return "no_steps";

  // 挂起等人拍板。它和下面的 needs_input 不是一回事：这一条**有**一个具体的、
  // 已经算好参数、只差一个人点头的动作，Swift 要靠它决定弹不弹确认气泡
  if (state.status === "waiting_for_confirmation") return "needs_confirmation";

  if (state.status === "needs_input") {
    // needs_input 只有两个来源，都是「缺用户信息」，没有一个是「请批准这个动作」：
    //   1. policy.ask——模型选了 ASK，或置信度低于执行阈值（此时 actionId 是**真实动作**，不是 "ASK"）；
    //   2. 执行层报 stop（`needs_more_input`）——切片切不出这一步需要的内容。
    // 从前这里按 `actionId === "ASK"` 分流，于是 1 的低置信度分支与 2 会带着真实 actionId 落进
    // needs_confirmation（「请批准这个有风险的动作」），而它们根本没有 confirmId 可以批准。
    // 「要人拍板」是 waiting_for_confirmation 那条（上面已经返回），不是这里。
    return "needs_clarification";
  }
  if (state.status === "done") return "completed";

  if (isTaskAction(last.actionId)) {
    if (last.actionId === "UNSUPPORTED") return "unsupported";
    if (last.actionId === "BLOCKED") return "model_declined";
    if (last.actionId === "WAIT") return "stuck_waiting";
    if (last.actionId === "DONE") return "done_unverified";
    return "not_executable";
  }
  if (last.exec?.ok === false) return "exec_failed";
  if (last.verify?.ok === false) return "verify_failed";
  if (last.exec !== null && last.verify?.ok === true) return "step_budget";
  return "not_executable";
}

export function reasonsFrom(state: RunState): SessionReason[] {
  const code = terminalCode(state);
  const last = state.steps[state.steps.length - 1];
  if (!last) return [{ code, detail: "这一轮没有产生任何步骤" }];

  const details = [...last.reasons];
  // 执行或验证栽了的时候，`reasons` 里躺的是当初放行的理由（「置信度 0.9…」），
  // 真正该告诉人的是哪条判据没过
  if (code === "exec_failed" && last.exec?.ok === false) details.push(...last.exec.errors);
  if (code === "exec_failed" || code === "verify_failed") {
    for (const c of last.verify?.checks ?? []) if (!c.ok) details.push(`${c.name}: ${c.detail}`);
  }
  if (details.length === 0) details.push(`结局 ${state.status}`);
  return details.map((detail) => ({ code, detail, step: last.step }));
}

function stepsFrom(state: RunState): SessionStep[] {
  return state.steps.map((s) => ({
    step: s.step,
    actionId: s.actionId,
    executed: s.exec !== null,
    verified: s.verify === null ? null : s.verify.ok,
    confidence: s.judgement.confidence,
    complete: s.judgement.complete,
    destructive: s.judgement.destructive,
    reasons: s.reasons,
  }));
}

export function sessionUpdateFrom(
  state: RunState,
  ctx: { mode: SessionUpdate["mode"]; journal: SessionUpdate["journal"]; capabilities: CapabilityDescriptor[] },
): SessionUpdate {
  const reasons = reasonsFrom(state);
  // running 不是一次 handle 的合法结局。真出现了只能当 blocked 报：
  // 一个没收敛的 run 绝不能被说成做完了
  const status: SessionStatus = state.status === "running" ? "blocked" : state.status;
  const needsCapabilities = reasons.some((r) => r.code === "unsupported" || r.code === "not_executable");

  return {
    runId: state.runId,
    status,
    mode: ctx.mode,
    reasons,
    steps: stepsFrom(state),
    artifacts: state.artifacts.map((a) => ({ key: a.key, value: a.value, step: a.from.step })),
    ...(needsCapabilities ? { capabilities: ctx.capabilities } : {}),
    // 只在这一态给：session.confirm 认的就是 state.pending.confirmId 本身（见下面
    // makeSessionMethods 的 pending Map），两处读的是同一份数据，不会各铸一份对不上号
    ...(status === "waiting_for_confirmation" && state.pending ? { confirmId: state.pending.confirmId } : {}),
    journal: ctx.journal,
  };
}

/**
 * 阶段 3 的两个方法名。
 *
 * 类型标成 `RESERVED_CLIENT_METHODS` 的成员而不是裸字符串：协议里改了名字而这里没跟上，
 * `tsc --noEmit` 当场红，不会变成「Swift 发过来收到 method_not_found」这种只在联调时才暴露的错。
 */
const METHOD_SESSION_CONFIRM: (typeof RESERVED_CLIENT_METHODS)[number] = "session.confirm";
const METHOD_SESSION_CANCEL: (typeof RESERVED_CLIENT_METHODS)[number] = "session.cancel";

/** 一个 id 字段的长度上限，与 `rpc.ts` 对 requestKey 的判据一致。 */
const MAX_ID_CHARS = 128;

function requireId(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_ID_CHARS) {
    throw invalidParams(`params.${field} 必填，须是 1–${MAX_ID_CHARS} 字符的字符串`);
  }
  return raw;
}

export type ConfirmParams = { runId: string; confirmId: string; approved: boolean };

/**
 * `session.confirm` 的参数。
 *
 * `approved` 没有缺省值，这是刻意的：缺省 fail-closed 在这里不等于「默认取消」。
 * 一条读不出用户意思的消息不该被当成用户的决定——无论把它当成同意还是当成取消，
 * 记下来的都是一个人没做过的选择。拒收它，什么都不会发生，UI 也能如实重来一次。
 */
export function parseConfirmParams(raw: unknown): ConfirmParams {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalidParams("params 必须是 JSON 对象");
  }
  const p = raw as Record<string, unknown>;
  const runId = requireId(p.runId, "runId");
  const confirmId = requireId(p.confirmId, "confirmId");
  if (typeof p.approved !== "boolean") {
    throw invalidParams("params.approved 必须是布尔值；没有缺省值，读不出决定就不当作决定");
  }
  return { runId, confirmId, approved: p.approved };
}

/** `session.cancel` 的参数。协议里它只有 runId——没有 confirmId 可以对号，见下面的说明。 */
export function parseCancelParams(raw: unknown): { runId: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalidParams("params 必须是 JSON 对象");
  }
  return { runId: requireId((raw as Record<string, unknown>).runId, "runId") };
}

/** 挂着的一条 run。`resume` 是 `cli.ts` 接线交回来的闭包，这一层只负责让它最多被调一次。 */
type PendingRun = {
  confirmId: string;
  resume: (approved: boolean) => Promise<SessionRunOutput>;
  /** 恢复必须沿用**发起那一轮**的 mode 与能力清单——换一套就不是同一条 run 了。 */
  mode: SessionUpdate["mode"];
  capabilities: CapabilityDescriptor[];
};

/**
 * 同时挂着的确认数、以及已落定结果的回放条数。
 *
 * 都有上限，而且淘汰最老的那条：一个没人回答的气泡不该让进程无限长胖。
 * 被淘汰的后果是那次确认再也回答不了（`invalid_params`），不是「静默放行」——
 * 淘汰站在不执行那一边，所以这个上限本身不是安全判据。
 */
const MAX_PENDING = 8;
const MAX_SETTLED = 32;

function evict(m: Map<string, unknown>, max: number): void {
  while (m.size > max) {
    const oldest = m.keys().next();
    if (oldest.done) break;
    m.delete(oldest.value);
  }
}

export function makeSessionMethods(deps: SessionDeps): Record<string, RpcMethodSpec> {
  // 三态各一张表，键都是 runId。只活在这个闭包里：没有模块级变量，
  // 于是每个 `makeSessionMethods` 是一套独立的账，测试之间不会串
  const pending = new Map<string, PendingRun>();
  const resuming = new Map<string, { confirmId: string; task: Promise<SessionUpdate> }>();
  const settled = new Map<string, { confirmId: string; update: SessionUpdate }>();

  async function offersOrFail(): Promise<OfferSet> {
    try {
      return await deps.offers();
    } catch (err) {
      // 动作面没建起来就什么都还没发生，键可以放回去让人重试
      throw new RpcFailure("internal_error", `取动作面失败：${err instanceof Error ? err.message : String(err)}`, {
        sideEffectFree: true,
      });
    }
  }

  /**
   * 一次 run 跑到某个落点之后，翻译成 SessionUpdate，顺便决定要不要把它挂起来。
   *
   * 挂起而拿不到 `resume`（接线漏了）时**降级成 blocked**，不报
   * `waiting_for_confirmation`：报了的话 Swift 会弹一个气泡，而那个气泡点了没反应——
   * 「点了确认没反应」正是 protocol.ts 里点名要避免的那类缺陷。
   */
  function settleRun(out: SessionRunOutput, mode: SessionUpdate["mode"], capabilities: CapabilityDescriptor[]): SessionUpdate {
    const ctx = { mode, journal: out.journal, capabilities };
    if (out.state.status !== "waiting_for_confirmation") return sessionUpdateFrom(out.state, ctx);

    const p = out.state.pending;
    if (!p || !out.resume) {
      const steps = out.state.steps.slice();
      const last = steps[steps.length - 1];
      if (last) steps[steps.length - 1] = { ...last, reasons: [...last.reasons, "这一步需要确认，但本次接线没有给出恢复入口"] };
      return sessionUpdateFrom({ ...out.state, status: "blocked", pending: undefined, steps }, ctx);
    }

    pending.set(out.state.runId, { confirmId: p.confirmId, resume: out.resume, mode, capabilities });
    evict(pending, MAX_PENDING);
    return sessionUpdateFrom(out.state, ctx);
  }

  /**
   * 人回答了。这是「一个决定最多执行一次」在会话层的那一半。
   *
   * `rpc.ts` 的 once 只认 requestKey：Swift 超时重发同一条 confirm 它挡得住，
   * 但「用户连点两次、UI 各生成了一个 key」它认不出来——那是两条完全合法的、
   * 键不同的请求。所以这里再挡一次，抓手换成 runId 与 confirmId：
   * 挂起点在**任何 await 之前**就被同步摘走，第二次进来只能看到 resuming 或 settled。
   *
   * `confirmId === null` 是 `session.cancel` 的路径——协议给它的 params 里没有 confirmId。
   * 不对号在这里是可以接受的：取消只会让事情**不**发生，它站在安全的那一边。
   */
  async function answer(runId: string, confirmId: string | null, approved: boolean): Promise<SessionUpdate> {
    const mismatch = (got: string) =>
      invalidParams(`params.confirmId 与 ${got} 的那次确认对不上；不要猜 id，重新发起这条指令`);

    const flying = resuming.get(runId);
    if (flying) {
      // 决定已经在执行，甚至 Apple Event 可能已经发出去了。此刻给出第二个答案，
      // 唯一诚实的回应是同一份结果——取消不是 undo（protocol.ts 的原话）
      if (confirmId !== null && flying.confirmId !== confirmId) throw mismatch("正在执行中");
      return flying.task;
    }
    const done = settled.get(runId);
    if (done) {
      if (confirmId !== null && done.confirmId !== confirmId) throw mismatch("已经落定");
      return done.update;
    }
    const p = pending.get(runId);
    if (!p) {
      throw invalidParams("params.runId 上没有待确认的动作：它可能已经被回答过、被取消过，或者 core 重启过了");
    }
    if (confirmId !== null && p.confirmId !== confirmId) throw mismatch("正在等待");

    pending.delete(runId);
    const task = (async () => {
      const out = await p.resume(approved);
      const update = settleRun(out, p.mode, p.capabilities);
      // 又挂起了一次：那是一个新铸的 confirmId，这一次的答案不能顶替它的结局。
      // 用旧 confirmId 再来一次会落到上面 pending 的 mismatch 分支，正是我们要的
      if (out.state.status !== "waiting_for_confirmation") {
        settled.set(runId, { confirmId: p.confirmId, update });
        evict(settled, MAX_SETTLED);
      }
      return update;
    })().finally(() => {
      resuming.delete(runId);
    });
    resuming.set(runId, { confirmId: p.confirmId, task });
    return task;
  }

  return {
    [METHOD_SESSION_HANDLE]: {
      once: true,
      handler: async (raw, ctx) => {
        const params = parseHandleParams(raw);
        if (!deps.credentialsPresent()) {
          throw new RpcFailure("credentials_missing", "缺少模型凭证（环境变量 TYPESAFE_API_KEY），无法理解这条指令", {
            sideEffectFree: true,
          });
        }
        const offers = await offersOrFail();
        // deps.run 抛出来的错**不**声明 sideEffectFree：跑到一半炸了，
        // 没人能保证 Apple Event 还没发出去，此时重发比报错危险
        const out = await deps.run({
          utterance: params.utterance,
          execute: params.execute,
          engine: params.engine,
          offers,
          signal: ctx.signal,
        });
        return settleRun(out, params.execute ? "execute" : "dry-run", capabilitiesFrom(offers));
      },
    },

    [METHOD_SESSION_CONFIRM]: {
      // 和 session.handle 同一个理由：它会真的把那个动作发出去
      once: true,
      handler: async (raw) => {
        const params = parseConfirmParams(raw);
        return answer(params.runId, params.confirmId, params.approved);
      },
    },

    [METHOD_SESSION_CANCEL]: {
      /**
       * 没有 `once`，因为协议给它的 params 里根本没有 requestKey——而这没关系：
       * 取消本身就是幂等的，它的全部作用是「让还没发生的那一步不要发生」。
       * 连点两次的第二次会落进 resuming / settled，拿到同一份结果。
       *
       * 它**拦不住**一条正在跑的 `session.handle`。不是偷懒：runId 是 run 开始之后
       * 才铸出来的，Swift 在那之前根本说不出要取消哪一条。已经发出的 Apple Event
       * 更不会回滚（protocol.ts 写明了它不是 undo）。
       */
      handler: async (raw) => answer(parseCancelParams(raw).runId, null, false),
    },

    [METHOD_SESSION_DESCRIBE]: {
      // 只读，没有副作用，所以不需要幂等键——Swift 启动时可以拿它当连通性探针
      handler: async (): Promise<SessionDescription> => {
        const offers = await offersOrFail();
        return { protocol: PROTOCOL_VERSION, capabilities: capabilitiesFrom(offers), surfaceTotal: offers.total };
      },
    },
  };
}
