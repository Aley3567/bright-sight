import XCTest
@testable import BrightSightVoice

final class AssistantStateTests: XCTestCase {
  func testVoiceFlowKeepsPartialTextUntilWorking() {
    var state = AssistantState()
    state.beginAuthorization()
    XCTAssertEqual(state.phase, .authorizing)

    state.beginListening()
    state.updatePartial("打开备忘录", level: 0.7)
    XCTAssertEqual(state.phase, .listening)
    XCTAssertEqual(state.transcript, "打开备忘录")
    XCTAssertEqual(state.audioLevel, 0.7)

    state.beginFinalizing()
    XCTAssertEqual(state.phase, .finalizing)
    XCTAssertEqual(state.transcript, "打开备忘录")

    state.beginWorking(command: state.transcript, source: .voice)
    XCTAssertEqual(state.phase, .working)
    XCTAssertEqual(state.source, .voice)
  }

  func testTypingAndVoiceConvergeBeforeExecution() {
    var voice = AssistantState()
    voice.beginWorking(command: "搜索 Bright Sight", source: .voice)

    var text = AssistantState()
    text.beginTyping()
    text.beginWorking(command: "搜索 Bright Sight", source: .text)

    XCTAssertEqual(voice.phase, text.phase)
    XCTAssertEqual(voice.transcript, text.transcript)
    XCTAssertNotEqual(voice.source, text.source)
  }

  func testResultAndFailureResetToSameIdleState() {
    var success = AssistantState()
    success.beginWorking(command: "打开设置", source: .text)
    success.complete("已经打开系统设置")
    XCTAssertEqual(success.phase, .result)
    success.reset()

    var failure = AssistantState()
    failure.fail("没有麦克风权限")
    XCTAssertEqual(failure.phase, .failure)
    failure.reset()

    XCTAssertEqual(success, AssistantState())
    XCTAssertEqual(failure, AssistantState())
  }

  func testAudioLevelIsClamped() {
    var state = AssistantState()
    state.updatePartial("测试", level: 2)
    XCTAssertEqual(state.audioLevel, 1)
    state.updatePartial("测试", level: -1)
    XCTAssertEqual(state.audioLevel, 0)
  }

  func testConfirmationKeepsActionReasonAndOpaqueHandlesSeparate() {
    var state = AssistantState()
    let confirmation = CommandConfirmation(runId: "RUN1", confirmId: "CONFIRM1", reason: "会新建一条笔记")
    state.beginConfirming(confirmation, action: "记录会议要点")

    XCTAssertEqual(state.phase, .confirming)
    XCTAssertEqual(state.confirmationAction, "记录会议要点")
    XCTAssertEqual(state.detail, "会新建一条笔记")
    XCTAssertEqual(state.confirmation, confirmation)

    state.beginAnsweringConfirmation()
    XCTAssertTrue(state.isAnsweringConfirmation)
    state.complete("已完成")
    XCTAssertNil(state.confirmation)
    XCTAssertFalse(state.isAnsweringConfirmation)
  }
}
