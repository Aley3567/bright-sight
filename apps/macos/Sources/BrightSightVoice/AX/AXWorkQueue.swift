import Foundation

/// AX 调用的调度等级。名字与系统 QoS 对齐，但这里只决定出队顺序；真正在哪条
/// `DispatchQueue` 上运行由后续的 AX runtime 负责。
enum AXWorkQoS: Sendable {
  case userInitiated
  case utility
  case background

  fileprivate static let priorityOrder: [AXWorkQoS] = [
    .userInitiated,
    .utility,
    .background,
  ]

  var dispatchQoS: DispatchQoS.QoSClass {
    switch self {
    case .userInitiated: return .userInitiated
    case .utility: return .utility
    case .background: return .background
    }
  }
}

struct AXWorkItem<ID: Hashable, Payload> {
  let id: ID
  let processID: pid_t
  let qos: AXWorkQoS
  let payload: Payload
}

extension AXWorkItem: Sendable where ID: Sendable, Payload: Sendable {}
extension AXWorkItem: Equatable where ID: Equatable, Payload: Equatable {}

/// AX 队列只管理调度状态，不直接持有线程或执行闭包。
///
/// AX API 是同步调用；单条串行队列会让一个失去响应的应用挡住所有应用。这里允许不同进程
/// 并行，但同一进程始终只放行一个调用。配合 AX messaging timeout，一个坏进程最多占一个
/// 槽位，不会把同进程的后续工作继续堆进执行器。
struct AXWorkQueue<ID: Hashable, Payload> {
  enum EnqueueResult: Equatable {
    case accepted
    case duplicate
    case full
  }

  let pendingLimit: Int
  let concurrencyLimit: Int

  private var pending: [AXWorkItem<ID, Payload>] = []
  private var active: [ID: pid_t] = [:]
  private var activeProcesses: Set<pid_t> = []

  init(pendingLimit: Int, concurrencyLimit: Int) {
    precondition(pendingLimit > 0, "AX pending limit must be positive")
    precondition(concurrencyLimit > 0, "AX concurrency limit must be positive")
    self.pendingLimit = pendingLimit
    self.concurrencyLimit = concurrencyLimit
  }

  var pendingCount: Int { pending.count }
  var activeCount: Int { active.count }
  var isIdle: Bool { pending.isEmpty && active.isEmpty }

  mutating func enqueue(_ item: AXWorkItem<ID, Payload>) -> EnqueueResult {
    // id 在一次排队到完成之间不可复用；否则迟到的完成通知会释放另一项工作。
    guard !active.keys.contains(item.id), !pending.contains(where: { $0.id == item.id }) else {
      return .duplicate
    }
    guard pending.count < pendingLimit else { return .full }
    pending.append(item)
    return .accepted
  }

  /// 尽量填满当前空闲槽位。高 QoS 优先，同一 QoS 内保持 FIFO。
  ///
  /// 选取时会跳过正在执行的进程，而不是停在队首等待：这是「一个坏进程不能拖住其他进程」
  /// 真正落在代码里的判据。
  mutating func startReady() -> [AXWorkItem<ID, Payload>] {
    var ready: [AXWorkItem<ID, Payload>] = []
    while active.count < concurrencyLimit, let index = nextEligibleIndex() {
      let item = pending.remove(at: index)
      active[item.id] = item.processID
      activeProcesses.insert(item.processID)
      ready.append(item)
    }
    return ready
  }

  /// 返回 false 表示这个完成通知不属于任何在飞工作；调用方不能据此释放别的槽位。
  @discardableResult
  mutating func finish(_ id: ID) -> Bool {
    guard let processID = active.removeValue(forKey: id) else { return false }
    activeProcesses.remove(processID)
    return true
  }

  @discardableResult
  mutating func cancelPending(_ id: ID) -> Bool {
    guard let index = pending.firstIndex(where: { $0.id == id }) else { return false }
    pending.remove(at: index)
    return true
  }

  private func nextEligibleIndex() -> Int? {
    for qos in AXWorkQoS.priorityOrder {
      if let index = pending.firstIndex(where: {
        $0.qos == qos && !activeProcesses.contains($0.processID)
      }) {
        return index
      }
    }
    return nil
  }
}
