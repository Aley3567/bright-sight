import ApplicationServices
import Foundation
@testable import BrightSightVoice

/// AX 的真实实现要连系统辅助功能服务，单元测试里跑不了，所以遍历、执行与调度接线共用一个纯内存替身。
///
/// 单独放一个文件是为了让 `AXActionSurfaceTests`（遍历与执行）和 `AXRuntimeTests`（调度接线）
/// 共用同一份行为定义。两边各写一份 fake，会掩盖「一边的 fake 比另一边宽松」这类缺陷——
/// 那正是最需要被测试发现的一种。
final class FakeAXStore {
  struct Entry {
    let element: AXUIElement
    var state: AXElementState
    let children: [AXUIElement]
  }

  /// 按下之后元素呈现的样子。
  ///
  /// 默认「什么都没变」是刻意的：真实系统里按一下不一定有可观测变化，而 `effect_unknown` 正是
  /// 那种情况下的正确答案。需要覆盖 `executed` 的测试必须显式说出它期待的变化，
  /// 不能让 fake 的默认值替它把结论圆过去。
  enum PressOutcome {
    case changed(AXElementState)
    case unchanged
    case targetVanishes
  }

  let application: AXUIElement
  let focusedWindow: AXUIElement
  var replaceTextCalls = 0
  var performCalls: [String] = []
  var applicationCalls = 0
  var manualAccessibilityCalls = 0
  var pressOutcome: PressOutcome = .unchanged
  private var entries: [Entry] = []
  private var failures: [(AXUIElement, AXCallError)] = []
  private var positions: [(AXUIElement, CGPoint)] = []

  init(application: AXUIElement, focusedWindow: AXUIElement) {
    self.application = application
    self.focusedWindow = focusedWindow
  }

  func add(_ element: AXUIElement, state: AXElementState, children: [AXUIElement] = []) {
    entries.append(Entry(element: element, state: state, children: children))
  }

  func fail(_ element: AXUIElement, with error: AXCallError) {
    failures.append((element, error))
  }

  /// 缺省「读不到位置」是刻意的：真实的 AX 树里有大量元素没有 `AXPosition`，
  /// 而「兜底也兜不住」正是那种情况下的正确答案。需要覆盖几何兜底的测试必须显式摆出坐标，
  /// 不能让替身的缺省值替它把结论圆过去。
  func place(_ element: AXUIElement, at point: CGPoint) {
    positions.append((element, point))
  }

  func position(of element: AXUIElement) -> CGPoint? {
    positions.first { CFEqual($0.0, element) }?.1
  }

  func snapshot(of element: AXUIElement) throws -> (AXElementState, [AXUIElement]) {
    if let failure = failures.first(where: { CFEqual($0.0, element) })?.1 { throw failure }
    guard let entry = entries.first(where: { CFEqual($0.element, element) }) else {
      throw AXCallError(code: AXError.invalidUIElement.rawValue, kind: .stale, operation: "fake lookup")
    }
    return (entry.state, entry.children)
  }

  func replaceText(_ value: String, in element: AXUIElement) throws {
    let index = try index(of: element, operation: "fake replace")
    replaceTextCalls += 1
    let old = entries[index].state
    entries[index].state = AXElementState(
      role: old.role,
      subrole: old.subrole,
      identifier: old.identifier,
      title: old.title,
      description: old.description,
      value: value,
      enabled: old.enabled,
      selected: old.selected,
      editable: old.editable,
      actions: old.actions
    )
  }

  func press(_ action: String, on element: AXUIElement) throws {
    let index = try index(of: element, operation: "fake press")
    performCalls.append(action)
    switch pressOutcome {
    case let .changed(next): entries[index].state = next
    case .unchanged: break
    case .targetVanishes: entries.remove(at: index)
    }
  }

  func currentState(of element: AXUIElement) -> AXElementState? {
    entries.first(where: { CFEqual($0.element, element) })?.state
  }

  private func index(of element: AXUIElement, operation: String) throws -> Int {
    guard let index = entries.firstIndex(where: { CFEqual($0.element, element) }) else {
      throw AXCallError(code: AXError.invalidUIElement.rawValue, kind: .stale, operation: operation)
    }
    return index
  }
}

struct FakeAXClient: AXSurfaceClient {
  let store: FakeAXStore
  /// 非 nil 时每次 `application` 调用都先在这里等，用来把队列压到 `pendingLimit`。
  /// 这是让「背压」可测的唯一办法：不卡住在飞的工作，队列永远不会满。
  var gate: DispatchSemaphore?

  init(store: FakeAXStore, gate: DispatchSemaphore? = nil) {
    self.store = store
    self.gate = gate
  }

  func application(processID _: pid_t) throws -> AXUIElement {
    store.applicationCalls += 1
    gate?.wait()
    return store.application
  }

  func focusedWindow(of _: AXUIElement) throws -> AXUIElement { store.focusedWindow }

  func state(of element: AXUIElement, includeChildren: Bool) throws -> (AXElementState, [AXUIElement]) {
    let snapshot = try store.snapshot(of: element)
    return (snapshot.0, includeChildren ? snapshot.1 : [])
  }

  func identical(_ lhs: AXUIElement, _ rhs: AXUIElement) -> Bool { CFEqual(lhs, rhs) }

  func replaceText(_ value: String, in element: AXUIElement) throws { try store.replaceText(value, in: element) }

  func perform(_ action: String, on element: AXUIElement) throws { try store.press(action, on: element) }

  func setManualAccessibility(on _: AXUIElement) throws { store.manualAccessibilityCalls += 1 }

  func position(of element: AXUIElement) -> CGPoint? { store.position(of: element) }
}

func axState(
  role: String,
  subrole: String? = nil,
  identifier: String? = nil,
  title: String? = nil,
  value: String? = nil,
  enabled: Bool = true,
  selected: Bool? = nil,
  editable: Bool = false,
  actions: [String] = []
) -> AXElementState {
  AXElementState(
    role: role,
    subrole: subrole,
    identifier: identifier,
    title: title,
    description: nil,
    value: value,
    enabled: enabled,
    selected: selected,
    editable: editable,
    actions: actions
  )
}

/// 构造 `ax.observe` 的线上参数。走 JSON 而不是直接 init，是因为参数校验本身也是被测行为。
func axObserveParams(_ fields: [String: JSONValue]) throws -> AXObserveParams {
  try AXObserveParams(json: .object(fields))
}

func axPerformParams(
  frameID: String,
  offerID: String,
  operation: AXOperation,
  value: String? = nil
) throws -> AXPerformParams {
  var fields: [String: JSONValue] = [
    "frameId": .string(frameID),
    "offerId": .string(offerID),
    "operation": .string(operation.rawValue),
  ]
  if let value { fields["value"] = .string(value) }
  return try AXPerformParams(json: .object(fields))
}
