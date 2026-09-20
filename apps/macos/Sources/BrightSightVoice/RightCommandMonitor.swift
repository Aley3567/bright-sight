import AppKit
import ApplicationServices
import Foundation

final class RightCommandMonitor {
  private let keyCode: UInt16 = 54
  private var globalMonitor: Any?
  private var localMonitor: Any?
  private var isPressed = false
  private let onChange: (Bool) -> Void

  init(onChange: @escaping (Bool) -> Void) {
    self.onChange = onChange
  }

  @discardableResult
  func start(promptForPermission: Bool = false) -> Bool {
    stop()

    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: promptForPermission] as CFDictionary
    let trusted = AXIsProcessTrustedWithOptions(options)

    globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
      self?.consume(event)
    }
    localMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
      self?.consume(event)
      return event
    }
    return trusted
  }

  var isTrusted: Bool {
    AXIsProcessTrusted()
  }

  @discardableResult
  func requestPermission() -> Bool {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
  }

  func stop() {
    if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
    if let localMonitor { NSEvent.removeMonitor(localMonitor) }
    globalMonitor = nil
    localMonitor = nil
    isPressed = false
  }

  private func consume(_ event: NSEvent) {
    guard event.keyCode == keyCode else { return }
    let pressed = event.modifierFlags.intersection(.deviceIndependentFlagsMask).contains(.command)
    guard pressed != isPressed else { return }
    isPressed = pressed
    DispatchQueue.main.async { [onChange] in onChange(pressed) }
  }

  deinit { stop() }
}
