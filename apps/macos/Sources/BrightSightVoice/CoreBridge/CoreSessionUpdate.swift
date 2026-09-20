import Foundation

/// 一次 `session.handle` 的结局。
///
/// `waitingForConfirmation` 会进入确认气泡；它不是失败，也不能折进 `needsInput`。
enum CoreSessionStatus: Equatable, Sendable {
  case done
  case blocked
  case needsInput
  case waitingForConfirmation
  case unknown(String)

  init(wire: String) {
    switch wire {
    case "done": self = .done
    case "blocked": self = .blocked
    case "needs_input": self = .needsInput
    case "waiting_for_confirmation": self = .waitingForConfirmation
    default: self = .unknown(wire)
    }
  }

  var wire: String {
    switch self {
    case .done: return "done"
    case .blocked: return "blocked"
    case .needsInput: return "needs_input"
    case .waitingForConfirmation: return "waiting_for_confirmation"
    case .unknown(let raw): return raw
    }
  }
}

/// 结局的机器可读分类。**code 决定走哪条分支，detail 决定显示什么字。**
///
/// 不要去 match detail 的中文：改版之前这里正是靠 `contains("终止意图 UNSUPPORTED")` 判的，
/// 核心那边改一句文案就静默失效，而且失效的方向是「什么都没发生，但界面说做完了」。
enum CoreReasonCode: Equatable, Sendable {
  case completed
  case unsupported
  case modelDeclined
  case doneUnverified
  case stuckWaiting
  case needsClarification
  case needsConfirmation
  case execFailed
  case verifyFailed
  case stepBudget
  case notExecutable
  case noSteps
  case unknown(String)

  init(wire: String) {
    switch wire {
    case "completed": self = .completed
    case "unsupported": self = .unsupported
    case "model_declined": self = .modelDeclined
    case "done_unverified": self = .doneUnverified
    case "stuck_waiting": self = .stuckWaiting
    case "needs_clarification": self = .needsClarification
    case "needs_confirmation": self = .needsConfirmation
    case "exec_failed": self = .execFailed
    case "verify_failed": self = .verifyFailed
    case "step_budget": self = .stepBudget
    case "not_executable": self = .notExecutable
    case "no_steps": self = .noSteps
    default: self = .unknown(wire)
    }
  }

  var wire: String {
    switch self {
    case .completed: return "completed"
    case .unsupported: return "unsupported"
    case .modelDeclined: return "model_declined"
    case .doneUnverified: return "done_unverified"
    case .stuckWaiting: return "stuck_waiting"
    case .needsClarification: return "needs_clarification"
    case .needsConfirmation: return "needs_confirmation"
    case .execFailed: return "exec_failed"
    case .verifyFailed: return "verify_failed"
    case .stepBudget: return "step_budget"
    case .notExecutable: return "not_executable"
    case .noSteps: return "no_steps"
    case .unknown(let raw): return raw
    }
  }
}

struct CoreReason: Equatable, Sendable {
  var code: CoreReasonCode
  /// 人读的原文，直接来自 `policy.ts` / `loop.ts`。**可能含用户原话**：显示、朗读都行，不落日志。
  var detail: String
  var step: Int?

  init(code: CoreReasonCode, detail: String, step: Int? = nil) {
    self.code = code
    self.detail = detail
    self.step = step
  }

  init?(json: JSONValue) {
    guard let code = json["code"]?.stringValue else { return nil }
    self.code = CoreReasonCode(wire: code)
    self.detail = json["detail"]?.stringValue ?? ""
    self.step = json["step"]?.intValue
  }
}

/// 「我目前只会 X 和 Y」的结构化版本。怎么渲染是 UI 的事，所以这里只存事实。
struct CoreCapability: Equatable, Sendable {
  var id: String
  var app: String
  /// 一句话说明，来自 sdef，语言随系统——所以不要在代码里为它写死中文对照表。
  var summary: String

  init(id: String, app: String, summary: String) {
    self.id = id
    self.app = app
    self.summary = summary
  }

  init?(json: JSONValue) {
    guard let id = json["id"]?.stringValue else { return nil }
    self.id = id
    self.app = json["app"]?.stringValue ?? ""
    self.summary = json["summary"]?.stringValue ?? ""
  }
}

struct CoreSessionStep: Equatable, Sendable {
  var step: Int
  var actionId: String
  var executed: Bool
  /// null = 这一步没执行，所以没有可验证的东西。别把它折成 false。
  var verified: Bool?

  init(step: Int, actionId: String, executed: Bool, verified: Bool?) {
    self.step = step
    self.actionId = actionId
    self.executed = executed
    self.verified = verified
  }

  init?(json: JSONValue) {
    guard let actionId = json["actionId"]?.stringValue else { return nil }
    self.step = json["step"]?.intValue ?? 0
    self.actionId = actionId
    self.executed = json["executed"]?.boolValue ?? false
    self.verified = json["verified"]?.boolValue
  }
}

struct CoreSessionUpdate: Equatable, Sendable {
  var runId: String
  var confirmId: String?
  var status: CoreSessionStatus
  var mode: String
  var reasons: [CoreReason]
  var steps: [CoreSessionStep]
  var capabilities: [CoreCapability]
  /// 这一条是缓存回放：同一个 requestKey 之前来过，**副作用没有再发生一次**。
  /// UI 因此不该重复播报，否则用户会以为又做了一遍。
  var replayed: Bool

  init(
    runId: String = "",
    confirmId: String? = nil,
    status: CoreSessionStatus,
    mode: String = "execute",
    reasons: [CoreReason] = [],
    steps: [CoreSessionStep] = [],
    capabilities: [CoreCapability] = [],
    replayed: Bool = false
  ) {
    self.runId = runId
    self.confirmId = confirmId
    self.status = status
    self.mode = mode
    self.reasons = reasons
    self.steps = steps
    self.capabilities = capabilities
    self.replayed = replayed
  }

  /// `artifacts` 与 `journal` 刻意不解码：artifacts 里是真实回读到的值（网址、笔记正文），
  /// journal.path 是家目录下的一条路径。UI 都用不上，而它们一旦进了这个进程，
  /// 就多一个可能被日志捡走的地方。要查这些去看留痕。
  ///
  init(json: JSONValue) throws {
    guard let status = json["status"]?.stringValue else {
      // 读不出结局就绝不能当成做完了：这里抛错，调用方会把它当失败报出去
      throw CoreError(.malformedMessage, "核心的结果里没有 status 字段")
    }
    self.runId = json["runId"]?.stringValue ?? ""
    self.confirmId = json["confirmId"]?.stringValue
    self.status = CoreSessionStatus(wire: status)
    self.mode = json["mode"]?.stringValue ?? ""
    self.reasons = (json["reasons"]?.arrayValue ?? []).compactMap(CoreReason.init(json:))
    self.steps = (json["steps"]?.arrayValue ?? []).compactMap(CoreSessionStep.init(json:))
    self.capabilities = (json["capabilities"]?.arrayValue ?? []).compactMap(CoreCapability.init(json:))
    self.replayed = json[CoreProtocol.replayedField]?.boolValue ?? false
  }
}
