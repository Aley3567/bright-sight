import XCTest
@testable import BrightSightVoice

/// id 空间与路由判决。这里的每一条都有一个方向相反的对照，因为奇偶判据一共有两条、
/// 方向正好相反：**回应**必须是奇数（我们发出去的），**请求**必须是偶数（对面发起的）。
/// 只测一条的话，把两条写成同一个方向也会全绿。
final class CoreRouterTests: XCTestCase {
  private func route(_ line: String, pending: Set<Int> = [], inbound: Set<Int> = []) -> CoreRoute {
    CoreRouter.route(CoreParsedMessage.parse(line), pending: pending, inbound: inbound)
  }

  func testPeerRequestWithOurOwnParityIsAnIdConflict() {
    // 奇数是我方的请求空间。对面拿奇数发请求就会和我们自己的 id 撞车
    guard case .respond(let id, let error) = route("{\"id\":7,\"method\":\"ax.observe\",\"params\":{}}") else {
      return XCTFail("奇数请求必须回 id_conflict")
    }
    XCTAssertEqual(id, 7)
    XCTAssertEqual(error.code, .idConflict)
    XCTAssertEqual(error.layer, .transport)
  }

  func testPeerRequestWithEvenIdIsDispatchedNotRejected() {
    // 对照：偶数请求是**合法**的，阶段 4 的 ax.observe 正是这样过来的。
    // 把它也拦掉的话，反向通道从第一条消息起就是死的，而单测「奇数被拦住」照样全绿
    guard case .dispatch(let id, let method, _) = route("{\"id\":2,\"method\":\"ax.observe\",\"params\":{}}") else {
      return XCTFail("偶数请求必须放行到派发")
    }
    XCTAssertEqual(id, 2)
    XCTAssertEqual(method, "ax.observe")
  }

  func testSameInboundIdTwiceWhileStillRunningIsAnIdConflict() {
    guard case .dispatch = route("{\"id\":4,\"method\":\"ax.perform\",\"params\":{}}", inbound: []) else {
      return XCTFail("第一次应该派发")
    }
    guard case .respond(let id, let error) = route("{\"id\":4,\"method\":\"ax.perform\",\"params\":{}}", inbound: [4]) else {
      return XCTFail("同一个 id 还在处理中又来一次是协议违规")
    }
    XCTAssertEqual(id, 4)
    XCTAssertEqual(error.code, .idConflict)
  }

  func testResponsesGoBackToTheCallThatIsWaitingForThem() {
    guard case .settle(let id, let result) = route("{\"id\":3,\"result\":{\"status\":\"done\"}}", pending: [1, 3, 5]) else {
      return XCTFail("在等的 id 必须落回那次调用")
    }
    XCTAssertEqual(id, 3)
    XCTAssertEqual(result, .success(.object(["status": .string("done")])))
  }

  func testResponseWithPeerParityOrUnknownIdIsATransportError() {
    // 偶数**回应**：那个 id 属于对面的请求空间，不可能是给我们的回应
    guard case .report(let even) = route("{\"id\":2,\"result\":{}}", pending: [1, 3]) else {
      return XCTFail("偶数回应对不上号")
    }
    XCTAssertEqual(even.code, .unknownResponse)

    // 奇数但没人在等：迟到的回应，或者 id 被复用了
    guard case .report(let stale) = route("{\"id\":9,\"result\":{}}", pending: [1, 3]) else {
      return XCTFail("没在等的 id 同样对不上号")
    }
    XCTAssertEqual(stale.code, .unknownResponse)
    XCTAssertEqual(stale.layer, .transport)
  }

  func testUnreadableLinesAnswerTheCallerWhenTheIdIsKnown() {
    guard case .respond(let id, let error) = route("{\"id\":6,\"result\":1,\"error\":{}}") else {
      return XCTFail("认得出 id 就要回一条对得上号的失败")
    }
    XCTAssertEqual(id, 6)
    XCTAssertEqual(error.code, .malformedMessage)

    guard case .report(let anonymous) = route("这一行不是 JSON") else {
      return XCTFail("认不出 id 只能发通知")
    }
    XCTAssertEqual(anonymous.code, .parseError)
  }

  func testNotificationsAreHandedOverAsIs() {
    guard case .notify(let method, let params) = route("{\"method\":\"server.ready\",\"params\":{\"serverId\":\"01ABC\"}}") else {
      return XCTFail("通知应该原样交出去")
    }
    XCTAssertEqual(method, CoreProtocol.notifyServerReady)
    XCTAssertEqual(params["serverId"]?.stringValue, "01ABC")
  }
}

final class CoreCallTableTests: XCTestCase {
  func testAllocatesOddIdsAndNeverReusesThem() {
    var table = CoreCallTable<String>()
    let first = table.allocate()
    let second = table.allocate()
    let third = table.allocate()
    XCTAssertEqual([first, second, third], [1, 3, 5])
    XCTAssertTrue([first, second, third].allSatisfy(CoreProtocol.isOurRequestID))

    table.register(first, "a")
    XCTAssertEqual(table.take(first), "a")
    // 用完即弃之后再分配也不会回头用 1：迟到的回应落到下一次调用头上，
    // 而那两次调用的副作用完全不同
    XCTAssertEqual(table.allocate(), 7)
  }

  func testOutOfOrderResponsesEachFindTheirOwnCall() {
    var table = CoreCallTable<String>()
    let slow = table.allocate()
    let quick = table.allocate()
    table.register(slow, "session.handle")
    table.register(quick, "session.describe")
    XCTAssertEqual(table.ids, [slow, quick])

    XCTAssertEqual(table.take(quick), "session.describe", "后发的先回，各归各位")
    XCTAssertNil(table.take(quick), "取走一次就没了")
    XCTAssertEqual(table.count, 1)
    XCTAssertEqual(table.takeAll(), ["session.handle"])
    XCTAssertEqual(table.count, 0)
  }
}

final class CoreTransportHealthTests: XCTestCase {
  func testTransportErrorsAddUpUntilRestart() {
    var health = CoreTransportHealth(threshold: 3)
    XCTAssertEqual(health.record(CoreError(.parseError, "读不出来")), .keep)
    XCTAssertEqual(health.record(CoreError(.unknownResponse, "对不上号")), .keep)
    XCTAssertEqual(health.record(CoreError(.oversizedLine, "太长了")), .restart)
    XCTAssertEqual(health.strikes, 0, "重启之后重新计数，不该立刻又要求重启一次")
  }

  func testMethodLayerErrorsNeverTriggerRestart() {
    // 新旧分支同时可能命中：两种错误都是「一条 error 回来了」，只有 layer 不一样。
    // 判据装错位置的话，缺一次凭证就会把核心重启一遍，而用户只看到又等了一次冷启动
    var health = CoreTransportHealth(threshold: 3)
    for _ in 0..<10 {
      XCTAssertEqual(health.record(CoreError(.credentialsMissing, "缺凭证")), .keep)
      XCTAssertEqual(health.record(CoreError(.invalidParams, "参数不合法")), .keep)
      XCTAssertEqual(health.record(CoreError(.unknown("future_code"), "以后才有的")), .keep)
    }
    XCTAssertEqual(health.strikes, 0)
  }

  func testOneGoodResponseClearsEarlierStrikes() {
    var health = CoreTransportHealth(threshold: 3)
    XCTAssertEqual(health.record(CoreError(.parseError, "读不出来")), .keep)
    XCTAssertEqual(health.record(CoreError(.parseError, "读不出来")), .keep)
    health.recordSuccess()
    XCTAssertEqual(health.record(CoreError(.parseError, "读不出来")), .keep, "零星事故不该攒一辈子")
    XCTAssertEqual(health.strikes, 1)
  }
}
