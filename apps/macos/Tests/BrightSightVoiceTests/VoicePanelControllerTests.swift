import XCTest
@testable import BrightSightVoice

/// 只测 `VoicePanelController.shouldHide` 这个纯函数——真实 NSPanel/NSWorkspace 通知没法在
/// `swift test` 里可靠地触发，判定逻辑单独抽出来测才不用去 mock 整个 AppKit。
final class VoicePanelControllerTests: XCTestCase {
  func testHidesWhenUnpinnedAndAnotherAppActivatesDuringOrdinaryPhases() {
    for phase: AssistantPhase in [.idle, .authorizing, .listening, .finalizing, .typing] {
      XCTAssertTrue(
        VoicePanelController.shouldHide(isPinned: false, phase: phase, activatedIsSelf: false),
        "phase=\(phase) 应该隐藏"
      )
    }
  }

  func testKeepsVisibleDuringExecutionAndResultPhasesEvenWhenUnpinned() {
    for phase: AssistantPhase in [.working, .confirming, .result, .failure] {
      XCTAssertFalse(
        VoicePanelController.shouldHide(isPinned: false, phase: phase, activatedIsSelf: false),
        "phase=\(phase) 是执行/结果阶段的例外，不该隐藏"
      )
    }
  }

  func testPinnedNeverHidesRegardlessOfPhaseOrActivatedApp() {
    // 新旧分支同时命中：pin 与阶段例外同时满足时，结果仍然是不隐藏，而不是被两条判据互相抵消。
    XCTAssertFalse(VoicePanelController.shouldHide(isPinned: true, phase: .idle, activatedIsSelf: false))
    XCTAssertFalse(VoicePanelController.shouldHide(isPinned: true, phase: .working, activatedIsSelf: false))
    XCTAssertFalse(VoicePanelController.shouldHide(isPinned: true, phase: .idle, activatedIsSelf: true))
  }

  func testActivatingSelfNeverHidesRegardlessOfPhase() {
    XCTAssertFalse(VoicePanelController.shouldHide(isPinned: false, phase: .idle, activatedIsSelf: true))
    XCTAssertFalse(VoicePanelController.shouldHide(isPinned: false, phase: .working, activatedIsSelf: true))
  }
}
