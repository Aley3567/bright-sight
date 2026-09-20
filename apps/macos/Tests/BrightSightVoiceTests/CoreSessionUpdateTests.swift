import XCTest
@testable import BrightSightVoice

final class CoreSessionUpdateTests: XCTestCase {
  private func update(_ json: String) throws -> CoreSessionUpdate {
    guard let value = JSONValue.decode(Data(json.utf8)) else {
      throw CoreError(.parseError, "样本本身不是合法 JSON")
    }
    return try CoreSessionUpdate(json: value)
  }

  func testDecodesATypicalDoneResult() throws {
    let decoded = try update("""
    {"runId":"01ABCDEF","status":"done","mode":"execute",
     "reasons":[{"code":"completed","detail":"每一步都验证过","step":2}],
     "steps":[{"step":1,"actionId":"Google Chrome.make-tab","executed":true,"verified":true,
               "confidence":0.9,"complete":0.5,"destructive":0.1,"reasons":[]},
              {"step":2,"actionId":"DONE","executed":false,"verified":null,
               "confidence":0.9,"complete":1,"destructive":0,"reasons":[]}],
     "artifacts":[{"key":"url","value":"https://example.com/","step":1}],
     "journal":{"path":"/somewhere/01ABCDEF.jsonl","redacted":true,"failures":0}}
    """)

    XCTAssertEqual(decoded.status, .done)
    XCTAssertEqual(decoded.mode, "execute")
    XCTAssertEqual(decoded.reasons, [CoreReason(code: .completed, detail: "每一步都验证过", step: 2)])
    XCTAssertEqual(decoded.steps.count, 2)
    XCTAssertEqual(decoded.steps[0].actionId, "Google Chrome.make-tab")
    XCTAssertEqual(decoded.steps[0].verified, true)
    XCTAssertNil(decoded.steps[1].verified, "没执行的步骤没有可验证的东西，null 不能折成 false")
    XCTAssertFalse(decoded.replayed)
    XCTAssertTrue(decoded.capabilities.isEmpty)
  }

  func testUnknownStatusAndReasonCodeKeepTheirWireValue() throws {
    // 阶段 3 之后会有新的 code。认不出来要留原值走 default 分支，而不是解析失败
    let decoded = try update("""
    {"status":"stage_five_thing","mode":"execute","reasons":[{"code":"brand_new_code","detail":"以后才有的原因"}],
     "steps":[],"artifacts":[],"journal":{"path":"x","redacted":true,"failures":0},
     "somethingAddedLater":{"nested":true}}
    """)
    XCTAssertEqual(decoded.status, .unknown("stage_five_thing"))
    XCTAssertEqual(decoded.reasons.first?.code, .unknown("brand_new_code"))
    XCTAssertEqual(decoded.reasons.first?.detail, "以后才有的原因")
    XCTAssertNil(decoded.reasons.first?.step, "step 可有可无")
  }

  func testWaitingForConfirmationAndCapabilitiesDecode() throws {
    let decoded = try update("""
    {"runId":"RUN1","confirmId":"CONFIRM1","status":"waiting_for_confirmation","mode":"execute",
     "reasons":[{"code":"needs_confirmation","detail":"这个 Chrome 身份不在允许名单里","step":1}],
     "steps":[],"artifacts":[],
     "capabilities":[{"id":"Notes.make-note","app":"Notes","summary":"新建一条备忘录","effect":"creates","risk":"write","argv":["title","body"]}],
     "journal":{"path":"x","redacted":true,"failures":0}}
    """)
    XCTAssertEqual(decoded.status, .waitingForConfirmation)
    XCTAssertEqual(decoded.runId, "RUN1")
    XCTAssertEqual(decoded.confirmId, "CONFIRM1")
    XCTAssertEqual(decoded.capabilities, [CoreCapability(id: "Notes.make-note", app: "Notes", summary: "新建一条备忘录")])
  }

  func testDoneDoesNotInventAConfirmationID() throws {
    let decoded = try update("""
    {"runId":"RUN1","status":"done","mode":"execute","reasons":[{"code":"completed","detail":"做完了"}],
     "steps":[],"artifacts":[],"journal":{"path":"x","redacted":true,"failures":0}}
    """)
    XCTAssertEqual(decoded.runId, "RUN1")
    XCTAssertNil(decoded.confirmId)
  }

  func testReplayedFlagIsRead() throws {
    let decoded = try update("""
    {"status":"done","mode":"execute","reasons":[{"code":"completed","detail":"做完了"}],
     "steps":[],"artifacts":[],"journal":{"path":"x","redacted":true,"failures":0},"replayed":true}
    """)
    XCTAssertTrue(decoded.replayed)
  }

  func testMissingStatusIsAnErrorNotAnEmptySuccess() {
    // 读不出结局绝不能当成做完了：这里必须抛
    XCTAssertThrowsError(try update("{\"mode\":\"execute\",\"reasons\":[]}")) { error in
      XCTAssertEqual((error as? CoreError)?.code, .malformedMessage)
    }
    // 阳性对照：同一个样本补上 status 就能解出来，说明上面不是因为别的字段缺了才抛
    XCTAssertNoThrow(try update("{\"status\":\"blocked\",\"mode\":\"execute\",\"reasons\":[]}"))
  }

  func testReasonWithoutCodeIsDroppedRatherThanGuessed() throws {
    let decoded = try update("""
    {"status":"blocked","mode":"execute","reasons":[{"detail":"没有 code 的一条"},{"code":"unsupported","detail":"这件事我不会"}],
     "steps":[],"artifacts":[],"journal":{"path":"x","redacted":true,"failures":0}}
    """)
    XCTAssertEqual(decoded.reasons.map(\.code), [.unsupported], "code 决定走哪条分支，没有 code 的一条不能凑一个出来")
  }
}
