import Foundation

/// 一次 handle 的结局 → 面板上显示什么、要不要念、进哪个状态。
///
/// 这里是「非 done 一律判失败」那条老逻辑的替代品。老逻辑的代价很具体：
/// `waiting_for_confirmation` 是「等你一句话」，却曾被报成「处理失败」，
/// 用户看到的现象就是「它卡住了不行动」。
///
/// 分支一律按 `reasons[].code` 走，显示的字一律取 `reasons[].detail`。
/// **不要反过来 match detail 的中文**——核心那边改一句文案，这里就静默走错分支。
enum CoreOutcomeSummary {
  /// 能力清单最多念几条。全量动作面有几百条，念完用户已经走了；
  /// 而且阶段 4 之后能力是「当前界面的函数」，每次都不一样，更不能指望人听完。
  private static let capabilityLimit = 3

  static func outcome(for update: CoreSessionUpdate) -> CommandOutcome {
    let confirmation = confirmation(for: update)
    let disposition = disposition(for: update, confirmation: confirmation)
    let visual = visualText(for: update, disposition: disposition)

    // replayed = 同一个 requestKey 之前来过，副作用**没有**发生第二次。
    // 再念一遍会让人以为又做了一遍
    if update.replayed {
      return CommandOutcome(
        visualSummary: "这条指令刚才已经执行过，没有重复执行。\(visual)",
        spokenSummary: nil,
        disposition: disposition,
        confirmation: confirmation
      )
    }
    return CommandOutcome(
      visualSummary: visual,
      spokenSummary: spokenText(for: update, disposition: disposition),
      disposition: disposition,
      confirmation: confirmation
    )
  }

  private static func disposition(
    for update: CoreSessionUpdate,
    confirmation: CommandConfirmation?
  ) -> CommandDisposition {
    switch update.status {
    case .done:
      return .completed
    case .waitingForConfirmation:
      // 缺少抓手时不展示一个点了也不可能继续的气泡。核心协议保证这两个 id 同时存在，
      // 真缺了说明两侧装配已经漂移，安全的退路是「没完成」。
      return confirmation == nil ? .unfinished : .needsConfirmation
    case .needsInput:
      // needs_input 没有 checkpoint/confirmId，不能借确认气泡假装它能恢复；追问入口留给后续阶段。
      return .unfinished
    case .blocked, .unknown:
      // 认不出来的 status 走这里：没做完，但也不是这条线坏了。
      // 缺省落在「没完成」而不是「完成了」——说成完成是这里唯一不可接受的错
      return .unfinished
    }
  }

  private static func confirmation(for update: CoreSessionUpdate) -> CommandConfirmation? {
    guard update.status == .waitingForConfirmation,
          !update.runId.isEmpty,
          let confirmId = update.confirmId,
          !confirmId.isEmpty else { return nil }
    return CommandConfirmation(runId: update.runId, confirmId: confirmId, reason: primaryDetail(update))
  }

  private static func visualText(for update: CoreSessionUpdate, disposition: CommandDisposition) -> String {
    switch disposition {
    case .completed:
      return completedText(for: update)
    case .needsConfirmation:
      return "需要你确认：\(primaryDetail(update))"
    case .unfinished:
      let reason = primaryDetail(update)
      guard needsCapabilityList(update) else { return reason }
      let list = capabilityList(update)
      return list.isEmpty ? reason : "\(reason)\n目前我会：\(list)"
    }
  }

  private static func spokenText(for update: CoreSessionUpdate, disposition: CommandDisposition) -> String {
    // 念的永远只有第一句：能力清单那一串在耳朵里是噪音，眼睛看才有用
    switch disposition {
    case .completed: return completedText(for: update)
    case .needsConfirmation: return "需要你确认：\(primaryDetail(update))"
    case .unfinished: return primaryDetail(update)
    }
  }

  /// 做完了说一句什么。
  ///
  /// 老代码是去 stdout 里找 `判断: Google Chrome.make-tab` 这行字；现在从 steps 的 actionId
  /// 推：真执行过的步骤取动作 id 的应用名前缀。动作 id 由动作面自动生成（`app.command`），
  /// 所以新接一个应用时这句话会自己跟着变，不需要有人记得回来改。
  private static func completedText(for update: CoreSessionUpdate) -> String {
    let executed = update.steps.filter(\.executed)
    var apps: [String] = []
    for step in executed {
      let app = appName(ofAction: step.actionId, capabilities: update.capabilities)
      if let app, !apps.contains(app) { apps.append(app) }
    }
    let verified = !executed.isEmpty && executed.allSatisfy { $0.verified == true }
    let tail = verified ? "，并验证通过" : ""
    if update.mode == "dry-run" {
      // 语音条永远传 execute: true，走到这里说明核心那边把它当演练跑了——
      // 那是装配问题，不能让它看起来像「已经做完」
      return "只做了演练，没有真的动手（核心报告 dry-run）"
    }
    if apps.isEmpty { return executed.isEmpty ? "指令已处理" : "指令已执行\(tail)" }
    return "已完成\(apps.joined(separator: "、"))操作\(tail)"
  }

  private static func appName(ofAction actionId: String, capabilities: [CoreCapability]) -> String? {
    if let match = capabilities.first(where: { $0.id == actionId }), !match.app.isEmpty { return match.app }
    // 能力清单只在 unsupported / not_executable 时给，所以多数成功路径要靠 id 自己
    guard let dot = actionId.lastIndex(of: ".") else { return nil }
    let app = String(actionId[actionId.startIndex..<dot])
    return app.isEmpty ? nil : app
  }

  private static func primaryDetail(_ update: CoreSessionUpdate) -> String {
    if let detail = update.reasons.first(where: { !$0.detail.isEmpty })?.detail { return detail }
    // 一条能读的原因都没有：至少把机器可读的那两个词报出来，
    // 好让人知道落到了哪条分支，而不是看见一句没有信息量的「出错了」
    let code = update.reasons.first?.code.wire ?? "无原因"
    return "这条指令没有完成（\(update.status.wire) / \(code)）"
  }

  private static func needsCapabilityList(_ update: CoreSessionUpdate) -> Bool {
    update.reasons.contains { $0.code == .unsupported || $0.code == .notExecutable }
  }

  /// 能力清单只给事实，不给文案。
  ///
  /// 老代码在这里硬编码了一句「目前可以打开应用、用 Chrome 搜索或新建备忘录」，
  /// 那句话在动作面变化时不会跟着变；现在每一项都来自 `capabilities`。
  private static func capabilityList(_ update: CoreSessionUpdate) -> String {
    let items = update.capabilities.prefix(capabilityLimit).map { capability -> String in
      let summary = capability.summary.isEmpty ? capability.id : capability.summary
      return capability.app.isEmpty ? summary : "\(capability.app)·\(summary)"
    }
    if items.isEmpty { return "" }
    let rest = update.capabilities.count - items.count
    return items.joined(separator: "；") + (rest > 0 ? "，等 \(update.capabilities.count) 项" : "")
  }
}
