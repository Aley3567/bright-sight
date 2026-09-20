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
