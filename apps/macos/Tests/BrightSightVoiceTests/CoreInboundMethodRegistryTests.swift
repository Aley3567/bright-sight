import XCTest
@testable import BrightSightVoice

final class CoreInboundMethodRegistryTests: XCTestCase {
  func testKnownMethodRunsAndUnknownMethodIsNotClaimed() {
    var received: JSONValue?
    let registry = CoreInboundMethodRegistry(handlers: [
      "ax.observe": { params, completion in
        received = params
        completion(.success(.object(["frameId": .string("f")])))
      },
    ])
    var result: Result<JSONValue, CoreError>?
    XCTAssertTrue(registry.dispatch(method: "ax.observe", params: .object(["scope": .string("application")])) {
      result = $0
    })
    XCTAssertEqual(received, .object(["scope": .string("application")]))
    guard case .success(let value) = result else { return XCTFail("已注册方法应该回成功") }
    XCTAssertEqual(value["frameId"]?.stringValue, "f")

    XCTAssertFalse(registry.dispatch(method: "future.method", params: .null) { _ in
      XCTFail("未知方法不能被调用")
    })
  }

  func testResetDelegatesToRuntimeBoundary() {
    var resets = 0
    let registry = CoreInboundMethodRegistry(handlers: [:]) { resets += 1 }
    registry.reset()
    XCTAssertEqual(resets, 1)
  }
}
