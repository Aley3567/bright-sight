import AVFoundation
import Foundation
import Speech

final class AppleSpeechTranscriber: SpeechTranscribing {
  let displayName = "Apple Speech（中文基线）"

  private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
  private let audioEngine = AVAudioEngine()
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var activeToken: UUID?
  private var tapInstalled = false
  private var isStopping = false
  private var stopWhenReady = false
  private var lastTranscript = ""
  private var lastLevelAt = Date.distantPast

  private var onReady: (() -> Void)?
  private var onPartial: ((String) -> Void)?
  private var onLevel: ((Float) -> Void)?
  private var onFinal: ((String) -> Void)?
  private var onFailure: ((String) -> Void)?

  func start(
    hotwords: [String],
    onReady: @escaping () -> Void,
    onPartial: @escaping (String) -> Void,
    onLevel: @escaping (Float) -> Void,
    onFinal: @escaping (String) -> Void,
    onFailure: @escaping (String) -> Void
  ) {
    cancel()

    let token = UUID()
    activeToken = token
    self.onReady = onReady
    self.onPartial = onPartial
    self.onLevel = onLevel
    self.onFinal = onFinal
    self.onFailure = onFailure
    stopWhenReady = false
    isStopping = false
    lastTranscript = ""

    requestPermissions { [weak self] granted, message in
      guard let self, self.activeToken == token else { return }
      guard granted else {
        self.fail(message ?? "需要麦克风与语音识别权限")
        return
      }
      self.startEngine(hotwords: hotwords, token: token)
    }
  }

  func stop() {
    guard activeToken != nil else { return }
    guard audioEngine.isRunning else {
      stopWhenReady = true
      return
    }

    isStopping = true
    audioEngine.stop()
    removeTapIfNeeded()
    recognitionRequest?.endAudio()

    let token = activeToken
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { [weak self] in
      guard let self, self.activeToken == token, self.isStopping else { return }
      if self.lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        self.fail("没有听清，请再说一次")
      } else {
        self.finish(self.lastTranscript)
      }
    }
  }

  func cancel() {
    activeToken = nil
    stopWhenReady = false
    isStopping = false
    if audioEngine.isRunning { audioEngine.stop() }
    removeTapIfNeeded()
    recognitionRequest?.endAudio()
    recognitionTask?.cancel()
    recognitionTask = nil
    recognitionRequest = nil
    clearCallbacks()
  }

  private func requestPermissions(completion: @escaping (Bool, String?) -> Void) {
    SFSpeechRecognizer.requestAuthorization { speechStatus in
      AVCaptureDevice.requestAccess(for: .audio) { microphoneGranted in
        DispatchQueue.main.async {
          guard speechStatus == .authorized else {
            completion(false, "请在系统设置中允许语音识别")
            return
          }
          guard microphoneGranted else {
            completion(false, "请在系统设置中允许麦克风访问")
            return
          }
          completion(true, nil)
        }
      }
    }
  }

  private func startEngine(hotwords: [String], token: UUID) {
    guard activeToken == token else { return }
    guard let recognizer, recognizer.isAvailable else {
      fail("中文语音识别当前不可用")
      return
    }

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.taskHint = .dictation
    request.contextualStrings = hotwords
    if #available(macOS 13.0, *) { request.addsPunctuation = true }
    recognitionRequest = request

    let input = audioEngine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      fail("没有可用的麦克风输入")
      return
    }

    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      request.append(buffer)
      guard let self else { return }
      let now = Date()
      guard now.timeIntervalSince(self.lastLevelAt) >= 0.05 else { return }
      self.lastLevelAt = now
      let level = Self.normalizedLevel(buffer)
      DispatchQueue.main.async { [weak self] in self?.onLevel?(level) }
    }
    tapInstalled = true

    recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
      DispatchQueue.main.async {
        guard let self, self.activeToken == token else { return }
        if let result {
          let text = result.bestTranscription.formattedString
          self.lastTranscript = text
          self.onPartial?(text)
          if result.isFinal {
            self.finish(text)
            return
          }
        }
        if let error {
          if self.isStopping, !self.lastTranscript.isEmpty {
            self.finish(self.lastTranscript)
          } else {
            self.fail("转录失败：\(error.localizedDescription)")
          }
        }
      }
    }

    do {
      audioEngine.prepare()
      try audioEngine.start()
      onReady?()
      if stopWhenReady { stop() }
    } catch {
      fail("麦克风启动失败：\(error.localizedDescription)")
    }
  }

  private func finish(_ text: String) {
    let callback = onFinal
    tearDown()
    callback?(text.trimmingCharacters(in: .whitespacesAndNewlines))
  }

  private func fail(_ message: String) {
    let callback = onFailure
    tearDown()
    callback?(message)
  }

  private func tearDown() {
    activeToken = nil
    stopWhenReady = false
    isStopping = false
    if audioEngine.isRunning { audioEngine.stop() }
    removeTapIfNeeded()
    recognitionRequest?.endAudio()
    recognitionTask?.cancel()
    recognitionTask = nil
    recognitionRequest = nil
    clearCallbacks()
  }

  private func removeTapIfNeeded() {
    guard tapInstalled else { return }
    audioEngine.inputNode.removeTap(onBus: 0)
    tapInstalled = false
  }

  private func clearCallbacks() {
    onReady = nil
    onPartial = nil
    onLevel = nil
    onFinal = nil
    onFailure = nil
  }

  private static func normalizedLevel(_ buffer: AVAudioPCMBuffer) -> Float {
    guard let channel = buffer.floatChannelData?[0] else { return 0 }
    let count = Int(buffer.frameLength)
    guard count > 0 else { return 0 }
    var sum: Float = 0
    for index in 0..<count {
      let sample = channel[index]
      sum += sample * sample
    }
    let rms = sqrt(sum / Float(count))
    return min(max(rms * 9, 0.04), 1)
  }
}
