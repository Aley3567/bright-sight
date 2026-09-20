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

  private func call(
    _ start: (@escaping AXRuntime.Completion) -> Void
  ) async throws -> JSONValue {
    try await withCheckedThrowingContinuation { continuation in
      start { continuation.resume(with: $0.mapError { $0 as Error }) }
    }
  }
}
