import Foundation

/// 一条入站消息该怎么处置。纯判决，不做 IO——`CoreSession` 照着执行。
enum CoreRoute: Equatable {
  /// 是我方某次调用的回应。
  case settle(id: Int, result: CoreCallResult)
  /// 对面发起的调用（阶段 4 的 `ax.observe` / `ax.perform` 就走这里）。
  case dispatch(id: Int, method: String, params: JSONValue)
  /// 对面的通知。不认识的一律静默忽略，这是协议兼容规则 2。
  case notify(method: String, params: JSONValue)
  /// 回一条对得上号的 `{id,error}`。**不断开连接**——兼容规则 1。
  case respond(id: Int, error: CoreError)
  /// 对不上号，只能发一条 `transport.error` 通知，让对面知道有东西我们读不懂。
  case report(error: CoreError)
}

enum CoreCallResult: Equatable {
  case success(JSONValue)
  case failure(CoreError)
}

enum CoreRouter {
  /// - Parameters:
  ///   - pending: 我方正在等回应的 id。
  ///   - inbound: 我方正在处理的对面请求 id（同一个 id 还没处理完又来一次是协议违规）。
  static func route(_ message: CoreParsedMessage, pending: Set<Int>, inbound: Set<Int>) -> CoreRoute {
    switch message {
    case .invalid(let code, let detail, let id):
      let error = CoreError(code, detail)
      // 认得出 id 就回一条对得上号的失败，对面那次调用立刻有结论；认不出就只能发通知
      if let id { return .respond(id: id, error: error) }
      return .report(error: error)

    case .notification(let method, let params):
      return .notify(method: method, params: params)

    case .success(let id, let result):
      if let route = misdirectedResponse(id, pending: pending) { return route }
      return .settle(id: id, result: .success(result))

    case .failure(let id, let error):
      if let route = misdirectedResponse(id, pending: pending) { return route }
      return .settle(id: id, result: .failure(error))

    case .request(let id, let method, let params):
      // 奇数是**我方**的请求空间。对面拿奇数发请求，就会和我们自己发出去的 id 撞车，
      // 之后所有回应都分不清归属。反过来偶数请求是合法的，阶段 4 的反向调用正是偶数——
      // 这两条方向相反，写反了的表现是「反向通道一接上就全被拒」
      if CoreProtocol.isOurRequestID(id) {
        return .respond(id: id, error: CoreError(.idConflict, "id \(id) 属于本端的请求空间，请改用偶数 id"))
      }
      if inbound.contains(id) {
        return .respond(id: id, error: CoreError(.idConflict, "id \(id) 还在处理中"))
      }
      return .dispatch(id: id, method: method, params: params)
    }
  }

  private static func misdirectedResponse(_ id: Int, pending: Set<Int>) -> CoreRoute? {
    if !CoreProtocol.isOurRequestID(id) {
      return .report(error: CoreError(.unknownResponse, "收到 id \(id) 的回应，但该 id 不属于本端的请求空间"))
    }
    if !pending.contains(id) {
      return .report(error: CoreError(.unknownResponse, "收到 id \(id) 的回应，但没有在等这个 id"))
    }
    return nil
  }
}
