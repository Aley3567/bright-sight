import Foundation

protocol SpeechTranscribing: AnyObject {
  var displayName: String { get }

  func start(
    hotwords: [String],
    onReady: @escaping () -> Void,
    onPartial: @escaping (String) -> Void,
    onLevel: @escaping (Float) -> Void,
    onFinal: @escaping (String) -> Void,
    onFailure: @escaping (String) -> Void
  )

  func stop()
  func cancel()
}

protocol SpeechSpeaking: AnyObject {
  var onSpeakingChanged: ((Bool) -> Void)? { get set }

  func speak(_ text: String)
  func stop()
}
