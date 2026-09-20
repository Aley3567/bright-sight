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
}
