import AppKit
import Foundation

struct AXProcessInstance: Hashable, Sendable {
  let processID: pid_t
  let launchedAt: TimeInterval
}

struct AXCompatibilityCache {
  struct Detection: Equatable {
    let isChromium: Bool
    let expiresAt: Date
  }

  let ttl: TimeInterval
  private var detections: [AXProcessInstance: Detection] = [:]
  private var poked: Set<AXProcessInstance> = []

  init(ttl: TimeInterval = 300) {
    precondition(ttl > 0)
    self.ttl = ttl
  }

  mutating func detection(for instance: AXProcessInstance, now: Date) -> Bool? {
    guard let entry = detections[instance], entry.expiresAt > now else {
      detections.removeValue(forKey: instance)
      return nil
    }
    return entry.isChromium
  }

  mutating func recordDetection(_ isChromium: Bool, for instance: AXProcessInstance, now: Date) {
    detections[instance] = Detection(isChromium: isChromium, expiresAt: now.addingTimeInterval(ttl))
    pruneDeadProcessIDs(keeping: instance)
  }

  mutating func claimPoke(for instance: AXProcessInstance) -> Bool {
    poked.insert(instance).inserted
  }

  private mutating func pruneDeadProcessIDs(keeping current: AXProcessInstance) {
    detections = detections.filter { $0.key.processID != current.processID || $0.key == current }
    poked = poked.filter { $0.processID != current.processID || $0 == current }
  }
}

/// poke 的结局。
///
/// 写失败不向上抛：poke 只是替 Chromium 系应用把 AX 树建出来的尽力而为动作，它失败时
/// 观察本身仍然成立，只是拿到的动作面可能为空。让整次 `ax.observe` 报错会把「这个应用没开
/// 无障碍树」伪装成「AX 通道坏了」，反而更难归因。
enum AXPokeOutcome: Equatable, Sendable {
  case notNeeded
  case enabled
  case failed(String)
}

final class AXCompatibility: @unchecked Sendable {
  private let lock = NSLock()
  private var cache = AXCompatibilityCache()

  /// 生产入口：先确认进程还在，再交给下面的决策。进程已退出时不做任何事——
  /// 那说明观察目标本身没了，poke 与否都不影响后续的失败归因。
  @discardableResult
  func prepare(
    processID: pid_t,
    application: AXUIElement,
    poke: (AXUIElement) throws -> Void,
    now: Date = Date()
  ) -> AXPokeOutcome {
    guard let running = NSRunningApplication(processIdentifier: processID) else { return .notNeeded }
    return prepare(
      instance: AXProcessInstance(
        processID: processID,
        launchedAt: running.launchDate?.timeIntervalSince1970 ?? 0
      ),
      bundleURL: running.bundleURL,
      application: application,
      poke: poke,
      now: now
    )
  }

  /// 决策与副作用分开：这里不查 `NSRunningApplication`，测试可以直接给假实例与假 bundle，
  /// 不必依赖一个真的在跑的 Electron 进程。
  @discardableResult
  func prepare(
    instance: AXProcessInstance,
    bundleURL: URL?,
    application: AXUIElement,
    poke: (AXUIElement) throws -> Void,
    now: Date = Date()
  ) -> AXPokeOutcome {
    let shouldPoke: Bool = lock.withLock {
      let chromium: Bool
      if let cached = cache.detection(for: instance, now: now) {
        chromium = cached
      } else {
        chromium = Self.detectChromium(bundleURL: bundleURL)
        cache.recordDetection(chromium, for: instance, now: now)
      }
      return chromium && cache.claimPoke(for: instance)
    }
    guard shouldPoke else { return .notNeeded }
    do {
      try poke(application)
      return .enabled
    } catch {
      // 即使写失败也不在同一进程上反复 poke；反复写一个不支持的私有属性只会制造更多 AX 阻塞。
      // `claimPoke` 在尝试之前就已经消耗掉这次机会，所以失败天然只发生一次。
      return .failed(String(describing: error))
    }
  }

  static func detectChromium(bundleURL: URL?) -> Bool {
    guard let bundleURL else { return false }
    let frameworks = bundleURL.appendingPathComponent("Contents/Frameworks", isDirectory: true)
    let candidates = [
      frameworks.appendingPathComponent("Electron Framework.framework", isDirectory: true),
      frameworks.appendingPathComponent("Chromium Embedded Framework.framework", isDirectory: true),
    ]
    return candidates.contains { FileManager.default.fileExists(atPath: $0.path) }
  }
}

private extension NSLock {
  func withLock<T>(_ body: () -> T) -> T {
    lock()
    defer { unlock() }
    return body()
  }
}
