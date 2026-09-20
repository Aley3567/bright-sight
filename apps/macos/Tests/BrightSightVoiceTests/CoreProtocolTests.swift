import XCTest
@testable import BrightSightVoice

final class CoreProtocolTests: XCTestCase {
  func testParsesTheFourMessageShapes() {
    guard case .request(let id, let method, let params) = CoreParsedMessage.parse(
      "{\"id\":2,\"method\":\"ax.observe\",\"params\":{\"scope\":\"focusedWindow\"}}"
    ) else { return XCTFail("请求没认出来") }
    XCTAssertEqual(id, 2)
    XCTAssertEqual(method, "ax.observe")
    XCTAssertEqual(params["scope"]?.stringValue, "focusedWindow")

    guard case .success(let successId, let result) = CoreParsedMessage.parse("{\"id\":1,\"result\":{\"status\":\"done\"}}") else {
      return XCTFail("成功回应没认出来")
    }
    XCTAssertEqual(successId, 1)
    XCTAssertEqual(result["status"]?.stringValue, "done")

    guard case .failure(let failureId, let error) = CoreParsedMessage.parse(
      "{\"id\":3,\"error\":{\"code\":\"invalid_params\",\"layer\":\"method\",\"message\":\"params.utterance 必须是非空字符串\",\"retriable\":false}}"
    ) else { return XCTFail("失败回应没认出来") }
    XCTAssertEqual(failureId, 3)
    XCTAssertEqual(error.code, .invalidParams)
    XCTAssertEqual(error.layer, .method)
    XCTAssertFalse(error.retriable)

    guard case .notification(let notifyMethod, let notifyParams) = CoreParsedMessage.parse(
      "{\"method\":\"server.ready\",\"params\":{\"protocol\":1,\"serverId\":\"01ABCDEF\",\"pid\":4242}}"
    ) else { return XCTFail("通知没认出来") }
    XCTAssertEqual(notifyMethod, CoreProtocol.notifyServerReady)
    XCTAssertEqual(notifyParams["serverId"]?.stringValue, "01ABCDEF")
    XCTAssertEqual(notifyParams["protocol"]?.intValue, 1)
  }

  func testIdNullIsANotificationNotAMalformedResponse() {
    guard case .notification(let method, _) = CoreParsedMessage.parse("{\"id\":null,\"method\":\"transport.error\",\"params\":{}}") else {
      return XCTFail("id 为 null 等于没有 id")
    }
    XCTAssertEqual(method, CoreProtocol.notifyTransportError)
  }

  func testMalformedShapesAreRejectedWithTheIdWhenItIsReadable() {
    guard case .invalid(let code, _, let id) = CoreParsedMessage.parse("not json at all") else {
      return XCTFail("不是 JSON 的一行必须报 parse_error")
    }
    XCTAssertEqual(code, .parseError)
    XCTAssertNil(id)

    guard case .invalid(let arrayCode, _, _) = CoreParsedMessage.parse("[1,2,3]") else {
      return XCTFail("顶层不是对象就是畸形消息")
    }
    XCTAssertEqual(arrayCode, .malformedMessage)

    // 同时带 result 和 error：不挑一个用，挑一个等于替对面猜它想说什么。
    // id 认得出来，所以要带上，好让对面那次调用立刻有结论
    guard case .invalid(let bothCode, _, let bothId) = CoreParsedMessage.parse("{\"id\":1,\"result\":1,\"error\":{}}") else {
      return XCTFail("result 与 error 只能有一个")
    }
    XCTAssertEqual(bothCode, .malformedMessage)
    XCTAssertEqual(bothId, 1)

    guard case .invalid(_, _, let noneId) = CoreParsedMessage.parse("{\"id\":1}") else {
      return XCTFail("带 id 却什么都没有也是畸形")
    }
    XCTAssertEqual(noneId, 1)

    for bad in ["{\"id\":0,\"result\":1}", "{\"id\":1.5,\"result\":1}", "{\"id\":\"1\",\"result\":1}", "{\"id\":-3,\"result\":1}"] {
      guard case .invalid(_, _, let badId) = CoreParsedMessage.parse(bad) else {
        return XCTFail("id 必须是正整数：\(bad)")
      }
      XCTAssertNil(badId, "认不出 id 就不要编一个出来")
    }
  }

  func testUnknownEnumValuesSurviveInsteadOfBeingGuessed() {
    // 兼容规则 4：对面下个版本会加新的 code。认不出来要留原值并走保守缺省，不是崩掉也不是改写成别的 code
    guard case .failure(_, let error) = CoreParsedMessage.parse(
      "{\"id\":1,\"error\":{\"code\":\"quota_exhausted\",\"layer\":\"billing\",\"message\":\"后面的版本才有的东西\"}}"
    ) else { return XCTFail("失败回应没认出来") }
    XCTAssertEqual(error.code, .unknown("quota_exhausted"))
    XCTAssertEqual(error.layer, .unknown("billing"))
    XCTAssertFalse(error.retriable, "认不出来的 code 一律不可重发——缺省必须等于拦住")

    // 对照：认得出来的 code 在缺字段时按表填缺省，不会被一起降级
    guard case .failure(_, let timeout) = CoreParsedMessage.parse("{\"id\":1,\"error\":{\"code\":\"request_timeout\",\"message\":\"超时\"}}") else {
      return XCTFail("失败回应没认出来")
    }
    XCTAssertEqual(timeout.layer, .method)
    XCTAssertTrue(timeout.retriable, "只有超时是 retriable")
  }

  func testEncodedLineHasExactlyOneNewlineAtTheEnd() {
    // 用户原话里带回车是常事（ASR 不会，但输入框会）。行内出现裸换行就会把帧切断，
    // 表现为「对面偶尔解析失败」
    let outbound = CoreOutbound.request(
      id: 1,
      method: CoreProtocol.methodSessionHandle,
      params: .object([
        CoreProtocol.requestKeyField: .string("11111111-2222-3333-4444-555555555555"),
        "utterance": .string("第一行\n第二行\r\n第三行"),
        "execute": .bool(true),
      ])
    )
    guard let line = outbound.line() else { return XCTFail("请求应该能序列化") }
    XCTAssertEqual(line.filter { $0 == 0x0A }.count, 1)
    XCTAssertEqual(line.last, 0x0A)

    guard let text = String(data: line.dropLast(), encoding: .utf8) else { return XCTFail("应该是合法 UTF-8") }
    guard case .request(let id, let method, let params) = CoreParsedMessage.parse(text) else {
      return XCTFail("自己写出去的东西自己要认得")
    }
    XCTAssertEqual(id, 1)
    XCTAssertEqual(method, CoreProtocol.methodSessionHandle)
    XCTAssertEqual(params["utterance"]?.stringValue, "第一行\n第二行\r\n第三行")
    XCTAssertEqual(params["execute"]?.boolValue, true, "execute 必须是布尔，不能变成 1")
    XCTAssertTrue(text.contains("\"id\":1"), "id 要落成整数，不是 1.0")
  }

  func testIdParityRulesPointInOppositeDirections() {
    // 这两条方向相反，写反的表现是「阶段 4 的反向通道一接上就全被拒」
    XCTAssertTrue(CoreProtocol.isOurRequestID(1))
    XCTAssertTrue(CoreProtocol.isOurRequestID(4242 + 1))
    XCTAssertFalse(CoreProtocol.isOurRequestID(2))
    XCTAssertTrue(CoreProtocol.isPeerRequestID(2))
    XCTAssertFalse(CoreProtocol.isPeerRequestID(3))
  }

  func testJSONValueKeepsTrackOfPresentButNullFields() {
    guard let value = JSONValue.decode(Data("{\"verified\":null,\"executed\":false}".utf8)) else {
      return XCTFail("应该能解析")
    }
    XCTAssertTrue(value.hasKey("verified"))
    XCTAssertEqual(value["verified"], JSONValue.null)
    XCTAssertNil(value["verified"]?.boolValue, "null 不是 false")
    XCTAssertEqual(value["executed"]?.boolValue, false)
    XCTAssertFalse(value.hasKey("missing"))
  }
}
