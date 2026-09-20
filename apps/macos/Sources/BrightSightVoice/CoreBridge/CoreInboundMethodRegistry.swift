import Foundation

final class CoreInboundMethodRegistry: @unchecked Sendable {
  typealias Completion = (Result<JSONValue, CoreError>) -> Void
  typealias Handler = (JSONValue, @escaping Completion) -> Void

  private let handlers: [String: Handler]
  private let resetHandler: () -> Void

  init(handlers: [String: Handler], reset: @escaping () -> Void = {}) {
    self.handlers = handlers
    resetHandler = reset
  }

  @discardableResult
  func dispatch(method: String, params: JSONValue, completion: @escaping Completion) -> Bool {
    guard let handler = handlers[method] else { return false }
    handler(params, completion)
    return true
  }

  func reset() {
    resetHandler()
  }

  static func accessibility(runtime: AXRuntime = AXRuntime()) -> CoreInboundMethodRegistry {
    CoreInboundMethodRegistry(
      handlers: [
        CoreProtocol.methodAXObserve: runtime.observe,
        CoreProtocol.methodAXPerform: runtime.perform,
      ],
      reset: runtime.invalidateFrames
    )
  }
}
