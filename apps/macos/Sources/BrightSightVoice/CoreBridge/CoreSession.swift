import Foundation

/// 长驻的执行核心 + 双向 JSON Lines。
///
/// 改造之前是「一条指令 spawn 一次 `bright-sight run`，再去 stdout 里认中文」。那条通道只能单向、
/// 只能一问一答，而 AX 遍历必须留在 Swift（元素引用要跨步骤保活）、决策必须留在 Node，
/// 「Node 决策到一半反过来要求 Swift 去观察」在文本 stdout 上无解。所以进程长驻、两个方向都能发请求。
///
/// **为什么是串行队列而不是 actor**：stdout 的每个 chunk 都要从管道回调里转进来，
/// 而 `Task { await … }` 两次提交的执行顺序由调度器决定、不保证先来先到。行切分依赖字节到达顺序，
/// 顺序一乱，半行就会被拼反，而且只在大结果上偶发。`DispatchQueue.async` 是 FIFO，原样保住顺序。
final class CoreSession: @unchecked Sendable {
  /// 单条指令的整体上限。核心链路是模型调用 + AppleScript 执行 + verify，各有自己的重试预算；
  /// 实测 45 s 会误杀正常运行。`src/cli.ts` 的 `SERVE_DRAIN_TIMEOUT_MS` 跟这个数对齐。
  static let defaultHandleTimeout: Duration = .seconds(90)

  /// 反复启动失败的刹车：窗口内起够这么多次还留不住，就不再自动重启。
  /// 没有刹车的话，核心一崩就是每条指令都等一次冷启动，而用户只看到「一直在转」。
  private static let launchBudget = 3
  private static let launchWindow: TimeInterval = 60

  /// 记住多少个「结局未知」的 requestKey。够多就行——键是每次提交现铸的，这里只是兜底。
  private static let keyMemory = 128

  /// 核心的 stderr **默认丢弃**，只在这个开关打开时转发到 App 的 stderr。
  ///
  /// 那里面有 `[rpc] …` 这类行，而协议写明 `error.message` 可能含用户原话。App 的 stderr
  /// 在双击启动时会被系统收走，等于绕开 `src/redact.ts` 在磁盘上攒一份明文。
  /// 开关只控制行为，不存数据（`CLAUDE.md` 一、环境变量）。
  private static let logCoreVariable = "BRIGHTSIGHT_VOICE_LOG_CORE"

  /// 写给已经退出的核心会触发 SIGPIPE，默认动作是杀掉整个进程——
  /// 语音条不该因为核心崩了就跟着从屏幕上消失。
  private static let sigpipeIgnored: Void = {
    signal(SIGPIPE, SIG_IGN)
  }()

  private final class PendingCall {
    let requestKey: String?
    let resume: (Result<JSONValue, Error>) -> Void
    var timeout: DispatchWorkItem?

    init(requestKey: String?, resume: @escaping (Result<JSONValue, Error>) -> Void) {
      self.requestKey = requestKey
      self.resume = resume
    }
  }

  /// 调用发起与调用取消是两段不同的代码，取消可能先到。用一个只在串行队列上访问的小盒子
  /// 把它们串起来：取消先到就把 `cancelled` 立起来，发起那一段看到了就不发。
  private final class CallSlot: @unchecked Sendable {
    var id: Int?
    var cancelled = false
  }

  private let queue = DispatchQueue(label: "com.brightsight.core-session")
  private let handleTimeout: Duration
  private let forwardsCoreLog: Bool

  private var process: Process?
  private var input: FileHandle?
  private var reader = CoreLineReader()
  private var calls = CoreCallTable<PendingCall>()
  private var inboundInFlight: Set<Int> = []
  private var health = CoreTransportHealth()
  private var serverId: String?
  /// 当前这个核心进程上用过的幂等键。它一重启，这些键的结局就再也没人能回答。
  private var keysOnCurrentServer: [String] = []
  private var unknownOutcomeKeys: [String] = []
  private var recentLaunches: [Date] = []
  private var lastExitReason: String?
  /// 第几次启动。
  ///
  /// 进程回调是异步的：上一个核心的 stdout 残余和 terminationHandler 完全可能在下一个核心
  /// 已经起来之后才到。不带世代号的话，晚到的退出通知会把**新**进程的状态一起抹掉，
  /// 而晚到的字节会被拌进新进程的行缓冲里——两种都是只在重启前后偶发、事后完全查不出来的故障。
  private var generation = 0

  init(handleTimeout: Duration = CoreSession.defaultHandleTimeout, environment: [String: String] = ProcessInfo.processInfo.environment) {
    self.handleTimeout = handleTimeout
    self.forwardsCoreLog = environment[CoreSession.logCoreVariable] == "1"
  }

  // ── 对外 ────────────────────────────────────────────────────────────────────

  /// 一条用户指令。
  ///
  /// - Parameters:
  ///   - requestKey: 幂等键，一条指令一个。本类**没有任何自动重发路径**，所以它在这里的作用是
  ///     兜底：万一将来谁加了重试，同一个键不会让副作用发生第二次。
  ///   - execute: 没有默认值是刻意的。协议那边省略等于 dry-run，调用处必须自己把这一位写出来，
  ///     「忘了接线」的后果才会是什么都没发生，而不是在别人的浏览器里开一个标签页。
  func handle(utterance: String, requestKey: String, execute: Bool) async throws -> CoreSessionUpdate {
    let params = JSONValue.object([
      CoreProtocol.requestKeyField: .string(requestKey),
      "utterance": .string(utterance),
      "execute": .bool(execute),
    ])
    let result = try await call(
      method: CoreProtocol.methodSessionHandle,
      params: params,
      requestKey: requestKey,
      timeout: handleTimeout
    )
    return try CoreSessionUpdate(json: result)
  }

  /// 同意一个具体的挂起点。confirmId 是核心现铸的不透明 id，Swift 只负责原样回传。
  func confirm(runId: String, confirmId: String, requestKey: String) async throws -> CoreSessionUpdate {
    let params = JSONValue.object([
      CoreProtocol.requestKeyField: .string(requestKey),
      "runId": .string(runId),
      "confirmId": .string(confirmId),
      "approved": .bool(true),
    ])
    let result = try await call(
      method: CoreProtocol.methodSessionConfirm,
      params: params,
      requestKey: requestKey,
      timeout: handleTimeout
    )
    return try CoreSessionUpdate(json: result)
  }

  /// 取消站在安全的一边，不会发出待确认的 Apple Event，所以协议不需要 requestKey。
  func cancel(runId: String) async throws -> CoreSessionUpdate {
    let result = try await call(
      method: CoreProtocol.methodSessionCancel,
      params: .object(["runId": .string(runId)]),
      requestKey: nil,
      timeout: handleTimeout
    )
    return try CoreSessionUpdate(json: result)
  }

  func shutdown() {
    queue.async { self.terminateProcess(reason: "App 退出") }
  }

  // ── 出站调用 ────────────────────────────────────────────────────────────────

  private func call(method: String, params: JSONValue, requestKey: String?, timeout: Duration) async throws -> JSONValue {
    let slot = CallSlot()
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<JSONValue, Error>) in
        queue.async {
          self.startCall(slot: slot, method: method, params: params, requestKey: requestKey, timeout: timeout) { result in
            continuation.resume(with: result)
          }
        }
      }
    } onCancel: {
      queue.async { self.cancelCall(slot) }
    }
  }

  private func startCall(
    slot: CallSlot,
    method: String,
    params: JSONValue,
    requestKey: String?,
    timeout: Duration,
    completion: @escaping (Result<JSONValue, Error>) -> Void
  ) {
    if slot.cancelled {
      completion(.failure(CancellationError()))
      return
    }
    // 这个键的结局没人能回答（上一次超时、被取消，或核心中途没了）。不重发——
    // 那条指令可能已经在用户的浏览器里开过标签页了。这是整个幂等设计里唯一兜不住的缺口，
    // 所以它必须在这里显式撞墙，而不是悄悄再发一次
    if let requestKey, unknownOutcomeKeys.contains(requestKey) {
      completion(.failure(CoreCommandError.outcomeUnknown))
      return
    }

    do {
      try ensureRunning()
    } catch {
      completion(.failure(error))
      return
    }

    let id = calls.allocate()
    slot.id = id
    guard let line = CoreOutbound.request(id: id, method: method, params: params).line() else {
      completion(.failure(CoreCommandError.rpc(CoreError(.internalError, "请求无法序列化"))))
      return
    }

    let pending = PendingCall(requestKey: requestKey, resume: completion)
    calls.register(id, pending)
    do {
      try write(line)
    } catch {
      _ = calls.take(id)
      // 写不进去说明管道已经断了。字节到底落地没有这里分不清，所以按最坏的算
      markOutcomeUnknown(requestKey)
      terminateProcess(reason: "stdin 写入失败")
      completion(.failure(requestKey == nil
        ? CoreCommandError.rpc(CoreError(.peerGone, "执行核心不在运行"))
        : CoreCommandError.outcomeUnknown))
      return
    }
    if let requestKey { keysOnCurrentServer.append(requestKey) }

    let seconds = Int(timeout.components.seconds)
    let work = DispatchWorkItem { [weak self] in self?.timeoutCall(id, seconds: seconds) }
    pending.timeout = work
    queue.asyncAfter(deadline: .now() + Self.interval(timeout), execute: work)
  }

  private func timeoutCall(_ id: Int, seconds: Int) {
    guard let pending = calls.take(id) else { return }
    // 不顺手把核心杀掉：它可能正跑在 act 与 verify 之间，杀掉等于 Apple Event 已经发出去了，
    // 验证和留痕永远不会落地。等不下去的是我们，不是它
    markOutcomeUnknown(pending.requestKey)
    pending.resume(.failure(CoreCommandError.timedOut(seconds: seconds)))
  }

  private func cancelCall(_ slot: CallSlot) {
    slot.cancelled = true
    guard let id = slot.id, let pending = calls.take(id) else { return }
    pending.timeout?.cancel()
    // 取消只能拦住「还没发生的下一步」，已经投递出去的 Apple Event 不会回滚，所以结局同样未知
    markOutcomeUnknown(pending.requestKey)
    pending.resume(.failure(CancellationError()))
  }

  // ── 进程 ────────────────────────────────────────────────────────────────────

  private func ensureRunning() throws {
    if let process, process.isRunning { return }
    try launch()
  }

  private func launch() throws {
    let now = Date()
    recentLaunches = recentLaunches.filter { now.timeIntervalSince($0) < Self.launchWindow }
    guard recentLaunches.count < Self.launchBudget else {
      let tail = lastExitReason.map { "：\($0)" } ?? ""
      throw CoreCommandError.coreUnavailable("执行核心反复退出，已经停止自动重启\(tail)")
    }
    guard let entry = CoreLocator.resolve(
      bundleResources: Bundle.main.resourceURL,
      executable: Bundle.main.executableURL,
      environment: ProcessInfo.processInfo.environment
    ) else {
      throw CoreCommandError.missingCore
    }
    _ = Self.sigpipeIgnored

    generation += 1
    let launched = generation
    let process = Process()
    let stdin = Pipe()
    let stdout = Pipe()
    let stderr = Pipe()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    // `-l` 是为了拿到登录 shell 的 PATH：App 自己的环境里通常没有 node。
    // 用户原话不再出现在 argv 里——它走 stdin 上的 JSON，脚本文本中没有任何可被拼接的位置
    process.arguments = [
      "-lc",
      "cd -- \"$1\" && exec node \"$2\" serve",
      "bright-sight",
      entry.root.path,
      entry.script.path,
    ]
    process.standardInput = stdin
    process.standardOutput = stdout
    process.standardError = stderr

    stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let chunk = handle.availableData
      guard !chunk.isEmpty else {
        handle.readabilityHandler = nil
        return
      }
      self?.queue.async { self?.ingest(chunk, generation: launched) }
    }
    let forwards = forwardsCoreLog
    stderr.fileHandleForReading.readabilityHandler = { handle in
      let chunk = handle.availableData
      guard !chunk.isEmpty else {
        handle.readabilityHandler = nil
        return
      }
      // 必须读，哪怕丢掉：不读的话 64 KB 的管道写满，核心就阻塞在 write 上不动了，
      // 表现为「指令跑到一半永远不返回」——这次改造之前正好踩过这个坑
      guard forwards else { return }
      FileHandle.standardError.write(chunk)
    }
    process.terminationHandler = { [weak self] finished in
      let status = finished.terminationStatus
      let reason = finished.terminationReason
      self?.queue.async { self?.handleExit(generation: launched, status: status, reason: reason) }
    }

    do {
      try process.run()
    } catch {
      throw CoreCommandError.launchFailed(error.localizedDescription)
    }
    // 父进程必须放掉自己那份读写端的写端，否则子进程退出了也等不到 EOF
    try? stdout.fileHandleForWriting.close()
    try? stderr.fileHandleForWriting.close()

    recentLaunches.append(now)
    self.process = process
    self.input = stdin.fileHandleForWriting
    reader.reset()
    serverId = nil
    keysOnCurrentServer.removeAll()
    inboundInFlight.removeAll()
  }

  private func handleExit(generation: Int, status: Int32, reason: Process.TerminationReason) {
    // 上一代的退出通知晚到了，而这一代正跑得好好的：什么都别动
    guard generation == self.generation else { return }
    lastExitReason = reason == .uncaughtSignal ? "被信号 \(status) 终止" : "退出码 \(status)"
    abandonProcess()
  }

  private func terminateProcess(reason: String) {
    guard process != nil else { return }
    lastExitReason = reason
    abandonProcess()
  }

  /// 把当前这个核心从状态里摘干净，并让在飞的调用全部落定。
  ///
  /// 主动重启和核心自己崩掉走同一条路径：两条各写一份的话，「重启之后旧 key 还能重发」
  /// 这类缺口只会在其中一条上被堵住。
  private func abandonProcess() {
    // 这一代到此为止：它的退出通知和管道残余字节之后再到，都不再作数
    generation += 1
    // 先关 stdin：`serve` 收到 EOF 会把在飞的处理排空再退（见 src/cli.ts 末尾），
    // 比直接 SIGTERM 少一类「Apple Event 发出去了、验证没落地」的残局
    try? input?.close()
    input = nil
    if let process, process.isRunning { process.terminate() }
    process = nil
    reader.reset()
    serverId = nil
    inboundInFlight.removeAll()
    poisonKeysOnCurrentServer()

    for pending in calls.takeAll() {
      pending.timeout?.cancel()
      // 带幂等键的是一条真会动手的指令：核心中途没了，做到哪一步这边看不见，
      // 只能说「结局未知」并把决定权交回给人
      pending.resume(.failure(pending.requestKey == nil
        ? CoreCommandError.rpc(CoreError(.peerGone, "执行核心已经退出"))
        : CoreCommandError.outcomeUnknown))
    }
  }

  private func write(_ data: Data) throws {
    guard let input else { throw CoreCommandError.rpc(CoreError(.peerGone, "执行核心不在运行")) }
    try input.write(contentsOf: data)
  }

  private func send(_ outbound: CoreOutbound) {
    guard let line = outbound.line() else { return }
    try? write(line)
  }

  // ── 入站 ────────────────────────────────────────────────────────────────────

  private func ingest(_ chunk: Data, generation: Int) {
    // 上一代残留在管道里的字节。拌进新一代的行缓冲会把它的第一条消息切坏
    guard generation == self.generation else { return }
    for line in reader.ingest(chunk) {
      switch line {
      case .text(let text):
        route(line: text)
      case .oversized(let bytes):
        report(CoreError(.oversizedLine, "单行超过 \(CoreProtocol.maxLineBytes) 字节（收到 \(bytes)），已丢弃并重新对齐"))
      case .undecodable(let bytes):
        report(CoreError(.parseError, "有一行 \(bytes) 字节不是合法 UTF-8，已丢弃"))
      }
    }
  }

  private func route(line: String) {
    switch CoreRouter.route(CoreParsedMessage.parse(line), pending: calls.ids, inbound: inboundInFlight) {
    case .settle(let id, let result):
      settle(id: id, result: result)
    case .dispatch(let id, let method, _):
      // 阶段 4 的 ax.observe / ax.perform 还没有实现。如实回 method_not_found，**不断开连接**：
      // 断开的话，对面每加一个方法都会变成一次破坏性变更（兼容规则 1）
      send(.failure(id: id, error: CoreError(.methodNotFound, "Swift 侧还没有实现 \(method)")))
    case .notify(let method, let params):
      notify(method: method, params: params)
    case .respond(let id, let error):
      applyHealth(health.record(error))
      send(.failure(id: id, error: error))
    case .report(let error):
      report(error)
    }
  }

  private func settle(id: Int, result: CoreCallResult) {
    guard let pending = calls.take(id) else { return }
    pending.timeout?.cancel()
    switch result {
    case .success(let value):
      health.recordSuccess()
      // 这个进程能正常回话，之前那几次重启不再算数
      recentLaunches.removeAll()
      pending.resume(.success(value))
    case .failure(let error):
      applyHealth(health.record(error))
      // 超时和 replay_unavailable 的共同点是「副作用发生没有，问不出来」，
      // 其余方法层错误（参数不合法、缺凭证）都发生在执行之前，键可以继续用
      if error.code == .requestTimeout || error.code == .replayUnavailable {
        markOutcomeUnknown(pending.requestKey)
      }
      pending.resume(.failure(CoreCommandError.rpc(error)))
    }
  }

  private func notify(method: String, params: JSONValue) {
    switch method {
    case CoreProtocol.notifyServerReady:
      ready(params)
    case CoreProtocol.notifyTransportError:
      // 对面读不懂我们发过去的东西。它自己已经处理了，这边只记一笔健康度
      applyHealth(health.record(CoreError(wire: params["error"] ?? .null)))
    default:
      break // 不认识的通知静默忽略（兼容规则 2）
    }
  }

  private func ready(_ params: JSONValue) {
    if let version = params["protocol"]?.intValue, version != CoreProtocol.version {
      let mismatch = CoreCommandError.protocolMismatch(core: version, app: CoreProtocol.version)
      lastExitReason = "协议版本对不上（核心 \(version)，App \(CoreProtocol.version)）"
      for pending in calls.takeAll() {
        pending.timeout?.cancel()
        pending.resume(.failure(mismatch))
      }
      terminateProcess(reason: lastExitReason ?? "协议版本对不上")
      return
    }
    let incoming = params["serverId"]?.stringValue
    if let previous = serverId, previous != incoming {
      // serverId 变了 = 核心重启过。幂等缓存只活在它的进程内存里，于是「上一条指令到底
      // 执行没执行」这个问题再也没人能回答。旧键一律封存：不重发，换个新键发同一条也不行
      poisonKeysOnCurrentServer()
    }
    serverId = incoming
  }

  private func report(_ error: CoreError) {
    applyHealth(health.record(error))
    send(.notification(method: CoreProtocol.notifyTransportError, params: .object(["error": error.json])))
  }

  private func applyHealth(_ verdict: CoreTransportHealth.Verdict) {
    guard verdict == .restart else { return }
    // 传输层错误反复出现说明这条线本身坏了（读不出来的行、对不上号的 id）。重启是唯一能把
    // 两侧状态重新对齐的手段；进程不在的时候下一条指令会自己把它拉起来
    terminateProcess(reason: "传输层错误反复出现")
  }

  private func markOutcomeUnknown(_ key: String?) {
    guard let key, !unknownOutcomeKeys.contains(key) else { return }
    unknownOutcomeKeys.append(key)
    if unknownOutcomeKeys.count > Self.keyMemory {
      unknownOutcomeKeys.removeFirst(unknownOutcomeKeys.count - Self.keyMemory)
    }
  }

  private func poisonKeysOnCurrentServer() {
    let keys = keysOnCurrentServer
    keysOnCurrentServer.removeAll()
    for key in keys { markOutcomeUnknown(key) }
  }

  private static func interval(_ duration: Duration) -> DispatchTimeInterval {
    let parts = duration.components
    let milliseconds = parts.seconds * 1000 + parts.attoseconds / 1_000_000_000_000_000
    return .milliseconds(Int(clamping: milliseconds))
  }
}
