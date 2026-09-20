import XCTest
@testable import BrightSightVoice

/// 「非 done 一律判失败」被换成按 `reasons[].code` 分支之后，这里守的是那几条分支各自落对地方。
final class CoreOutcomeSummaryTests: XCTestCase {
  func testDoneReportsWhichAppsWereTouchedAndThatItWasVerified() {
    let outcome = CoreOutcomeSummary.outcome(for: CoreSessionUpdate(
      status: .done,
      reasons: [CoreReason(code: .completed, detail: "每一步都验证过")],
      steps: [
        CoreSessionStep(step: 1, actionId: "Google Chrome.make-tab", executed: true, verified: true),
        CoreSessionStep(step: 2, actionId: "Notes.make-note", executed: true, verified: true),
        CoreSessionStep(step: 3, actionId: "DONE", executed: false, verified: nil),
      ]
    ))
    XCTAssertEqual(outcome.disposition, .completed)
    XCTAssertTrue(outcome.visualSummary.contains("Google Chrome"))
    XCTAssertTrue(outcome.visualSummary.contains("Notes"))
    XCTAssertTrue(outcome.visualSummary.contains("验证通过"))
    XCTAssertEqual(outcome.spokenSummary, outcome.visualSummary)
  }

  func testDoneWithoutVerificationDoesNotClaimItWasVerified() {
    let outcome = CoreOutcomeSummary.outcome(for: CoreSessionUpdate(
      status: .done,
      reasons: [CoreReason(code: .completed, detail: "做完了")],
      steps: [CoreSessionStep(step: 1, actionId: "Notes.make-note", executed: true, verified: false)]
    ))
    XCTAssertEqual(outcome.disposition, .completed)
    XCTAssertFalse(outcome.visualSummary.contains("验证通过"), "验证没过就别说验证过了")
    XCTAssertTrue(outcome.visualSummary.contains("Notes"))
  }

  func testNeedsInputCannotPretendToBeAResumableConfirmation() {
    // needs_input 当前没有 checkpoint/confirmId。即使旧核心错把 code 写成 needs_confirmation，
    // 也不能展示一个点了以后无处可发的确认按钮。
    let confirmation = CoreOutcomeSummary.outcome(for: CoreSessionUpdate(
      status: .needsInput,
      reasons: [CoreReason(code: .needsConfirmation, detail: "这个 Chrome 身份不在允许名单里")]
    ))
    XCTAssertEqual(confirmation.disposition, .unfinished)
    XCTAssertNil(confirmation.confirmation)
    XCTAssertTrue(confirmation.visualSummary.contains("这个 Chrome 身份不在允许名单里"))

    let clarification = CoreOutcomeSummary.outcome(for: CoreSessionUpdate(
      status: .needsInput,
      reasons: [CoreReason(code: .needsClarification, detail: "要搜什么关键词？")]
    ))
    XCTAssertEqual(clarification.disposition, .unfinished, "追问不是确认：没有待办动作可以点头")
    XCTAssertEqual(clarification.visualSummary, "要搜什么关键词？")
  }

  func testWaitingForConfirmationGoesToTheConfirmBranch() {
    // 句柄与给人看的理由一路同行，UI 不从文案里反推 id。
    let outcome = CoreOutcomeSummary.outcome(for: CoreSessionUpdate(
      runId: "RUN1",
      confirmId: "CONFIRM1",
      status: .waitingForConfirmation,
      reasons: [CoreReason(code: .needsConfirmation, detail: "要在备忘录里写入一条新笔记")]
    ))
    XCTAssertEqual(outcome.disposition, .needsConfirmation)
    XCTAssertEqual(outcome.confirmation, CommandConfirmation(
      runId: "RUN1",
      confirmId: "CONFIRM1",
      reason: "要在备忘录里写入一条新笔记"
    ))
  }

  func testWaitingForConfirmationWithoutHandlesFailsClosed() {
    let outcome = CoreOutcomeSummary.outcome(for: CoreSessionUpdate(
      status: .waitingForConfirmation,
      reasons: [CoreReason(code: .needsConfirmation, detail: "需要确认")]
    ))
    XCTAssertEqual(outcome.disposition, .unfinished)
    XCTAssertNil(outcome.confirmation)
  }

  func testUnsupportedRendersTheCapabilitiesItWasGivenNotAHardcodedSentence() {
    let capabilities = [
      CoreCapability(id: "Google Chrome.make-tab", app: "Google Chrome", summary: "新建一个标签页"),
      CoreCapability(id: "Notes.make-note", app: "Notes", summary: "新建一条备忘录"),
    ]
    let outcome = CoreOutcomeSummary.outcome(for: CoreSessionUpdate(
      status: .blocked,
      reasons: [CoreReason(code: .unsupported, detail: "这个界面操作没有对应的脚本命令")],
      capabilities: capabilities
    ))
    XCTAssertEqual(outcome.disposition, .unfinished)
    XCTAssertTrue(outcome.visualSummary.contains("这个界面操作没有对应的脚本命令"))
    // 阳性对照：清单里的两项都真的出现了，所以下面那条「不含旧文案」不是空断言
    XCTAssertTrue(outcome.visualSummary.contains("新建一个标签页"))
    XCTAssertTrue(outcome.visualSummary.contains("新建一条备忘录"))
    XCTAssertFalse(
      outcome.visualSummary.contains("目前可以打开应用、用 Chrome 搜索或新建备忘录"),
      "能力清单来自 capabilities，不是代码里写死的一句话"
    )
    XCTAssertEqual(outcome.spokenSummary, "这个界面操作没有对应的脚本命令", "念的只有第一句，清单留给眼睛")
  }

  func testCapabilityListIsTruncatedAndSaysHowMany() {
    let many = (1...7).map { CoreCapability(id: "App\($0).do", app: "App\($0)", summary: "做第 \($0) 件事") }
    let outcome = CoreOutcomeSummary.outcome(for: CoreSessionUpdate(
      status: .blocked,
      reasons: [CoreReason(code: .notExecutable, detail: "这条动作没能进入执行")],
      capabilities: many
    ))
    XCTAssertTrue(outcome.visualSummary.contains("做第 1 件事"))
    XCTAssertFalse(outcome.visualSummary.contains("做第 4 件事"))
    XCTAssertTrue(outcome.visualSummary.contains("等 7 项"))
  }

  func testUnknownStatusAndCodeFallThroughWithoutClaimingSuccess() {
    let outcome = CoreOutcomeSummary.outcome(for: CoreSessionUpdate(
      status: .unknown("stage_five_thing"),
      reasons: [CoreReason(code: .unknown("brand_new_code"), detail: "以后才有的原因")]
    ))
    XCTAssertEqual(outcome.disposition, .unfinished, "认不出来的结局落在「没完成」——说成完成是这里唯一不可接受的错")
    XCTAssertEqual(outcome.visualSummary, "以后才有的原因")
  }

  func testNoReasonsStillSaysWhichBranchItLandedOn() {
    let outcome = CoreOutcomeSummary.outcome(for: CoreSessionUpdate(status: .blocked))
    XCTAssertEqual(outcome.disposition, .unfinished)
    XCTAssertTrue(outcome.visualSummary.contains("blocked"), "一句没有信息量的「出错了」查不了任何问题")
  }

  func testReplayedResultIsShownButNotSpokenAgain() {
    let outcome = CoreOutcomeSummary.outcome(for: CoreSessionUpdate(
      status: .done,
      reasons: [CoreReason(code: .completed, detail: "做完了")],
      steps: [CoreSessionStep(step: 1, actionId: "Notes.make-note", executed: true, verified: true)],
      replayed: true
    ))
    XCTAssertEqual(outcome.disposition, .completed)
    XCTAssertNil(outcome.spokenSummary, "副作用没有再发生一次，再念一遍会让人以为又做了一遍")
    XCTAssertTrue(outcome.visualSummary.contains("已经执行过"))
  }

  func testDryRunResultIsNotPresentedAsDone() {
    // 语音条永远传 execute: true，走到这里说明装配出了问题，不能让它看起来像做完了
    let outcome = CoreOutcomeSummary.outcome(for: CoreSessionUpdate(
      status: .done,
      mode: "dry-run",
      reasons: [CoreReason(code: .completed, detail: "演练完成")],
      steps: [CoreSessionStep(step: 1, actionId: "Notes.make-note", executed: true, verified: true)]
    ))
    XCTAssertTrue(outcome.visualSummary.contains("演练"))
    XCTAssertFalse(outcome.visualSummary.contains("已完成Notes操作"))
  }

  /// 四种分支在同一次 update 里同时命中。
  ///
  /// 只测顺风路径的话，「判据装错了位置」「把不该管的也管了」这两类缺陷会全绿通过——
  /// 比如把过滤条件写成 `verified != nil`，单独测每一条都还是对的。
  func testStepListSeparatesVerifiedUnverifiedFailedAndNeverRun() {
    let outcome = CoreOutcomeSummary.outcome(for: CoreSessionUpdate(
      status: .done,
      reasons: [CoreReason(code: .completed, detail: "做完了")],
      steps: [
        CoreSessionStep(step: 1, actionId: "Google Chrome.make-tab", executed: true, verified: true),
        CoreSessionStep(step: 2, actionId: "Notes.make-note", executed: true, verified: nil),
        CoreSessionStep(step: 3, actionId: "Notes.append-note", executed: true, verified: false),
        CoreSessionStep(step: 4, actionId: "DONE", executed: false, verified: nil),
      ]
    ))

    XCTAssertEqual(outcome.steps.count, 3, "没执行过的步骤（含终止意图 DONE）不进「已经动过什么」这张清单")
    XCTAssertEqual(outcome.steps.map(\.state), [.verified, .unverified, .failed])
    XCTAssertEqual(outcome.steps.map(\.app), ["Google Chrome", "Notes", "Notes"])
    XCTAssertEqual(outcome.steps.map(\.command), ["make-tab", "make-note", "append-note"])
  }

  /// `verified` 的 null 是三态里唯一能把人骗了的那个。
  func testUnverifiedStepIsNeverShownAsVerified() {
    let outcome = CoreOutcomeSummary.outcome(for: CoreSessionUpdate(
      status: .done,
      reasons: [CoreReason(code: .doneUnverified, detail: "动作发出去了，但没能回读")],
      steps: [CoreSessionStep(step: 1, actionId: "Notes.make-note", executed: true, verified: nil)]
    ))
    XCTAssertEqual(outcome.steps.map(\.state), [.unverified])
    XCTAssertNotEqual(outcome.steps.first?.state, .verified, "null 不是「验证过」")
    XCTAssertNotEqual(outcome.steps.first?.state, .failed, "null 也不是「验证没过」——是没有可核对的东西")
  }

  /// 失败时这张清单更不能空：副作用可能已经发生了一半。
  func testFailedOutcomeStillCarriesWhatWasAlreadyDone() {
    let outcome = CoreOutcomeSummary.outcome(for: CoreSessionUpdate(
      status: .blocked,
      reasons: [CoreReason(code: .verifyFailed, detail: "第 2 步回读对不上")],
      steps: [
        CoreSessionStep(step: 1, actionId: "Google Chrome.make-tab", executed: true, verified: true),
        CoreSessionStep(step: 2, actionId: "Notes.make-note", executed: true, verified: false),
      ]
    ))
    XCTAssertEqual(outcome.disposition, .unfinished)
    XCTAssertEqual(outcome.steps.count, 2, "没做成不等于什么都没发生")
    XCTAssertEqual(outcome.steps.map(\.state), [.verified, .failed])
  }

  /// 应用名优先取 capabilities 给的，没有才退回 id 前缀——和 completedText 用的是同一条规则。
  func testStepAppNamePrefersCapabilityOverIdPrefix() {
    let outcome = CoreOutcomeSummary.outcome(for: CoreSessionUpdate(
      status: .done,
      reasons: [CoreReason(code: .completed, detail: "做完了")],
      steps: [CoreSessionStep(step: 1, actionId: "com.example.thing.do-it", executed: true, verified: true)],
      capabilities: [CoreCapability(id: "com.example.thing.do-it", app: "某个应用", summary: "做一件事")]
    ))
    XCTAssertEqual(outcome.steps.first?.app, "某个应用")
    XCTAssertEqual(outcome.steps.first?.command, "do-it", "命令名始终取最后一段，不受 capabilities 影响")
  }

  /// 拆不出应用名时退回整串而不是空字符串。
  ///
  /// 实际到不了这里（动作 id 由动作面按 `app.command` 生成，没有点号的只有 DONE/ASK 这类
  /// 终止意图，而它们 executed=false 早被滤掉了）。记录下来是为了钉住「宁可重复也不显示空」。
  func testActionIdWithoutDotFallsBackToWholeString() {
    let outcome = CoreOutcomeSummary.outcome(for: CoreSessionUpdate(
      status: .done,
      reasons: [CoreReason(code: .completed, detail: "做完了")],
      steps: [CoreSessionStep(step: 1, actionId: "standalone", executed: true, verified: true)]
    ))
    XCTAssertEqual(outcome.steps.first?.app, "standalone")
    XCTAssertEqual(outcome.steps.first?.command, "standalone")
  }
}
