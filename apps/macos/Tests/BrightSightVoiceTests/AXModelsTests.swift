import ApplicationServices
import XCTest
@testable import BrightSightVoice

final class AXModelsTests: XCTestCase {
  func testObserveParamsValidateScopePaginationAndPID() throws {
    let params = try AXObserveParams(json: .object([
      "scope": .string("application"),
      "pid": .number(42),
      "offset": .number(20),
      "pageSize": .number(50),
    ]))
    XCTAssertEqual(params.scope, .application)
    XCTAssertEqual(params.processID, 42)
    XCTAssertEqual(params.offset, 20)
    XCTAssertEqual(params.pageSize, 50)

    XCTAssertThrowsError(try AXObserveParams(json: .object(["scope": .string("desktop")])))
    XCTAssertThrowsError(try AXObserveParams(json: .object(["scope": .string("application"), "pid": .number(-1)])))
    XCTAssertThrowsError(try AXObserveParams(json: .object(["scope": .string("application"), "pageSize": .number(201)])))
  }

  func testObserveParamsCarryTraversalBudgetOverridesAndRejectOutOfRange() throws {
    let params = try AXObserveParams(json: .object([
      "scope": .string("focusedWindow"),
      "depth": .number(12),
      "nodes": .number(800),
      "ms": .number(150),
    ]))
    XCTAssertEqual(params.depth, 12)
    XCTAssertEqual(params.nodes, 800)
    XCTAssertEqual(params.milliseconds, 150)

    // 不带就是 nil：由 overridden 退回基准值，不是「不限」，也不是「0」
    let bare = try AXObserveParams(json: .object(["scope": .string("focusedWindow")]))
    XCTAssertNil(bare.depth)
    XCTAssertNil(bare.nodes)
    XCTAssertNil(bare.milliseconds)
    XCTAssertNil(bare.pageSize)

    // 边界值要放行
    XCTAssertNoThrow(try AXObserveParams(json: .object([
      "scope": .string("application"), "depth": .number(Double(AXWireLimits.maxDepth)),
    ])))
    XCTAssertNoThrow(try AXObserveParams(json: .object([
      "scope": .string("application"), "nodes": .number(Double(AXWireLimits.maxNodes)),
    ])))
    XCTAssertNoThrow(try AXObserveParams(json: .object([
      "scope": .string("application"), "ms": .number(Double(AXWireLimits.maxMilliseconds)),
    ])))

    // 越界 / 类型不对都要当场拒，不能静默退回缺省——退回缺省等于一次看起来正常的浅观察。
    // 这组是「新旧分支同时可能命中」：旧分支（合法参数）必须照旧通过，新分支（越界）必须拦住。
    XCTAssertThrowsError(try AXObserveParams(json: .object([
      "scope": .string("application"), "depth": .number(Double(AXWireLimits.maxDepth + 1)),
    ])))
    XCTAssertThrowsError(try AXObserveParams(json: .object([
      "scope": .string("application"), "depth": .number(-1),
    ])))
    XCTAssertThrowsError(try AXObserveParams(json: .object([
      "scope": .string("application"), "nodes": .number(Double(AXWireLimits.maxNodes + 1)),
    ])))
    XCTAssertThrowsError(try AXObserveParams(json: .object([
      "scope": .string("application"), "ms": .number(0),
    ])))
    XCTAssertThrowsError(try AXObserveParams(json: .object([
      "scope": .string("application"), "depth": .string("12"),
    ])))
  }

  func testBudgetOverriddenKeepsTheBaseForOmittedFields() {
    let base = AXTraversalBudget(maxDepth: 2, maxNodes: 50, maxMilliseconds: 1_000, pageSize: 10)

    // 只覆盖 depth：另外两项保持基准值，既不是被清零，也不是被放大
    let onlyDepth = base.overridden(maxDepth: 12, maxNodes: nil, maxMilliseconds: nil)
    XCTAssertEqual(onlyDepth.maxDepth, 12)
    XCTAssertEqual(onlyDepth.maxNodes, 50)
    XCTAssertEqual(onlyDepth.maxMilliseconds, 1_000)
    XCTAssertEqual(onlyDepth.pageSize, 10)

    // 三项全缺省 = 基准值本身——「不传 = 用基准值」这条就是它
    XCTAssertEqual(base.overridden(maxDepth: nil, maxNodes: nil, maxMilliseconds: nil), base)

    // 生产默认档由具名常量组装；跨语言门禁（test/ax.test.ts）另比对这几个常量的取值
    XCTAssertEqual(AXTraversalBudget.protectiveDefault.maxDepth, AXTraversalBudget.defaultMaxDepth)
    XCTAssertEqual(AXTraversalBudget.protectiveDefault.maxNodes, AXTraversalBudget.defaultMaxNodes)
    XCTAssertEqual(
      AXTraversalBudget.protectiveDefault.maxMilliseconds,
      AXTraversalBudget.defaultMaxMilliseconds
    )
    XCTAssertEqual(AXTraversalBudget.protectiveDefault.pageSize, AXTraversalBudget.defaultPageSize)
  }

  func testPerformParamsKeepValueOnTypeTextOnly() throws {
    let typed = try AXPerformParams(json: .object([
      "frameId": .string("f"),
      "offerId": .string("o"),
      "operation": .string("TYPE_TEXT"),
      "value": .string("原样文本"),
    ]))
    XCTAssertEqual(typed.value, "原样文本")

    XCTAssertThrowsError(try AXPerformParams(json: .object([
      "frameId": .string("f"), "offerId": .string("o"), "operation": .string("TYPE_TEXT"),
    ])))
    XCTAssertThrowsError(try AXPerformParams(json: .object([
      "frameId": .string("f"), "offerId": .string("o"), "operation": .string("CLICK"), "value": .string("x"),
    ])))
  }

  func testOfferFactoryMapsKnownOperationsAndKeepsUnknownRolesConservative() {
    let text = state(role: kAXTextFieldRole as String, editable: true)
    XCTAssertEqual(
      AXOfferFactory.offers(for: text),
      [AXOfferDescriptor(operation: .typeText, effect: .draft, risk: .safe)]
    )

    let menu = state(role: kAXMenuItemRole as String, actions: [kAXPressAction as String])
    XCTAssertEqual(
      AXOfferFactory.offers(for: menu),
      [AXOfferDescriptor(operation: .select, effect: .change, risk: .caution)]
    )

    let unknown = state(role: "AXFutureControl", actions: [kAXPressAction as String])
    XCTAssertEqual(
      AXOfferFactory.offers(for: unknown),
      [AXOfferDescriptor(operation: .click, effect: .change, risk: .caution)],
      "不认识的 role 可以沿系统声明的 AXPress 降级，但不能降成 safe"
    )
    XCTAssertTrue(AXOfferFactory.offers(for: state(role: "AXFutureControl", enabled: false, actions: [kAXPressAction as String])).isEmpty)
  }

  func testFingerprintRequiresPathWindowAndAttributesTogether() {
    let base = AXElementFingerprint(
      processID: 42,
      window: AXWindowFingerprint(role: "AXWindow", subrole: nil, identifier: "main", title: "A"),
      path: [0, 2],
      role: "AXButton",
      subrole: nil,
      identifier: "save",
      title: "保存",
      value: nil
    )
    XCTAssertTrue(base.matches(base))
    let moved = AXElementFingerprint(
      processID: 42,
      window: base.window,
      path: [0, 3],
      role: base.role,
      subrole: base.subrole,
      identifier: base.identifier,
      title: base.title,
      value: base.value
    )
    XCTAssertFalse(base.matches(moved), "属性相同但路径变了也不能沿用旧引用")
  }

  func testAXErrorsSeparateBusyPermissionStaleAndUnsupported() {
    XCTAssertEqual(AXErrorClassifier.kind(for: .cannotComplete), .busy)
    XCTAssertEqual(AXErrorClassifier.kind(for: .apiDisabled), .permission)
    XCTAssertEqual(AXErrorClassifier.kind(for: .invalidUIElement), .stale)
    XCTAssertEqual(AXErrorClassifier.kind(for: .attributeUnsupported), .unsupported)
    XCTAssertEqual(AXErrorClassifier.kind(for: .failure), .unknown)
  }

  private func state(
    role: String,
    enabled: Bool = true,
    editable: Bool = false,
    actions: [String] = []
  ) -> AXElementState {
    AXElementState(
      role: role,
      subrole: nil,
      identifier: nil,
      title: "控件",
      description: nil,
      value: nil,
      enabled: enabled,
      selected: nil,
      editable: editable,
      actions: actions
    )
  }
}
