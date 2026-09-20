import AppKit
import XCTest
@testable import BrightSightVoice

final class AXRuntimeLiveTests: XCTestCase {
  func testObserveFinderWithoutPerformingAnAction() async throws {
    guard ProcessInfo.processInfo.environment["BRIGHTSIGHT_LIVE"] == "1" else {
      throw XCTSkip("设 BRIGHTSIGHT_LIVE=1 才跑真实 AX 调用")
    }
    guard AXIsProcessTrusted() else {
      throw XCTSkip("当前测试宿主没有 Accessibility 权限")
    }

    guard let processID = NSWorkspace.shared.runningApplications.first(where: {
      $0.bundleIdentifier == "com.apple.finder"
    })?.processIdentifier
    else {
      throw XCTSkip("Finder 当前没有运行")
    }

    let runtime = AXRuntime(
      budget: AXTraversalBudget(maxDepth: 6, maxNodes: 300, maxMilliseconds: 1_000, pageSize: 100)
    )
    let observed = try await call { completion in
      runtime.observe(params: .object([
        "scope": .string("application"),
        "pid": .number(Double(processID)),
        "pageSize": .number(100),
      ]), completion: completion)
    }
    XCTAssertNotNil(observed["frameId"]?.stringValue)
    XCTAssertEqual(observed["pid"]?.intValue, Int(processID))
    XCTAssertNotNil(observed["offers"]?.arrayValue)
    XCTAssertNotNil(observed["page"]?.objectValue)
  }

  /// 真机上量一次「同名目标到底被分开了多少」。
  ///
  /// 这条测的不是某个函数的返回值，而是**这套做法在真实界面上还成不成立**。单元测试里的
  /// 树是我们自己造的，造的时候就已经假设了「祖先节点带着能区分的文字」——那正是需要被
  /// 真机推翻的假设。上一轮那个 `-25200` 就是这么漏过去的：115 个测试全绿，测的全是我们
  /// 对 macOS 的想象。
  ///
  /// 断言刻意只钉「不倒退」：具体分开几组取决于当时前台开着什么，钉死数字会让这条测试
  /// 变成一个随桌面状态随机红的噪声源。真正的信息在打印出来的那几行里。
  func testDisambiguationContextSeparatesDuplicateLabelsOnTheFrontmostApp() async throws {
    guard ProcessInfo.processInfo.environment["BRIGHTSIGHT_LIVE"] == "1" else {
      throw XCTSkip("设 BRIGHTSIGHT_LIVE=1 才跑真实 AX 调用")
    }
    guard AXIsProcessTrusted() else {
      throw XCTSkip("当前测试宿主没有 Accessibility 权限")
    }
    guard let front = NSWorkspace.shared.frontmostApplication else {
      throw XCTSkip("取不到前台应用")
    }

    let runtime = AXRuntime(
      budget: AXTraversalBudget(maxDepth: 6, maxNodes: 500, maxMilliseconds: 1_000, pageSize: 200)
    )
    let observed = try await call { completion in
      runtime.observe(params: .object([
        "scope": .string("focusedWindow"),
        "pid": .number(Double(front.processIdentifier)),
        "pageSize": .number(200),
      ]), completion: completion)
    }
    guard let offers = observed["offers"]?.arrayValue, !offers.isEmpty else {
      throw XCTSkip("\(front.localizedName ?? "前台应用") 的焦点窗口里没有可动作元素")
    }

    struct Seen { let label: String; let operation: String; let context: String? }
    let seen: [Seen] = offers.compactMap { offer in
      guard let target = offer["target"]?.objectValue,
            let label = target["label"]?.stringValue,
            let operation = offer["operation"]?.stringValue
      else { return nil }
      return Seen(label: label, operation: operation, context: target["context"]?.stringValue)
    }

    var groups: [String: [Seen]] = [:]
    for item in seen { groups["\(item.operation)\u{1f}\(item.label)", default: []].append(item) }
    let duplicates = groups.filter { $0.value.count > 1 }

    print("── 真机消歧：\(front.localizedName ?? "?")，\(offers.count) 个可动作元素，\(duplicates.count) 组同名 ──")
    var separated = 0
    for (key, items) in duplicates.sorted(by: { $0.value.count > $1.value.count }) {
      let label = key.split(separator: "\u{1f}").last.map(String.init) ?? key
      let contexts = items.compactMap(\.context)
      let distinct = Set(contexts).count
      let ok = contexts.count == items.count && distinct == items.count
      if ok { separated += 1 }
      print("  \(ok ? "分开" : "未分") 「\(label)」×\(items.count) → \(distinct) 个不同上下文")
      if ok {
        if let sample = contexts.first { print("      例：\(sample.prefix(90))") }
      } else {
        // 分不开的组要把每一条都列出来。只打一个样本的话，「为什么是 4 个而不是 6 个」
        // 这种问题永远查不下去——而看不懂的数字不能当成通过。
        for (index, item) in items.enumerated() {
          print("      [\(index)] \(item.context.map { String($0.suffix(60)) } ?? "<无上下文>")")
        }
      }
      // 拿到了上下文就不能是空串：空串在选项说明里会落成一对空括号，比没有更糟。
      XCTAssertFalse(contexts.contains(where: \.isEmpty), "「\(label)」拿到了空的区分文字")
    }
    if duplicates.isEmpty {
      print("  前台窗口里没有同名目标——这次量不到东西，换个页面再跑")
    } else {
      print("── \(separated)/\(duplicates.count) 组被完全分开 ──")
      // 唯一的硬断言：撞名的 offer 必须**都**拿到上下文。分不分得开取决于那棵树，
      // 但「撞名了却一个字都没附」只可能是回填逻辑没跑，那是缺陷。
      for (key, items) in duplicates {
        let label = key.split(separator: "\u{1f}").last.map(String.init) ?? key
        XCTAssertEqual(items.compactMap(\.context).count, items.count, "「\(label)」有 offer 撞了名却没拿到区分文字")
      }
    }
  }

  /// 真机量一遍遍历预算：同一页面上不同 depth/nodes/ms 各能看见多少可动作元素、走到多深、
  /// 为什么停下。§1.1 的验收（Chrome 的 GitHub 页面出现 40+ 可动作元素、不再报 depth 截断、
  /// 耗时在预算内）靠它取证——单元测试里的树是我们自己造的，证明不了真实网页长什么样。
  ///
  /// 断言刻意只钉**形状**而不钉具体数字：页面随用户当时开着什么而变，钉死数量会变成随桌面状态
  /// 随机红的噪声源。真正的信息在打印出来的那张表里——看不懂的数字不能当成通过。
  func testTraversalBudgetTiersOnChromePrintTheActionableSurface() async throws {
    guard ProcessInfo.processInfo.environment["BRIGHTSIGHT_LIVE"] == "1" else {
      throw XCTSkip("设 BRIGHTSIGHT_LIVE=1 才跑真实 AX 调用")
    }
    guard AXIsProcessTrusted() else {
      throw XCTSkip("当前测试宿主没有 Accessibility 权限")
    }
    // 按 bundle id 定位 Chrome，而不是「取前台应用」：免得为了量一条测试去抢用户的焦点。
    // 与 `testObserveFinderWithoutPerformingAnAction` 里用 `com.apple.finder` 是同一个路数——
    // bundle id 是应用身份，不是随机器变的数据。
    guard let chrome = NSWorkspace.shared.runningApplications.first(where: {
      $0.bundleIdentifier == "com.google.Chrome"
    }) else {
      throw XCTSkip("Chrome 当前没有运行")
    }

    // 第一档是**改之前的**生产值（depth 6），用来对照「看不到网页内容」这个现象；
    // 中间那档是 §1.1 的建议值；最后一档是本次定下的生产默认档，验收靠它取证。
    let tiers = [
      AXTraversalBudget(maxDepth: 6, maxNodes: 500, maxMilliseconds: 150, pageSize: 200),
      AXTraversalBudget(maxDepth: 12, maxNodes: 800, maxMilliseconds: 150, pageSize: 200),
      AXTraversalBudget(
        maxDepth: AXTraversalBudget.defaultMaxDepth,
        maxNodes: AXTraversalBudget.defaultMaxNodes,
        maxMilliseconds: AXTraversalBudget.defaultMaxMilliseconds,
        pageSize: 200
      ),
    ]

    print("── 真机遍历预算：\(chrome.localizedName ?? "Chrome") pid=\(chrome.processIdentifier) 前台=\(NSWorkspace.shared.frontmostApplication?.localizedName ?? "?") ──")
    print("  depth/nodes/ms | 可动作元素 | 遍历节点 | 耗时 | 截断原因")
    for tier in tiers {
      let runtime = AXRuntime(budget: tier)
      let observed: JSONValue
      do {
        observed = try await call { completion in
          runtime.observe(params: .object([
            "scope": .string("focusedWindow"),
            "pid": .number(Double(chrome.processIdentifier)),
            "depth": .number(Double(tier.maxDepth)),
            "nodes": .number(Double(tier.maxNodes)),
            "ms": .number(Double(tier.maxMilliseconds)),
            "pageSize": .number(200),
          ]), completion: completion)
        }
      } catch {
        // 一棵树在遍历期间会继续变化，单档失败不该带走整张表——如实打出来，接着量下一档
        print("  \(tier.maxDepth)/\(tier.maxNodes)/\(tier.maxMilliseconds) | 观察失败：\(error)")
        continue
      }
      let total = observed["page"]?["total"]?.intValue ?? -1
      let elapsed = observed["elapsedMs"]?.intValue ?? -1
      let truncation = observed["truncated"]
      // 遍历节点数只在被截断时随 truncated 上报；走完整棵树时线上没有这个数，
      // 如实打「—」而不是编一个。
      let nodesText = truncation?["nodes"]?.intValue.map(String.init) ?? "—"
      let reason = truncation?["reason"]?.stringValue ?? "完成"
      print("  \(tier.maxDepth)/\(tier.maxNodes)/\(tier.maxMilliseconds) | \(total) | \(nodesText) | \(elapsed)ms | \(reason)")
      // 打几条样本标签：数字对不上预期时，先要能回答「我看的到底是哪个页面」。
      // 头部的是浏览器自己的工具栏，尾部才是网页内容——两头都打。
      // 看不懂的数字不能当成通过，上一轮那个 `-25200` 就是这么查出来的。
      let labels = (observed["offers"]?.arrayValue ?? []).compactMap { $0["target"]?["label"]?.stringValue }
      let head = labels.prefix(3).joined(separator: " / ")
      let tail = labels.suffix(3).joined(separator: " / ")
      if !labels.isEmpty { print("      头：\(head)　尾：\(tail)") }
    }
  }

  private func call(
    _ start: (@escaping AXRuntime.Completion) -> Void
  ) async throws -> JSONValue {
    try await withCheckedThrowingContinuation { continuation in
      start { continuation.resume(with: $0.mapError { $0 as Error }) }
    }
  }
}
