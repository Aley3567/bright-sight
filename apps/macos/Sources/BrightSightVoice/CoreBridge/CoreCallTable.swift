import Foundation

/// 在飞的出站调用：id 分配 + 等待者登记。
///
/// 做成泛型不是为了复用，是为了能测：真实的等待者是 `CheckedContinuation`，
/// 它既不可比较也不能凭空造，测试里换成 String 就能把「奇数空间」「乱序回应各归各位」
/// 这两条判据逐条断言。`CoreSession` 只负责把它搬到串行队列上跑。
struct CoreCallTable<Waiter> {
  /// 奇数、递增、**不复用**。
  ///
  /// 不复用是刻意的：回收 id 意味着一个迟到的回应可能落到下一次调用头上，
  /// 而那两次调用的副作用完全不同。id 是 Int，按每秒一条指令算也够跑到宇宙热寂。
  private var next = 1
  private var waiters: [Int: Waiter] = [:]

  var count: Int { waiters.count }
  var ids: Set<Int> { Set(waiters.keys) }

  mutating func allocate() -> Int {
    defer { next += 2 }
    return next
  }

  mutating func register(_ id: Int, _ waiter: Waiter) {
    waiters[id] = waiter
  }

  mutating func take(_ id: Int) -> Waiter? {
    waiters.removeValue(forKey: id)
  }

  mutating func takeAll() -> [Waiter] {
    let all = Array(waiters.values)
    waiters.removeAll()
    return all
  }
}

/// 「传输层错误反复出现就重启核心」这条判据。
///
/// 单独成型是因为它必须能测反面：method 层的错误（方法不存在、参数不合法、缺凭证）
/// 是我们自己的 bug 或配置问题，重启核心既治不好也会让用户白等一次冷启动。
/// 只测顺风路径的话，「把不该管的也管了」正好全绿通过。
struct CoreTransportHealth {
  enum Verdict: Equatable {
    case keep
    case restart
  }

  private(set) var strikes = 0
  let threshold: Int

  init(threshold: Int = 3) {
    self.threshold = threshold
  }

  /// 收到一条对得上号的回应 = 这条线还活着，之前的零星事故不再累计。
  mutating func recordSuccess() {
    strikes = 0
  }

  mutating func record(_ error: CoreError) -> Verdict {
    switch error.layer {
    case .transport:
      strikes += 1
      if strikes >= threshold {
        strikes = 0
        return .restart
      }
      return .keep
    case .method, .unknown:
      return .keep
    }
  }
}
