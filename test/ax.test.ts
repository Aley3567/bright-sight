import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AX_EDITABLE_ROLES,
  AX_LINK_ROLE,
  AX_MAX_CONTEXT_CHARACTERS,
  AX_MAX_CONTEXT_LEVELS,
  AX_MAX_PAGE_SIZE,
  AX_MENU_ITEM_ROLE,
  AX_METHOD_OBSERVE,
  AX_METHOD_PERFORM,
  AX_ROLE_DESCRIPTORS,
  axCapabilityFor,
  observeAX,
  performAX,
  stricterEffect,
  stricterRisk,
  type AxEffect,
  type AxOperation,
  type AxRisk,
} from "../src/ax.ts";
import { AX_SERVER_METHODS } from "../src/protocol.ts";
import { RpcFailure, type RpcPeer } from "../src/rpc.ts";

function peerReturning(result: unknown, seen: Array<{ method: string; params: unknown }> = []): Pick<RpcPeer, "call"> {
  return {
    call: async <T>(method: string, params?: unknown): Promise<T> => {
      seen.push({ method, params });
      return result as T;
    },
  };
}

const offer = {
  id: "offer-1",
  operation: "CLICK",
  target: {
    ref: "opaque-ref",
    role: "AXButton",
    label: "继续",
    state: { enabled: true, editable: false },
  },
  effect: "change",
  risk: "caution",
};

test("ax.observe sends only structured scope and validates the returned frame", async () => {
  const seen: Array<{ method: string; params: unknown }> = [];
  const result = await observeAX(peerReturning({
    frameId: "frame-1",
    pid: 42,
    offers: [offer],
    page: { offset: 0, count: 1, total: 1 },
    elapsedMs: 7,
  }, seen), { scope: "focusedWindow", pid: 42 });

  assert.equal(result.frameId, "frame-1");
  assert.equal(result.offers[0]?.target.ref, "opaque-ref");
  assert.deepEqual(seen, [{ method: "ax.observe", params: { scope: "focusedWindow", pid: 42 } }]);
  assert.equal("path" in result.offers[0]!.target, false, "AX 路径不能越过 Swift 边界");
});

test("ax.observe rejects malformed pagination instead of silently accepting it", async () => {
  await assert.rejects(
    observeAX(peerReturning({
      frameId: "frame-1",
      pid: 42,
      offers: [offer],
      page: { offset: 0, count: 0, total: 1 },
      elapsedMs: 7,
    }), { scope: "application" }),
    (error: unknown) => error instanceof RpcFailure && error.code === "malformed_message",
  );
});

test("ax.perform requires text only for TYPE_TEXT", async () => {
  const peer = peerReturning({ status: "executed", artifacts: [], verify: { ok: true, detail: "ok" } });
  await assert.rejects(
    performAX(peer, { frameId: "f", offerId: "o", operation: "TYPE_TEXT" }),
    (error: unknown) => error instanceof RpcFailure && error.code === "invalid_params",
  );
  await assert.rejects(
    performAX(peer, { frameId: "f", offerId: "o", operation: "CLICK", value: "x" }),
    (error: unknown) => error instanceof RpcFailure && error.code === "invalid_params",
  );
});

test("ax.perform preserves stale and effect_unknown as business results", async () => {
  const stale = await performAX(peerReturning({
    status: "rejected_stale",
    artifacts: [],
    verify: { ok: false, detail: "frame expired" },
  }), { frameId: "f", offerId: "o", operation: "CLICK" });
  assert.equal(stale.status, "rejected_stale");

  const unknown = await performAX(peerReturning({
    status: "effect_unknown",
    artifacts: [],
    verify: { ok: false, detail: "readback failed" },
    error: "do not retry",
  }), { frameId: "f", offerId: "o", operation: "CLICK" });
  assert.equal(unknown.status, "effect_unknown");
  assert.equal(unknown.error, "do not retry");
});

test("ax.perform refuses a success result whose verification failed", async () => {
  await assert.rejects(
    performAX(peerReturning({
      status: "executed",
      artifacts: [],
      verify: { ok: false, detail: "contradiction" },
    }), { frameId: "f", offerId: "o", operation: "CLICK" }),
    (error: unknown) => error instanceof RpcFailure && error.code === "malformed_message",
  );
});

// ── 跨语言常量对照 ───────────────────────────────────────────────────────────
//
// `CoreProtocol.swift` 是 `src/protocol.ts` 的手抄影子，没有 codegen，漂移只能靠测试发现。
// 下面这两条真的去读 Swift 源文件，而不是各写一遍字面量——后者在两边同时改错时依然全绿。

const SWIFT_CORE_PROTOCOL = new URL(
  "../apps/macos/Sources/BrightSightVoice/CoreBridge/CoreProtocol.swift",
  import.meta.url,
);
const SWIFT_AX_MODELS = new URL(
  "../apps/macos/Sources/BrightSightVoice/AX/AXModels.swift",
  import.meta.url,
);

/** 抽出 `static let methodAX… = "…"` 里的线协议方法名。 */
function swiftWireMethodNames(source: string): string[] {
  return [...source.matchAll(/static let methodAX\w+ = "([^"]+)"/g)].map((match) => match[1]!);
}

/** 抽出 `static let <name> = N`。按名字取，免得每加一条限额就复制一个提取器。 */
function swiftIntLimit(source: string, name: string): number | undefined {
  const match = new RegExp(`static let ${name} = (\\d+)`).exec(source);
  return match ? Number(match[1]) : undefined;
}

test("AX 方法名在 Node 三处与 Swift 影子之间一致", async () => {
  const swiftMethods = swiftWireMethodNames(await readFile(SWIFT_CORE_PROTOCOL, "utf8"));

  assert.deepEqual(
    [AX_METHOD_OBSERVE, AX_METHOD_PERFORM].sort(),
    [...AX_SERVER_METHODS].sort(),
    "src/ax.ts 与 src/protocol.ts 的 AX 方法名漂移了",
  );
  assert.deepEqual(
    swiftMethods.sort(),
    [...AX_SERVER_METHODS].sort(),
    "Swift CoreProtocol 的 methodAX* 常量与本侧 AX_SERVER_METHODS 漂移了",
  );
});

test("pageSize 上限在 Node 校验与 Swift 校验之间一致", async () => {
  const swiftLimit = swiftIntLimit(await readFile(SWIFT_AX_MODELS, "utf8"), "maxPageSize");

  assert.equal(swiftLimit, AX_MAX_PAGE_SIZE, "Swift AXWireLimits.maxPageSize 与 AX_MAX_PAGE_SIZE 漂移了");
  await assert.rejects(
    observeAX(peerReturning({}), { scope: "application", pageSize: AX_MAX_PAGE_SIZE + 1 }),
    (error: unknown) => error instanceof RpcFailure && error.code === "invalid_params",
  );
  await assert.rejects(
    observeAX(peerReturning({}), { scope: "application", pageSize: 0 }),
    (error: unknown) => error instanceof RpcFailure && error.code === "invalid_params",
  );
});

test("区分文字的两个限额在 Node 与 Swift 之间一致", async () => {
  const source = await readFile(SWIFT_AX_MODELS, "utf8");

  assert.equal(
    swiftIntLimit(source, "maxContextCharacters"),
    AX_MAX_CONTEXT_CHARACTERS,
    "Swift AXWireLimits.maxContextCharacters 与 AX_MAX_CONTEXT_CHARACTERS 漂移了",
  );
  assert.equal(
    swiftIntLimit(source, "maxContextLevels"),
    AX_MAX_CONTEXT_LEVELS,
    "Swift AXWireLimits.maxContextLevels 与 AX_MAX_CONTEXT_LEVELS 漂移了",
  );
});

test("跨语言对照测试本身有效：字面量一改就会被发现", () => {
  // 没有这条，上面两条可以退化成「提取器永远返回空/期望值」而全绿。
  assert.deepEqual(
    swiftWireMethodNames('static let methodAXObserve = "ax.observe.v2"'),
    ["ax.observe.v2"],
    "提取器没有真的读源文本",
  );
  assert.equal(swiftIntLimit("static let maxPageSize = 201", "maxPageSize"), 201);
  assert.equal(swiftIntLimit("// 这个文件里没有那个常量", "maxPageSize"), undefined, "找不到时必须返回 undefined 而不是凑一个值");
  // 按名字取就必须真的分得清名字：两个常量挨着放时，不能拿前一个的值去答后一个。
  assert.equal(swiftIntLimit("static let maxContextCharacters = 200\nstatic let maxContextLevels = 3", "maxContextLevels"), 3);
  assert.deepEqual(swiftWireMethodNames("static let methodSessionHandle = \"session.handle\""), []);
});

// ── 能力标签自算（阶段 5.2） ─────────────────────────────────────────────────
//
// 决策 2 的落点：Node 不信任 Swift 发来的 effect/risk，自己按 operation + role + editable 再算一遍，
// 不符时取更严的一侧。下面先钉住自算结果，再与 Swift AXOfferFactory 的源文本做跨语言对照。

test("axCapabilityFor 复刻 Swift 的四条 role 规则", () => {
  // 可编辑文本框 → TYPE_TEXT/draft/safe（editable 与 role 两个前提都要满足）
  assert.deepEqual(axCapabilityFor("TYPE_TEXT", "AXTextField", true), { effect: "draft", risk: "safe", known: true });
  assert.deepEqual(axCapabilityFor("TYPE_TEXT", "AXTextArea", true), { effect: "draft", risk: "safe", known: true });
  assert.deepEqual(axCapabilityFor("TYPE_TEXT", "AXComboBox", true), { effect: "draft", risk: "safe", known: true });
  // 菜单项 → SELECT/change/caution
  assert.deepEqual(axCapabilityFor("SELECT", "AXMenuItem", false), { effect: "change", risk: "caution", known: true });
  // AXLink → OPEN/navigate/safe
  assert.deepEqual(axCapabilityFor("OPEN", "AXLink", false), { effect: "navigate", risk: "safe", known: true });
  // 其余有 AXPress 的 role → CLICK/change/caution（兜底，不降级）
  assert.deepEqual(axCapabilityFor("CLICK", "AXButton", false), { effect: "change", risk: "caution", known: true });
});

test("axCapabilityFor 拦得住：认不出的组合按兜底档算，绝不降级成 safe", () => {
  const unknown: Array<[AxOperation, string, boolean]> = [
    // operation 与该 role 应有的 operation 不符
    ["SELECT", "AXButton", false],
    ["OPEN", "AXButton", false],
    ["CLICK", "AXMenuItem", false], // 菜单项 Swift 走 SELECT，不会落到 CLICK
    ["CLICK", "AXLink", false], // 链接 Swift 走 OPEN，不会落到 CLICK
    // TYPE_TEXT 的两个前提任一不满足
    ["TYPE_TEXT", "AXButton", true],
    ["TYPE_TEXT", "AXTextField", false], // 不可编辑的文本框
  ];
  for (const [operation, role, editable] of unknown) {
    const capability = axCapabilityFor(operation, role, editable);
    const where = `${operation}/${role}/${editable}`;
    assert.equal(capability.known, false, `${where} 应当认不出`);
    assert.equal(capability.effect, "change", `${where} 的兜底 effect`);
    assert.equal(capability.risk, "caution", `${where} 的兜底 risk`);
    assert.notEqual(capability.risk, "safe", `${where} 不能降级成 safe`);
    assert.notEqual(capability.effect, "read", `${where} 不能降级成 read`);
  }
});

test("axCapabilityFor 不越界：认识得出的组合逐字沿用 Swift 标签，不被兜底吞掉", () => {
  // AXLink 是唯一的 navigate/safe 组合；若被兜底吞掉会变成 change/caution，这条钉住它
  assert.deepEqual(axCapabilityFor("OPEN", "AXLink", false), { effect: "navigate", risk: "safe", known: true });
  // 可编辑文本框是唯一的 draft/safe 组合
  assert.deepEqual(axCapabilityFor("TYPE_TEXT", "AXTextField", true), { effect: "draft", risk: "safe", known: true });
  // 同一 role、不同 operation：CLICK 认识、SELECT 不认识——判据挂在 operation 上，没有把整类 role 一刀切
  assert.equal(axCapabilityFor("CLICK", "AXTextField", false).known, true);
  assert.equal(axCapabilityFor("SELECT", "AXTextField", false).known, false);
});

test("更严是全序 destroy > submit > change > draft > navigate > read", () => {
  const order: AxEffect[] = ["read", "navigate", "draft", "submit", "change", "destroy"];
  // 穷举全部 36 对：既钉住序本身，也钉住同值恒等与参数对称
  for (let i = 0; i < order.length; i += 1) {
    for (let j = 0; j < order.length; j += 1) {
      assert.equal(stricterEffect(order[i]!, order[j]!), j >= i ? order[j]! : order[i]!);
    }
  }
  // 相邻对防「取最大值」的误读：change 严于 submit，submit 严于 draft，draft 严于 navigate
  assert.equal(stricterEffect("change", "submit"), "change");
  assert.equal(stricterEffect("submit", "draft"), "submit");
  assert.equal(stricterEffect("draft", "navigate"), "draft");
});

test("stricterRisk 是全序 destructive > caution > safe", () => {
  const order: AxRisk[] = ["safe", "caution", "destructive"];
  for (let i = 0; i < order.length; i += 1) {
    for (let j = 0; j < order.length; j += 1) {
      assert.equal(stricterRisk(order[i]!, order[j]!), j >= i ? order[j]! : order[i]!);
    }
  }
  assert.equal(stricterRisk("safe", "caution"), "caution");
  assert.equal(stricterRisk("destructive", "caution"), "destructive");
  assert.equal(stricterRisk("safe", "safe"), "safe");
});

// ── 跨语言门禁：role → effect/risk 表（阶段 5.2） ─────────────────────────────
//
// `AXOfferFactory` 是 Swift 那份映射，`AX_ROLE_DESCRIPTORS` 是它在 Node 侧的影子。这里真去读
// Swift 源文本比对，而不是两边各写一遍字面量——后者在两边同时改错时依然全绿。它只看源码文本，
// 不编译、不跑 Swift、不碰 Accessibility，所以无条件跑在 npm test 里。

const SWIFT_AX_ACTION_SURFACE = new URL(
  "../apps/macos/Sources/BrightSightVoice/AX/AXActionSurface.swift",
  import.meta.url,
);

/**
 * `kAX*Role` 常量到线上 role 串的桥。这些值来自 ApplicationServices 头，对所有 macOS 都一样。
 * 桥表里没有的常量会在 resolveSwiftRole 里抛错——新增一条 editableRole 会当场把门禁弄红，
 * 逼着人回来同步 Node 侧，而不是被静默漏掉。
 */
const SWIFT_ROLE_CONSTANTS: Record<string, string> = {
  kAXTextFieldRole: "AXTextField",
  kAXTextAreaRole: "AXTextArea",
  kAXComboBoxRole: "AXComboBox",
  kAXMenuItemRole: "AXMenuItem",
};

/** Swift `AXOperation` 的 case 名到线协议值的桥（effect/risk 的 case 名与值同名，不需要桥）。 */
const SWIFT_OPERATION_CASES: Record<string, AxOperation> = {
  click: "CLICK",
  typeText: "TYPE_TEXT",
  select: "SELECT",
  open: "OPEN",
};

function resolveSwiftRole(token: string): string {
  const name = token.replace(/\s+as\s+String$/, "").trim();
  if (name.startsWith('"') && name.endsWith('"')) return name.slice(1, -1);
  const resolved = SWIFT_ROLE_CONSTANTS[name];
  if (!resolved) throw new Error(`门禁不认识 Swift role 常量 ${name}，先把它加进 SWIFT_ROLE_CONSTANTS`);
  return resolved;
}

/** 抽出 `editableRoles: Set<String> = [ … ]` 里的 role 串。找不到那块时返回空数组——比对会因此变红，fail-closed。 */
function swiftEditableRoles(source: string): string[] {
  const block = /static let editableRoles: Set<String> = \[([\s\S]*?)\]/.exec(source);
  if (!block) return [];
  return block[1]!
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(resolveSwiftRole);
}

/** 抽出工厂里每一条 `.init(operation: .x, effect: .y, risk: .z)`。 */
function swiftOfferDescriptors(source: string): Array<{ operation: string; effect: string; risk: string }> {
  return [...source.matchAll(/\.init\(operation:\s*\.(\w+),\s*effect:\s*\.(\w+),\s*risk:\s*\.(\w+)\)/g)].map(
    (match) => ({
      operation: SWIFT_OPERATION_CASES[match[1]!] ?? match[1]!,
      effect: match[2]!,
      risk: match[3]!,
    }),
  );
}

/** 抽出 press 分支里 `state.role == …` 的 role 前提。 */
function swiftPressRoleConditions(source: string): string[] {
  return [...source.matchAll(/state\.role\s*==\s*\(?(.*?)\)?\s*\{/g)].map((match) => resolveSwiftRole(match[1]!));
}

const normalizeDescriptor = (d: { operation: string; effect: string; risk: string }): string =>
  `${d.operation}/${d.effect}/${d.risk}`;

test("role → effect/risk 映射在 Node 与 Swift AXOfferFactory 之间一致", async () => {
  const swift = await readFile(SWIFT_AX_ACTION_SURFACE, "utf8");
  assert.deepEqual(
    swiftOfferDescriptors(swift).map(normalizeDescriptor).sort(),
    AX_ROLE_DESCRIPTORS.map(normalizeDescriptor).sort(),
    "src/ax.ts 的 AX_ROLE_DESCRIPTORS 与 Swift AXOfferFactory 漂移了",
  );
});

test("editableRoles 在 Node 与 Swift 之间一致", async () => {
  const swift = await readFile(SWIFT_AX_ACTION_SURFACE, "utf8");
  assert.deepEqual(swiftEditableRoles(swift).sort(), [...AX_EDITABLE_ROLES].sort(), "可编辑 role 集合漂移了");
});

test("press 分支的 role 字面量在 Node 与 Swift 之间一致", async () => {
  const swift = await readFile(SWIFT_AX_ACTION_SURFACE, "utf8");
  assert.deepEqual(
    swiftPressRoleConditions(swift).sort(),
    [AX_MENU_ITEM_ROLE, AX_LINK_ROLE].sort(),
    "菜单项 / 链接的 role 字面量漂移了",
  );
});

test("跨语言映射门禁本身有效：Swift 字面量一改就会被发现", () => {
  // 没有这条，上面三条可以退化成「提取器永远返回空」而全绿。
  assert.deepEqual(
    swiftOfferDescriptors("result.append(.init(operation: .open, effect: .read, risk: .destructive))"),
    [{ operation: "OPEN", effect: "read", risk: "destructive" }],
    "提取器没有真的读 operation/effect/risk 三件套",
  );
  assert.deepEqual(
    swiftPressRoleConditions('if state.role == "AXLinkX" {'),
    ["AXLinkX"],
    "提取器没有真的读 press 分支的 role 前提",
  );
  assert.deepEqual(
    swiftEditableRoles("private static let editableRoles: Set<String> = [\n  kAXComboBoxRole as String,\n]"),
    ["AXComboBox"],
    "提取器没有真的读 editableRoles",
  );
  // 桥表里没有的常量必须炸，而不是静默丢掉一条
  assert.throws(
    () => swiftEditableRoles("private static let editableRoles: Set<String> = [ kAXSecureTextFieldRole as String ]"),
    /不认识/,
  );
  // 找不到那块时必须返回空数组，而不是凑一个值
  assert.deepEqual(swiftEditableRoles("// 这个文件里没有 editableRoles"), []);
});

// ── 区分文字的解析 ────────────────────────────────────────────────────────────

function observeWith(target: Record<string, unknown>): unknown {
  return {
    frameId: "frame-1",
    pid: 42,
    offers: [{ ...offer, target: { ...offer.target, ...target } }],
    page: { offset: 0, count: 1, total: 1 },
    elapsedMs: 7,
  };
}

test("ax.observe 收下 offer 的区分文字，缺省时是 undefined 而不是空串", async () => {
  const withContext = await observeAX(peerReturning(observeWith({ context: "草稿 未命名 删除" })), { scope: "focusedWindow" });
  assert.equal(withContext.offers[0]?.target.context, "草稿 未命名 删除");

  const without = await observeAX(peerReturning(observeWith({})), { scope: "focusedWindow" });
  assert.equal(without.offers[0]?.target.context, undefined, "缺省要留成 undefined：空串会在选项说明里落下一对空括号");
});

test("ax.observe 判超长的区分文字为畸形，不悄悄截断", async () => {
  // 截断由对侧负责。本侧再截一刀，等于把「对侧聚合逻辑漏了截断」这个缺陷抹平成正常行为——
  // 上限的意义就是超了要有人知道。
  await assert.rejects(
    observeAX(peerReturning(observeWith({ context: "长".repeat(AX_MAX_CONTEXT_CHARACTERS + 1) })), { scope: "focusedWindow" }),
    (error: unknown) => error instanceof RpcFailure && error.code === "malformed_message",
  );
  // 恰好等于上限要放行：边界上差一个的写法会让对侧每次截满都被拒。
  const exact = await observeAX(
    peerReturning(observeWith({ context: "长".repeat(AX_MAX_CONTEXT_CHARACTERS) })),
    { scope: "focusedWindow" },
  );
  assert.equal(exact.offers[0]?.target.context?.length, AX_MAX_CONTEXT_CHARACTERS);
});

test("ax.observe 判非字符串的区分文字为畸形", async () => {
  await assert.rejects(
    observeAX(peerReturning(observeWith({ context: 42 })), { scope: "focusedWindow" }),
    (error: unknown) => error instanceof RpcFailure && error.code === "malformed_message",
  );
});
