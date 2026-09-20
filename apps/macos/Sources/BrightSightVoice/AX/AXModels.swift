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

  /// 请求没带 `depth` / `nodes` / `ms` 时用的默认档。
  ///
  /// 单独起名、写成 `static let` 有两条理由：`protectiveDefault` 直接**引用**它们，于是
  /// 「默认预算」在源码里只有一个来源；`test/ax.test.ts` 的跨语言门禁用 `static let <name> = N`
  /// 的形式取值，写死在 `protectiveDefault` 括号里的字面量它抓不到。
  ///
  /// 数字取自真机实测（Chrome 的前台窗口，生产口径每节点读 10 个属性），分两页量：
  ///
  /// | 页面 | depth/nodes/ms | 可动作元素 | 遍历节点 | 耗时 | 截断 |
  /// | --- | --- | --- | --- | --- | --- |
  /// | GitHub 首页 | 6 / 500 / 150（原生产值） | 4 | 22 | 27ms | depth |
  /// | GitHub 首页 | 12 / 800 / 150 | 67 | 231 | 44ms | depth |
  /// | GitHub 首页 | 16 / 800 / 150 | 141（全部） | 536 | 107ms | depth |
  /// | GitHub 首页 | 20 / 800 / 150 | 141（全部） | — | 101ms | 完成 |
  /// | 长文页（小林 coding） | 20 / 800 / 150 | 40 | 569 | 152ms | deadline |
  /// | 长文页 | 20 / 2000 / 300 | ~130 | 1787 | ~300ms | deadline |
  ///
  /// 由此定档：depth 20（GitHub 18 起走完，留一档余量）；nodes 2000（GitHub 只需约 540，
  /// 长文页在 300ms 内到 1787 也够）；ms 300——GitHub 仍在 ~110ms 走完、不受影响，长文页
  /// 从「40 个」提到「~130 个」，而 300ms 相对模型那几秒的延迟可以忽略。
  static let defaultMaxDepth = 20
  static let defaultMaxNodes = 2000
  static let defaultMaxMilliseconds = 300
  static let defaultPageSize = 80

  static let protectiveDefault = AXTraversalBudget(
    maxDepth: defaultMaxDepth,
    maxNodes: defaultMaxNodes,
    maxMilliseconds: defaultMaxMilliseconds,
    pageSize: defaultPageSize
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

  /// 按请求里的可选覆盖项派生这一轮的实际预算。`nil` = 请求没给这一项，保留基准值。
  ///
  /// 「不给」等于「用基准值」，不等于「不限」——缺省站在保守那一边。越界值在这之前
  /// 已被 `AXObserveParams` 按 `AXWireLimits` 拒掉，这里不再重复校验。
  func overridden(maxDepth: Int?, maxNodes: Int?, maxMilliseconds: Int?) -> AXTraversalBudget {
    AXTraversalBudget(
      maxDepth: maxDepth ?? self.maxDepth,
      maxNodes: maxNodes ?? self.maxNodes,
      maxMilliseconds: maxMilliseconds ?? self.maxMilliseconds,
      pageSize: pageSize
    )
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

  /// 单次观察允许请求的最大遍历深度。
  ///
  /// 上限不是「实测完成档」本身（那是 20，也是默认档），而是它之上再留一档余量：真正的时间兜底
  /// 是 `maxMilliseconds`，深度只用来拦住明显离谱的请求。32 对任何真实网页都够，再深只会拖住对端。
  static let maxDepth = 32

  /// 单次观察允许请求的最大遍历节点数。GitHub 首页整棵树约 540 个节点；长文页 5000 个都还没走完，
  /// 但那种页面由 ms 截止兜住，5000 只是拦住明显离谱的请求。
  static let maxNodes = 5000

  /// 单次观察允许请求的最大耗时预算（毫秒）。它才是真正的时间兜底：长文页的树深到走不完，
  /// 靠这个数保证观察不会挂住用户的应用。3000 是个宽裕的上限，生产默认只用 300。
  static let maxMilliseconds = 3000
}

struct AXObserveParams: Equatable, Sendable {
  let scope: AXObservationScope
  let processID: pid_t?
  let offset: Int
  let pageSize: Int?
  /// 遍历预算的三个覆盖项。`nil` = 这一项没请求，由 `AXTraversalBudget.overridden` 退回基准值。
  ///
  /// 三个都做成请求参数是因为它们互相牵制：只把 depth 提上去而节点数不变，结果只是把
  /// 「depth 截断」换成「nodes 截断」，网页照样看不全。
  let depth: Int?
  let nodes: Int?
  let milliseconds: Int?

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
    // 上限卡在解析层，越界值当场拒掉而不是夹到边界：夹等于替调用方猜它想要什么，
    // 而「传了个我没法用的值」要让它当场可见（`CLAUDE.md` 三、缺省值一律 fail-closed）。
    self.depth = try Self.boundedInt(fields["depth"], key: "depth", range: 0...AXWireLimits.maxDepth)
    self.nodes = try Self.boundedInt(fields["nodes"], key: "nodes", range: 1...AXWireLimits.maxNodes)
    self.milliseconds = try Self.boundedInt(
      fields["ms"],
      key: "ms",
      range: 1...AXWireLimits.maxMilliseconds
    )
    self.scope = scope
    self.processID = pid
    self.offset = offset
    self.pageSize = pageSize
  }

  /// 解析一个可选的有界整数参数。
  ///
  /// **字段在但值不合法**（越界、不是整数）时抛错，绝不静默退回缺省：「不传」才是缺省，
  /// 「传了个我没法用的值」是调用方的缺陷，退回缺省会让它变成一次看起来正常的浅观察。
  private static func boundedInt(_ value: JSONValue?, key: String, range: ClosedRange<Int>) throws -> Int? {
    guard let value else { return nil }
    guard let raw = value.intValue, range.contains(raw) else {
      throw CoreError(.invalidParams, "\(key) 必须在 \(range.lowerBound)...\(range.upperBound)")
    }
    return raw
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
