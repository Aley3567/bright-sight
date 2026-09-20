import XCTest
@testable import BrightSightVoice

final class ApplicationLauncherTests: XCTestCase {
  func testExtractsCommonChineseLaunchCommands() {
    XCTAssertEqual(ApplicationLauncher.requestedApplicationName(from: "打开我的微信"), "微信")
    XCTAssertEqual(ApplicationLauncher.requestedApplicationName(from: "帮我打开一下 Safari"), "Safari")
    XCTAssertEqual(ApplicationLauncher.requestedApplicationName(from: "启动系统设置这个应用"), "系统设置")
  }

  func testDoesNotClaimSearchOrWritingCommands() {
    XCTAssertNil(ApplicationLauncher.requestedApplicationName(from: "在 Chrome 搜索 Bright Sight"))
    XCTAssertNil(ApplicationLauncher.requestedApplicationName(from: "在备忘录写一段文字"))
  }

  func testResolvesInstalledWechatAliasWithoutLaunchingIt() {
    let target = ApplicationLauncher().target(for: "打开我的微信")
    XCTAssertEqual(target?.url.lastPathComponent, "WeChat.app")
  }
}
