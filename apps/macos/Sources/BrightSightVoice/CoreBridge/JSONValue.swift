import Foundation

/// 线上那一层 JSON 的最小表示。
///
/// 不直接把 `SessionUpdate` 声明成 `Decodable` 结构体：协议兼容规则 3 要求「不认识的字段忽略」，
/// 而 `Decodable` 的失败模式正好相反——多出来的字段静默丢掉，少一个字段却整条解析失败。
/// 阶段 3 / 阶段 4 往结果里加字段是计划内的事，那时第一批用户会先看到「解析失败」。
/// 所以入站一律先落成 JSONValue，再由各自的 init 只挑自己认识的字段。
enum JSONValue: Equatable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  subscript(key: String) -> JSONValue? {
    guard case .object(let fields) = self else { return nil }
    return fields[key]
  }

  var stringValue: String? {
    guard case .string(let value) = self else { return nil }
    return value
  }

  var boolValue: Bool? {
    guard case .bool(let value) = self else { return nil }
    return value
  }

  var doubleValue: Double? {
    guard case .number(let value) = self else { return nil }
    return value
  }

  /// 只在数值确实是整数且落在 JSON 安全整数范围内时才给出，别的一律 nil：
  /// id 是 `{"id":1}` 这种东西，`1.5` 或 `1e300` 不是「大一点的 id」，是畸形消息。
  var intValue: Int? {
    guard case .number(let value) = self,
          value.rounded() == value,
          value.magnitude <= 9_007_199_254_740_991
    else { return nil }
    return Int(value)
  }

  var arrayValue: [JSONValue]? {
    guard case .array(let value) = self else { return nil }
    return value
  }

  var objectValue: [String: JSONValue]? {
    guard case .object(let value) = self else { return nil }
    return value
  }

  /// 「这个键在不在」和「它的值是不是 null」是两件事，`parseMessage` 的判别顺序依赖前者。
  func hasKey(_ key: String) -> Bool {
    guard case .object(let fields) = self else { return false }
    return fields.keys.contains(key)
  }

  init(foundation: Any) {
    switch foundation {
    case is NSNull:
      self = .null
    case let number as NSNumber:
      // JSONSerialization 把 true/false 也给成 NSNumber，只有 CFTypeID 分得出来；
      // 认错的后果是 `"execute": true` 在回显时变成 1
      self = CFGetTypeID(number as CFTypeRef) == CFBooleanGetTypeID()
        ? .bool(number.boolValue)
        : .number(number.doubleValue)
    case let text as String:
      self = .string(text)
    case let items as [Any]:
      self = .array(items.map(JSONValue.init(foundation:)))
    case let fields as [String: Any]:
      self = .object(fields.mapValues(JSONValue.init(foundation:)))
    default:
      self = .null
    }
  }

  var foundationValue: Any {
    switch self {
    case .null:
      return NSNull()
    case .bool(let value):
      return value
    case .number(let value):
      // 整数落回 Int，否则 `{"id":1}` 会被写成 `{"id":1.0}`——合法 JSON，但对面的 `isRpcId`
      // 要求安全整数，1.0 在 JS 里虽然等于 1，没必要赌两边的取整规则一致
      return value.rounded() == value && value.magnitude <= 9_007_199_254_740_991 ? Int(value) : value
    case .string(let value):
      return value
    case .array(let items):
      return items.map(\.foundationValue)
    case .object(let fields):
      return fields.mapValues(\.foundationValue)
    }
  }

  static func decode(_ data: Data) -> JSONValue? {
    guard let raw = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return nil }
    return JSONValue(foundation: raw)
  }

  func encoded() -> Data? {
    let value = foundationValue
    guard JSONSerialization.isValidJSONObject(value) else { return nil }
    return try? JSONSerialization.data(withJSONObject: value, options: [])
  }
}
