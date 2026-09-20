import AppKit
import XCTest
@testable import BrightSightVoice

final class RightCommandMonitorTests: XCTestCase {
  /// 假的权限源。`trusted` 随时可改，`promptCalls` 记录 start 查了几次权限。
  private final class FakeTrust {
    var trusted = false
    var promptCalls = 0
  }

  private func makeMonitor(_ fake: FakeTrust) -> RightCommandMonitor {
    RightCommandMonitor(
      onChange: { _ in },
      trustCheck: { fake.trusted },
      promptForTrust: { _ in
        fake.promptCalls += 1
        return fake.trusted
      }
    )
  }

  /// 运行期拿到权限之后，监听必须被重装一次。
  ///
  /// 判据取 `promptForTrust` 的调用次数，而不是某个内部标志：`start()` 每次都会查一遍权限，
  /// 所以「重装发生了」在外部就表现为「又多查了一次」。钉内部标志的话测的是实现，
  /// 而这里真正要保证的是行为——**没有权限时注册的监听是死的，权限到手必须重走一遍**。
  func testGrantingPermissionAtRuntimeRestartsTheMonitor() {
    let fake = FakeTrust()
    let monitor = makeMonitor(fake)
    _ = monitor.start(promptForPermission: false)
    XCTAssertEqual(fake.promptCalls, 1, "start 自己应该查一次权限")

    monitor.startWatchingForTrust(interval: 0.02)
    XCTAssertEqual(fake.promptCalls, 1, "还没授权，不该立刻重装")

    fake.trusted = true
    waitUntil(timeout: 2) { fake.promptCalls == 2 }
    XCTAssertEqual(fake.promptCalls, 2, "权限到手后应该重装一次")
  }

  /// 授权之后轮询要停。不停的话每秒一次系统调用会一直跟着 App 跑到退出。
  func testWatchingStopsAfterThePermissionArrives() {
    let fake = FakeTrust()
    let monitor = makeMonitor(fake)
    _ = monitor.start(promptForPermission: false)
    monitor.startWatchingForTrust(interval: 0.02)

    fake.trusted = true
    waitUntil(timeout: 2) { fake.promptCalls >= 2 }
    let settled = fake.promptCalls
    XCTAssertGreaterThanOrEqual(settled, 2, "前置条件没成立，后面的否定断言说明不了问题")

    // 再空转一段：真有 Timer 活着的话这里会继续加。
    spinRunLoop(for: 0.3)
    XCTAssertEqual(fake.promptCalls, settled, "轮询在授权之后没有停下来")
  }

  /// 已经有权限时不该白起一个 Timer。
  func testAlreadyTrustedDoesNotStartWatching() {
    let fake = FakeTrust()
    fake.trusted = true
    let monitor = makeMonitor(fake)
    _ = monitor.start(promptForPermission: false)

    monitor.startWatchingForTrust(interval: 0.02)
    let settled = fake.promptCalls
    spinRunLoop(for: 0.3)
    XCTAssertEqual(fake.promptCalls, settled, "已经有权限了还在轮询")
  }

  /// `stop()` 要把轮询一起停掉——App 的退出路径走的就是它。
  func testStopCancelsTheWatch() {
    let fake = FakeTrust()
    let monitor = makeMonitor(fake)
    _ = monitor.start(promptForPermission: false)
    monitor.startWatchingForTrust(interval: 0.02)

    monitor.stop()
    let settled = fake.promptCalls
    fake.trusted = true
    spinRunLoop(for: 0.3)
    XCTAssertEqual(fake.promptCalls, settled, "stop 之后不该再重装")
  }

  // ── run loop 帮手 ───────────────────────────────────────────────────────────

  /// 转 main run loop 直到条件成立或超时。
  ///
  /// 轮询挂在 main run loop 上，不转它就永远不会触发——直接 `Thread.sleep` 会得到一个
  /// 假的「什么都没发生」，那是这个文件里最容易写出全绿假象的地方。
  private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() { return }
      RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
  }

  /// 空转 run loop 一段时间。「等一会儿看它会不会又动」这类否定断言只能这样写：
  /// 换成 sleep 就同时把被测的 Timer 也冻住了。
  private func spinRunLoop(for duration: TimeInterval) {
    RunLoop.main.run(until: Date().addingTimeInterval(duration))
  }
}
