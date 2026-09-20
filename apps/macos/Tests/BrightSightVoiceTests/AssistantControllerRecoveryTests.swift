import XCTest
@testable import BrightSightVoice

@MainActor
final class AssistantControllerRecoveryTests: XCTestCase {
  func testBackFromFinalizingPreservesTranscriptForEditing() {
    let transcriber = MockTranscriber()
    let speaker = MockSpeaker()
    let model = AssistantController(
      transcriber: transcriber,
      speaker: speaker,
      executor: ImmediateExecutor()
    )

    model.beginVoice()
    transcriber.onReady?()
    transcriber.onPartial?("打开浏览器搜索 Bright Sight")
    model.endVoice()

    XCTAssertEqual(model.state.phase, .finalizing)
    model.back()

    XCTAssertEqual(model.state.phase, .typing)
    XCTAssertEqual(model.draftText, "打开浏览器搜索 Bright Sight")
    XCTAssertGreaterThanOrEqual(transcriber.cancelCount, 1)
  }

  func testRecognitionFailureCanStartVoiceAgain() {
    let transcriber = MockTranscriber()
    let model = AssistantController(
      transcriber: transcriber,
      speaker: MockSpeaker(),
      executor: ImmediateExecutor()
    )

    model.beginVoice()
    transcriber.onFailure?("没有听清，请再说一次")
    XCTAssertEqual(model.state.phase, .failure)

    model.retryVoice()
    XCTAssertEqual(model.state.phase, .authorizing)
    XCTAssertEqual(transcriber.startCount, 2)
  }

  func testTogglePinPersistsToUserDefaults() {
    let key = "isPinned"
    let defaults = UserDefaults.standard
    let previous = defaults.object(forKey: key)
    defer {
      if let previous { defaults.set(previous, forKey: key) } else { defaults.removeObject(forKey: key) }
    }
    defaults.removeObject(forKey: key)

    let model = AssistantController(
      transcriber: MockTranscriber(),
      speaker: MockSpeaker(),
      executor: ImmediateExecutor()
    )
    XCTAssertFalse(model.isPinned, "没有存过值时应该默认不置顶")

    model.togglePin()
    XCTAssertTrue(model.isPinned)
    XCTAssertEqual(defaults.bool(forKey: key), true)

    model.togglePin()
    XCTAssertFalse(model.isPinned)
    XCTAssertEqual(defaults.bool(forKey: key), false)
  }

  func testSpeakerLifecycleDrivesWaveformState() async {
    let speaker = MockSpeaker()
    let model = AssistantController(
      transcriber: MockTranscriber(),
      speaker: speaker,
      executor: ImmediateExecutor()
    )

    speaker.onSpeakingChanged?(true)
    await Task.yield()
    XCTAssertTrue(model.isSpeaking)

    speaker.onSpeakingChanged?(false)
    await Task.yield()
    XCTAssertFalse(model.isSpeaking)
  }
}

private final class MockTranscriber: SpeechTranscribing {
  let displayName = "Mock"
  var startCount = 0
  var cancelCount = 0
  var onReady: (() -> Void)?
  var onPartial: ((String) -> Void)?
  var onFailure: ((String) -> Void)?

  func start(
    hotwords: [String],
    onReady: @escaping () -> Void,
    onPartial: @escaping (String) -> Void,
    onLevel: @escaping (Float) -> Void,
    onFinal: @escaping (String) -> Void,
    onFailure: @escaping (String) -> Void
  ) {
    startCount += 1
    self.onReady = onReady
    self.onPartial = onPartial
    self.onFailure = onFailure
  }

  func stop() {}

  func cancel() {
    cancelCount += 1
  }
}

private final class MockSpeaker: SpeechSpeaking {
  var onSpeakingChanged: ((Bool) -> Void)?
  func speak(_ text: String) {}
  func stop() { onSpeakingChanged?(false) }
}

private struct ImmediateExecutor: CommandExecuting {
  func execute(
    _ command: String,
    onAccepted: @escaping (String) -> Void
  ) async throws -> CommandOutcome {
    CommandOutcome(visualSummary: "完成", spokenSummary: nil)
  }
}
