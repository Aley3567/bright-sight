import ApplicationServices
import XCTest
@testable import BrightSightVoice

/// `AXRuntime` 把解析、调度、执行和 frame 存储接在一起，是 AX 能力层唯一有并发的一层。
/// 这里覆盖它的接线与背压：哪些失败该在碰客户端之前就被拦住，哪些 frame 只能被执行一次。
final class AXRuntimeTests: XCTestCase {
  func testObserveStoresAFrameThatPerformConsumesExactlyOnce() throws {
    let store = buttonStore(pid: 601)
    let runtime = AXRuntime(client: FakeAXClient(store: store))

    let observed = expectation(description: "observe 回包")
    var frameID: String?
    var offerID: String?
    runtime.observe(params: .object(["scope": .string("application"), "pid": .number(601)])) { result in
      defer { observed.fulfill() }
      guard case let .success(json) = result else { return XCTFail("观察不该失败：\(result)") }
      frameID = json["frameId"]?.stringValue
      offerID = json["offers"]?.arrayValue?.first?["id"]?.stringValue
    }
    wait(for: [observed], timeout: 2)

    let frame = try XCTUnwrap(frameID, "observe 必须铸出一个 frame")
    let offer = try XCTUnwrap(offerID, "按钮应当给出一个动作")
    store.pressOutcome = .changed(axState(
      role: kAXButtonRole as String,
      title: "Go",
      selected: true,
      actions: [kAXPressAction as String]
    ))

    let performed = expectation(description: "perform 回包")
    runtime.perform(params: .object([
      "frameId": .string(frame),
      "offerId": .string(offer),
      "operation": .string("CLICK"),
    ])) { result in
      defer { performed.fulfill() }
      guard case let .success(json) = result else { return XCTFail("执行不该失败：\(result)") }
      XCTAssertEqual(json["status"]?.stringValue, AXActionStatus.executed.rawValue)
    }
    wait(for: [performed], timeout: 2)

    // frame 是单次消费的。同一个 id 再来一次必须判 stale——这是「一个决定最多执行一次」
    // 在 AX 这一侧的落点，判错的代价是替用户多按一下按钮。
    let repeated = expectation(description: "重复 perform")
    runtime.perform(params: .object([
      "frameId": .string(frame),
      "offerId": .string(offer),
      "operation": .string("CLICK"),
    ])) { result in
      defer { repeated.fulfill() }
      guard case let .success(json) = result else { return XCTFail("过期 frame 是业务结果，不是错误：\(result)") }
      XCTAssertEqual(json["status"]?.stringValue, AXActionStatus.rejectedStale.rawValue)
    }
    wait(for: [repeated], timeout: 2)

    XCTAssertEqual(store.performCalls.count, 1, "同一个 frame 不能让客户端被按第二下")
  }

  func testPerformOnAnUnknownFrameIsStaleWithoutTouchingTheClient() {
    let store = buttonStore(pid: 602)
    let runtime = AXRuntime(client: FakeAXClient(store: store))

    let done = expectation(description: "perform 回包")
    runtime.perform(params: .object([
      "frameId": .string("never-issued"),
      "offerId": .string("offer-1"),
      "operation": .string("CLICK"),
    ])) { result in
      defer { done.fulfill() }
      guard case let .success(json) = result else { return XCTFail("认不出的 frame 是业务结果，不是错误：\(result)") }
      XCTAssertEqual(json["status"]?.stringValue, AXActionStatus.rejectedStale.rawValue)
    }
    wait(for: [done], timeout: 2)

    XCTAssertEqual(store.applicationCalls, 0, "frame 认不出来时不该去碰任何应用")
  }

  func testMalformedParamsAreRejectedBeforeTouchingTheClient() {
    let store = buttonStore(pid: 603)
    let runtime = AXRuntime(client: FakeAXClient(store: store))

    let done = expectation(description: "observe 回包")
    runtime.observe(params: .object(["scope": .string("everything")])) { result in
      defer { done.fulfill() }
      guard case let .failure(error) = result else { return XCTFail("非法 scope 必须被拒") }
      XCTAssertEqual(error.code, .invalidParams)
    }
    wait(for: [done], timeout: 2)

    XCTAssertEqual(store.applicationCalls, 0, "参数不合法时不该发起任何 AX 调用")
  }

  func testPendingLimitRejectsTheOverflowingCallInsteadOfQueueingItForever() {
    let store = buttonStore(pid: 604)
    let gate = DispatchSemaphore(value: 0)
    let runtime = AXRuntime(
      pendingLimit: 1,
      concurrencyLimit: 1,
      client: FakeAXClient(store: store, gate: gate)
    )
    let params = JSONValue.object(["scope": .string("application"), "pid": .number(604)])

    let inFlight = expectation(description: "在飞的那条")
    let queued = expectation(description: "排队的那条")
    let rejected = expectation(description: "被背压拒掉的那条")
    var rejection: CoreError?

    runtime.observe(params: params) { _ in inFlight.fulfill() }
    runtime.observe(params: params) { _ in queued.fulfill() }
    runtime.observe(params: params) { result in
      defer { rejected.fulfill() }
      guard case let .failure(error) = result else { return XCTFail("超出 pendingLimit 必须当场拒绝") }
      rejection = error
    }

    wait(for: [rejected], timeout: 2)
    for _ in 0..<4 { gate.signal() }
    wait(for: [inFlight, queued], timeout: 2)

    XCTAssertEqual(rejection?.code, .internalError, "背压是「现在做不了」，不是「参数不对」")
    // 每条被接受的观察建两次 application（一次给 Chromium 兼容探测，一次给遍历本身），
    // 两条工作就是 4 次。被拒的那条一次都没有——它连客户端都没碰到。
    XCTAssertEqual(store.applicationCalls, 4, "被拒的那条不能悄悄变成第三次调用")
  }

  private func buttonStore(pid: pid_t) -> FakeAXStore {
    let app = AXUIElementCreateApplication(pid)
    let window = AXUIElementCreateApplication(pid + 1)
    let button = AXUIElementCreateApplication(pid + 2)
    let store = FakeAXStore(application: app, focusedWindow: window)
    store.add(app, state: axState(role: kAXApplicationRole as String), children: [button])
    store.add(window, state: axState(role: kAXWindowRole as String, title: "Main"))
    store.add(button, state: axState(
      role: kAXButtonRole as String,
      title: "Go",
      actions: [kAXPressAction as String]
    ))
    return store
  }
}
