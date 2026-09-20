import AppKit
import ApplicationServices
import Foundation

final class RightCommandMonitor {
  private let keyCode: UInt16 = 54
  private var globalMonitor: Any?
  private var localMonitor: Any?
  private var isPressed = false
  private var permissionWatch: Timer?
  private let onChange: (Bool) -> Void

  /// 权限查询与授权弹窗做成参数，是为了让「运行期授权之后监听要重装」这条逻辑能被测。
  /// 直接调 `AXIsProcessTrusted()` 的话，那条路径只有在真的去系统设置点开关时才走得到，
  /// 而那是本仓明确不指望自动化覆盖的部分——于是它就成了永远没人验的一行。
  private let trustCheck: () -> Bool
  private let promptForTrust: (Bool) -> Bool

  init(
    onChange: @escaping (Bool) -> Void,
    trustCheck: @escaping () -> Bool = { AXIsProcessTrusted() },
    promptForTrust: @escaping (Bool) -> Bool = { prompt in
      let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
      return AXIsProcessTrustedWithOptions(options)
    }
  ) {
    self.onChange = onChange
    self.trustCheck = trustCheck
    self.promptForTrust = promptForTrust
  }

  @discardableResult
  func start(promptForPermission: Bool = false) -> Bool {
    stop()

    let trusted = promptForTrust(promptForPermission)

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
    trustCheck()
  }

  /// 权限还没到手时反复重试，到手了就重新 start 一次。
  ///
  /// 为什么不能只「检测到权限变了」就完事：`AXIsProcessTrusted()` 每次调用都是实时的，
  /// 进程内没有缓存，所以检测本身不费事。麻烦在别处——**全局事件监听是在没有权限时注册的，
  /// 那次注册静默失败，权限到手之后旧监听不会自己活过来**。必须重走一遍 start。
  /// README 里那句「授权后请重启应用」就是这件事的用户可见形态。
  ///
  /// 用轮询而不是监听系统设置变化：TCC 没有对外的变更通知，轮询是唯一稳的做法。
  /// 一秒一次 `AXIsProcessTrusted()` 是一次廉价系统调用，而且授权到位后立刻就停。
  func startWatchingForTrust(interval: TimeInterval = 1) {
    guard permissionWatch == nil, !isTrusted else { return }
    let timer = Timer(timeInterval: interval, repeats: true) { [weak self] timer in
      guard let self, self.isTrusted else { return }
      timer.invalidate()
      self.permissionWatch = nil
      self.start(promptForPermission: false)
    }
    // 加进 common mode：default mode 在菜单追踪和拖拽期间是停的，而「刚点完菜单里的
    // 授权项」恰恰是这个 Timer 最该醒着的时候。
    RunLoop.main.add(timer, forMode: .common)
    permissionWatch = timer
  }

  @discardableResult
  func requestPermission() -> Bool {
    promptForTrust(true)
  }

  func stop() {
    permissionWatch?.invalidate()
    permissionWatch = nil
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
