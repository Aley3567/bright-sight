import AppKit
import Combine
import SwiftUI

final class VoicePanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}

@MainActor
final class VoicePanelController {
  /// 未 pin 且不在这些阶段时，切到别的 App 就隐藏自己——见 `handleAppActivation`。
  /// working/confirming：执行期间助手会主动激活目标 App（Chrome、备忘录），不排除就会自己把自己藏掉；
  /// result/failure：结果刚出来，用户切走一下（比如去看 Chrome 里新开的标签页）不该立刻收起面板。
  private nonisolated static let exemptFromAutoHide: Set<AssistantPhase> = [.working, .confirming, .result, .failure]

  private let model: AssistantController
  private let panel: VoicePanel
  private var cancellable: AnyCancellable?
  private var pinCancellable: AnyCancellable?
  private var activationObserver: NSObjectProtocol?
  /// 拖拽开始时的 panel 原点；DragGesture 的 translation 是相对手势起点的累计量，
  /// 不是逐帧增量，所以只需要在手势开始时记一次，后续每次都用它加 translation。
  private var dragOrigin: NSPoint?

  init(model: AssistantController) {
    self.model = model
    self.panel = VoicePanel(
      contentRect: NSRect(x: 0, y: 0, width: 444, height: 142),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )

    panel.level = .floating
    panel.isFloatingPanel = true
    panel.hidesOnDeactivate = false
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
    panel.contentViewController = NSHostingController(
      rootView: VoiceCapsuleView(
        model: model,
        onDragChanged: { [weak self] translation in self?.applyDrag(translation) },
        onDragEnded: { [weak self] in self?.dragOrigin = nil }
      )
    )

    model.onRequestHide = { [weak self] in self?.hide() }
    cancellable = model.$state
      .map(\.phase)
      .removeDuplicates()
      .sink { [weak self] phase in self?.resize(for: phase) }
    pinCancellable = model.$isPinned
      .removeDuplicates()
      .sink { [weak self] pinned in self?.applyPinned(pinned) }

    activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification,
      object: nil,
      queue: .main
    ) { [weak self] notification in
      // queue: .main 保证这个闭包确实在主线程跑，但编译器看不出来，用 assumeIsolated 而不是
      // 再包一层 Task { @MainActor in } ——避免多一次 run loop 调度，让隐藏时机更贴近激活事件本身。
      MainActor.assumeIsolated {
        self?.handleAppActivation(notification)
      }
    }
  }

  func show(preferTyping: Bool = false) {
    if preferTyping { model.showTyping() }
    positionAtTop()
    panel.orderFrontRegardless()
    if preferTyping { panel.makeKey() }
  }

  func hide() {
    panel.orderOut(nil)
  }

  func toggle() {
    panel.isVisible ? hide() : show()
  }

  // 拖动是临时的：拖完之后一次交互里 phase 会连续变化好几次（idle→authorizing→
  // listening→finalizing→working→result），如果这里也把面板摆回屏幕顶部居中，
  // 用户每说一句话面板就弹回去，等于拖了个寂寞。所以 resize 只做「顶边不动、改高度」，
  // 水平位置（拖拽改的那个量）原样保留；真正的「归位」只在 show() 里，对应「每次唤起都重新居中」
  // 而不是「拖动后还记得上次位置」的语义。
  private func resize(for phase: AssistantPhase) {
    let height: CGFloat
    switch phase {
    case .idle: height = 142
    case .authorizing, .finalizing, .working: height = 188
    case .listening: height = 204
    case .typing: height = 148
    case .confirming: height = 230
    case .result: height = 174
    case .failure: height = 194
    }

    var frame = panel.frame
    let top = frame.maxY
    frame.size.height = height
    frame.origin.y = top - height
    panel.setFrame(frame, display: true, animate: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion == false)
  }

  private func positionAtTop() {
    let screen = NSScreen.main ?? NSScreen.screens.first
    guard let visible = screen?.visibleFrame else { return }
    let frame = panel.frame
    let x = visible.midX - frame.width / 2
    let y = visible.maxY - frame.height - 14
    panel.setFrameOrigin(NSPoint(x: x.rounded(), y: y.rounded()))
  }

  private func applyDrag(_ translation: CGSize) {
    if dragOrigin == nil { dragOrigin = panel.frame.origin }
    guard let origin = dragOrigin else { return }
    // SwiftUI 的 y 轴向下为正，AppKit 的窗口坐标 y 轴向上为正，所以这里要反号。
    let point = NSPoint(x: origin.x + translation.width, y: origin.y - translation.height)
    panel.setFrameOrigin(point)
  }

  /// 未 pin 时保持原来的 .floating（跟其它悬浮工具窗同级）；
  /// pin 亮起后换成 .statusBar——比 .floating 高，配合已有的
  /// canJoinAllSpaces + fullScreenAuxiliary，才能在别的 App 切到全屏时也压得住。
  private func applyPinned(_ pinned: Bool) {
    panel.level = pinned ? .statusBar : .floating
  }

  private func handleAppActivation(_ notification: Notification) {
    let activatedIsSelf = (notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
      .map { $0.processIdentifier == ProcessInfo.processInfo.processIdentifier } ?? true
    guard Self.shouldHide(
      isPinned: model.isPinned,
      phase: model.state.phase,
      activatedIsSelf: activatedIsSelf
    ) else { return }
    hide()
  }

  /// 失焦隐藏的判定逻辑：不摸真实 NSWindow，纯函数，方便单测覆盖「pin 与阶段例外同时命中」这类分支。
  /// activatedIsSelf 读不到时按「是自己」处理——宁可这次该隐藏没隐藏，也不要把用户正在操作的面板藏起来。
  /// 标 nonisolated 是因为它不摸任何 @MainActor 状态，测试不必因此把自己也标成 @MainActor。
  nonisolated static func shouldHide(isPinned: Bool, phase: AssistantPhase, activatedIsSelf: Bool) -> Bool {
    if isPinned { return false }
    if activatedIsSelf { return false }
    if exemptFromAutoHide.contains(phase) { return false }
    return true
  }
}
