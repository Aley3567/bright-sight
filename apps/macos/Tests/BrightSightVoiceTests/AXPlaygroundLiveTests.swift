import AppKit
import ApplicationServices
import XCTest
@testable import BrightSightVoice

/// 让 AX 动作第一次真的落到一个真实应用上，并核对动作之后的回读。
///
/// 在此之前 `ax.perform` **一次都没有在真机上跑过**——阶段 4 / 5 拿到的真机证据全是**观察**。
/// 观察与执行都不是一回事：观察只读，执行会改对面的状态，而这条路上的每个假设
/// （`AXValue` 写得进去、`AXPress` 真的会触发 action、菜单项的 press 语义）都还没有被
/// macOS 确认过。本仓已经被真机打脸三次，全都发生在「测试全绿但假设错了」的地方。
///
/// 靶子是 `Sources/AXPlayground`：形状已知，动作之后把状态**显示在界面上**，所以回读有两个
/// 独立来源（控件的属性，以及可见文字）。不拿备忘录或 TextEdit 当靶子的理由很实际——
/// 回读不到的时候要能分清是「我们没点中」还是「那个应用的 AX 树本来就不给读」，
/// 而拿真实应用当靶子，这两种情况长得一模一样。
///
/// 靶子不在 `ALLOWED_APPS` 里，所以这条测试**绕过了 policy**，直接调 `AXRuntime`。
/// 这是故意的：这里验的是能力层能不能动手，不是决策层放不放行——两者失败的原因完全不同，
/// 混在一条测试里会让任何一次失败都要重新分辨是哪一层坏了。端到端另走一条路。
final class AXPlaygroundLiveTests: XCTestCase {
  private var playground: Process?
  private var playgroundPID: pid_t = 0

  /// 观察与执行必须走**同一个** runtime 实例。
  ///
  /// 这一条是被真机教出来的：最初 `observe` 和 `perform` 各自 `AXRuntime(...)` 了一个新实例，
  /// 于是每一次 perform 都返回 `rejected_stale`——frame 存在实例里，另一个实例压根不认识
  /// 那个 frameId。这不是缺陷，是 freshness guard 在正确工作，而测试把「同一个会话」这件事
  /// 拆成了两半。生产上本来就是一个长驻 runtime，这里照做才测的是真东西。
  private var runtime: AXRuntime!

  override func setUpWithError() throws {
    try super.setUpWithError()
    guard ProcessInfo.processInfo.environment["BRIGHTSIGHT_LIVE"] == "1" else {
      throw XCTSkip("设 BRIGHTSIGHT_LIVE=1 才跑真实 AX 调用")
    }
    guard AXIsProcessTrusted() else {
      throw XCTSkip("当前测试宿主没有 Accessibility 权限")
    }
    runtime = makeRuntime()
    try startPlayground()
  }

  override func tearDownWithError() throws {
    // 只关自己拉起的那一个。靶场里没有任何要保存的东西，但「只碰自己造出来的东西」
    // 是本仓的硬约束——测试尤其容易在这里越界。
    if let playground, playground.isRunning {
      playground.terminate()
      playground.waitUntilExit()
    }
    playground = nil
    try super.tearDownWithError()
  }

  func testTypeTextReplacesTheEditorContent() async throws {
    let before = try await observeEditor()
    let target = try offer(in: before, role: "AXTextArea")
    let replacement = "被 AX 换掉的一段字 \(UUID().uuidString.prefix(8))"

    let result = try await perform(
      frame: before, offerID: target.id, operation: "TYPE_TEXT", value: replacement
    )
    XCTAssertEqual(result.status, "executed", "TYPE_TEXT 没有执行：\(result.error ?? "无错误信息")")

    // 回读必须重来一次观察，不能复用执行前的那一帧：`offerId` 只在它所属的 frame 里有效，
    // 拿旧帧的 id 去核对等于自己跟自己说话。
    let after = try await observeEditor()
    let editors = after.offers.filter { $0.target.role == "AXTextArea" }.map(\.target.label)
    XCTAssertEqual(
      editors, [replacement],
      "文本区的 AXValue 没有变成我们写进去的值——动作报 executed 不代表字真的进去了。这一帧的文本区有：\(editors)"
    )
    // 阳性对照：如果执行前就已经是那个值，上面那条断言恒真，这条测试什么都没证明。
    XCTAssertNotEqual(
      before.offers.first(where: { $0.id == target.id })?.target.label, replacement,
      "执行前就已经是目标值了，这条测试没能证明任何事"
    )
  }

  func testClickPressesTheButtonAndItsTitleChanges() async throws {
    let before = try await observeEditor()
    let (target, initialPresses) = try playgroundButton(in: before)

    let result = try await perform(frame: before, offerID: target.id, operation: "CLICK")
    XCTAssertEqual(result.status, "executed", "CLICK 没有执行：\(result.error ?? "无错误信息")")

    // 按钮标题会被靶场的 action 改掉，而 action 只在 AXPress 真的送达之后才跑。
    // 所以标题变了同时证明了两件事：AXPress 发出去了，且对面的 action 真的执行了。
    // 只读到「动作面里按钮还在」是不够的——那个在没点中的情况下也成立。
    //
    // 断言「比动作前多了一次」而不是「恰好 1 次」：靶场窗口就摆在这台机器的桌面上，
    // 人手随时可能点到那个按钮。钉死绝对数字会让这条测试在「有人碰了一下」时红，
    // 而那不是缺陷；相对断言测的才是我们真的发出了这一次 AXPress。
    let after = try await observeEditor()
    let titles = after.offers.filter { $0.target.role == "AXButton" }.map(\.target.label)
    XCTAssertTrue(
      titles.contains("已按 \(initialPresses + 1) 次"),
      "点击没有让计数从 \(initialPresses) 变成 \(initialPresses + 1)。这一帧的按钮有：\(titles.joined(separator: "、"))"
    )
  }

  func testMenuSelectionReachesTheItem() async throws {
    // 菜单栏不在窗口里，所以这一条必须用 application 范围观察——focusedWindow 永远看不到它。
    let before = try await observeApplication()
    let target = try offer(in: before, role: "AXMenuItem", label: "第一个靶子")

    let result = try await perform(frame: before, offerID: target.id, operation: "SELECT")
    XCTAssertEqual(result.status, "executed", "SELECT 没有执行：\(result.error ?? "无错误信息")")

    // 菜单项自己的状态不会变，变的是它触发的那段代码写下的东西——所以回读去找状态标签。
    // 同样不按 role 取第一个：菜单栏本身就有若干 `AXStaticText`，而它们都不带我们写的那句话。
    let after = try await observeApplication()
    let texts = after.offers.filter { $0.target.role == "AXStaticText" }.map(\.target.label)
    XCTAssertTrue(
      texts.contains(where: { $0.contains("第一个靶子") }),
      "菜单项触发的 action 没有留下痕迹，没人在说「第一个靶子」。这一帧的静态文字有：\(texts.joined(separator: "、"))"
    )
  }

  // ── 靶场 ────────────────────────────────────────────────────────────────────

  private var packageRoot: URL {
    // #filePath 指到这个文件本身：<repo>/apps/macos/Tests/BrightSightVoiceTests/<本文件>
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
  }

  private func startPlayground() throws {
    // swift test 与 swift build 共用同一个 .build，测试跑起来时靶场一定已经编译好了
    // （Package.swift 把它列为同一个包里的可执行产物）。
    let candidates = ["debug", "release"].map {
      packageRoot.appendingPathComponent(".build/\($0)/AXPlayground")
    }
    guard let binary = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0.path) }) else {
      throw XCTSkip("没找到 AXPlayground 可执行文件，先跑一次 swift build")
    }

    let process = Process()
    process.executableURL = binary
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    playground = process
    playgroundPID = process.processIdentifier

    // 观察一律带上 pid，所以**不要求靶场成为前台应用**。这条是被真机教出来的：最初这里
    // 等的是「靶场成为 frontmost」，而从终端跑 swift test 时永远等不到——抢回焦点的是终端
    // 自己，而观察是跟着前台走的，于是量到的是终端窗口，三个动作全部 `rejected_stale`。
    // 靶场不需要在前台，它只需要活着、窗口还在。
    let deadline = Date().addingTimeInterval(10)
    while Date() < deadline {
      if !process.isRunning {
        XCTFail("靶场启动后立刻退出了")
        return
      }
      if windowExists() {
        try awaitSettled()
        return
      }
      Thread.sleep(forTimeInterval: 0.1)
    }
    XCTFail("靶场启动后 10 秒内没有建出窗口")
  }

  /// 靶场的窗口在不在。直接问 AX，而不是问 `NSWorkspace` 的前台是谁——后者在测试宿主里
  /// 不可靠（见上），而且「窗口存在」才是后面的观察真正依赖的前提。
  private func windowExists() -> Bool {
    let app = AXUIElementCreateApplication(playgroundPID)
    var windows: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windows) == .success,
          let list = windows as? [AXUIElement]
    else { return false }
    return !list.isEmpty
  }

  private func awaitSettled() throws {
    Thread.sleep(forTimeInterval: 0.5)
  }

  // ── 观察与执行 ──────────────────────────────────────────────────────────────

  private func makeRuntime() -> AXRuntime {
    // 预算给得比生产宽：这一条测的是「动作能不能成立」，不是「生产预算够不够看」。
    // 预算不足会让观察截断，而截断会把「目标不在这一页」伪装成「动作失败」。
    AXRuntime(budget: AXTraversalBudget(maxDepth: 12, maxNodes: 2_000, maxMilliseconds: 2_000, pageSize: 200))
  }

  /// 靶场不是前台应用（见 `startPlayground`），所以两条观察都走 `application` 范围并显式带上
  /// pid。`focusedWindow` 依赖那个进程持有 key window，在测试宿主里拿不到，用它只会得到
  /// 「目标不在这一页」这种看起来像缺陷、实际是取景取错了的失败。
  private func observeEditor() async throws -> ObservedFrame {
    try await observe(scope: "application", pid: playgroundPID)
  }

  private func observeApplication() async throws -> ObservedFrame {
    try await observe(scope: "application", pid: playgroundPID)
  }

  private func observe(scope: String, pid: pid_t) async throws -> ObservedFrame {
    let raw = try await call { completion in
      runtime.observe(params: .object([
        "scope": .string(scope),
        "pid": .number(Double(pid)),
        "pageSize": .number(200),
      ]), completion: completion)
    }
    guard let frameID = raw["frameId"]?.stringValue,
          let offers = raw["offers"]?.arrayValue
    else {
      throw XCTSkip("观察没有返回 frameId / offers：\(raw)")
    }
    let parsed = try offers.map { try AxOfferSnapshot(json: $0) }
    return ObservedFrame(frameID: frameID, offers: parsed)
  }

  private func perform(
    frame: ObservedFrame,
    offerID: String,
    operation: String,
    value: String? = nil
  ) async throws -> (status: String?, error: String?) {
    var params: [String: JSONValue] = [
      "frameId": .string(frame.frameID),
      "offerId": .string(offerID),
      "operation": .string(operation),
    ]
    if let value { params["value"] = .string(value) }

    let raw = try await call { completion in
      runtime.perform(params: .object(params), completion: completion)
    }
    return (raw["status"]?.stringValue, raw["error"]?.stringValue)
  }

  private func offer(
    in frame: ObservedFrame,
    role: String,
    label: String? = nil
  ) throws -> AxOfferSnapshot {
    let matches = frame.offers.filter {
      $0.target.role == role && (label == nil || $0.target.label == label)
    }
    guard let first = matches.first else {
      // 找不到时把这一帧实际有什么打出来。「找不到目标」这种失败如果不带现场，
      // 下一个人只能靠猜——而这个仓库的规则是看不懂的数字不能当成通过。
      let seen = frame.offers.map { "\($0.target.role)「\($0.target.label)」" }.joined(separator: "、")
      throw XCTSkip("这一帧里没有 \(role)\(label.map { "「\($0)」" } ?? "")。实际有：\(seen)")
    }
    return first
  }

  /// 按标题的**形状**找靶场按钮，连它当前被按了多少次一起返回。
  ///
  /// 不按 role 取第一个：窗口的关闭键、最小化键、缩放键也是 `AXButton`，而且在真实桌面上
  /// 排得比我们的按钮还靠前。取第一个多半取到它们，然后这条测试在「点错了东西」时依然绿。
  private func playgroundButton(in frame: ObservedFrame) throws -> (AxOfferSnapshot, Int) {
    for candidate in frame.offers where candidate.target.role == "AXButton" {
      if let count = pressCount(from: candidate.target.label) {
        return (candidate, count)
      }
    }
    let seen = frame.offers.filter { $0.target.role == "AXButton" }.map(\.target.label)
    throw XCTSkip("这一帧里没有靶场按钮（标题形如「点我」或「已按 N 次」）。AXButton 有：\(seen.joined(separator: "、"))")
  }

  /// 靶场按钮的标题只有这两种形状。`点我` 是零次，之后是 `已按 N 次`。
  private func pressCount(from title: String) -> Int? {
    if title == "点我" { return 0 }
    guard title.hasPrefix("已按 "), title.hasSuffix(" 次") else { return nil }
    return Int(title.dropFirst("已按 ".count).dropLast(" 次".count))
  }

  private func call(
    _ start: (@escaping AXRuntime.Completion) -> Void
  ) async throws -> JSONValue {
    try await withCheckedThrowingContinuation { continuation in
      start { continuation.resume(with: $0.mapError { $0 as Error }) }
    }
  }
}

private struct ObservedFrame {
  let frameID: String
  let offers: [AxOfferSnapshot]
}

/// 只取这条测试要用的字段。刻意不复用生产侧的解析：那一份的职责是**校验**对端有没有
/// 越界，越界就报错；测试这里要的是「尽量把拿到的东西描述出来」，两者对残缺数据的
/// 态度正好相反，合并只会让两边都别扭。
private struct AxOfferSnapshot {
  struct Target {
    let role: String
    let label: String
  }

  let id: String
  let target: Target

  init(json: JSONValue) throws {
    guard let fields = json.objectValue,
          let id = fields["id"]?.stringValue,
          let target = fields["target"]?.objectValue,
          let role = target["role"]?.stringValue
    else {
      throw XCTSkip("offer 形状不认识：\(json)")
    }
    self.id = id
    self.target = Target(role: role, label: target["label"]?.stringValue ?? "")
  }
}
