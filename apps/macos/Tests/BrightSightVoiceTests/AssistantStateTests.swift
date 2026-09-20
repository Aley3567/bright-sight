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

  func testPushLevelSlidesTheWindowLeftAndKeepsItFixedLength() {
    var state = AssistantState()
    let window = AssistantState.levelWindow
    XCTAssertEqual(state.levels.count, window)

    for index in 1...window {
      state.pushLevel(Float(index) / Float(window))
    }
    XCTAssertEqual(state.levels.count, window, "定长滚动窗口，不能越推越长")
    XCTAssertEqual(state.levels.last ?? 0, 1, accuracy: 0.001, "最新采样落在右端")
    XCTAssertEqual(state.levels.first ?? 0, 1 / Float(window), accuracy: 0.001, "最旧的那个已经被挤出去了")
  }

  func testPushLevelClampsAndKeepsAudioLevelInSync() {
    var state = AssistantState()
    state.pushLevel(2)
    XCTAssertEqual(state.levels.last, 1)
    XCTAssertEqual(state.audioLevel, 1, "两个字段读的是同一个采样，不能各说各话")

    state.pushLevel(-1)
    XCTAssertEqual(state.levels.last, 0)
    XCTAssertEqual(state.audioLevel, 0)
  }

  /// 新一轮开始时波形要清零，否则上一句的余波会挂在那里冒充「正在听到声音」。
  func testStartingANewRoundClearsThePreviousWaveform() {
    var state = AssistantState()
    state.pushLevel(0.9)

    state.beginAuthorization()
    XCTAssertTrue(state.levels.allSatisfy { $0 == 0 }, "开始录音前残留的余波会骗人")

    state.pushLevel(0.9)
    state.beginWorking(command: "打开备忘录", source: .voice)
    XCTAssertTrue(state.levels.allSatisfy { $0 == 0 })
    XCTAssertTrue(state.steps.isEmpty, "新一轮不该带着上一轮的步骤")
  }
}
