import AppKit
import SwiftUI

@main
struct BrightSightVoiceApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

  var body: some Scene {
    Settings { EmptyView() }
  }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem!
  private var model: AssistantController!
  private var panelController: VoicePanelController!
  private var commandMonitor: RightCommandMonitor!
  private var executor: CoreCommandExecutor!

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)

    // 执行器现在带着一个长驻的 Node 进程，要活得和 App 一样久：
    // 每条指令重建一次，等于把「连续两条指令复用同一个核心」这件事又丢掉
    executor = CoreCommandExecutor()
    model = AssistantController(
      transcriber: AppleSpeechTranscriber(),
      speaker: AssistantSpeaker(),
      executor: executor
    )
    panelController = VoicePanelController(model: model)
    configureStatusItem()

    commandMonitor = RightCommandMonitor { [weak self] pressed in
      guard let self else { return }
      if pressed {
        self.panelController.show()
        self.model.beginVoice()
      } else {
        self.model.endVoice()
      }
    }
    _ = commandMonitor.start(promptForPermission: false)
    // 首次运行几乎一定还没授权，这里就开始等：用户去系统设置打开开关、切回 App，
    // 右 Command 当场可用。菜单标题每次右键都会重建，所以它会自己变成「已允许」。
    commandMonitor.startWatchingForTrust()

    panelController.show()
  }

  func applicationWillTerminate(_ notification: Notification) {
    commandMonitor.stop()
    model.close()
    // 不关的话核心会多活一会儿：它靠 stdin 的 EOF 才知道该收摊，而那要等内核回收 fd
    executor.shutdown()
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    panelController.show()
    return true
  }

  private func configureStatusItem() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    guard let button = statusItem.button else { return }
    button.image = NSImage(systemSymbolName: "circle.hexagongrid.fill", accessibilityDescription: "Bright Sight")
    button.image?.isTemplate = true
    button.imagePosition = .imageLeft
    button.title = " BS"
    button.font = .systemFont(ofSize: NSFont.systemFontSize, weight: .semibold)
    button.target = self
    button.action = #selector(statusItemClicked(_:))
    button.sendAction(on: [.leftMouseUp, .rightMouseUp])
    button.toolTip = "Bright Sight"
  }

  @objc private func statusItemClicked(_ sender: Any?) {
    guard let event = NSApp.currentEvent else {
      panelController.toggle()
      return
    }
    if event.type == .rightMouseUp, let button = statusItem.button {
      NSMenu.popUpContextMenu(contextMenu(), with: event, for: button)
    } else {
      panelController.toggle()
    }
  }

  private func contextMenu() -> NSMenu {
    let menu = NSMenu()
    let speak = NSMenuItem(title: "开始说话", action: #selector(startSpeaking), keyEquivalent: "")
    speak.target = self
    menu.addItem(speak)

    let type = NSMenuItem(title: "输入文字…", action: #selector(startTyping), keyEquivalent: "")
    type.target = self
    menu.addItem(type)

    let feedback = NSMenuItem(
      title: model.voiceFeedbackEnabled ? "关闭语音反馈" : "开启语音反馈",
      action: #selector(toggleVoiceFeedback),
      keyEquivalent: ""
    )
    feedback.target = self
    menu.addItem(feedback)

    let accessibility = NSMenuItem(
      title: commandMonitor.isTrusted ? "辅助功能：已允许" : "允许右 Command 快捷键…",
      action: commandMonitor.isTrusted ? nil : #selector(requestAccessibilityPermission),
      keyEquivalent: ""
    )
    accessibility.target = self
    menu.addItem(accessibility)

    menu.addItem(.separator())
    let quit = NSMenuItem(title: "退出 Bright Sight", action: #selector(quitApp), keyEquivalent: "q")
    quit.target = self
    menu.addItem(quit)
    return menu
  }

  @objc private func startSpeaking() {
    panelController.show()
    model.beginVoice()
  }

  @objc private func startTyping() {
    panelController.show(preferTyping: true)
  }

  @objc private func toggleVoiceFeedback() {
    model.toggleVoiceFeedback()
  }

  @objc private func requestAccessibilityPermission() {
    _ = commandMonitor.requestPermission()
    // 弹窗只是把用户送到系统设置。真正要等的是他打开开关那一下，所以这里也要开始轮询
    // ——不重复调用的话，用户从「从来没授权过」这条路走进来就永远不会被重装。
    commandMonitor.startWatchingForTrust()
  }

  @objc private func quitApp() {
    NSApp.terminate(nil)
  }
}
