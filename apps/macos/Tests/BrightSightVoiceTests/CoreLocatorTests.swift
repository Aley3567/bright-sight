import XCTest
@testable import BrightSightVoice

final class CoreLocatorTests: XCTestCase {
  private var scratch: URL!

  override func setUpWithError() throws {
    scratch = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      .appendingPathComponent("bright-sight-locator-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: scratch)
  }

  /// 造一个「看起来像仓库根」的目录。`parts` 控制造哪几个判据文件，用来测缺一个时会不会误认。
  @discardableResult
  private func makeRoot(_ name: String, script: Bool = true, manifest: Bool = true) throws -> URL {
    let root = scratch.appendingPathComponent(name, isDirectory: true)
    try FileManager.default.createDirectory(at: root.appendingPathComponent("bin"), withIntermediateDirectories: true)
    if script {
      try Data("#!/usr/bin/env node\n".utf8).write(to: root.appendingPathComponent("bin/bright-sight.js"))
    }
    if manifest {
      try Data("{}".utf8).write(to: root.appendingPathComponent("package.json"))
    }
    return root
  }

  func testPackagedCoreWinsOverTheDevelopmentFallback() throws {
    let resources = try makeRoot("Resources")
    let packaged = resources.appendingPathComponent("core", isDirectory: true)
    try FileManager.default.createDirectory(at: packaged.appendingPathComponent("bin"), withIntermediateDirectories: true)
    try Data("#!/usr/bin/env node\n".utf8).write(to: packaged.appendingPathComponent("bin/bright-sight.js"))
    try Data("{}".utf8).write(to: packaged.appendingPathComponent("package.json"))
    let repo = try makeRoot("repo")

    let entry = CoreLocator.resolve(
      bundleResources: resources,
      executable: nil,
      environment: [CoreLocator.rootVariable: repo.path]
    )
    // 装好的 App 永远先用自己带的那份核心：机器上恰好有个仓库副本，不该把线上行为悄悄换掉
    XCTAssertEqual(entry?.root.standardizedFileURL, packaged.standardizedFileURL)
    XCTAssertEqual(entry?.script.lastPathComponent, "bright-sight.js")
  }

  func testEnvironmentVariablePointsAtTheRepoWhenThereIsNoBundledCore() throws {
    let repo = try makeRoot("repo")
    let entry = CoreLocator.resolve(
      bundleResources: scratch.appendingPathComponent("no-such-resources", isDirectory: true),
      executable: nil,
      environment: [CoreLocator.rootVariable: repo.path]
    )
    XCTAssertEqual(entry?.root.standardizedFileURL, repo.standardizedFileURL)
  }

  func testWalksUpFromTheExecutableWhenNothingIsConfigured() throws {
    // swift run 下可执行文件在 <repo>/apps/macos/.build/arm64-apple-macosx/debug/ 底下
    let repo = try makeRoot("repo")
    let deep = repo.appendingPathComponent("apps/macos/.build/arm64-apple-macosx/debug", isDirectory: true)
    try FileManager.default.createDirectory(at: deep, withIntermediateDirectories: true)

    let entry = CoreLocator.resolve(
      bundleResources: nil,
      executable: deep.appendingPathComponent("BrightSightVoice"),
      environment: [:]
    )
    XCTAssertEqual(entry?.root.standardizedFileURL, repo.standardizedFileURL)
  }

  func testBothMarkersAreRequired() throws {
    let onlyScript = try makeRoot("only-script", script: true, manifest: false)
    let onlyManifest = try makeRoot("only-manifest", script: false, manifest: true)
    let complete = try makeRoot("complete")

    for candidate in [onlyScript, onlyManifest] {
      XCTAssertNil(
        CoreLocator.resolve(bundleResources: nil, executable: nil, environment: [CoreLocator.rootVariable: candidate.path]),
        "两个判据独立查：\(candidate.lastPathComponent) 只满足一个，不该被认成仓库根"
      )
    }
    // 阳性对照：同一套 resolve 在两个判据都满足时确实找得到，
    // 否则上面那三个 nil 可能只是因为函数根本没在工作
    XCTAssertNotNil(
      CoreLocator.resolve(bundleResources: nil, executable: nil, environment: [CoreLocator.rootVariable: complete.path])
    )
  }

  func testGivesUpInsteadOfWalkingToTheFilesystemRoot() throws {
    let deep = scratch.appendingPathComponent("a/b/c/d/e/f/g/h/i/j", isDirectory: true)
    try FileManager.default.createDirectory(at: deep, withIntermediateDirectories: true)
    XCTAssertNil(CoreLocator.resolve(
      bundleResources: nil,
      executable: deep.appendingPathComponent("BrightSightVoice"),
      environment: [:]
    ))
  }

  // ── 包内自带的 node ──────────────────────────────────────────────────────────

  /// 造一份「像 node 一样的文件」，`executable` 控制执行位。内容是什么不重要——
  /// 这里测的是定位，不是运行。
  private func makeNode(in root: URL, executable: Bool) throws -> URL {
    let node = root.appendingPathComponent("node")
    try Data("#!/bin/sh\n".utf8).write(to: node)
    try FileManager.default.setAttributes(
      [.posixPermissions: executable ? 0o755 : 0o644],
      ofItemAtPath: node.path
    )
    return node
  }

  private func resolveNode(at root: URL) -> URL? {
    CoreLocator.resolve(
      bundleResources: nil,
      executable: nil,
      environment: [CoreLocator.rootVariable: root.path]
    )?.node
  }

  /// 包内自带 node 时，entry 要指向它——「用户不装 Node 也能跑」的全部依据就是这一条。
  func testBundledNodeIsPickedUpWhenItIsExecutable() throws {
    let root = try makeRoot("with-node")
    let node = try makeNode(in: root, executable: true)
    XCTAssertEqual(resolveNode(at: root)?.standardizedFileURL, node.standardizedFileURL)
  }

  /// 在、但没有执行位，必须当成「没有」。
  ///
  /// 这条判据的存在理由很具体：拷进包的 node 有可能丢权限位（zip 解压、同步工具、一部分
  /// `cp` 变体都会），而 `fileExists` 对这种情况照样通过。判据松了的话，失败点被推到 exec
  /// 那一刻，现场只剩一句语焉不详的权限错误——回退 PATH 也救不回来，因为目标机器上本来
  /// 就没有 node。
  func testBundledNodeWithoutExecuteBitIsTreatedAsAbsent() throws {
    let root = try makeRoot("node-not-executable")
    try makeNode(in: root, executable: false)
    XCTAssertNil(resolveNode(at: root), "没有执行位的 node 不该被当成可用")

    // 阳性对照：只改权限位这一个变量，同一套 resolve 就该拿到它。
    // 少了这一条，上面的 nil 也可能只是因为探测根本没在看这个文件——那是最糟的一种全绿。
    _ = try makeNode(in: root, executable: true)
    XCTAssertNotNil(resolveNode(at: root), "补上执行位之后就该认出来了")
  }

  /// 开发期的仓库根没有这一份 node，此时 core 仍然要定位得到。
  ///
  /// `node` 是可选字段，这一条钉的是「可选」的语义：缺了它回退 PATH 上的 node，
  /// 而不是让整个核心定位失败——后者会把开发期直接变成 `missingCore`。
  func testDevelopmentRootResolvesWithoutABundledNode() throws {
    let repo = try makeRoot("repo-without-node")
    let entry = CoreLocator.resolve(
      bundleResources: nil,
      executable: nil,
      environment: [CoreLocator.rootVariable: repo.path]
    )
    XCTAssertNotNil(entry, "缺 node 不该让整个核心定位失败")
    XCTAssertNil(entry?.node)
    XCTAssertEqual(entry?.script.lastPathComponent, "bright-sight.js")
  }
}
