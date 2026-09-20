import AVFoundation
import Foundation

final class AssistantSpeaker: NSObject, SpeechSpeaking, AVSpeechSynthesizerDelegate {
  var onSpeakingChanged: ((Bool) -> Void)?

  private let synthesizer = AVSpeechSynthesizer()
  private var pendingUtterances = 0

  override init() {
    super.init()
    synthesizer.delegate = self
  }

  func speak(_ text: String) {
    let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !clean.isEmpty else { return }
    let utterance = AVSpeechUtterance(string: clean)
    utterance.voice = AVSpeechSynthesisVoice(language: "zh-CN")
    utterance.rate = 0.48
    utterance.pitchMultiplier = 1.02
    pendingUtterances += 1
    onSpeakingChanged?(true)
    synthesizer.speak(utterance)
  }

  func stop() {
    pendingUtterances = 0
    synthesizer.stopSpeaking(at: .immediate)
    onSpeakingChanged?(false)
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    finishUtterance()
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    finishUtterance()
  }

  private func finishUtterance() {
    pendingUtterances = max(0, pendingUtterances - 1)
    if pendingUtterances == 0 { onSpeakingChanged?(false) }
  }
}
