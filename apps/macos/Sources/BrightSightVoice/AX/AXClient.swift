import ApplicationServices
import Foundation

enum AXFailureKind: String, Equatable, Sendable {
  case busy
  case permission
  case stale
  case unsupported
  case invalid
  case unknown
}

struct AXCallError: Error, Equatable, Sendable {
  let code: Int32
  let kind: AXFailureKind
  let operation: String

  var description: String { "\(operation) 失败（AXError \(code)，\(kind.rawValue)）" }
}

enum AXErrorClassifier {
  static func kind(for error: AXError) -> AXFailureKind {
    switch error {
    case .cannotComplete:
      // AX 没有单独的 timeout 错误；官方定义把进程忙、失去响应和消息发送失败都收在这里。
      return .busy
    case .apiDisabled:
      return .permission
    case .invalidUIElement, .noValue:
      return .stale
    case .attributeUnsupported, .actionUnsupported, .parameterizedAttributeUnsupported, .notImplemented:
      return .unsupported
    case .illegalArgument, .invalidUIElementObserver:
      return .invalid
    default:
      return .unknown
    }
  }
}

struct AXAttributeValues {
  private let values: [String: CFTypeRef]

  init(_ values: [String: CFTypeRef]) {
    self.values = values
  }

  subscript(_ attribute: String) -> CFTypeRef? { values[attribute] }

  func string(_ attribute: String) -> String? {
    values[attribute] as? String
  }

  func bool(_ attribute: String) -> Bool? {
    (values[attribute] as? NSNumber)?.boolValue
  }

  func elements(_ attribute: String) -> [AXUIElement] {
    guard let raw = values[attribute] as? [AnyObject] else { return [] }
    return raw.compactMap { value in
      guard CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
      return (value as! AXUIElement)
    }
  }
}

struct AXElementState: Equatable, Sendable {
  let role: String
  let subrole: String?
  let identifier: String?
  let title: String?
  let description: String?
  let value: String?
  let enabled: Bool
  let selected: Bool?
  let editable: Bool
  let actions: [String]

  var visibleSignature: String {
    [role, subrole, identifier, title, description, value, String(enabled), selected.map(String.init)]
      .compactMap { $0 }
      .joined(separator: "\u{1f}")
  }
}

/// AX 本身不可在单元测试里伪造。把遍历、执行与 Chromium 兼容探测真正依赖的最小能力列出来，
/// 测试可以用不触碰系统辅助功能服务的内存实现验证预算、分页、freshness 与调度接线；
/// 生产仍只由 `AXClient` 实现。
protocol AXSurfaceClient {
  func application(processID: pid_t) throws -> AXUIElement
  func focusedWindow(of application: AXUIElement) throws -> AXUIElement
  func state(of element: AXUIElement, includeChildren: Bool) throws -> (AXElementState, [AXUIElement])
  func identical(_ lhs: AXUIElement, _ rhs: AXUIElement) -> Bool
  func replaceText(_ value: String, in element: AXUIElement) throws
  func perform(_ action: String, on element: AXUIElement) throws
  func setManualAccessibility(on application: AXUIElement) throws
  func position(of element: AXUIElement) -> CGPoint?
}

struct AXClient {
  static let fingerprintAttributes = [
    kAXRoleAttribute,
    kAXSubroleAttribute,
    kAXIdentifierAttribute,
    kAXTitleAttribute,
    kAXDescriptionAttribute,
    kAXValueAttribute,
    kAXEnabledAttribute,
    kAXSelectedAttribute,
  ] as [String]

  static let traversalAttributes = fingerprintAttributes + [kAXChildrenAttribute as String]

  let messagingTimeout: Float

  init(messagingTimeout: Float = 1.0) {
    self.messagingTimeout = messagingTimeout
  }

  func application(processID: pid_t) throws -> AXUIElement {
    let app = AXUIElementCreateApplication(processID)
    let result = AXUIElementSetMessagingTimeout(app, messagingTimeout)
    try check(result, operation: "设置 AX messaging timeout")
    return app
  }

  func focusedWindow(of application: AXUIElement) throws -> AXUIElement {
    var raw: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &raw)
    try check(result, operation: "读取 focused window")
    guard let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else {
      throw AXCallError(code: AXError.noValue.rawValue, kind: .stale, operation: "读取 focused window")
    }
    return (raw as! AXUIElement)
  }

  func attributes(_ names: [String], of element: AXUIElement) throws -> AXAttributeValues {
    var raw: CFArray?
    let result = AXUIElementCopyMultipleAttributeValues(
      element,
      names as CFArray,
      AXCopyMultipleAttributeOptions(rawValue: 0),
      &raw
    )
    if result == .notImplemented || result == .attributeUnsupported {
      return try attributesIndividually(names, of: element)
    }
    try check(result, operation: "批量读取 AX 属性")
    guard let items = raw as? [AnyObject], items.count == names.count else {
      throw AXCallError(code: AXError.failure.rawValue, kind: .unknown, operation: "批量读取 AX 属性")
    }
    var values: [String: CFTypeRef] = [:]
    for (name, item) in zip(names, items) {
      if item is NSNull { continue }
      if CFGetTypeID(item) == AXValueGetTypeID(),
         AXValueGetType(item as! AXValue) == .axError
      {
        continue
      }
      values[name] = item
    }
    return AXAttributeValues(values)
  }

  private func attributesIndividually(_ names: [String], of element: AXUIElement) throws -> AXAttributeValues {
    var values: [String: CFTypeRef] = [:]
    for name in names {
      var value: CFTypeRef?
      let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
      if result == .success, let value {
        values[name] = value
      } else if result != .attributeUnsupported && result != .noValue && result != .notImplemented {
        try check(result, operation: "读取 AX 属性 \(name)")
      }
    }
    return AXAttributeValues(values)
  }

  func state(of element: AXUIElement, includeChildren: Bool = false) throws -> (AXElementState, [AXUIElement]) {
    let names = includeChildren ? Self.traversalAttributes : Self.fingerprintAttributes
    let values = try attributes(names, of: element)
    guard let role = values.string(kAXRoleAttribute as String) else {
      throw AXCallError(code: AXError.noValue.rawValue, kind: .stale, operation: "读取 AXRole")
    }
    var actionNames: CFArray?
    let actionResult = AXUIElementCopyActionNames(element, &actionNames)
    let actions: [String]
    if actionResult == .success {
      actions = actionNames as? [String] ?? []
    } else if AXErrorClassifier.kind(for: actionResult) == .permission {
      // 权限失败是整次调用的前提失败，降级没有意义：没授权的话这棵树根本读不了。
      try check(actionResult, operation: "读取 AX actions")
      actions = []
    } else {
      // 其余失败一律降级成「这个元素没有可执行动作」。
      //
      // 实测逼出来的：Finder 窗口里的 `AXSplitter` 对 `AXUIElementCopyActionNames` 返回的是
      // `kAXErrorFailure`（-25200）这个通用失败码，而不是 `kAXErrorActionUnsupported`。
      // 苹果文档里查不到这条，300 个节点的遍历里有 2 个这样的元素——原先只放行 `.unsupported`，
      // 于是一次完全正常的 Finder 观察会被两个分隔条整个带走。
      //
      // 降级而不是跳过元素：`role` 在上面已经读成功了，元素本身是有效的，只是 actions 列表
      // 拿不到。交给遍历层去跳过的话，跳掉的是这个元素**连同它的整棵子树**。
      // 方向上这是 fail-closed：读不到就当它没有动作，宁可少给一个 offer，不会多给。
      //
      // 刻意**不**把 -25200 在 `AXErrorClassifier` 里改判成 `.unsupported`：它是通用失败码，
      // 真正的故障也会走它，改判会让别处的排查失去这个信号。策略差异留在这里，分类保持诚实。
      actions = []
    }
    var settable = DarwinBoolean(false)
    let settableResult = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
    let editable = settableResult == .success && settable.boolValue
    let state = AXElementState(
      role: role,
      subrole: values.string(kAXSubroleAttribute as String),
      identifier: values.string(kAXIdentifierAttribute as String),
      title: Self.text(values[kAXTitleAttribute as String]),
      description: Self.text(values[kAXDescriptionAttribute as String]),
      value: Self.text(values[kAXValueAttribute as String]),
      enabled: values.bool(kAXEnabledAttribute as String) ?? true,
      selected: values.bool(kAXSelectedAttribute as String),
      editable: editable,
      actions: actions
    )
    return (state, includeChildren ? values.elements(kAXChildrenAttribute as String) : [])
  }

  func setFocused(_ element: AXUIElement) throws {
    try check(
      AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue),
      operation: "聚焦 AX 元素"
    )
  }

  func replaceText(_ value: String, in element: AXUIElement) throws {
    try setFocused(element)
    try check(
      AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString),
      operation: "替换 AX 文本"
    )
  }

  func perform(_ action: String, on element: AXUIElement) throws {
    try check(AXUIElementPerformAction(element, action as CFString), operation: "执行 \(action)")
  }

  func setManualAccessibility(on application: AXUIElement) throws {
    try check(
      AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, kCFBooleanTrue),
      operation: "启用 AXManualAccessibility"
    )
  }

  func identical(_ lhs: AXUIElement, _ rhs: AXUIElement) -> Bool {
    CFEqual(lhs, rhs)
  }

  /// 元素在屏幕上的左上角坐标，读不到就是 `nil`。
  ///
  /// **不抛错**，与这个类型里其它读取方法相反：位置只在「文字分不开同名目标」时才被用来兜底，
  /// 是一条锦上添花的信息。让它抛错，等于让一个可选的改进有权作废整次观察。
  ///
  /// 它也**不在** `traversalAttributes` 里，不参与逐节点的批量读取：几何只对分不开的那几个
  /// 元素有意义，而遍历预算是 500 节点 / 150ms 这个量级——真机实测 GitHub 整棵树正好顶满
  /// 150ms，给每个节点多读两个属性是拿常规路径去补一条罕见路径。
  func position(of element: AXUIElement) -> CGPoint? {
    var raw: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &raw)
    guard result == .success, let raw, CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    guard AXValueGetValue(raw as! AXValue, .cgPoint, &point) else { return nil }
    return point
  }

  func processID(of element: AXUIElement) throws -> pid_t {
    var pid: pid_t = 0
    try check(AXUIElementGetPid(element, &pid), operation: "读取 AX 元素进程")
    return pid
  }

  private func check(_ error: AXError, operation: String) throws {
    guard error != .success else { return }
    throw AXCallError(code: error.rawValue, kind: AXErrorClassifier.kind(for: error), operation: operation)
  }

  private static func text(_ value: CFTypeRef?) -> String? {
    switch value {
    case let string as String:
      return capped(string)
    case let number as NSNumber:
      return capped(number.stringValue)
    default:
      return nil
    }
  }

  private static func capped(_ value: String) -> String? {
    let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !clean.isEmpty else { return nil }
    return String(clean.prefix(256))
  }
}

extension AXClient: AXSurfaceClient {}
