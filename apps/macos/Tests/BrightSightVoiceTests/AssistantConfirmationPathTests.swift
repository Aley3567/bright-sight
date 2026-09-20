import XCTest
@testable import BrightSightVoice

/// 结局三分之后，面板进哪个状态。
///
/// serve 模式没有 TTY，profile 预检问不了人，所以陌生 Chrome profile 现在就会回
/// needs_confirmation。这条路径要能走到 `.confirming`，否则用户看到的是「处理失败」，
/// 而核心其实在等他一句话——那正是「卡住不行动」。
@MainActor
final class AssistantConfirmationPathTests: XCTestCase {
  private func model(_ outcome: CommandOutcome) -> (AssistantController, StubSpeaker, StubExecutor) {
    let speaker = StubSpeaker()
    let executor = StubExecutor(outcome: outcome)
    let controller = AssistantController(
      transcriber: StubTranscriber(),
      speaker: speaker,
      executor: executor
    )
    return (controller, speaker, executor)
  }

  private func submit(_ controller: AssistantController, _ command: String = "在备忘录里记一下会议要点") async {
    controller.draftText = command
    controller.submitDraft()
    await settle(controller)
  }

  /// 执行是 detached Task，等它落定。轮询而不是固定 sleep：慢机器上固定时长要么不够要么白等。
  private func settle(_ controller: AssistantController) async {
    for _ in 0..<200 {
      if controller.state.phase != .working { return }
      try? await Task.sleep(nanoseconds: 5_000_000)
    }
  }


  private func settleConfirmation(_ controller: AssistantController) async {
    for _ in 0..<200 {
      if !controller.state.isAnsweringConfirmation { return }
      try? await Task.sleep(nanoseconds: 5_000_000)
    }
  }

  func testNeedsConfirmationLandsInConfirmingNotFailure() async {
    let confirmation = CommandConfirmation(runId: "RUN1", confirmId: "CONFIRM1", reason: "这个 Chrome 身份不在允许名单里")
    let (controller, speaker, _) = model(CommandOutcome(
      visualSummary: "需要你确认：这个 Chrome 身份不在允许名单里",
      spokenSummary: "需要你确认",
      disposition: .needsConfirmation,
      confirmation: confirmation
    ))
    await submit(controller)

    XCTAssertEqual(controller.state.phase, .confirming)
    XCTAssertEqual(controller.state.detail, confirmation.reason)
    XCTAssertEqual(controller.state.confirmationAction, "在备忘录里记一下会议要点")
    XCTAssertEqual(controller.state.confirmation, confirmation)
    XCTAssertEqual(speaker.spoken.last, "需要你确认")
  }

  func testApproveForwardsTheExactHandlesAndAppliesTheNewOutcome() async {
    let confirmation = CommandConfirmation(runId: "RUN1", confirmId: "CONFIRM1", reason: "将创建内容")
    let (controller, _, executor) = model(CommandOutcome(
      visualSummary: "需要确认",
      spokenSummary: nil,
      disposition: .needsConfirmation,
      confirmation: confirmation
    ))
    executor.confirmOutcome = CommandOutcome(visualSummary: "已完成 Notes 操作", spokenSummary: nil)
    await submit(controller)

    controller.approveConfirmation()
    controller.approveConfirmation()
    await settleConfirmation(controller)

    XCTAssertEqual(executor.confirmed, [confirmation], "按钮连点不能把同一个决定发两遍")
    XCTAssertTrue(executor.cancelled.isEmpty)
    XCTAssertEqual(controller.state.phase, .result)
    XCTAssertEqual(controller.state.detail, "已完成 Notes 操作")
  }

  func testCancelUsesSessionCancelPathAndAppliesItsReason() async {
    let confirmation = CommandConfirmation(runId: "RUN1", confirmId: "CONFIRM1", reason: "将创建内容")
    let (controller, _, executor) = model(CommandOutcome(
      visualSummary: "需要确认",
      spokenSummary: nil,
      disposition: .needsConfirmation,
      confirmation: confirmation
    ))
    executor.cancelOutcome = CommandOutcome(
      visualSummary: "用户取消了确认，这一步没有执行",
      spokenSummary: nil,
      disposition: .unfinished
    )
    await submit(controller)

    controller.rejectConfirmation()
    await settleConfirmation(controller)

    XCTAssertEqual(executor.cancelled, [confirmation])
    XCTAssertTrue(executor.confirmed.isEmpty)
    XCTAssertEqual(controller.state.phase, .failure)
    XCTAssertEqual(controller.state.detail, "用户取消了确认，这一步没有执行")
  }

  func testASecondSuspensionReplacesTheConsumedConfirmationHandle() async {
    let first = CommandConfirmation(runId: "RUN1", confirmId: "CONFIRM1", reason: "先确认第一步")
    let second = CommandConfirmation(runId: "RUN1", confirmId: "CONFIRM2", reason: "再确认第二步")
    let (controller, _, executor) = model(CommandOutcome(
      visualSummary: "需要确认第一步",
      spokenSummary: nil,
      disposition: .needsConfirmation,
      confirmation: first
    ))
    executor.confirmOutcome = CommandOutcome(
      visualSummary: "需要确认第二步",
      spokenSummary: nil,
      disposition: .needsConfirmation,
      confirmation: second
    )
    await submit(controller)

    controller.approveConfirmation()
    await settleConfirmation(controller)

    XCTAssertEqual(executor.confirmed, [first])
    XCTAssertEqual(controller.state.phase, .confirming)
    XCTAssertEqual(controller.state.confirmation, second)
    XCTAssertEqual(controller.state.detail, "再确认第二步")
  }

  func testClosingAConfirmationCancelsThePendingCoreRun() async {
    let confirmation = CommandConfirmation(runId: "RUN1", confirmId: "CONFIRM1", reason: "将创建内容")
    let (controller, _, executor) = model(CommandOutcome(
      visualSummary: "需要确认",
      spokenSummary: nil,
      disposition: .needsConfirmation,
      confirmation: confirmation
    ))
    var hideCount = 0
    controller.onRequestHide = { hideCount += 1 }
    await submit(controller)

    controller.close()
    await settleConfirmation(controller)

    XCTAssertEqual(hideCount, 1)
    XCTAssertEqual(executor.cancelled, [confirmation])
    XCTAssertEqual(controller.state, AssistantState())
  }

  func testUnfinishedShowsTheCoreReasonInsteadOfAGenericFailure() async {
    let (controller, _, _) = model(CommandOutcome(
      visualSummary: "这个界面操作没有对应的脚本命令",
      spokenSummary: "这个界面操作没有对应的脚本命令",
      disposition: .unfinished
    ))
    await submit(controller)

    XCTAssertEqual(controller.state.phase, .failure)
    XCTAssertEqual(controller.state.detail, "这个界面操作没有对应的脚本命令")
    XCTAssertFalse(controller.state.detail.hasPrefix("处理失败"), "任务没做成不是抛异常，别套上异常的壳")
  }

  func testCompletedStillGoesToResult() async {
    // 对照：三条分支是同一个 switch 上的，改了前两条不能把最常走的这条带偏
    let (controller, speaker, _) = model(CommandOutcome(visualSummary: "已完成 Notes 操作，并验证通过", spokenSummary: "已完成"))
    await submit(controller)

    XCTAssertEqual(controller.state.phase, .result)
    XCTAssertEqual(controller.state.detail, "已完成 Notes 操作，并验证通过")
    XCTAssertEqual(speaker.spoken.last, "已完成")
  }

  func testReplayedOutcomeIsShownWithoutBeingSpoken() async {
    let (controller, speaker, _) = model(CommandOutcome(
      visualSummary: "这条指令刚才已经执行过，没有重复执行。已完成 Notes 操作",
      spokenSummary: nil
    ))
    await submit(controller)

    XCTAssertEqual(controller.state.phase, .result)
    XCTAssertTrue(speaker.spoken.filter { $0.contains("已经执行过") }.isEmpty)
    // 阳性对照：这一路上确实播过别的话（接单那一句），所以「没播报结果」不是因为压根没接上播报
    XCTAssertFalse(speaker.spoken.isEmpty)
  }

  func testThrownErrorsStillReadAsFailures() async {
    let controller = AssistantController(
      transcriber: StubTranscriber(),
      speaker: StubSpeaker(),
      executor: ThrowingExecutor(error: CoreCommandError.outcomeUnknown)
    )
    controller.draftText = "搜一下 example.com"
    controller.submitDraft()
    await settle(controller)

    XCTAssertEqual(controller.state.phase, .failure)
    XCTAssertTrue(controller.state.detail.contains("这条指令做到哪一步"), "结局未知要说清楚是未知，不是失败")
  }
}

private final class StubExecutor: CommandExecuting {
  let outcome: CommandOutcome
  var confirmOutcome = CommandOutcome(visualSummary: "已确认", spokenSummary: nil)
  var cancelOutcome = CommandOutcome(visualSummary: "已取消", spokenSummary: nil, disposition: .unfinished)
  private(set) var confirmed: [CommandConfirmation] = []
  private(set) var cancelled: [CommandConfirmation] = []
  init(outcome: CommandOutcome) { self.outcome = outcome }

  func execute(_ command: String, onAccepted: @escaping (String) -> Void) async throws -> CommandOutcome {
    onAccepted("好的，我来执行")
    return outcome
  }

  func confirm(_ confirmation: CommandConfirmation) async throws -> CommandOutcome {
    confirmed.append(confirmation)
    return confirmOutcome
  }

  func cancel(_ confirmation: CommandConfirmation) async throws -> CommandOutcome {
    cancelled.append(confirmation)
    return cancelOutcome
  }
}

private struct ThrowingExecutor: CommandExecuting {
  let error: Error
  func execute(_ command: String, onAccepted: @escaping (String) -> Void) async throws -> CommandOutcome {
    onAccepted("好的，我来执行")
    throw error
  }
}

private final class StubTranscriber: SpeechTranscribing {
  let displayName = "Stub"
  func start(
    hotwords: [String],
    onReady: @escaping () -> Void,
    onPartial: @escaping (String) -> Void,
    onLevel: @escaping (Float) -> Void,
    onFinal: @escaping (String) -> Void,
    onFailure: @escaping (String) -> Void
  ) {}
  func stop() {}
  func cancel() {}
}

private final class StubSpeaker: SpeechSpeaking {
  var onSpeakingChanged: ((Bool) -> Void)?
  private(set) var spoken: [String] = []
  func speak(_ text: String) { spoken.append(text) }
  func stop() {}
}
