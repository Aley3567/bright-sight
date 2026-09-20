import ApplicationServices
import Foundation

enum AXObservationScope: String, Equatable, Sendable {
  case focusedWindow
  case application
}

enum AXOperation: String, Equatable, Sendable {
  case click = "CLICK"
  case typeText = "TYPE_TEXT"
  case select = "SELECT"
  case open = "OPEN"
}

enum AXCapabilityEffect: String, Equatable, Sendable {
  case read
  case navigate
  case draft
  case submit
  case change
  case destroy
}

enum AXCapabilityRisk: String, Equatable, Sendable {
  case safe
  case caution
  case destructive
}

enum AXActionStatus: String, Equatable, Sendable {
  case executed
  case rejectedStale = "rejected_stale"
  case failed
  case effectUnknown = "effect_unknown"
}

struct AXTraversalBudget: Equatable, Sendable {
  let maxDepth: Int
  let maxNodes: Int
  let maxMilliseconds: Int
  let pageSize: Int

  static let protectiveDefault = AXTraversalBudget(
    maxDepth: 6,
    maxNodes: 500,
    maxMilliseconds: 150,
    pageSize: 80
  )

  init(maxDepth: Int, maxNodes: Int, maxMilliseconds: Int, pageSize: Int) {
    precondition(maxDepth >= 0)
    precondition(maxNodes > 0)
    precondition(maxMilliseconds > 0)
    precondition(pageSize > 0)
    self.maxDepth = maxDepth
    self.maxNodes = maxNodes
    self.maxMilliseconds = maxMilliseconds
    self.pageSize = pageSize
  }
}

struct AXTruncation: Equatable, Sendable {
  enum Reason: String, Equatable, Sendable {
    case depth
    case nodes
    case deadline
  }

  let reason: Reason
  let depth: Int
  let nodes: Int
  let milliseconds: Int

  var json: JSONValue {
    .object([
      "reason": .string(reason.rawValue),
      "depth": .number(Double(depth)),
      "nodes": .number(Double(nodes)),
      "ms": .number(Double(milliseconds)),
    ])
  }
}

struct AXTargetState: Equatable, Sendable {
  let enabled: Bool
  let selected: Bool?
  let editable: Bool

  var json: JSONValue {
    var fields: [String: JSONValue] = [
      "enabled": .bool(enabled),
      "editable": .bool(editable),
    ]
    if let selected { fields["selected"] = .bool(selected) }
    return .object(fields)
  }
}

struct AXActionOffer: Equatable, Sendable {
  let id: String
  let operation: AXOperation
  let ref: String
  let role: String
  let label: String
  let state: AXTargetState
  let effect: AXCapabilityEffect
  let risk: AXCapabilityRisk
  /// 把这个目标与同名目标区分开的文字，**只有 label 撞了才有值**。
  ///
  /// 声明成 `var` 且带缺省，是为了让遍历先铸出 offer、等整页都在手上再回填——
  /// "是不是重复" 这件事在铸单条的时候还不知道。见 `AXSurfaceBuilder.disambiguationContexts`。
  var context: String? = nil

  var json: JSONValue {
    var target: [String: JSONValue] = [
      "ref": .string(ref),
      "role": .string(role),
      "label": .string(label),
      "state": state.json,
    ]
    if let context { target["context"] = .string(context) }
    return .object([
      "id": .string(id),
      "operation": .string(operation.rawValue),
      "target": .object(target),
      "effect": .string(effect.rawValue),
      "risk": .string(risk.rawValue),
    ])
  }
}

struct AXElementFingerprint: Equatable, Sendable {
  let processID: pid_t
  let window: AXWindowFingerprint?
  let path: [Int]
  let role: String
  let subrole: String?
  let identifier: String?
  let title: String?
  let value: String?

  func matches(_ other: AXElementFingerprint) -> Bool {
    processID == other.processID
      && window == other.window
      && path == other.path
      && role == other.role
      && subrole == other.subrole
      && identifier == other.identifier
      && title == other.title
      && value == other.value
  }
}

struct AXWindowFingerprint: Equatable, Sendable {
  let role: String
  let subrole: String?
  let identifier: String?
  let title: String?
}

struct AXVerification: Equatable, Sendable {
  let ok: Bool
  let detail: String

  var json: JSONValue {
    .object(["ok": .bool(ok), "detail": .string(detail)])
  }
}

/// 线上校验用的边界值。
///
/// 这些数字在 `src/ax.ts` 各有一份对侧校验，两边必须同时改：Swift 校验参数、Node 校验响应，
/// 只有一边改会让「对面认为合法的值」在本侧被拒。`test/ax.test.ts` 里有一条跨语言对照测试
/// 直接读这个文件比对字面量，就是为了让漏改的那一次红掉。
enum AXWireLimits {
  static let maxPageSize = 200

  /// 单条 offer 区分文字的字符上限。
  ///
  /// 刻意远小于 `browser-use/jev-ultrafast` 那个 6000 字符的 `innerText`：那边给**每个**元素
  /// 都附上下文，我们只给重复项附。官方 jaggedness 文档把「大量不相关状态」列为已知失败模式
  /// （"Context grows, accuracy falls"），少附且短附两头都占。
  static let maxContextCharacters = 200

  /// 向上找区分文字的最大层数。真机实测（Chrome 的 GitHub 页面，141 个可动作元素、8 组同名）
  /// 四组分别在第 1、1、2、3 层被区分开，3 层是实测够用的上限。
  static let maxContextLevels = 3
}

struct AXObserveParams: Equatable, Sendable {
  let scope: AXObservationScope
  let processID: pid_t?
  let offset: Int
  let pageSize: Int?

  init(json: JSONValue) throws {
    guard let fields = json.objectValue else {
      throw CoreError(.invalidParams, "ax.observe params 必须是对象")
    }
    guard let rawScope = fields["scope"]?.stringValue,
          let scope = AXObservationScope(rawValue: rawScope)
    else {
      throw CoreError(.invalidParams, "scope 必须是 focusedWindow 或 application")
    }
    let pid: pid_t?
    if let value = fields["pid"] {
      guard let raw = value.intValue, raw > 0, raw <= Int(Int32.max) else {
        throw CoreError(.invalidParams, "pid 必须是正整数")
      }
      pid = pid_t(raw)
    } else {
      pid = nil
    }
    let offset = fields["offset"]?.intValue ?? 0
    guard offset >= 0 else { throw CoreError(.invalidParams, "offset 不能是负数") }
    let pageSize = fields["pageSize"]?.intValue
    if let pageSize, !(1...AXWireLimits.maxPageSize).contains(pageSize) {
      throw CoreError(.invalidParams, "pageSize 必须在 1...\(AXWireLimits.maxPageSize)")
    }
    self.scope = scope
    self.processID = pid
    self.offset = offset
    self.pageSize = pageSize
  }
}

struct AXPerformParams: Equatable, Sendable {
  let frameID: String
  let offerID: String
  let operation: AXOperation
  let value: String?

  init(json: JSONValue) throws {
    guard let fields = json.objectValue else {
      throw CoreError(.invalidParams, "ax.perform params 必须是对象")
    }
    guard let frameID = fields["frameId"]?.stringValue, !frameID.isEmpty,
          let offerID = fields["offerId"]?.stringValue, !offerID.isEmpty
    else {
      throw CoreError(.invalidParams, "frameId 与 offerId 必填")
    }
    guard let rawOperation = fields["operation"]?.stringValue,
          let operation = AXOperation(rawValue: rawOperation)
    else {
      throw CoreError(.invalidParams, "operation 不受支持")
    }
    let value = fields["value"]?.stringValue
    if operation == .typeText, value == nil {
      throw CoreError(.invalidParams, "TYPE_TEXT 必须提供 value")
    }
    if operation != .typeText, fields.keys.contains("value") {
      throw CoreError(.invalidParams, "只有 TYPE_TEXT 可以提供 value")
    }
    self.frameID = frameID
    self.offerID = offerID
    self.operation = operation
    self.value = value
  }
}

struct AXPerformResult: Equatable, Sendable {
  let status: AXActionStatus
  let verification: AXVerification
  let error: String?

  var json: JSONValue {
    var fields: [String: JSONValue] = [
      "status": .string(status.rawValue),
      "artifacts": .array([]),
      "verify": verification.json,
    ]
    if let error { fields["error"] = .string(error) }
    return .object(fields)
  }
}
