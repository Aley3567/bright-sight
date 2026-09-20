import AppKit
import Combine
import Foundation

@MainActor
final class AssistantController: ObservableObject {
  @Published private(set) var state = AssistantState()
  @Published private(set) var isSpeaking = false
  @Published var draftText = ""
  @Published var voiceFeedbackEnabled: Bool {
    didSet { UserDefaults.standard.set(voiceFeedbackEnabled, forKey: Self.voiceFeedbackKey) }
  }
  /// 图钉状态：点亮后面板既不会因为切到其他应用被 1.3 的失焦逻辑隐藏，也在
  /// VoicePanelController 里把 panel.level 提到更高，跨 Space/全屏都压得住。
  @Published var isPinned: Bool {
    didSet { UserDefaults.standard.set(isPinned, forKey: Self.pinnedKey) }
  }

  var onRequestHide: (() -> Void)?

  private static let voiceFeedbackKey = "voiceFeedbackEnabled"
  private static let pinnedKey = "isPinned"
  private let transcriber: SpeechTranscribing
  private let speaker: SpeechSpeaking
  private let executor: CommandExecuting
  private var pushHeld = false
  private var resetTask: Task<Void, Never>?
  private var executionTask: Task<Void, Never>?
  private var activeExecution: UUID?
  private var lastSubmittedCommand = ""
  private var lastInputSource: AssistantInputSource = .text

  var canRetryLastCommand: Bool {
    !lastSubmittedCommand.isEmpty
  }

  init(
    transcriber: SpeechTranscribing,
    speaker: SpeechSpeaking,
    executor: CommandExecuting
  ) {
    self.transcriber = transcriber
    self.speaker = speaker
    self.executor = executor
    self.voiceFeedbackEnabled = UserDefaults.standard.object(forKey: Self.voiceFeedbackKey) as? Bool ?? true
    self.isPinned = UserDefaults.standard.object(forKey: Self.pinnedKey) as? Bool ?? false
    self.speaker.onSpeakingChanged = { [weak self] speaking in
      Task { @MainActor in self?.isSpeaking = speaking }
    }
  }

  func beginVoice() {
    guard !pushHeld else { return }
    guard [.idle, .result, .failure, .typing].contains(state.phase) else { return }
    resetTask?.cancel()
    speaker.stop()
    pushHeld = true
    state.beginAuthorization()

    transcriber.start(
      hotwords: ["Bright Sight", "Chrome", "Safari", "备忘录", "系统设置"],
      onReady: { [weak self] in
        guard let self else { return }
        self.state.beginListening()
        if !self.pushHeld { self.endVoice() }
      },
      onPartial: { [weak self] text in self?.state.updatePartial(text) },
      onLevel: { [weak self] level in self?.state.updatePartial(self?.state.transcript ?? "", level: level) },
      onFinal: { [weak self] text in self?.submit(text, source: .voice) },
      onFailure: { [weak self] message in
        self?.pushHeld = false
        self?.state.fail(message)
      }
    )
  }

  func endVoice() {
    guard pushHeld else { return }
    pushHeld = false
    if state.phase == .listening { state.beginFinalizing() }
    transcriber.stop()
  }

  func toggleVoiceCapture() {
    if pushHeld { endVoice() } else { beginVoice() }
  }

  func showTyping() {
    stopActiveWork()
    state.beginTyping()
  }

  func back() {
    if state.phase == .typing {
      cancelCurrent()
      return
    }

    let recoverableText = state.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    stopActiveWork()
    if recoverableText.isEmpty {
      state.reset()
    } else {
      draftText = recoverableText
      state.beginTyping()
    }
  }

  func cancelCurrent() {
    stopActiveWork()
    state.reset()
  }

  func retryLastCommand() {
    guard canRetryLastCommand else { return }
    let command = lastSubmittedCommand
    let source = lastInputSource
    stopActiveWork()
    submit(command, source: source)
  }

  func retryVoice() {
    stopActiveWork()
    state.reset()
    beginVoice()
  }

  func stopSpeaking() {
    speaker.stop()
  }

  func approveConfirmation() {
    answerConfirmation(approved: true)
  }

  func rejectConfirmation() {
    answerConfirmation(approved: false)
  }

  func submitDraft() {
    let command = draftText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !command.isEmpty else { return }
    draftText = ""
    submit(command, source: .text)
  }

  func toggleVoiceFeedback() {
    voiceFeedbackEnabled.toggle()
    if !voiceFeedbackEnabled { speaker.stop() }
  }

  func togglePin() {
    isPinned.toggle()
  }

  func close() {
    if state.phase == .confirming, state.confirmation != nil {
      // 关掉确认气泡也等于拒绝：不能只把 UI 藏起来，却让核心里的挂起点继续占着。
      answerConfirmation(approved: false, resetAfterAnswer: true)
      onRequestHide?()
      return
    }
    stopActiveWork()
    state.reset()
    onRequestHide?()
  }

  private func submit(_ raw: String, source: AssistantInputSource) {
    let command = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !command.isEmpty else {
      state.fail("没有听清，请再说一次")
      return
    }

    stopActiveWork()
    pushHeld = false
    lastSubmittedCommand = command
    lastInputSource = source
    state.beginWorking(command: command, source: source)
    let execution = UUID()
    activeExecution = execution

    executionTask = Task { [weak self] in
      guard let self else { return }
      do {
        let outcome = try await self.executor.execute(command) { [weak self] message in
          Task { @MainActor in
            guard let self,
                  self.activeExecution == execution,
                  self.voiceFeedbackEnabled else { return }
            self.speaker.speak(message)
          }
        }
        guard !Task.isCancelled, self.activeExecution == execution else { return }
        self.apply(outcome, command: command)
      } catch {
        guard !Task.isCancelled, self.activeExecution == execution else { return }
        self.state.fail("处理失败：\(error.localizedDescription)")
      }
      self.executionTask = nil
      self.activeExecution = nil
      if self.state.phase == .result { self.scheduleAutoReset() }
    }
  }

  private func answerConfirmation(approved: Bool, resetAfterAnswer: Bool = false) {
    guard state.phase == .confirming,
          !state.isAnsweringConfirmation,
          let confirmation = state.confirmation else { return }

    resetTask?.cancel()
    speaker.stop()
    state.beginAnsweringConfirmation()
    let execution = UUID()
    activeExecution = execution
    executionTask = Task { [weak self] in
      guard let self else { return }
      do {
        let outcome = approved
          ? try await self.executor.confirm(confirmation)
          : try await self.executor.cancel(confirmation)
        guard !Task.isCancelled, self.activeExecution == execution else { return }
        self.apply(outcome, command: self.lastSubmittedCommand)
      } catch {
        guard !Task.isCancelled, self.activeExecution == execution else { return }
        self.state.fail("处理确认失败：\(error.localizedDescription)")
      }
      self.executionTask = nil
      self.activeExecution = nil
      if resetAfterAnswer {
        self.state.reset()
        return
      }
      if self.state.phase == .result { self.scheduleAutoReset() }
    }
  }

  private func apply(_ outcome: CommandOutcome, command: String) {
    // 三条分支而不是「成功 / 失败」两条：核心把「要人拍板」和「我不会做这件事」
    // 都当成正常结局回过来，把它们折进 failure 就等于告诉用户「出错了」。
    switch outcome.disposition {
    case .completed:
      state.complete(outcome.visualSummary)
    case .needsConfirmation:
      guard let confirmation = outcome.confirmation else {
        state.fail("核心要求确认，但没有给出可用的确认标识；这一步没有执行")
        return
      }
      state.beginConfirming(confirmation, action: command)
    case .unfinished:
      state.fail(outcome.visualSummary)
    }
    if voiceFeedbackEnabled, let spoken = outcome.spokenSummary {
      speaker.speak(spoken)
    }
  }

  private func stopActiveWork() {
    resetTask?.cancel()
    resetTask = nil
    pushHeld = false
    transcriber.cancel()
    speaker.stop()
    executionTask?.cancel()
    executionTask = nil
    activeExecution = nil
  }

  private func scheduleAutoReset() {
    resetTask?.cancel()
    resetTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 4_000_000_000)
      guard !Task.isCancelled, let self else { return }
      guard self.state.phase == .result || self.state.phase == .failure else { return }
      self.state.reset()
      self.onRequestHide?()
    }
  }
}
