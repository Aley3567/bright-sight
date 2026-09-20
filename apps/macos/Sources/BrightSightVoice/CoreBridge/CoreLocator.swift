import Foundation

struct CoreEntry: Equatable {
  /// 工作目录：核心要在自己的目录里跑才找得到 `node_modules`。
  var root: URL
  /// `bin/bright-sight.js`。
  var script: URL
  /// 包内自带的那份 node。
  ///
  /// 可选的，因为开发期的仓库根没有这一份——`build-app.sh` 只在打包时才拷进来。
  /// 缺了就回退到 PATH 上的 node，那是开发机的正常状态。
  var node: URL?
}

/// 核心在哪。
///
/// 打包后它在 App 资源里（`build-app.sh` 把 bin / src / package.json / SDK 拷进 `Contents/Resources/core`）。
/// 但 `swift run` 的 `Bundle.main.resourceURL` 底下没有 core/，于是开发期第一条指令就是 `missingCore`，
/// 逼着人每改一行 Swift 都先打一次包。
///
/// 回退路径**不许写死任何人的家目录**：这个仓库会被别人 clone 到别的地方。所以只有两种来源——
/// 环境变量（开关，由 `scripts/dev-run.sh` 按脚本自身位置推出来），或者从可执行文件位置向上找。
enum CoreLocator {
  /// 开发期回退：指向仓库根。`swift run` 时由 `scripts/dev-run.sh` 设好。
  static let rootVariable = "BRIGHTSIGHT_CORE_ROOT"

  /// 向上找几层。`.build/arm64-apple-macosx/debug/BrightSightVoice` 到仓库根是 5 层，
  /// 给到 8 层留点余量；无上限地往上爬会在别人的目录结构里认错一个同名的 bin/
  private static let maxAscent = 8

  static func resolve(
    bundleResources: URL?,
    executable: URL?,
    environment: [String: String],
    isCoreRoot: (URL) -> Bool = CoreLocator.looksLikeCoreRoot
  ) -> CoreEntry? {
    // 顺序是「精确 → 特化 → 兜底」：装好的 App 永远先用自己带的那份核心，
    // 免得机器上恰好有个仓库副本把线上行为悄悄换掉
    if let resources = bundleResources {
      let packaged = resources.appendingPathComponent("core", isDirectory: true)
      if isCoreRoot(packaged) { return entry(at: packaged) }
    }
    if let configured = environment[rootVariable], !configured.isEmpty {
      let root = URL(fileURLWithPath: configured, isDirectory: true)
      if isCoreRoot(root) { return entry(at: root) }
    }
    if let executable {
      var dir = executable.deletingLastPathComponent()
      for _ in 0..<maxAscent {
        if isCoreRoot(dir) { return entry(at: dir) }
        let parent = dir.deletingLastPathComponent()
        if parent.path == dir.path { break }
        dir = parent
      }
    }
    return nil
  }

  /// 两个条件独立查：只看 `bin/bright-sight.js` 会认上任何有同名脚本的目录，
  /// 只看 `package.json` 会认上任何 Node 项目。一个改错了，另一个还拦得住。
  static func looksLikeCoreRoot(_ root: URL) -> Bool {
    let fm = FileManager.default
    return fm.fileExists(atPath: root.appendingPathComponent("bin/bright-sight.js").path)
      && fm.fileExists(atPath: root.appendingPathComponent("package.json").path)
  }

  private static func entry(at root: URL) -> CoreEntry {
    let node = root.appendingPathComponent("node")
    return CoreEntry(
      root: root,
      script: root.appendingPathComponent("bin/bright-sight.js"),
      // 判据用 isExecutableFile 而不是 fileExists。拷进来的 node 完全可能「在，但没有执行位」
      // ——zip 解压、某些同步工具、一部分 cp 变体都会把权限位丢掉。那时候 fileExists 照样通过，
      // 失败点被推到 exec 那一刻，而现场只剩一句语焉不详的权限错误；回退 PATH 也救不回来，
      // 因为用户机器上本来就没有 node。在这里就判死，能回退的回退，回退不了的第一条指令就报错。
      node: FileManager.default.isExecutableFile(atPath: node.path) ? node : nil
    )
  }
}
