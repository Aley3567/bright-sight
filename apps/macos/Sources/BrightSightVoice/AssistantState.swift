import Foundation

enum AssistantPhase: String, Equatable, Sendable {
  case idle
  case authorizing
  case listening
  case finalizing
  case typing
  case working
  /// 等人拍板。serve 模式没有 TTY，profile 预检问不了人，陌生 Chrome profile 会走这条。
  case confirming
  case result
  case failure
}

enum AssistantInputSource: Equatable, Sendable {
  case voice
  case text
}

struct AssistantState: Equatable, Sendable {
  var phase: AssistantPhase = .idle
  var transcript = ""
  var detail = "按住右 ⌘ 说话"
  var audioLevel: Float = 0
  var source: AssistantInputSource?
  var confirmation: CommandConfirmation?
  var confirmationAction = ""
  var isAnsweringConfirmation = false

  mutating func beginAuthorization() {
    phase = .authorizing
    transcript = ""
    detail = "正在准备麦克风…"
    audioLevel = 0
    source = .voice
  }

  mutating func beginListening() {
    phase = .listening
    detail = "正在听，松开右 ⌘ 后提交"
  }

  mutating func updatePartial(_ value: String, level: Float? = nil) {
    transcript = value
    if let level { audioLevel = min(max(level, 0), 1) }
  }

  mutating func beginFinalizing() {
    phase = .finalizing
    detail = "正在整理文字…"
    audioLevel = 0
  }

  mutating func beginTyping() {
    phase = .typing
    detail = "输入你要 Bright Sight 完成的事"
    audioLevel = 0
    source = .text
  }

  mutating func beginWorking(command: String, source: AssistantInputSource) {
    phase = .working
    transcript = command
    detail = "正在理解并准备行动…"
    audioLevel = 0
    self.source = source
  }

  /// 核心停在「要人拍板」那一步。
  ///
  /// 和 `fail` 分开是有实际后果的：`fail` 说的是「这件事没成」，而这里说的是「等你一句话」，
  /// 中间那条指令还挂在核心里等确认。落到 failure 上的话，用户看到的就是「处理失败」，
  /// 而真实情况是它在等人——这正是用户报的「卡住不行动」。
  mutating func beginConfirming(_ confirmation: CommandConfirmation, action: String) {
    phase = .confirming
    detail = confirmation.reason
    audioLevel = 0
    self.confirmation = confirmation
    confirmationAction = action
    isAnsweringConfirmation = false
  }

  mutating func beginAnsweringConfirmation() {
    guard phase == .confirming, confirmation != nil else { return }
    isAnsweringConfirmation = true
  }

  mutating func complete(_ message: String) {
    phase = .result
    detail = message
    audioLevel = 0
    confirmation = nil
    confirmationAction = ""
    isAnsweringConfirmation = false
  }

  mutating func fail(_ message: String) {
    phase = .failure
    detail = message
    audioLevel = 0
    confirmation = nil
    confirmationAction = ""
    isAnsweringConfirmation = false
  }

  mutating func reset() {
    self = AssistantState()
  }
}
