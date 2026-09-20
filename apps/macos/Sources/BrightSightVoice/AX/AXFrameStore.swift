import ApplicationServices
import Foundation

struct AXStoredOffer {
  let publicOffer: AXActionOffer
  let element: AXUIElement
  let fingerprint: AXElementFingerprint
  let beforeState: AXElementState
}

struct AXStoredFrame {
  let id: String
  let processID: pid_t
  let scope: AXObservationScope
  let root: AXUIElement
  let window: AXWindowFingerprint?
  let offers: [String: AXStoredOffer]
  let createdAt: Date
}

/// frame id 是能力引用，不是历史记录。新观察会让同一进程/范围的旧 frame 当场失效；TTL 只是
/// 第二道保险，防止 Node 长时间持有一个已经没人记得的引用。
struct AXFrameCatalog<Value> {
  struct Entry {
    let id: String
    let processID: pid_t
    let scope: AXObservationScope
    let createdAt: Date
    let value: Value
  }

  let ttl: TimeInterval
  private var entries: [String: Entry] = [:]

  init(ttl: TimeInterval) {
    precondition(ttl > 0)
    self.ttl = ttl
  }

  var count: Int { entries.count }

  mutating func insert(_ entry: Entry, now: Date) {
    prune(now: now)
    entries = entries.filter {
      $0.value.processID != entry.processID || $0.value.scope != entry.scope
    }
    entries[entry.id] = entry
  }

  mutating func value(for id: String, now: Date) -> Value? {
    prune(now: now)
    return entries[id]?.value
  }

  mutating func take(_ id: String, now: Date) -> Value? {
    prune(now: now)
    return entries.removeValue(forKey: id)?.value
  }

  mutating func removeAll() {
    entries.removeAll()
  }

  private mutating func prune(now: Date) {
    entries = entries.filter { now.timeIntervalSince($0.value.createdAt) <= ttl }
  }
}

final class AXFrameVault: @unchecked Sendable {
  private let lock = NSLock()
  private var catalog: AXFrameCatalog<AXStoredFrame>

  init(ttl: TimeInterval = 30) {
    catalog = AXFrameCatalog(ttl: ttl)
  }

  func insert(_ frame: AXStoredFrame, now: Date = Date()) {
    lock.lock()
    defer { lock.unlock() }
    catalog.insert(.init(
      id: frame.id,
      processID: frame.processID,
      scope: frame.scope,
      createdAt: frame.createdAt,
      value: frame
    ), now: now)
  }

  func value(for id: String, now: Date = Date()) -> AXStoredFrame? {
    lock.lock()
    defer { lock.unlock() }
    return catalog.value(for: id, now: now)
  }

  func take(_ id: String, now: Date = Date()) -> AXStoredFrame? {
    lock.lock()
    defer { lock.unlock() }
    return catalog.take(id, now: now)
  }

  func removeAll() {
    lock.lock()
    defer { lock.unlock() }
    catalog.removeAll()
  }
}
