import ApplicationServices
import Foundation
import XCTest
@testable import BrightSightVoice

final class AXFrameAndCompatibilityTests: XCTestCase {
  func testNewFrameInvalidatesOnlySameProcessAndScope() {
    let now = Date(timeIntervalSince1970: 100)
    var catalog = AXFrameCatalog<String>(ttl: 30)
    catalog.insert(entry("old", pid: 1, scope: .application, at: now, value: "old"), now: now)
    catalog.insert(entry("window", pid: 1, scope: .focusedWindow, at: now, value: "window"), now: now)
    catalog.insert(entry("other", pid: 2, scope: .application, at: now, value: "other"), now: now)
    catalog.insert(entry("new", pid: 1, scope: .application, at: now, value: "new"), now: now)

    XCTAssertNil(catalog.value(for: "old", now: now))
    XCTAssertEqual(catalog.value(for: "new", now: now), "new")
    XCTAssertEqual(catalog.value(for: "window", now: now), "window")
    XCTAssertEqual(catalog.value(for: "other", now: now), "other")
  }

  func testFrameTTLAndTakeMakeReferencesSingleUse() {
    let now = Date(timeIntervalSince1970: 100)
    var catalog = AXFrameCatalog<String>(ttl: 10)
    catalog.insert(entry("one", pid: 1, scope: .application, at: now, value: "value"), now: now)
    XCTAssertEqual(catalog.take("one", now: now.addingTimeInterval(9)), "value")
    XCTAssertNil(catalog.take("one", now: now.addingTimeInterval(9)))

    catalog.insert(entry("old", pid: 1, scope: .application, at: now, value: "old"), now: now)
    XCTAssertNil(catalog.value(for: "old", now: now.addingTimeInterval(11)))
  }

  func testCompatibilityCacheExpiresDetectionButPokesOncePerProcessInstance() {
    let now = Date(timeIntervalSince1970: 100)
    let first = AXProcessInstance(processID: 42, launchedAt: 10)
    var cache = AXCompatibilityCache(ttl: 5)
    XCTAssertNil(cache.detection(for: first, now: now))
    cache.recordDetection(true, for: first, now: now)
    XCTAssertEqual(cache.detection(for: first, now: now.addingTimeInterval(4)), true)
    XCTAssertNil(cache.detection(for: first, now: now.addingTimeInterval(6)))
    XCTAssertTrue(cache.claimPoke(for: first))
    XCTAssertFalse(cache.claimPoke(for: first))

    let reusedPID = AXProcessInstance(processID: 42, launchedAt: 20)
    cache.recordDetection(true, for: reusedPID, now: now)
    XCTAssertTrue(cache.claimPoke(for: reusedPID), "PID 被新进程复用后可以为新实例 poke 一次")
  }

  // ── poke 的副作用路径 ──────────────────────────────────────────────────────
  //
  // `AXCompatibility.prepare` 会真的去写一个系统私有属性。写失败以前会向上抛，
  // 让一次尽力而为的兼容动作拖垮整次 `ax.observe`——下面几条把它钉在「如实回报、绝不抛出、
  // 一个进程实例只尝试一次」上。

  func testChromiumDetectionReadsTheDiskInsteadOfGuessing() throws {
    XCTAssertTrue(
      AXCompatibility.detectChromium(bundleURL: try temporaryBundle(frameworks: ["Electron Framework.framework"]))
    )
    XCTAssertTrue(
      AXCompatibility.detectChromium(bundleURL: try temporaryBundle(frameworks: ["Chromium Embedded Framework.framework"]))
    )
    XCTAssertFalse(
      AXCompatibility.detectChromium(bundleURL: try temporaryBundle()),
      "没有那两个 framework 的 bundle 就是在磁盘上找不到，不能被认成 Chromium"
    )
    XCTAssertFalse(AXCompatibility.detectChromium(bundleURL: nil))
  }

  func testPokeFailureIsReportedAndNeverThrownNorRetried() throws {
    let now = Date(timeIntervalSince1970: 100)
    let instance = AXProcessInstance(processID: 7, launchedAt: 1)
    let application = AXUIElementCreateApplication(7)
    let compatibility = AXCompatibility()
    let bundle = try temporaryBundle(frameworks: ["Electron Framework.framework"])
    var attempts = 0
    let failing: (AXUIElement) throws -> Void = { _ in
      attempts += 1
      throw AXCallError(code: AXError.notImplemented.rawValue, kind: .unsupported, operation: "poke")
    }

    // 故意不 catch：写失败不再向上抛。抛出去等于让一个私有属性的写入否掉整次观察。
    let first = compatibility.prepare(
      instance: instance,
      bundleURL: bundle,
      application: application,
      poke: failing,
      now: now
    )
    guard case .failed = first else {
      return XCTFail("poke 失败必须如实回报，实际是 \(first)")
    }
    XCTAssertEqual(attempts, 1)

    let second = compatibility.prepare(
      instance: instance,
      bundleURL: bundle,
      application: application,
      poke: failing,
      now: now.addingTimeInterval(1)
    )
    XCTAssertEqual(second, .notNeeded, "claimPoke 在尝试之前就消耗掉了机会，失败也只发生一次")
    XCTAssertEqual(attempts, 1, "反复写一个不支持的私有属性只会制造更多 AX 阻塞")
  }

  func testSuccessfulPokeReportsEnabledExactlyOnce() throws {
    let now = Date(timeIntervalSince1970: 100)
    let instance = AXProcessInstance(processID: 9, launchedAt: 1)
    let application = AXUIElementCreateApplication(9)
    let compatibility = AXCompatibility()
    let bundle = try temporaryBundle(frameworks: ["Electron Framework.framework"])
    var attempts = 0
    let poke: (AXUIElement) throws -> Void = { _ in attempts += 1 }

    let first = compatibility.prepare(
      instance: instance,
      bundleURL: bundle,
      application: application,
      poke: poke,
      now: now
    )
    let second = compatibility.prepare(
      instance: instance,
      bundleURL: bundle,
      application: application,
      poke: poke,
      now: now.addingTimeInterval(1)
    )

    XCTAssertEqual(first, .enabled)
    XCTAssertEqual(second, .notNeeded)
    XCTAssertEqual(attempts, 1)
  }

  func testNonChromiumBundleIsNeverPoked() throws {
    let now = Date(timeIntervalSince1970: 100)
    let instance = AXProcessInstance(processID: 8, launchedAt: 1)
    let application = AXUIElementCreateApplication(8)
    let compatibility = AXCompatibility()
    var attempts = 0

    let outcome = compatibility.prepare(
      instance: instance,
      bundleURL: try temporaryBundle(),
      application: application,
      poke: { _ in attempts += 1 },
      now: now
    )

    XCTAssertEqual(outcome, .notNeeded)
    XCTAssertEqual(attempts, 0, "非 Chromium 应用不该被写私有属性")
  }

  /// 造一个带指定 framework 目录的假 bundle。
  ///
  /// `detectChromium` 判的是磁盘上有没有那个目录，所以这里必须真的落一个目录——
  /// 改成注入一个 Bool 就等于不再测这段判据本身。
  private func temporaryBundle(frameworks: [String] = []) throws -> URL {
    let root = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("brightsight-ax-compat-\(UUID().uuidString)")
    let contents = root.appendingPathComponent("Fake.app/Contents/Frameworks")
    try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
    for framework in frameworks {
      try FileManager.default.createDirectory(
        at: contents.appendingPathComponent(framework),
        withIntermediateDirectories: true
      )
    }
    addTeardownBlock { try? FileManager.default.removeItem(at: root) }
    return root.appendingPathComponent("Fake.app")
  }

  private func entry(
    _ id: String,
    pid: pid_t,
    scope: AXObservationScope,
    at: Date,
    value: String
  ) -> AXFrameCatalog<String>.Entry {
    .init(id: id, processID: pid, scope: scope, createdAt: at, value: value)
  }
}
