// Bright Sight 的 AX 靶场。
//
// 为什么需要它：AX 能力层的测试全跑在 `FakeAXStore` 上，那测的是**我们对 macOS 的假设**，
// 不是 macOS。真机验证需要一组形状已知的控件，好让「动作真的落到目标上了」这件事有可核对的
// 证据——拿备忘录或 TextEdit 当靶子的话，回读不到时分不清是我们没点中，还是那个应用的 AX 树
// 本来就不给读。
//
// 三种 operation 各一个靶子，对应 `AXActionSurface` 里三条互不相同的分派分支：
//   TYPE_TEXT → 可编辑文本区，走 `editable && editableRoles.contains(role)`
//   SELECT    → 菜单项，走 `role == kAXMenuItemRole`（唯一能产生 SELECT 的 role）
//   CLICK     → 按钮，走「系统声明了 AXPress」的兜底分支
//
// 每个靶子被动作之后都会把自己的状态**显示在界面上**，于是回读有两个独立来源：控件的
// AXValue，以及可见的标签文字。两个来源对不上时，说明我们对 AX 的理解有偏差，而不是
// 「动作成功了」——这正是这个靶场要暴露的东西。
//
// 全部按 `accessibilityIdentifier` 定位，不按位置。本仓已经因为「按位置定位」栽过四次
// （见 CLAUDE.md 第四节），靶场没有理由再犯：窗口一多、控件一改，位置就变了。

import AppKit

/// 靶子的状态。动作改的是这里，回读读的是这里在界面上的呈现——不是我们的动作记录。
final class PlaygroundState {
    static let shared = PlaygroundState()

    private(set) var buttonPressCount = 0
    private(set) var chosenMenuItems: [String] = []

    weak var statusLabel: NSTextField?
    weak var button: NSButton?

    func recordButtonPress() {
        buttonPressCount += 1
        refresh()
    }

    func recordMenuChoice(_ title: String) {
        chosenMenuItems.append(title)
        refresh()
    }

    /// 把状态推到界面上。动作之后由 `record*` 调，窗口建好时由 delegate 调一次
    /// ——初始状态也得显示出来，否则「回读」在第一次动作之前读到的是空字符串，
    /// 那会让「动作前 vs 动作后」的对照失去意义。
    func refresh() {
        let menu = chosenMenuItems.isEmpty ? "（还没选过）" : chosenMenuItems.joined(separator: " → ")
        statusLabel?.stringValue = "按钮按了 \(buttonPressCount) 次；菜单选过：\(menu)"
        // 按钮标题也动一下：同一个事实的第二处呈现，用来分辨「AXPress 发出去了」与
        // 「action 真的跑了」——只读到标题变化说明前者成立，两者都变才算后者也成立。
        button?.title = buttonPressCount == 0 ? "点我" : "已按 \(buttonPressCount) 次"
    }
}

final class PlaygroundDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    // MARK: - 菜单

    /// `SELECT` 只能由菜单项产生，所以靶场必须有真的菜单栏——这是它不能做成一个
    /// 无窗口小工具的原因。
    private func buildMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(
            withTitle: "退出靶场",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        appMenuItem.submenu = appMenu

        let playgroundMenuItem = NSMenuItem()
        let playgroundMenu = NSMenu(title: "靶场")
        for title in ["第一个靶子", "第二个靶子"] {
            let item = NSMenuItem(title: title, action: #selector(menuItemChosen(_:)), keyEquivalent: "")
            item.target = self
            // 与控件用同一套 identifier 前缀，回读时一眼能看出这是靶场自己的东西。
            item.setAccessibilityIdentifier("brightsight.playground.menuitem.\(title)")
            playgroundMenu.addItem(item)
        }
        playgroundMenuItem.submenu = playgroundMenu

        mainMenu.addItem(appMenuItem)
        mainMenu.addItem(playgroundMenuItem)
        NSApp.mainMenu = mainMenu
    }

    @objc private func menuItemChosen(_ sender: NSMenuItem) {
        PlaygroundState.shared.recordMenuChoice(sender.title)
    }

    // MARK: - 窗口

    private func buildWindow() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 320),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Bright Sight AX 靶场"
        window.setAccessibilityIdentifier("brightsight.playground.window")

        let editor = NSTextView()
        editor.isEditable = true
        editor.isRichText = false
        editor.string = "把这段文字整体替换掉"
        editor.setAccessibilityIdentifier("brightsight.playground.editor")

        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.documentView = editor
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.heightAnchor.constraint(equalToConstant: 140).isActive = true

        let button = NSButton(
            title: "点我",
            target: self,
            action: #selector(buttonPressed(_:))
        )
        button.bezelStyle = .rounded
        button.setAccessibilityIdentifier("brightsight.playground.button")

        let label = NSTextField(labelWithString: "")
        label.setAccessibilityIdentifier("brightsight.playground.label")
        label.lineBreakMode = .byTruncatingTail

        let stack = NSStackView(views: [scroll, button, label])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        stack.translatesAutoresizingMaskIntoConstraints = false

        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            scroll.leadingAnchor.constraint(equalTo: stack.leadingAnchor, constant: 16),
            scroll.trailingAnchor.constraint(equalTo: stack.trailingAnchor, constant: -16),
        ])

        window.contentView = content

        PlaygroundState.shared.statusLabel = label
        PlaygroundState.shared.button = button
        PlaygroundState.shared.refresh()

        // 刻意不 center()：屏幕正中常常是别人正在干活的地方，而这个靶场会被自动化反复
        // 触碰，盖住正中等于把那些点击引到自己身上。实测过一次：窗口居中时，后台一个
        // 持续合成鼠标点击的程序每秒往按钮上打两三次，计数在几秒内就跳到了两位数，
        // 而窗口挪到角落之后是 0。放在可见区左上角，位置在每台机器上都可预测。
        if let visible = NSScreen.main?.visibleFrame {
            let size = window.frame.size
            window.setFrameOrigin(NSPoint(
                x: visible.minX + 80,
                y: visible.maxY - size.height - 80
            ))
        }
        window.makeKeyAndOrderFront(nil)
        self.window = window
    }

    @objc private func buttonPressed(_ sender: NSButton) {
        PlaygroundState.shared.recordButtonPress()
    }
}

// 靶场是验收工具，不是产品的一部分：它不进 .app，也不进 dmg。
// 用法：swift run --package-path apps/macos AXPlayground
let application = NSApplication.shared
let delegate = PlaygroundDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
