import Foundation

/// 一次指令跑完之后，面板该进哪个状态。
///
/// 存在的理由是「任务没做成」不等于「出错了」：核心把 `blocked` / `needs_input` 当作
/// 正常工作的产物回给我们（`src/protocol.ts` 里 business 那一层根本不在错误表里）。
/// 只有两种结果的话，这些结局只能挤进「失败」，而用户看到的是「处理失败」，
/// 真实情况却是「等你一句话」。
enum CommandDisposition: Equatable, Sendable {
  case completed
  /// 要人拍板才能继续。必须同时带着 `CommandConfirmation`，否则 UI 会 fail-closed。
  case needsConfirmation
  /// 没做完，而且不是这条线坏了。文案来自 `reasons[].detail`，不是一句通用的「失败」。
  case unfinished
}

/// 核心里一个仍然活着的挂起点。两个 id 都是不透明抓手；reason 才是给人看的理由。
struct CommandConfirmation: Equatable, Sendable {
  let runId: String
  let confirmId: String
  let reason: String
}

/// 一步执行在面板上的展示形态。
///
/// 和线上的 `CoreSessionStep` 分开，是因为那边的 `verified` 是三态可空（null =「这一步没执行，
/// 所以没有可验证的东西」）。把三态留到 UI 去展开，每个渲染点都要重写一遍同样的判断，
/// 而漏掉 null 分支的后果是把「发出去了但没核对」显示成「完成」——那正是这个项目最不能说的谎。
struct CommandStep: Equatable, Sendable {
  enum State: Equatable, Sendable {
    /// 发出去了，但核心没有给出可核对的回读。不是成功。
    case unverified
    case verified
    case failed
  }

  /// 来自动作 id 的 `app.command` 前缀，不是写死的中文名——动作面会自己长出新应用。
  let app: String
  let command: String
  let state: State
}

struct CommandOutcome: Equatable, Sendable {
  let visualSummary: String
  /// nil = 不要念。`replayed` 的结果就走这里：副作用没有再发生一次，播报会让人以为又做了一遍。
  let spokenSummary: String?
  let disposition: CommandDisposition
  let confirmation: CommandConfirmation?
  /// 真正发出去过的步骤。**失败时尤其要有**：这条指令没做成，但副作用可能已经发生了一半，
  /// 「已经动过什么」是用户决定要不要重来时唯一的依据。
  let steps: [CommandStep]

  init(
    visualSummary: String,
    spokenSummary: String?,
    disposition: CommandDisposition = .completed,
    confirmation: CommandConfirmation? = nil,
    steps: [CommandStep] = []
  ) {
    self.visualSummary = visualSummary
    self.spokenSummary = spokenSummary
    self.disposition = disposition
    self.confirmation = confirmation
    self.steps = steps
  }
}

protocol CommandExecuting {
  func execute(
    _ command: String,
    onAccepted: @escaping (String) -> Void
  ) async throws -> CommandOutcome
  func confirm(_ confirmation: CommandConfirmation) async throws -> CommandOutcome
  func cancel(_ confirmation: CommandConfirmation) async throws -> CommandOutcome
}

extension CommandExecuting {
  func confirm(_ confirmation: CommandConfirmation) async throws -> CommandOutcome {
    throw CoreCommandError.rpc(CoreError(.invalidParams, "当前执行器没有可确认的动作"))
  }

  func cancel(_ confirmation: CommandConfirmation) async throws -> CommandOutcome {
    throw CoreCommandError.rpc(CoreError(.invalidParams, "当前执行器没有可取消的动作"))
  }
}

/// Phase 1 only validates the input experience. It never claims a computer action happened.
struct PreviewCommandExecutor: CommandExecuting {
  func execute(
    _ command: String,
    onAccepted: @escaping (String) -> Void
  ) async throws -> CommandOutcome {
    onAccepted("好的，我听到了")
    try await Task.sleep(nanoseconds: 650_000_000)
    return CommandOutcome(
      visualSummary: "指令已捕获；执行器将在下一阶段接入",
      spokenSummary: "指令已经记录，执行器还没有接入"
    )
  }
}

enum CoreCommandError: LocalizedError {
  case missingCore
  case launchFailed(String)
  /// 携带实际用到的秒数，避免超时文案与 `CoreCommandExecutor.executionTimeout` 各写一份、改一处漏一处。
  case timedOut(seconds: Int)
  /// 核心反复退出，已经不再自动重启。
  case coreUnavailable(String)
  /// `server.ready` 报的协议版本与 App 对不上。这不是网络问题，是核心与 App 不是一次构建出来的。
  case protocolMismatch(core: Int, app: Int)
  /// 指令发出去了，但结局问不出来（超时、被取消、核心中途没了）。
  ///
  /// **不是失败，是「不知道」。** 副作用可能已经发生，所以这一侧绝不自动重发；
  /// 要不要再来一次只能由人决定，这是整个幂等设计里唯一兜不住的缺口。
  case outcomeUnknown
  /// 传输层 / 方法层的错误，原样带出核心给的那句话。
  case rpc(CoreError)

  var errorDescription: String? {
    switch self {
    case .missingCore:
      return "应用内没有找到 Bright Sight 执行核心，请重新构建应用"
    case .launchFailed(let detail):
      return "无法启动执行核心：\(detail)"
    case .timedOut(let seconds):
      return "执行超过 \(seconds) 秒，还没有结果；核心可能还在跑，先去看一眼再决定要不要重来"
    case .coreUnavailable(let detail):
      return detail
    case .protocolMismatch(let core, let app):
      return "执行核心的协议版本是 \(core)，应用是 \(app)，请重新构建应用"
    case .outcomeUnknown:
      return "和执行核心的连接中断了，这条指令做到哪一步这里看不到；请先确认一下再决定要不要重来"
    case .rpc(let error):
      switch error.layer {
      case .transport:
        return "和执行核心的连接出了问题：\(error.message)"
      case .method, .unknown:
        // 方法层的 message 已经是给人看的一句话（缺凭证、参数不合法都在这里），原样用
        return error.message
      }
    }
  }
}

/// 把一条指令交给长驻的执行核心。
///
/// 进程长驻而不是一条指令 spawn 一次：连续两条指令复用同一个 Node 进程（动作面、SDK 客户端
/// 都不必重建），而且反向通道一直在，阶段 4 的「Node 决策到一半反过来要求 Swift 观察」才有落点。
final class CoreCommandExecutor: CommandExecuting {
  /// 保留这个名字：`src/cli.ts` 的 `SERVE_DRAIN_TIMEOUT_MS` 在注释里点名跟它对齐。
  static let executionTimeout: Duration = CoreSession.defaultHandleTimeout

  private let applicationLauncher = ApplicationLauncher()
  private let session: CoreSession

  init(session: CoreSession = CoreSession()) {
    self.session = session
  }

  func execute(
    _ command: String,
    onAccepted: @escaping (String) -> Void
  ) async throws -> CommandOutcome {
    // 「打开某个应用」这条捷径绕过核心：它是一次 NSWorkspace 调用，没有模型、没有 AppleScript，
    // 用不着为它把整条闭环跑一遍
    if let target = applicationLauncher.target(for: command) {
      onAccepted("好的，我来打开\(target.name)")
      let name = try await applicationLauncher.launch(target)
      let summary = "已打开\(name)"
      return CommandOutcome(visualSummary: summary, spokenSummary: summary)
    }

    onAccepted("好的，我来执行")
    let update = try await session.handle(
      utterance: command,
      // 一条指令一个幂等键，现铸。重发时才需要复用同一个键，而这一侧没有任何自动重发路径——
      // 核心重启之后旧键的结局没人能回答，那时连「换个新键发同一条」都不许（见 CoreSession）
      requestKey: UUID().uuidString,
      // 显式传：协议那边省略等于 dry-run
      execute: true
    )
    return CoreOutcomeSummary.outcome(for: update)
  }

  func confirm(_ confirmation: CommandConfirmation) async throws -> CommandOutcome {
    let update = try await session.confirm(
      runId: confirmation.runId,
      confirmId: confirmation.confirmId,
      requestKey: UUID().uuidString
    )
    return CoreOutcomeSummary.outcome(for: update)
  }

  func cancel(_ confirmation: CommandConfirmation) async throws -> CommandOutcome {
    CoreOutcomeSummary.outcome(for: try await session.cancel(runId: confirmation.runId))
  }

  func shutdown() {
    session.shutdown()
  }
}
