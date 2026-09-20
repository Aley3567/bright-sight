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
  /// 波形的历史采样窗口长度。
  ///
  /// 定长滚动而不是无限追加：这是「刚才这一秒说得怎么样」，更旧的采样没有意义。
  /// 配 AVAudioEngine 1024 帧的 buffer（48kHz 下约 47Hz 回调），48 个点约等于 1 秒，
  /// 刚好覆盖一个短句的起伏；再长就看不出在流动，再短则停顿还没来得及走出去就被挤掉了。
  static let levelWindow = 48

  var phase: AssistantPhase = .idle
  var transcript = ""
  var detail = "按住右 ⌘ 说话"
  var audioLevel: Float = 0
  /// 与 `audioLevel` 并存而不是取代它：那个是「此刻的响度」，这个是「刚才一秒的形状」。
  /// 只有后者能让停顿留下一段平坦的痕迹继续左移，而不是整排一起塌到底。
  var levels: [Float] = Array(repeating: 0, count: AssistantState.levelWindow)
  /// 这一轮真正动过的步骤。**失败态也要有**：副作用可能已经发生了一半。
  var steps: [CommandStep] = []
  var source: AssistantInputSource?
  var confirmation: CommandConfirmation?
  var confirmationAction = ""
  var isAnsweringConfirmation = false

  mutating func beginAuthorization() {
    phase = .authorizing
    transcript = ""
    detail = "正在准备麦克风…"
    audioLevel = 0
    levels = Array(repeating: 0, count: Self.levelWindow)
    steps = []
    source = .voice
  }

  mutating func beginListening() {
    phase = .listening
    detail = "正在听，松开右 ⌘ 后提交"
  }

  mutating func updatePartial(_ value: String, level: Float? = nil) {
    transcript = value
    if let level { pushLevel(level) }
  }

  /// 新采样从右端进，整条左移一格。
  mutating func pushLevel(_ value: Float) {
    let clamped = min(max(value, 0), 1)
    audioLevel = clamped
    levels.removeFirst()
    levels.append(clamped)
  }

  mutating func beginFinalizing() {
    phase = .finalizing
    detail = "正在整理文字…"
    audioLevel = 0
    levels = Array(repeating: 0, count: Self.levelWindow)
  }

  mutating func beginTyping() {
    phase = .typing
    detail = "输入你要 Bright Sight 完成的事"
    audioLevel = 0
    levels = Array(repeating: 0, count: Self.levelWindow)
    source = .text
  }

  mutating func beginWorking(command: String, source: AssistantInputSource) {
    phase = .working
    transcript = command
    detail = "正在理解并准备行动…"
    audioLevel = 0
    levels = Array(repeating: 0, count: Self.levelWindow)
    steps = []
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

  mutating func complete(_ message: String, steps: [CommandStep] = []) {
    phase = .result
    detail = message
    audioLevel = 0
    self.steps = steps
    confirmation = nil
    confirmationAction = ""
    isAnsweringConfirmation = false
  }

  mutating func fail(_ message: String, steps: [CommandStep] = []) {
    phase = .failure
    detail = message
    audioLevel = 0
    self.steps = steps
    confirmation = nil
    confirmationAction = ""
    isAnsweringConfirmation = false
  }

  mutating func reset() {
    self = AssistantState()
  }
}
