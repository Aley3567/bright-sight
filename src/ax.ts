import { RpcFailure, type RpcCallOptions, type RpcPeer } from "./rpc.ts";

export const AX_METHOD_OBSERVE = "ax.observe";
export const AX_METHOD_PERFORM = "ax.perform";

/**
 * 单页返回的 offer 上限。Swift 侧 `AXWireLimits.maxPageSize`（`AX/` 的 `AXModels.swift`）是
 * 同一个数字的另一半：本侧拿它校验出参请求，对侧拿它校验入参。改动必须同时落在两边，
 * `test/ax.test.ts` 末尾那条跨语言对照测试会直接读 Swift 源文件比对字面量。
 */
export const AX_MAX_PAGE_SIZE = 200;

/**
 * 单条 offer 区分文字的字符上限，与 Swift `AXWireLimits.maxContextCharacters` 成对。
 *
 * 本侧是**校验**而不是截断：超限说明对侧的聚合逻辑漏了截断，那是缺陷，不该由本侧悄悄抹平。
 */
export const AX_MAX_CONTEXT_CHARACTERS = 200;

/** 向上找区分文字的最大层数，与 Swift `AXWireLimits.maxContextLevels` 成对。本侧不使用，只做门禁对照。 */
export const AX_MAX_CONTEXT_LEVELS = 3;

export type AxObservationScope = "focusedWindow" | "application";
export type AxOperation = "CLICK" | "TYPE_TEXT" | "SELECT" | "OPEN";
export type AxEffect = "read" | "navigate" | "draft" | "submit" | "change" | "destroy";
export type AxRisk = "safe" | "caution" | "destructive";

export type AxObserveParams = {
  scope: AxObservationScope;
  pid?: number;
  offset?: number;
  pageSize?: number;
};

export type AxActionOffer = {
  id: string;
  operation: AxOperation;
  target: {
    ref: string;
    role: string;
    label: string;
    state: { enabled: boolean; selected?: boolean; editable: boolean };
    /**
     * 把这个目标与**同名目标**区分开的文字，只有 label 撞了才有值。
     *
     * 缺省是「这个 label 在本次动作面里唯一」，不是「没能算出上下文」——两者在这里同形，
     * 但后者不存在：Swift 只在撞名时才去聚合。
     */
    context?: string;
  };
  effect: AxEffect;
  risk: AxRisk;
};

export type AxObserveResult = {
  frameId: string;
  pid: number;
  offers: AxActionOffer[];
  page: { offset: number; count: number; total: number; nextOffset?: number };
  elapsedMs: number;
  truncated?: { reason: "depth" | "nodes" | "deadline"; depth: number; nodes: number; ms: number };
};

export type AxPerformParams = {
  frameId: string;
  offerId: string;
  operation: AxOperation;
  value?: string;
};

/**
 * `ax.perform` 的四种业务结局。
 *
 * 定义处在这里，其余地方（`types.ts` 的 `AxExecFact`）从它派生，免得同一份字面量在多处各写一遍而漂移。
 * `effect_unknown` 的性质与其他三个不同：它的语义是「副作用可能已经发生」，所以上层一律按失败处理、
 * 禁止自动重试——这正是 `verify.ts` 把四条结局映射成 check 时要区分开的原因。
 */
export type AxActionStatus = "executed" | "rejected_stale" | "failed" | "effect_unknown";

export type AxPerformResult = {
  status: AxActionStatus;
  artifacts: unknown[];
  verify: { ok: boolean; detail: string };
  error?: string;
};

/**
 * 执行一条 AX 动作所需的上下文。
 *
 * `frameId` 与 `offers` 是**成对**的：`offerId` 只在它所属的那个 frame 里有效，只带 id
 * 不带 frame 等于「拿一个不知道属于哪一帧的 id 去执行」，Swift 侧必然 `rejected_stale`。
 * `peer` 是反向调用的通道——AX 动作走它，绝不生成脚本、不发 Apple Event。
 *
 * `app` 是这一帧归属的前台应用名，由调用方从**本地快照**填，不取自远端——远端给的是一棵
 * 它自己解读过的树，「现在前台是谁」这件事我们自己看得见。它是重复守卫与恢复重认领要用的
 * 目标身份的一部分（见 `loop.ts`）：两个应用可以有同 role 同 label 的按钮，不带 app 会互相冒充。
 */
export type AxExecContext = {
  peer: AxPeer;
  frameId: string;
  offers: readonly AxActionOffer[];
  app: string;
};

export type AxPeer = Pick<RpcPeer, "call">;

export async function observeAX(
  peer: AxPeer,
  params: AxObserveParams,
  opts: RpcCallOptions = {},
): Promise<AxObserveResult> {
  validateObserveParams(params);
  const raw = await peer.call(AX_METHOD_OBSERVE, params, opts);
  return parseObserveResult(raw);
}

export async function performAX(
  peer: AxPeer,
  params: AxPerformParams,
  opts: RpcCallOptions = {},
): Promise<AxPerformResult> {
  validatePerformParams(params);
  const raw = await peer.call(AX_METHOD_PERFORM, params, opts);
  return parsePerformResult(raw);
}

function validateObserveParams(params: AxObserveParams): void {
  if (params.scope !== "focusedWindow" && params.scope !== "application") {
    invalid("scope 必须是 focusedWindow 或 application");
  }
  if (params.pid !== undefined && (!Number.isSafeInteger(params.pid) || params.pid <= 0)) {
    invalid("pid 必须是正整数");
  }
  if (params.offset !== undefined && (!Number.isSafeInteger(params.offset) || params.offset < 0)) {
    invalid("offset 不能是负数");
  }
  if (
    params.pageSize !== undefined &&
    (!Number.isSafeInteger(params.pageSize) || params.pageSize < 1 || params.pageSize > AX_MAX_PAGE_SIZE)
  ) {
    invalid(`pageSize 必须在 1...${AX_MAX_PAGE_SIZE}`);
  }
}

function validatePerformParams(params: AxPerformParams): void {
  if (!nonempty(params.frameId) || !nonempty(params.offerId)) invalid("frameId 与 offerId 必填");
  if (!isOperation(params.operation)) invalid("operation 不受支持");
  if (params.operation === "TYPE_TEXT" && typeof params.value !== "string") {
    invalid("TYPE_TEXT 必须提供 value");
  }
  if (params.operation !== "TYPE_TEXT" && params.value !== undefined) {
    invalid("只有 TYPE_TEXT 可以提供 value");
  }
}

function parseObserveResult(value: unknown): AxObserveResult {
  const root = record(value, "ax.observe result");
  const frameId = requiredString(root.frameId, "frameId");
  const pid = nonnegativeInteger(root.pid, "pid", false);
  const offers = array(root.offers, "offers").map(parseOffer);
  const pageRaw = record(root.page, "page");
  const page: AxObserveResult["page"] = {
    offset: nonnegativeInteger(pageRaw.offset, "page.offset"),
    count: nonnegativeInteger(pageRaw.count, "page.count"),
    total: nonnegativeInteger(pageRaw.total, "page.total"),
  };
  if (pageRaw.nextOffset !== undefined) page.nextOffset = nonnegativeInteger(pageRaw.nextOffset, "page.nextOffset");
  if (page.count !== offers.length || page.offset + page.count > page.total) malformed("page 与 offers 数量不一致");
  const result: AxObserveResult = {
    frameId,
    pid,
    offers,
    page,
    elapsedMs: nonnegativeInteger(root.elapsedMs, "elapsedMs"),
  };
  if (root.truncated !== undefined) {
    const raw = record(root.truncated, "truncated");
    if (raw.reason !== "depth" && raw.reason !== "nodes" && raw.reason !== "deadline") {
      malformed("truncated.reason 不受支持");
    }
    result.truncated = {
      reason: raw.reason,
      depth: nonnegativeInteger(raw.depth, "truncated.depth"),
      nodes: nonnegativeInteger(raw.nodes, "truncated.nodes"),
      ms: nonnegativeInteger(raw.ms, "truncated.ms"),
    };
  }
  return result;
}

function parseOffer(value: unknown): AxActionOffer {
  const raw = record(value, "offer");
  if (!isOperation(raw.operation)) malformed("offer.operation 不受支持");
  if (!isEffect(raw.effect)) malformed("offer.effect 不受支持");
  if (!isRisk(raw.risk)) malformed("offer.risk 不受支持");
  const target = record(raw.target, "offer.target");
  const state = record(target.state, "offer.target.state");
  const parsedState: AxActionOffer["target"]["state"] = {
    enabled: requiredBoolean(state.enabled, "offer.target.state.enabled"),
    editable: requiredBoolean(state.editable, "offer.target.state.editable"),
  };
  if (state.selected !== undefined) parsedState.selected = requiredBoolean(state.selected, "offer.target.state.selected");
  const parsedTarget: AxActionOffer["target"] = {
    ref: requiredString(target.ref, "offer.target.ref"),
    role: requiredString(target.role, "offer.target.role"),
    label: requiredString(target.label, "offer.target.label", true),
    state: parsedState,
  };
  if (target.context !== undefined) {
    const context = requiredString(target.context, "offer.target.context");
    if (context.length > AX_MAX_CONTEXT_CHARACTERS) {
      malformed(`offer.target.context 超过 ${AX_MAX_CONTEXT_CHARACTERS} 字符`);
    }
    parsedTarget.context = context;
  }
  return {
    id: requiredString(raw.id, "offer.id"),
    operation: raw.operation,
    target: parsedTarget,
    effect: raw.effect,
    risk: raw.risk,
  };
}

function parsePerformResult(value: unknown): AxPerformResult {
  const root = record(value, "ax.perform result");
  if (root.status !== "executed" && root.status !== "rejected_stale" && root.status !== "failed" && root.status !== "effect_unknown") {
    malformed("status 不受支持");
  }
  const verify = record(root.verify, "verify");
  const result: AxPerformResult = {
    status: root.status,
    artifacts: array(root.artifacts, "artifacts"),
    verify: {
      ok: requiredBoolean(verify.ok, "verify.ok"),
      detail: requiredString(verify.detail, "verify.detail", true),
    },
  };
  if (root.error !== undefined) result.error = requiredString(root.error, "error", true);
  if (result.status === "executed" && !result.verify.ok) malformed("executed 不能携带失败验证");
  return result;
}

function isOperation(value: unknown): value is AxOperation {
  return value === "CLICK" || value === "TYPE_TEXT" || value === "SELECT" || value === "OPEN";
}

function isEffect(value: unknown): value is AxEffect {
  return value === "read" || value === "navigate" || value === "draft" || value === "submit" || value === "change" || value === "destroy";
}

function isRisk(value: unknown): value is AxRisk {
  return value === "safe" || value === "caution" || value === "destructive";
}

// ── 能力标签自算（阶段 5.2） ─────────────────────────────────────────────────
//
// 决策 2：effect/risk **不信任远端**。Swift 随每个 offer 发来一组标签，Node 按
// `operation + role + editable` 自己再算一遍，两边不符时取更严的一侧（`stricterEffect` /
// `stricterRisk`）。所以下面这张表必须与 Swift `AXOfferFactory`（`AX/AXActionSurface.swift`）
// 平行——它是那个工厂的手抄影子。`test/ax.test.ts` 末尾的跨语言门禁会真去读 Swift 源文本比对，
// 漂移当场变红。

/**
 * Swift `AXOfferFactory.editableRoles` 的影子，存的是 role 的**字面量**而不是 `kAX*Role`
 * 常量名：常量在 ApplicationServices 头里，Node 取不到。门禁测试负责把这些常量名映射回
 * 字面量再比对，映射表里没有的常量会直接抛错——宁可门禁红，也不要静默漏比一条。
 */
export const AX_EDITABLE_ROLES: readonly string[] = ["AXTextField", "AXTextArea", "AXComboBox"];

/** Swift press 分支里分流 operation 的两个 role 字面量（`kAXMenuItemRole as String` / `"AXLink"`）。 */
export const AX_MENU_ITEM_ROLE = "AXMenuItem";
export const AX_LINK_ROLE = "AXLink";

/** 命中某条 role 规则时 Swift 会给的那组标签。 */
type AxRoleDescriptor = { operation: AxOperation; effect: AxEffect; risk: AxRisk };

const AX_TYPE_TEXT_DESCRIPTOR: AxRoleDescriptor = { operation: "TYPE_TEXT", effect: "draft", risk: "safe" };
const AX_SELECT_DESCRIPTOR: AxRoleDescriptor = { operation: "SELECT", effect: "change", risk: "caution" };
const AX_OPEN_DESCRIPTOR: AxRoleDescriptor = { operation: "OPEN", effect: "navigate", risk: "safe" };
const AX_CLICK_DESCRIPTOR: AxRoleDescriptor = { operation: "CLICK", effect: "change", risk: "caution" };

/** 四条 role 规则的完整清单，供跨语言门禁逐条比对。顺序与 Swift 工厂里的 if/else 分支一致。 */
export const AX_ROLE_DESCRIPTORS: readonly AxRoleDescriptor[] = [
  AX_TYPE_TEXT_DESCRIPTOR,
  AX_SELECT_DESCRIPTOR,
  AX_OPEN_DESCRIPTOR,
  AX_CLICK_DESCRIPTOR,
];

/**
 * 兜底档：Node 认不出这个 `operation + role` 组合时用的标签。
 *
 * 取 `change`/`caution` 与 Swift 那句「不能因不认识而降级成 safe」同向——认不出**不降级**，
 * 于是它会自然落进 policy 的确认闸，而不是变成一次静默放行。
 */
const AX_UNKNOWN_EFFECT: AxEffect = "change";
const AX_UNKNOWN_RISK: AxRisk = "caution";

/**
 * 自算结果。`known: false` 表示这个组合 Swift 产不出来（例如 `OPEN` 配一个非 `AXLink` 的 role）；
 * 此时 effect/risk 取兜底档，`known` 交给 policy 决定要不要额外拦一道。
 */
export type AxCapability = { effect: AxEffect; risk: AxRisk; known: boolean };

/**
 * 复刻 `AXOfferFactory.offers(for:)` 的选择，只是反过来问：给一条 offer 的 operation 与目标
 * role，Swift 会不会铸出它、会的话标签是什么。
 *
 * 反过来推的原因：Node 拿不到 `state.actions`（有没有 AXPress），而 operation 本身就是 Swift
 * 按 press 分支算出来的结果。于是这里按 operation 分派回它**应有的 role 前提**，前提不成立
 * 就是「Swift 不会产出这个组合」，返回 undefined 交给调用方判 `known: false`。
 */
function descriptorFor(operation: AxOperation, role: string, editable: boolean): AxRoleDescriptor | undefined {
  switch (operation) {
    case "TYPE_TEXT":
      return editable && AX_EDITABLE_ROLES.includes(role) ? AX_TYPE_TEXT_DESCRIPTOR : undefined;
    case "SELECT":
      return role === AX_MENU_ITEM_ROLE ? AX_SELECT_DESCRIPTOR : undefined;
    case "OPEN":
      return role === AX_LINK_ROLE ? AX_OPEN_DESCRIPTOR : undefined;
    case "CLICK":
      // Swift 的 press 兜底分支：菜单项与链接各走自己的 operation，落到 CLICK 的是「其余一切」。
      return role === AX_MENU_ITEM_ROLE || role === AX_LINK_ROLE ? undefined : AX_CLICK_DESCRIPTOR;
  }
}

export function axCapabilityFor(operation: AxOperation, role: string, editable: boolean): AxCapability {
  const descriptor = descriptorFor(operation, role, editable);
  if (descriptor) return { effect: descriptor.effect, risk: descriptor.risk, known: true };
  return { effect: AX_UNKNOWN_EFFECT, risk: AX_UNKNOWN_RISK, known: false };
}

/**
 * 「更严」是一个全序，不是取最大值：destroy > submit > change > draft > navigate > read。
 * 数组下标即序，越大越严；`indexOf` 相等时返回 `a`，于是同值结果与参数顺序无关。
 */
const AX_EFFECT_ORDER: readonly AxEffect[] = ["read", "navigate", "draft", "submit", "change", "destroy"];
const AX_RISK_ORDER: readonly AxRisk[] = ["safe", "caution", "destructive"];

export function stricterEffect(a: AxEffect, b: AxEffect): AxEffect {
  return AX_EFFECT_ORDER.indexOf(a) >= AX_EFFECT_ORDER.indexOf(b) ? a : b;
}

export function stricterRisk(a: AxRisk, b: AxRisk): AxRisk {
  return AX_RISK_ORDER.indexOf(a) >= AX_RISK_ORDER.indexOf(b) ? a : b;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) malformed(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) malformed(`${field} 必须是数组`);
  return value;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requiredString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) malformed(`${field} 必须是字符串`);
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") malformed(`${field} 必须是 boolean`);
  return value;
}

function nonnegativeInteger(value: unknown, field: string, allowZero = true): number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1)) malformed(`${field} 必须是${allowZero ? "非负" : "正"}整数`);
  return value as number;
}

function invalid(message: string): never {
  throw new RpcFailure("invalid_params", message, { sideEffectFree: true });
}

function malformed(message: string): never {
  throw new RpcFailure("malformed_message", `Swift AX 响应不合法：${message}`, { sideEffectFree: true });
}
