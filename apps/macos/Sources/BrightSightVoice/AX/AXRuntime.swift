import AppKit
import Foundation

private final class AXRuntimeJob: @unchecked Sendable {
  let run: () -> Result<JSONValue, CoreError>
  let completion: (Result<JSONValue, CoreError>) -> Void

  init(
    run: @escaping () -> Result<JSONValue, CoreError>,
    completion: @escaping (Result<JSONValue, CoreError>) -> Void
  ) {
    self.run = run
    self.completion = completion
  }
}

/// 真正执行 AX 同步调用的边界。调度状态只在 stateQueue 上变化，具体调用按 QoS 放到系统并发队列；
/// `AXWorkQueue` 保证同一 pid 单飞，因此一个应用卡住不会把另一个应用的观察排在它后面。
final class AXRuntime: @unchecked Sendable {
  typealias Completion = (Result<JSONValue, CoreError>) -> Void

  private let stateQueue = DispatchQueue(label: "com.brightsight.ax-runtime")
  private var scheduler: AXWorkQueue<UUID, AXRuntimeJob>
  private let client: any AXSurfaceClient
  private let budget: AXTraversalBudget
  private let frames: AXFrameVault
  private let compatibility: AXCompatibility

  init(
    pendingLimit: Int = 64,
    concurrencyLimit: Int = 4,
    client: any AXSurfaceClient = AXClient(),
    budget: AXTraversalBudget = .protectiveDefault,
    frameTTL: TimeInterval = 30
  ) {
    scheduler = AXWorkQueue(pendingLimit: pendingLimit, concurrencyLimit: concurrencyLimit)
    self.client = client
    self.budget = budget
    frames = AXFrameVault(ttl: frameTTL)
    compatibility = AXCompatibility()
  }

  func observe(params: JSONValue, completion: @escaping Completion) {
    let parsed: AXObserveParams
    do {
      parsed = try AXObserveParams(json: params)
    } catch let error as CoreError {
      completion(.failure(error))
      return
    } catch {
      completion(.failure(CoreError(.invalidParams, "ax.observe 参数无法解析")))
      return
    }
    guard let processID = parsed.processID ?? NSWorkspace.shared.frontmostApplication?.processIdentifier,
          processID > 0
    else {
      completion(.failure(CoreError(.invalidParams, "没有可观察的目标进程")))
      return
    }
    submit(processID: processID, qos: .utility, completion: completion) { [client, budget, frames, compatibility] in
      do {
        let app = try client.application(processID: processID)
        // poke 是尽力而为：失败不重试，也不让整次观察失败。这一维目前没有跨线通道
        // （线协议没有对应字段），失败的可见后果就是动作面变小。
        _ = compatibility.prepare(processID: processID, application: app) {
          try client.setManualAccessibility(on: $0)
        }
        // `budget` 是进程级的**基准**，不是最终值：把请求带来的 depth / nodes / ms 覆盖上去，
        // 不给的项退回基准值（缺省保守）。把它当常量直接遍历，请求参数就完全失效了。
        let effective = budget.overridden(
          maxDepth: parsed.depth,
          maxNodes: parsed.nodes,
          maxMilliseconds: parsed.milliseconds
        )
        let result = try AXSurfaceBuilder(client: client, budget: effective).observe(parsed, processID: processID)
        frames.insert(result.frame)
        return .success(result.json)
      } catch {
        return .failure(Self.coreError(error, operation: "ax.observe"))
      }
    }
  }

  func perform(params: JSONValue, completion: @escaping Completion) {
    let parsed: AXPerformParams
    do {
      parsed = try AXPerformParams(json: params)
    } catch let error as CoreError {
      completion(.failure(error))
      return
    } catch {
      completion(.failure(CoreError(.invalidParams, "ax.perform 参数无法解析")))
      return
    }
    guard let frame = frames.value(for: parsed.frameID) else {
      completion(.success(Self.staleResult("frame 已过期或不存在").json))
      return
    }
    submit(processID: frame.processID, qos: .userInitiated, completion: completion) { [client, frames] in
      // 排队期间可能发生了新 observe；到真正执行这一刻再 take，旧 frame 会可靠地被判 stale。
      guard let current = frames.take(parsed.frameID) else {
        return .success(Self.staleResult("frame 在排队期间失效").json)
      }
      return .success(AXActionPerformer(client: client).perform(parsed, frame: current).json)
    }
  }

  func invalidateFrames() {
    frames.removeAll()
  }

  private func submit(
    processID: pid_t,
    qos: AXWorkQoS,
    completion: @escaping Completion,
    run: @escaping () -> Result<JSONValue, CoreError>
  ) {
    stateQueue.async {
      let id = UUID()
      let job = AXRuntimeJob(run: run, completion: completion)
      switch self.scheduler.enqueue(.init(id: id, processID: processID, qos: qos, payload: job)) {
      case .accepted:
        self.drain()
      case .duplicate:
        completion(.failure(CoreError(.internalError, "AX 调度 id 冲突")))
      case .full:
        completion(.failure(CoreError(.internalError, "AX 队列已满，请稍后再试")))
      }
    }
  }

  private func drain() {
    for item in scheduler.startReady() {
      DispatchQueue.global(qos: item.qos.dispatchQoS).async {
        let result = item.payload.run()
        self.stateQueue.async {
          _ = self.scheduler.finish(item.id)
          item.payload.completion(result)
          self.drain()
        }
      }
    }
  }

  private static func staleResult(_ detail: String) -> AXPerformResult {
    AXPerformResult(
      status: .rejectedStale,
      verification: AXVerification(ok: false, detail: detail),
      error: nil
    )
  }

  private static func coreError(_ error: Error, operation: String) -> CoreError {
    if let error = error as? CoreError { return error }
    if let error = error as? AXCallError { return CoreError(.internalError, "\(operation)：\(error.description)") }
    return CoreError(.internalError, "\(operation)：\(error.localizedDescription)")
  }
}
