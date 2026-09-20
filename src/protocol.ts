/**
 * Swift ↔ Node 那条线的**人读契约**。
 *
 * 之所以单独成文件而不是散在 rpc.ts 里：另一侧是 Swift，它不 import TypeScript。
 * 凡是「线上出现过的东西」都必须在这里写全，反过来这里也不放任何实现细节——
 * 帧怎么切、id 怎么配对在 rpc.ts，会话怎么跑在 session.ts。
 * Swift 侧是手抄影子 `CoreProtocol.swift`，不是生成物，会漂移；对齐靠平行测试，
 * 没有 codegen。行上限这里按字符、Swift 按字节；未知 error code 两侧缺省也不同。
 *
 * ── 为什么是 JSON Lines over stdio ──
 * 原先是一次性 spawn `bright-sight run` + 解析中文文本 stdout 认结局。那条通道只能单向、
 * 只能一问一答，而 AX 遍历必须留在 Swift（元素引用要跨步骤保活），决策必须留在 Node。
 * 一旦「Node 决策到一半反过来要求 Swift 去观察」，文本 stdout 就无解了。
 * 生产路径已经换成这条线：`CommandExecutor.swift` 只调 `session.handle`，不再 parse CLI stdout。
 *
 * ── 四种消息 ──
 * 每行一个 JSON 对象，两个方向对称，谁都可以发请求：
 *
 *   请求   {"id":1,"method":"session.handle","params":{…}}
 *   成功   {"id":1,"result":{…}}
 *   失败   {"id":1,"error":{"code":"…","layer":"…","message":"…","retriable":false}}
 *   通知   {"method":"server.ready","params":{…}}        ← 没有 id，不回应
 *
 * ── id 空间按奇偶切开 ──
 * 计划里画的协议草图用的是一条共享递增序列（Swift 发 1，Node 发 2、3）。两侧各自分配 id
 * 时那是做不到的：没有共享计数器，Swift 的 1 和 Node 的 1 会同时在线上，`{"id":1,"result":…}`
 * 就分不清是谁的回应。所以这里把 id 空间静态切开：
 *
 *   Swift 发起的请求用**奇数** id（1、3、5…）
 *   Node  发起的请求用**偶数** id（2、4、6…）
 *
 * 于是「这条 response 是不是给我的」是一次奇偶判断，不需要任何协商。收到奇偶不属于对方的
 * **请求**是协议违规（`id_conflict`），因为那个 id 可能正被自己占用。
 *
 * ── 往后加东西不许打破已有消息 ──
 * 阶段 3（确认气泡）与阶段 4（AX 能力层）还要往这条线上加方法。四条兼容规则，两侧都要守：
 *
 *   1. 收到不认识的 **method** → 回 `method_not_found`，不要断开连接。
 *   2. 收到不认识的 **notification** → 静默忽略。通知没有回应，发送方无从得知对方不懂，
 *      断开或报错会让「加一条通知」变成一次破坏性变更。
 *   3. 收到不认识的 **字段** → 忽略。新增字段一律可选，已有字段不改名不改语义。
 *   4. 收到不认识的 **枚举值**（status / reason code / error code）→ 必须有 default 分支。
 *      Swift 侧写 `switch` 时不要依赖穷举——穷举在这里等于「下一个版本上线就静默走错分支」。
 *
 * ── params 里不存在可执行的东西 ──
 * `docs/agent-v2-design.md` §10 不变量 3：模型输出不能直接成为可执行代码、selector 或坐标。
 * RPC 让模型的结论能跨进程流动，这条不变量的攻击面因此变大，所以协议本身要顶住：
 * 下面每个 params 字段要么是**标识符**（对面自己造出来的 id、方法名、枚举值），
 * 要么是**用户原话**（只喂给模型和切片器，永远不拼进脚本文本，见 `src/osa.ts`）。
 * 不存在任何字段会被对面当成脚本、JavaScript、AppleScript、CSS/XPath selector 或屏幕坐标执行。
 * 新增字段前先回答这个问题，答不上来就不要加。
 */

import type { ActionSpec, CapabilityEffect, RunStatus } from "./types.ts";

/** 协议版本。`server.ready` 里报一次，对不上说明 core 与 App 不是一次构建出来的。 */
export const PROTOCOL_VERSION = 1;

/** 单行上限。超过就不是消息而是事故，按传输层错误处理并重新同步到下一个换行。 */
export const RPC_MAX_LINE_CHARS = 4 * 1024 * 1024;

/** 幂等键的字段名。它不是普通参数，是「一个决定最多执行一次」的抓手，见下。 */
export const RPC_REQUEST_KEY_FIELD = "requestKey";

/** 重放标记的字段名。凡是 `once` 方法的 result，被去重命中时由 RPC 层补上这一位。 */
export const RPC_REPLAYED_FIELD = "replayed";

/** 出站调用的默认超时。对面不答时不能让一次 run 永久挂住。 */
export const RPC_CALL_TIMEOUT_MS = 30_000;

export type RpcId = number;

export function isRpcId(v: unknown): v is RpcId {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

export type RpcParity = "odd" | "even";

export function parityOf(id: RpcId): RpcParity {
  return id % 2 === 0 ? "even" : "odd";
}

/**
 * 错误分三层，而且**层次写在线上**，不靠 Swift 自己去猜。
 *
 * 混成一种的后果很具体：Swift 没法决定「重试 / 报错 / 问用户」。三层的分工是——
 *
 *   transport  这条线本身坏了（行读不出来、id 对不上）。跟用户说了什么无关，
 *              也跟方法无关。反复出现就该重启 core。
 *   method     这次调用坏了（方法不存在、参数不合法、内部异常）。是我们这边的 bug 或配置问题，
 *              照原样重发通常没用。**这一层不包含「任务没做成」**。
 *   business   任务本身的结局。它根本不是 error——它是 `{"id":…,"result":{"status":"blocked",…}}`，
 *              带着 `reasons` 回来。`blocked` / `needs_input` 是助手正常工作的产物，
 *              把它们表达成 error，UI 就只能显示「出错了」，而真实原因是「我不会做这件事」。
 *
 * 所以这张表里永远不会出现 `blocked`、`needs_input` 这类值。测试对这一点有阳性对照。
 */
export type RpcErrorLayer = "transport" | "method";

/**
 * `retriable` 的语义是**「用同一个 requestKey 原样重发，是不是既安全又可能得到不同结果」**。
 *
 * 只有超时是 true：那时结果未知，而幂等键保证重发不会让副作用发生第二次（见 rpc.ts 的 once）。
 * 其余一律 false——尤其 `replay_unavailable`，它的意思正是「这条已经执行过了，别再发」。
 */
export const RPC_ERRORS = {
  /** 这一行不是合法 JSON。 */
  parse_error: { layer: "transport", retriable: false },
  /** 这一行超过 `RPC_MAX_LINE_CHARS`，已被丢弃并重新同步到下一个换行。 */
  oversized_line: { layer: "transport", retriable: false },
  /** JSON 合法，但不是四种消息中的任何一种。 */
  malformed_message: { layer: "transport", retriable: false },
  /** 收到一条 response，但它的 id 不在我方待答列表里（或奇偶不属于我方）。 */
  unknown_response: { layer: "transport", retriable: false },
  /** 对方用了不属于它的 id 奇偶，或同一个 id 还在处理中又发了一次。 */
  id_conflict: { layer: "transport", retriable: false },
  /** 连接正在关闭，未完成的请求一律失败。 */
  peer_gone: { layer: "transport", retriable: false },

  method_not_found: { layer: "method", retriable: false },
  /** 参数不合法。message 只说字段名和允许的取值，**不回显字段值**。 */
  invalid_params: { layer: "method", retriable: false },
  /** 处理过程中抛了未预期的异常。 */
  internal_error: { layer: "method", retriable: false },
  /** 出站调用超时。副作用可能已经发生，所以 rpc.ts 永不自动重发，由调用方决定。 */
  request_timeout: { layer: "method", retriable: true },
  /**
   * 这个 requestKey 执行过，但结果已经不在缓存里了。
   *
   * 不是「失败」，是「无法在不冒重复执行风险的前提下回答你」。Swift 收到它必须当成
   * 「已经做过」，不能换个 key 重发同一条指令。
   */
  replay_unavailable: { layer: "method", retriable: false },
  /** 缺模型凭证。是配置问题，不是任务失败，所以留在 method 层。 */
  credentials_missing: { layer: "method", retriable: false },
} as const satisfies Record<string, { layer: RpcErrorLayer; retriable: boolean }>;

export type RpcErrorCode = keyof typeof RPC_ERRORS;

export type RpcError = {
  code: RpcErrorCode;
  layer: RpcErrorLayer;
  /**
   * 人读的一句话。
   *
   * 它是**给用户看的**，可能含用户原话（例如内部异常把原话带进了异常消息）。
   * Swift 可以显示它、可以朗读它，但**不要把它写进任何持久日志**——
   * 本项目的落盘留痕默认脱敏（`src/redact.ts`），绕过那条路写一份明文日志
   * 等于把脱敏白做了。
   */
  message: string;
  retriable: boolean;
};

export function makeRpcError(code: RpcErrorCode, message: string, over: Partial<RpcError> = {}): RpcError {
  const d = RPC_ERRORS[code];
  return { code, layer: d.layer, message, retriable: d.retriable, ...over };
}

// ── 线上的四种消息 ───────────────────────────────────────────────────────────

export type RpcRequestMessage = { id: RpcId; method: string; params?: unknown };
export type RpcSuccessMessage = { id: RpcId; result: unknown };
export type RpcFailureMessage = { id: RpcId; error: RpcError };
export type RpcNotificationMessage = { method: string; params?: unknown };

export type RpcMessage = RpcRequestMessage | RpcSuccessMessage | RpcFailureMessage | RpcNotificationMessage;

export type ParsedMessage =
  | { kind: "request"; id: RpcId; method: string; params: unknown }
  | { kind: "success"; id: RpcId; result: unknown }
  | { kind: "failure"; id: RpcId; error: RpcError }
  | { kind: "notification"; method: string; params: unknown }
  /** 读不出来。`id` 能认出来就带上，好让对面收到一条对得上号的错误；认不出来就是 null。 */
  | { kind: "invalid"; code: RpcErrorCode; detail: string; id: RpcId | null };

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 把线上的 error 归一化。对面发来一个畸形 error 时不能因此崩掉，但也不能假装它是好的。 */
function normalizeError(v: unknown): RpcError {
  const r = asRecord(v);
  const code = r && typeof r.code === "string" && Object.hasOwn(RPC_ERRORS, r.code) ? (r.code as RpcErrorCode) : null;
  const message = r && typeof r.message === "string" ? r.message : "对方返回了读不懂的错误";
  if (!code) return makeRpcError("malformed_message", message);
  const d = RPC_ERRORS[code];
  return {
    code,
    layer: r && (r.layer === "transport" || r.layer === "method") ? r.layer : d.layer,
    message,
    retriable: r && typeof r.retriable === "boolean" ? r.retriable : d.retriable,
  };
}

/**
 * 一行文本 → 一条消息。纯函数，不认识流也不认识对面是谁。
 *
 * 判别顺序是刻意的：先按 `id` 在不在分成「有回应的」和「通知」，再在有 id 的那一支里
 * 按 `method` / `result` / `error` 三选一。同时带 `result` 和 `error` 是畸形，
 * 不挑一个用——挑一个就等于替对面猜它想说什么。
 */
export function parseMessage(line: string): ParsedMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (err) {
    return { kind: "invalid", code: "parse_error", detail: err instanceof Error ? err.message : "JSON 解析失败", id: null };
  }
  const m = asRecord(raw);
  if (!m) return { kind: "invalid", code: "malformed_message", detail: "消息必须是 JSON 对象", id: null };

  const hasId = Object.hasOwn(m, "id") && m.id !== null;
  if (!hasId) {
    if (typeof m.method !== "string") {
      return { kind: "invalid", code: "malformed_message", detail: "没有 id 的消息必须是通知，需要 method", id: null };
    }
    return { kind: "notification", method: m.method, params: m.params };
  }
  if (!isRpcId(m.id)) {
    return { kind: "invalid", code: "malformed_message", detail: "id 必须是正整数", id: null };
  }
  const id = m.id;

  const kinds = [typeof m.method === "string", Object.hasOwn(m, "result"), Object.hasOwn(m, "error")].filter(Boolean);
  if (kinds.length !== 1) {
    return {
      kind: "invalid",
      code: "malformed_message",
      detail: kinds.length === 0 ? "带 id 的消息必须有 method / result / error 之一" : "method / result / error 只能有一个",
      id,
    };
  }
  if (typeof m.method === "string") return { kind: "request", id, method: m.method, params: m.params };
  if (Object.hasOwn(m, "error")) return { kind: "failure", id, error: normalizeError(m.error) };
  return { kind: "success", id, result: m.result };
}

/**
 * 一条消息 → 一行文本（含换行）。
 *
 * `result: undefined` 要落成 `null`：`JSON.stringify` 会把 undefined 的属性整个丢掉，
 * `{"id":7}` 在对面解析出来既不是成功也不是失败，是畸形消息。
 * 换行不用担心——JSON 字符串里的控制字符一律被转义，正文里的换行不会切断帧。
 */
export function encodeMessage(m: RpcMessage): string {
  const fixed = Object.hasOwn(m, "result") && (m as RpcSuccessMessage).result === undefined
    ? { ...m, result: null }
    : m;
  return `${JSON.stringify(fixed)}\n`;
}

// ── 通知 ─────────────────────────────────────────────────────────────────────

/** Node → Swift，进程起来后第一条。 */
export const NOTIFY_SERVER_READY = "server.ready";
/** 双向，传输层出了对不上 id 的事故时发一条，没有回应。 */
export const NOTIFY_TRANSPORT_ERROR = "transport.error";

export type ServerReadyParams = {
  protocol: number;
  /**
   * 本次进程的身份，每次启动都不一样。
   *
   * 它是 Swift 判断「core 重启过了」的唯一依据，而这个判断直接关系到安全：
   * 幂等缓存只活在进程内存里，换了 serverId 就意味着「上一条指令到底执行没执行」
   * 这个问题再也没人能回答，此时**不得**用旧 requestKey 重发。见 rpc.ts 的 once。
   */
  serverId: string;
  pid: number;
};

export type TransportErrorParams = { error: RpcError };

// ── Swift → Node 的方法 ──────────────────────────────────────────────────────

export const METHOD_SESSION_HANDLE = "session.handle";
export const METHOD_SESSION_DESCRIBE = "session.describe";

/**
 * `session.confirm` / `session.cancel`。**核心侧已实现并注册**（`session.ts` 的
 * `makeSessionMethods`，经 `cli.ts` 的 `cmdServe` 进入 serve），Swift 确认气泡调用它们。
 * 常量名仍叫 `RESERVED_CLIENT_METHODS` 是历史包袱，不是「尚未实现」。
 *
 * 形状钉在这里，让核心、Swift bridge 与 UI 共用同一份 wire 约定：
 *
 *   session.confirm  `{requestKey, runId, confirmId, approved}`
 *                    从中断处继续，**不是**把历史重新解释成一条新命令
 *                    （`docs/agent-v2-design.md` §3.1）。`confirmId` 由上一条
 *                    `waiting_for_confirmation` 的 SessionUpdate 给出，Swift 原样回传。
 *   session.cancel   `{runId}`  取消只能拦住「还没发生的下一步」，已经发出的 Apple Event
 *                    不会回滚，所以它不是 undo。
 */
export const RESERVED_CLIENT_METHODS = ["session.confirm", "session.cancel"] as const;

export type SessionHandleParams = {
  /**
   * 幂等键，**必填**，由 Swift 生成（一条用户指令一个，重发时原样复用）。
   *
   * 这是 RPC 化之后「一个决定最多执行一次」唯一的抓手。长驻连接会超时、会重连、会重发，
   * 而 `session.handle` 的副作用是真的（开标签页、写笔记）。缺了它服务端直接拒绝，
   * 不会「先执行了再说」——缺省必须等于拦住（`CLAUDE.md` 三、缺省值一律 fail-closed）。
   */
  requestKey: string;
  /** 用户原话。只进模型与切片器，永不拼进脚本文本。 */
  utterance: string;
  /**
   * 省略 = dry-run。
   *
   * 和 CLI 的 `--execute` 同一个缺省：忘了接线的后果应该是「什么都没发生」，
   * 而不是「在别人的浏览器里开了个标签页」。
   */
  execute?: boolean;
  /** 搜索引擎的**名字**（`google` / `bing` / …），不是 URL 模板。不认识的名字一律 `invalid_params`。 */
  engine?: string;
};

export type SessionDescribeParams = Record<string, never>;

// ── Node → Swift 的 AX 方法 ───────────────────────────────────────────────────

/**
 * AX 能力层的两个反向调用。类型化调用与 fail-closed 响应校验在 `src/ax.ts`，
 * Swift 的真实实现位于 `apps/macos/Sources/BrightSightVoice/AX/`。
 *
 * 位置留在这里的意义是：反向通道的机制（rpc.ts 的 `call`）这一轮已经能用且有测试，
 * 阶段 4 只需要在 Swift 侧注册这两个方法名，不必再动协议骨架。
 *
 *   ax.observe  `{scope: "focusedWindow" | "application", pid?: number, offset?: number, pageSize?: number,
 *                 depth?: number, nodes?: number, ms?: number}`
 *               → `{frameId, pid, offers: ActionOffer[], page: {offset, count, total, nextOffset?},
 *                   elapsedMs, truncated?: {reason: "depth" | "nodes" | "deadline", depth, nodes, ms}}`
 *   ax.perform  `{frameId, offerId, operation, value?}`
 *               → `{status: "executed" | "rejected_stale" | "failed" | "effect_unknown", …}`
 *
 * `depth` / `nodes` / `ms` 是这一轮遍历的**资源预算**覆盖项（三个整数，不是 selector / 坐标），
 * 一律可选：省略 = 用对端 `protectiveDefault` 的对应值，**不放大**（`depth` 省略不会变成「不限」）。
 * 上限由两侧各自按 `AXWireLimits` / `AX_MAX_*` 校验，越界当场拒。按上面的兼容规则 3，
 * 收到不认识的字段忽略、不报错；加字段一律可选、已有字段不改名不改语义。`PROTOCOL_VERSION` 不动。
 *
 * 形状沿用 `docs/agent-v2-design.md` §3.2，两条硬约束一并记在这里：
 *   - `frameId` / `offerId` 都由 **Swift** 在观察那一刻铸造，Node 只能原样回传。
 *     Node（以及模型）不生成 selector、AX 路径、数组下标或坐标——没有这样的字段。
 *   - `offerId` 只在它所属的那个 frame 里有效。换了 frame 就作废，这是 freshness guard
 *     的协议侧一半，另一半是 Swift 执行前按属性指纹复验目标身份。
 */
export const AX_SERVER_METHODS = ["ax.observe", "ax.perform"] as const;

// ── session.handle 的结果 ────────────────────────────────────────────────────

/**
 * 一次 handle 的结局。
 *
 * `waiting_for_confirmation` 已经会作为 `session.handle` 的 result 出现
 * （policy 要人拍板、且带真实 `actionId` 时）。Swift 必须有这个分支：缺了会静默落进
 * default，表现为「点了确认没反应」。
 *
 * 设计文档早先草拟的 SessionStatus 有七个态，线上只有四个：
 * `idle` / `running` / `paused` 描述的是 Session 自己的生命周期，不是一次 handle 的回答，
 * 它们永远不会作为 `session.handle` 的 result 出现。
 */
export type SessionStatus = "done" | "blocked" | "needs_input" | "waiting_for_confirmation";

/**
 * 结局的机器可读分类。
 *
 * 分工是死的：**code 决定 UI 走哪条分支，detail 决定 UI 显示什么字。**
 * 别去 match detail 的中文。旧的 spawn+`contains("终止意图 UNSUPPORTED")` 路径已经不在；
 * `CoreOutcomeSummary.swift` 按 `reasons[].code` 分支。改一句文案不该让 UI 走错。
 *
 * 粒度说明（这是当前的真实能力边界，不是设计偏好）：code 由 `RunState` 的结构推导，
 * 而 `policy.ts` / `loop.ts` 目前只产出人读的 `reasons: string[]`，没有自己的 code。
 * 所以「白名单挡了」「没有模板」「答案校验没过」「同一动作第二次提议」这几种今天都收敛成
 * `not_executable`，具体判据在 detail 里。阶段 3 改 policy 时会细化——
 * 那时会**新增** code，不会改已有 code 的含义，所以 Swift 必须有 default 分支。
 */
export type SessionReasonCode =
  /** 做完了，而且每一步都验证过。 */
  | "completed"
  /** 模型选了 UNSUPPORTED：听懂了，但系统不会做。此时 result 带 `capabilities`。 */
  | "unsupported"
  /** 模型选了 BLOCKED：它自己认为做不下去。 */
  | "model_declined"
  /** 模型声称 DONE，但没有任何一步通过验证。不信任 DONE 是 `loop.ts` 的既有性质。 */
  | "done_unverified"
  /** 连续 WAIT 超过预算，在原地打转。 */
  | "stuck_waiting"
  /** 信息不够，要追问用户。 */
  | "needs_clarification"
  /** 要人拍板才能继续（破坏性动作，或 Chrome profile 不在允许名单）。阶段 3 的确认气泡就接这个。 */
  | "needs_confirmation"
  /** Apple Event 发出去了但失败了。 */
  | "exec_failed"
  /** 动作执行了，代码验证没过，且恢复预算用尽。 */
  | "verify_failed"
  /** 步数预算用完还没收手。 */
  | "step_budget"
  /** 这条动作没能进入执行：不在动作面 / 不在白名单 / 没有模板 / 答案校验没过 / 重复提议。 */
  | "not_executable"
  /** 一步都没有产生。 */
  | "no_steps";

export type SessionReason = {
  code: SessionReasonCode;
  /** 人读的原文，直接来自 `policy.ts` / `loop.ts` 的 reasons。UI 显示它，但不要用它做分支。 */
  detail: string;
  step?: number;
};

export type { CapabilityEffect } from "./types.ts";
export type CapabilityRisk = ActionSpec["risk"];

/**
 * 「我目前只会 X 和 Y」的结构化版本。
 *
 * 原计划 0.5 想让 CLI 的文本输出带上 status 与 reasons，再让 Swift 去解析；
 * 阶段 2 把整条通道换成了 JSON，那个文本契约当场作废，于是并到这里一次做对。
 *
 * 这里只给事实，不给文案：`CommandExecutor.swift` 现在硬编码了一句
 * 「目前可以打开应用、用 Chrome 搜索或新建备忘录」，那句话在动作面变化时不会跟着变，
 * 而阶段 4 之后动作面是**当前界面的函数**，每次都不一样。怎么渲染是 UI 的事。
 */
export type CapabilityDescriptor = {
  id: string;
  app: string;
  /** 一句话说明，来自 sdef，语言随系统。 */
  summary: string;
  effect: CapabilityEffect;
  risk: CapabilityRisk;
  /** 执行时真正需要的 argv 槽位名，按位置。来自冻结模板，不是 sdef 的形参表。 */
  argv: readonly string[];
};

export type SessionStep = {
  step: number;
  actionId: string;
  /**
   * 这一步有没有真的发出 Apple Event。
   *
   * 刻意不回传 argv：argv 里是真正发出去的值（网址、笔记正文），UI 不需要它，
   * 而它一旦跨进程流动就多一个可能被日志捡走的地方。要查 argv 去看留痕。
   */
  executed: boolean;
  /** 代码验证结果。null = 这一步没执行，所以没有可验证的东西。 */
  verified: boolean | null;
  confidence: number;
  complete: number;
  destructive: number;
  reasons: string[];
};

export type SessionUpdate = {
  runId: string;
  status: SessionStatus;
  /** 这一轮到底允不允许发 Apple Event。dry-run 下 status 多半不是 done，这是正常的。 */
  mode: "execute" | "dry-run";
  /** 至少一条。为什么是这个结局。 */
  reasons: SessionReason[];
  steps: SessionStep[];
  artifacts: { key: string; value: string; step: number }[];
  /** 只在 reasons 里出现 `unsupported` / `not_executable` 时给出——那正是需要回答「那你会什么」的时刻。 */
  capabilities?: CapabilityDescriptor[];
  /**
   * 待确认动作的抓手，只在 `status === "waiting_for_confirmation"` 时给出。
   *
   * 别的结局下没有意义：这个动作要么已经执行完毕（`done` / `blocked`），
   * 要么这个 id 已经被消费掉、下一次挂起会现铸一个新的——带出去只会造成「用旧 id 去猜」的错觉。
   * Swift 原样收下，回填进 `session.confirm` 的 `confirmId` 字段，不做任何解释或改写。
   */
  confirmId?: string;
  /**
   * 这一条是缓存回放：同一个 requestKey 之前来过，副作用**没有**发生第二次。
   * 由 RPC 层补上（`RPC_REPLAYED_FIELD`），不是 session 层写的。
   */
  replayed?: boolean;
  journal: { path: string; redacted: boolean; failures: number };
};

export type SessionDescription = {
  protocol: number;
  capabilities: CapabilityDescriptor[];
  /** 全量动作面规模。它是「没有为任何应用写适配代码」的量化证据，也是能力清单的分母。 */
  surfaceTotal: number;
};

// ── 编译期对账 ───────────────────────────────────────────────────────────────

/**
 * 协议里的枚举是**重写一遍**而不是 re-export 的：Swift 侧只读这一个文件，
 * 让人跳三个文件才能拼出一个 enum 是反的。代价是会漂移，所以用类型断言钉住——
 * 哪一侧加了新值而另一侧没跟上，`tsc --noEmit` 就红。
 */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

// 不再有 _EffectInSync：能力词表现在由 types.ts 唯一地定义，协议直接 re-export 它，
// 两侧无从漂移。它此前会漂，是因为脚本侧另有一套词表（create/navigate/read/destroy），
// 两套词表在 5.3 已统一——留着那条断言只会钉住一个已经不存在的分叉。
type _RiskInSync = Assert<Exactly<CapabilityRisk, ActionSpec["risk"]>>;
/** `RunStatus` 的四个值里，`running` 不是一次 handle 的合法结局，其余三个必须都在 SessionStatus 里。 */
type _StatusCovered = Assert<Exclude<RunStatus, "running"> extends SessionStatus ? true : false>;
