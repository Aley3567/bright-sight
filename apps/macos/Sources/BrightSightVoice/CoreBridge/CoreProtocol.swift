import Foundation

/// Swift 这一侧的协议常量与消息编解码。唯一事实来源是 `src/protocol.ts`，这里只是它的 Swift 影子。
///
/// 影子而不是生成物，所以会漂移。对齐靠两件事：常量都集中在这一个 enum 里（改的时候只有一处要改），
/// 以及所有枚举都带 `unknown(String)` 兜底分支——协议兼容规则 4 说得很直白，
/// 靠穷举 switch 的一侧会在对面加了新值的那一天静默走错分支。
enum CoreProtocol {
  /// 对齐 `PROTOCOL_VERSION`。对不上说明 core 与 App 不是一次构建出来的，那不是网络问题，是装配问题。
  static let version = 1

  /// 对齐 `RPC_MAX_LINE_CHARS`，但单位是**字节**。
  ///
  /// 那边按 JS 字符串长度算，这边在解码成 String 之前就要判断（见 `CoreLineReader`：
  /// 只有完整的一行才解码，否则多字节字符会被 chunk 边界切坏）。中文一个字三字节，
  /// 于是同一个数字在这边更严格：极端情况下我们会丢掉一条对面认为合法的行。
  /// 这个方向的偏差是安全的——丢行会让那次调用超时，而放行一条 12 MB 的行会让内存先出事。
  static let maxLineBytes = 4 * 1024 * 1024

  static let requestKeyField = "requestKey"
  static let replayedField = "replayed"

  static let methodSessionHandle = "session.handle"
  static let methodSessionConfirm = "session.confirm"
  static let methodSessionCancel = "session.cancel"
  static let methodAXObserve = "ax.observe"
  static let methodAXPerform = "ax.perform"
  static let notifyServerReady = "server.ready"
  static let notifyTransportError = "transport.error"

  /// 本端请求 id 的奇偶。Swift 用奇数，Node 用偶数。
  ///
  /// 两侧各自分配 id，不把空间切开就分不清 `{"id":1,"result":…}` 是谁的回应。
  /// 由此推出两条判据，方向相反，别写反：
  ///   - **回应**的 id 必须是奇数（那是我们发出去的请求），偶数回应 = `unknown_response`；
  ///   - **请求**的 id 必须是偶数（那是对面发起的调用，阶段 4 的 `ax.observe` 就长这样），
  ///     奇数请求 = `id_conflict`，因为那个 id 可能正被我们自己占用。
  static func isOurRequestID(_ id: Int) -> Bool { id % 2 != 0 }
  static func isPeerRequestID(_ id: Int) -> Bool { id % 2 == 0 }
}

enum CoreErrorLayer: Equatable, Sendable {
  /// 这条线本身坏了。反复出现就该重启核心，见 `CoreTransportHealth`。
  case transport
  /// 这次调用坏了（方法不存在、参数不合法、内部异常）。**不包含「任务没做成」**。
  case method
  case unknown(String)

  init(wire: String) {
    switch wire {
    case "transport": self = .transport
    case "method": self = .method
    default: self = .unknown(wire)
    }
  }

  var wire: String {
    switch self {
    case .transport: return "transport"
    case .method: return "method"
    case .unknown(let raw): return raw
    }
  }
}

enum CoreErrorCode: Equatable, Sendable {
  case parseError
  case oversizedLine
  case malformedMessage
  case unknownResponse
  case idConflict
  case peerGone
  case methodNotFound
  case invalidParams
  case internalError
  case requestTimeout
  case replayUnavailable
  case credentialsMissing
  case unknown(String)

  init(wire: String) {
    switch wire {
    case "parse_error": self = .parseError
    case "oversized_line": self = .oversizedLine
    case "malformed_message": self = .malformedMessage
    case "unknown_response": self = .unknownResponse
    case "id_conflict": self = .idConflict
    case "peer_gone": self = .peerGone
    case "method_not_found": self = .methodNotFound
    case "invalid_params": self = .invalidParams
    case "internal_error": self = .internalError
    case "request_timeout": self = .requestTimeout
    case "replay_unavailable": self = .replayUnavailable
    case "credentials_missing": self = .credentialsMissing
    default: self = .unknown(wire)
    }
  }

  var wire: String {
    switch self {
    case .parseError: return "parse_error"
    case .oversizedLine: return "oversized_line"
    case .malformedMessage: return "malformed_message"
    case .unknownResponse: return "unknown_response"
    case .idConflict: return "id_conflict"
    case .peerGone: return "peer_gone"
    case .methodNotFound: return "method_not_found"
    case .invalidParams: return "invalid_params"
    case .internalError: return "internal_error"
    case .requestTimeout: return "request_timeout"
    case .replayUnavailable: return "replay_unavailable"
    case .credentialsMissing: return "credentials_missing"
    case .unknown(let raw): return raw
    }
  }

  var defaultLayer: CoreErrorLayer {
    switch self {
    case .parseError, .oversizedLine, .malformedMessage, .unknownResponse, .idConflict, .peerGone:
      return .transport
    case .methodNotFound, .invalidParams, .internalError, .requestTimeout, .replayUnavailable, .credentialsMissing:
      return .method
    case .unknown:
      // 认不出来的 code 归到 method 层：transport 层会触发重启核心，
      // 而「对面说了一个我们不认识的词」不构成重启这条线的理由
      return .method
    }
  }

  /// 「用同一个 requestKey 原样重发，是不是既安全又可能得到不同结果」。只有超时是 true。
  /// 认不出来的 code 一律 false——缺省必须等于拦住。
  var defaultRetriable: Bool { self == .requestTimeout }
}

struct CoreError: Error, Equatable, Sendable {
  var code: CoreErrorCode
  var layer: CoreErrorLayer
  /// 给人看的一句话，**可能含用户原话**（内部异常会把原话带进异常消息）。
  /// 可以显示、可以朗读，绝不写进任何持久日志——本项目的落盘留痕默认脱敏，
  /// 在这一侧顺手写一份明文日志等于把 `src/redact.ts` 白做了。
  var message: String
  var retriable: Bool

  init(_ code: CoreErrorCode, _ message: String, retriable: Bool? = nil) {
    self.code = code
    self.layer = code.defaultLayer
    self.message = message
    self.retriable = retriable ?? code.defaultRetriable
  }

  /// 线上收到的 error。对面发来一条畸形 error 时不能因此崩掉，也不能假装它是好的。
  ///
  /// 和 `rpc.ts` 的 `normalizeError` 有一处刻意的分歧：那边把不认识的 code 折成
  /// `malformed_message`，这边保留原值（`.unknown(raw)`）。保留信息更有用，
  /// 而危险的那一面已经被 `defaultRetriable` 兜住了——不认识 = 不可重发。
  init(wire value: JSONValue) {
    let rawCode = value["code"]?.stringValue
    let code = rawCode.map(CoreErrorCode.init(wire:)) ?? .malformedMessage
    self.code = code
    self.layer = value["layer"]?.stringValue.map(CoreErrorLayer.init(wire:)) ?? code.defaultLayer
    self.message = value["message"]?.stringValue ?? "对方返回了读不懂的错误"
    self.retriable = value["retriable"]?.boolValue ?? code.defaultRetriable
  }

  var json: JSONValue {
    .object([
      "code": .string(code.wire),
      "layer": .string(layer.wire),
      "message": .string(message),
      "retriable": .bool(retriable),
    ])
  }
}

/// 一行文本 → 一条消息。纯函数，不认识流也不认识对面是谁。判别顺序照抄 `parseMessage`。
enum CoreParsedMessage: Equatable {
  case request(id: Int, method: String, params: JSONValue)
  case success(id: Int, result: JSONValue)
  case failure(id: Int, error: CoreError)
  case notification(method: String, params: JSONValue)
  /// 读不出来。id 认得出来就带上，好让对面收到一条对得上号的错误。
  case invalid(code: CoreErrorCode, detail: String, id: Int?)

  static func parse(_ line: String) -> CoreParsedMessage {
    guard let data = line.data(using: .utf8), let value = JSONValue.decode(data) else {
      return .invalid(code: .parseError, detail: "这一行不是合法 JSON", id: nil)
    }
    guard value.objectValue != nil else {
      return .invalid(code: .malformedMessage, detail: "消息必须是 JSON 对象", id: nil)
    }

    let idField = value["id"]
    if idField == nil || idField == .null {
      guard let method = value["method"]?.stringValue else {
        return .invalid(code: .malformedMessage, detail: "没有 id 的消息必须是通知，需要 method", id: nil)
      }
      return .notification(method: method, params: value["params"] ?? .null)
    }
    guard let id = idField?.intValue, id > 0 else {
      return .invalid(code: .malformedMessage, detail: "id 必须是正整数", id: nil)
    }

    let method = value["method"]?.stringValue
    let kinds = [method != nil, value.hasKey("result"), value.hasKey("error")].filter { $0 }.count
    guard kinds == 1 else {
      // 同时带 result 和 error 不挑一个用：挑一个就等于替对面猜它想说什么
      let detail = kinds == 0
        ? "带 id 的消息必须有 method / result / error 之一"
        : "method / result / error 只能有一个"
      return .invalid(code: .malformedMessage, detail: detail, id: id)
    }
    if let method {
      return .request(id: id, method: method, params: value["params"] ?? .null)
    }
    if value.hasKey("error") {
      return .failure(id: id, error: CoreError(wire: value["error"] ?? .null))
    }
    return .success(id: id, result: value["result"] ?? .null)
  }
}

/// 一条消息 → 一行文本（含换行）。
///
/// 行内不会出现裸换行：JSON 字符串里的控制字符一律被转义，用户原话里的回车不会切断帧。
/// 这条有测试逐字守着，因为一旦破了，表现是「对面偶尔解析失败」，最难查的那一类。
enum CoreOutbound: Equatable {
  case request(id: Int, method: String, params: JSONValue)
  case success(id: Int, result: JSONValue)
  case failure(id: Int, error: CoreError)
  case notification(method: String, params: JSONValue)

  var message: JSONValue {
    switch self {
    case .request(let id, let method, let params):
      return .object(["id": .number(Double(id)), "method": .string(method), "params": params])
    case .success(let id, let result):
      return .object(["id": .number(Double(id)), "result": result])
    case .failure(let id, let error):
      return .object(["id": .number(Double(id)), "error": error.json])
    case .notification(let method, let params):
      return .object(["method": .string(method), "params": params])
    }
  }

  func line() -> Data? {
    guard var data = message.encoded() else { return nil }
    data.append(0x0A)
    return data
  }
}
