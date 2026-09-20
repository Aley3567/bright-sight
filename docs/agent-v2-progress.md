# Bright Sight V2 进度记录

本文记录**已落地**的实现相对 V1 的行为变化、下一步任务和尚待用户拍板的问题；主设计的结构性决策
不在这里重复，见 [`agent-v2-design.md`](agent-v2-design.md)。**新的一段代码落地、一个决定拍板之后，
应该同步更新本文**（尤其是「当前实现状态」与「未决事项」两节），否则它会和
`agent-v2-design.md` 一样悄悄过期。

## 1. 现在实现到哪一步

RPC 化（阶段 0–3）、AX 能力层（阶段 4）与「决策和策略接上 AX」（阶段 5）已经落地；权限打包（阶段 6）尚未开始。
下面按行为对比写，不按阶段号——阶段号本身不说明用户能感知到什么变化。

### 1.1 通信方式：从「每条指令 spawn 一次」到长驻双向 RPC

- **以前**：Swift 每条指令 `exec node bin/bright-sight.js run ... --execute`，spawn 一次、单向、
  靠 parse 中文 stdout 文本判断结果。
- **现在**：Swift 起一个长驻 Node 子进程，双方用 JSON Lines over stdio 互相发请求
  （`src/rpc.ts` 的 `createPeer`；Swift 侧 `apps/macos/Sources/BrightSightVoice/CoreBridge/CoreSession.swift`）。
  协议的人读契约在 [`src/protocol.ts`](../src/protocol.ts)（`PROTOCOL_VERSION = 1`，`src/protocol.ts:55`）。
  Swift 侧是手抄影子 `CoreProtocol.swift`，会漂移：行上限 Node 按字符、Swift 按字节；未知 error
  code 两侧缺省不同。没有 codegen，对齐靠平行测试。不要把它读成可执行的同一 Interface。
- 结局分类不再 match 中文文案：`src/session.ts` 的 `terminalCode()`（`src/session.ts:151`）纯从
  `RunState` 的结构推导；Swift 侧同理，`CoreOutcomeSummary.swift` 按 `reason.code` 分支
  （`apps/macos/Sources/BrightSightVoice/CoreBridge/CoreOutcomeSummary.swift:32-47`）。
- `cli.ts` 保留了原来一次性的 `cmdRun`（调试/测试用，**直接 `runLoop`，不经 Session，
  没有 `session.confirm` 入口**），新增 `serve` 子命令（`cmdServe`，`src/cli.ts:177`）
  跑长驻 RPC 服务端。SDK / journal / profile / execute / resume 闭包的生产装配写在
  `cmdServe` 里，不在 `session.ts`——`session.ts:24-27` 自己承认接线在 CLI。
  这是现状，生产装配收到哪一层仍未拍板。

### 1.2 长驻进程的可靠性：从「跑一次就完」到显式生命周期管理

- pid 复用：`ensureRunning()` 只在进程不在跑时才重新 `launch()`（`CoreSession.swift:204-207`）。
- 崩溃/超时/取消统一走同一条收尾路径 `abandonProcess()`（`CoreSession.swift:306-328`），带幂等键的
  在飞调用一律标记「结局未知」而不是静默重发——`timeoutCall()` 明确**不**杀进程
  （`CoreSession.swift:185-191`，注释：它可能正跑在 act 与 verify 之间，杀掉等于验证和留痕永远落不了地）。
- 反复启动失败有刹车（`launchBudget = 3` / `launchWindow = 60s`，`CoreSession.swift:19-20`），
  用 `generation` 计数器防止晚到的退出通知/残留字节污染新进程状态（`CoreSession.swift:77`）。
- `serverId` 变化即判定核心重启过，把这一代用过的幂等键全部封存（`poisonKeysOnCurrentServer()`，
  `CoreSession.swift:447-451`）——重启后旧的确认/取消 id 全部失效，这也是 `session.ts` 里
  「挂起状态只存内存，不落盘」（`src/session.ts:29-33` 的模块注释）成立的另一半前提。
- 核心定位遵循「精确 → 特化 → 兜底」：打包资源 `core/` → 开发期环境变量
  `BRIGHTSIGHT_CORE_ROOT` → 从可执行文件向上找（最多 8 层）（`CoreLocator.swift:26-52`）。

### 1.3 模型调用：从「无超时无重试」到超时 + 受控重试

- `src/decide.ts`：`MODEL_TIMEOUT_MS = 25_000`（`src/decide.ts:49`）、
  `MAX_MODEL_RETRIES = 3`（`:52`）、只对 `429/503/529` 重试（`RETRYABLE_STATUS`，`:59`）。
- SDK 自带的重试被显式关掉（`NO_SDK_RETRY = { maxRetries: 0 }`，`:80`）——两层重试相乘、
  且 SDK 内部退避会吃掉外层的超时预算，会导致看到的是超时而不是真实错误。

### 1.4 权限感知：从「静默吞掉」到按错误码分类

- `src/perceive.ts` 把「问前台应用名」（只需 Automation）与「问窗口/元素」（需 Accessibility）拆成
  两段脚本（`FRONT_SRC`，`:30`；`WINDOW_SRC`，`:56`），后者失败按错误码分类而不是被
  `try...end try` 吞掉：`axFaultOfCode()`（`:158`）。三个错误码分属不同权限类别：
  `-1743` = `errAEEventNotPermitted`（Automation 被拒，`:147`）、
  `-25211` = `kAXErrorAPIDisabled`（Accessibility 被拒，`:151`）、`-1719` 是 System Events 复用来表示
  未获 Accessibility 访问的歧义码，只在首次触碰 AX 的那几步才能读作权限问题
  （`FIRST_AX_STAGE`，`:161`）。

### 1.5 确认/挂起：核心与确认气泡已打通

这条链路已经从核心挂起点打通到 Swift 确认气泡，详见第 2 节：

- `src/loop.ts` 的 `runLoop`/`resumeLoop` 支持挂起-恢复：`policy()` 返回 `confirm` 且带着真实
  `actionId` 时，循环把已执行步骤、artifacts、待确认动作参数存进 `PendingConfirmation.checkpoint`，
  状态置为 `waiting_for_confirmation` 并返回（`src/loop.ts:361-392`）；`resumeLoop` 从该 checkpoint
  继续，**重新 observe** 并核对 freshness（前台应用、窗口标题、Chrome profile 是否漂移，
  `staleness()`，`src/policy.ts:212-225`）后才真正执行（`src/loop.ts:248-266`）。
- `src/session.ts` 的 `makeSessionMethods()` 完整实现并注册了 `session.confirm` / `session.cancel`
  两个 RPC 方法（`:426-445`），`cli.ts` 的 `cmdServe` 把它们接进真实的 RPC peer
  （`methods: makeSessionMethods({...})`，`src/cli.ts:203`）。
- 挂起态只存内存里的一个 `Map`（键是 `runId`），不落盘（`src/session.ts:29-33`）：进程一重启，
  `serverId` 变化会让旧 `confirmId` 全部失效，这是刻意的 fail-closed 设计，不是遗漏。
- Swift 侧已解码 `runId` / `confirmId`，并通过 `CommandConfirmation` 把不透明句柄与给人看的理由一路带到
  `AssistantController`；缺少任一句柄时不会展示一个点了也无法继续的气泡，而是按未完成处理。
- 确认气泡分别展示原始指令（「要做什么」）和核心理由（「为什么需要确认」），确认走
  `session.confirm`，取消走 `session.cancel`。决定发出期间按钮禁用；若恢复后再次挂起，会用新的
  `confirmId` 替换旧挂起点。

### 1.6 阶段 4–5 已落地，阶段 6 尚未接线

- **AX 能力层**：Swift 已实现有预算的树观察、分页动作面、frame/offer 生命周期、属性指纹复验、
  受控执行、有界调度和 Electron/CEF 兼容；Node 已提供 `src/ax.ts` 类型化反向 RPC 封装。
  验收证据、收口修正与人工缺口见 [`phase-4-implementation.md`](phase-4-implementation.md)。
  验收时补掉了三处缺口：poke 失败曾会让整次 `ax.observe` 失败、`CLICK`/`SELECT`/`OPEN` 三条执行
  分支与 `AXRuntime` 调度接线无测试、跨语言常量无门禁。剩下三条显式推迟的缺口（权限失败跨不了线、
  `AXPokeOutcome` 无人消费、`artifacts` 恒空）都记在同一份文档里，并汇入下面第 13–15 条。
- **AX 已进入闭环**：`offersFrom(surface, axFrame?)` 把冻结脚本动作与本轮 AX offers 合并成同一个
  动作面（`src/surface.ts`），`cmdServe` 在每条指令 judge 之前观察一次 frame（`src/cli.ts`）。
  生产动作面因此不再只有 `src/scripts.ts` 里那 2 个写死的真实动作 + 5 个任务层动作。
- **动态决策已落地**：`src/decide.ts` 改成两级 head——action head 里每种 operation 一个
  `AX:<OP>` 代表项，每种 operation 各有一个 target head 选具体 offerId；`Decision.targetId`
  与 `executionActionId()` 把两半合成执行层认的那一个 id。policy 按 `spec.kind` 分流、
  按 effect 判闸（见下面第 1.7 节）。
- **技能与自进化**、**定时任务**、**Windows/ASR**：均未动代码，属于另一轮协作决策包
  （见 [`agent-v2-collaboration-brief.md`](agent-v2-collaboration-brief.md)）。
- **`needs_input` 没有挂起/恢复机制**：只有 `waiting_for_confirmation` 有上面第 1.5 节那套
  checkpoint/resume；模型追问（`ASK`）落地为 `needs_input` 后，循环直接 `return`
  （`src/loop.ts:353-359`），没有等价的「回答后从原处继续」路径。语音条也没有对应的
  「回答追问」入口（第 6 节未决事项之一）。
### 1.7 AX 动作在闭环里怎么被拦、被执行、被验证（阶段 5）

- **能力适配层**：`src/capability.ts` 是「一个动作怎么解析、怎么执行」的唯一收敛点。
  `ADAPTERS = [scriptAdapter, axAdapter]`，顺序即语义（精确冻结脚本 → AX 特化 → 无兜底放行）；
  `planOf` 分派、`runAction` 是唯一投递入口。`execute()` 退化成它的稳定库入口，
  `cli.ts` 两处装配直连 `runAction`——不存在「两条路都能执行同一个脚本动作」。
  `axAdapter` 的认领只看本轮 `ctx.ax`（offer 每次 observe 现铸），缺省不认领。
- **能力标签不信任远端**：`axCapabilityFor(operation, role, editable)` 在 Node 侧按 role 自算
  effect/risk，与 Swift `AXOfferFactory` 的映射表平行；两侧不符时 `stricterEffect` /
  `stricterRisk` 取更严的一侧，认不出的组合固定落 `change`/`caution` 且标 `known: false`，
  不降级成 safe。两张表的一致性由 `test/ax.test.ts` 直接读 Swift 源文本的跨语言门禁盯着。
- **policy 第四道硬闸**：`spec.kind === "ax"` 且 effect 是 `change`/`submit`/`destroy` 时一律
  `confirm`。判据用 effect 不用 risk——risk 的兜底档是「认得出才拦、认不出就放行」，
  按 effect 判才是 fail-closed。`isAllowedApp` / `template` / `profileBlock` 三条收窄到脚本动作：
  AX 不发 Apple Event，也不认 Chrome profile 这个概念。
- **verify 不再默认通过**：`exec.ax` 存在时折成一条 `ax_target_state`，只有 `executed` 且
  Swift 复验通过才算成功，`effect_unknown`（副作用可能已发生）一律判负且禁止自动重试；
  认不出的 actionId 判 `unknown_action`，任务层动作用 `isTaskAction` 显式排除，不靠
  「policy 恰好先分流了」这个隐含前提。
- **重复守卫改按目标身份**：AX 的 offerId 每次 observe 都变，拿它当键等于没有守卫。
  `guardKey` 对 AX 动作用 `(operation, app, role, label)` 的规范串（JSON 编码，防 label 自带
  分隔符碰撞），刻意不含 offerId / frameId。
- **确认恢复靠重新认领目标**：挂起时把目标身份记进 `PendingConfirmation.target`，恢复时
  在新 frame 里按身份匹配，要求**恰好唯一**命中；0 个或 ≥2 个都 `blocked` 且零 perform。
  「直接拿挂起时那对 (frameId, offerId) 去执行」被明确否掉——它要么必然 `rejected_stale`，
  要么要求 frame TTL 长到覆盖人的思考时间，后者等于取消 freshness。
- **切片切不出就收手**：`TYPE_TEXT` 的文本只从 `ctx.span` / `ctx.bodySource` 取，与脚本动作
  共用 `sourceValue` 那一套取值语法。切不出值（含空串）时返回带 `stop: "needs_more_input"`
  的失败，`loop` 据此置 `needs_input`——既不消耗恢复预算，也不触发「换条路重试」，
  因为缺输入重试多少次还是缺。刻意不拿空串顶上：空串会让「输入框被清空」看起来像一次成功输入。
- **留痕**：AX 的 offerId 是 Swift 现铸的外部串，在 `judge` 与 `suspend` 两条事件里都走
  `targetId` 字段并被指纹化；`act` 事件的 `ax` 按白名单脱敏（只放行 `status` 与 `verify.ok`）。

- **闭环模型走 `judge(TypeSafeClient)`，不是 `DecisionBackend`。** `DecisionBackend`
  `{route, pick}` 只有 `JevBackend` 一个 Adapter，生产调用在 `probe.ts`。`LoopDeps.decide`
  要的是带 `span` / `bodySource` / `violations` 的 `Decision`，两套 Interface 对不上。
- **`bright-sight probe` 是旁路。** 它面向全量 sdef，不经 Loop / REGISTRY / verify，
  `policy` 不传 `template` / `profile`，没有 `test/probe.test.ts`。USAGE 写明它是连通性探针，
  不是执行入口。
- **freshness 只盖确认恢复路径。** `resumeLoop` 会重新 observe 并跑 `staleness`；顺风
  `execute` 直接 `performAction`（`src/loop.ts:416-428`）。当前防的是「人看气泡的五分钟」，
  不是设计不变量 2 里「每次执行前检查 freshness」。
- **Compact 边上了三块业务邻属状态**：`ApplicationLauncher` 打开本机 App 不进 journal /
  policy / runId；`AssistantController.lastSubmittedCommand` 本地重试会铸新 `requestKey`；
  `unfinished` 被折成 `failure`，追问与失败在面板上不可区分。Native Launcher 按设计可以绕过
  模型，其余两项未拍板。

## 2. 阶段 3.3 确认气泡 UI（已完成）

### 2.1 核心侧已经支持什么

- `session.confirm` / `session.cancel` 已实现并注册（见 1.5 节），语义细节：
  - `approved` 没有缺省值，读不出决定就拒收，不当作任何一种决定（`parseConfirmParams`，
    `src/session.ts:261-272`，理由见其上方注释 `:254-260`）。
  - 「一个决定最多执行一次」在会话层有独立守卫，与 `rpc.ts` 的 `requestKey` 幂等机制正交：
    `answer()`（`src/session.ts:362-400`）用 `pending` → `resuming` → `settled` 三态表，
    挂起点在任何 `await` 之前同步摘走，处理连点两次但 `requestKey` 不同的情况。
  - `SessionUpdate` 只在 `status === "waiting_for_confirmation"` 时带 `confirmId`
    （`sessionUpdateFrom()`，`src/session.ts:228`），不带整份 `checkpoint`——恢复现场信息不该跨进程流动。

### 2.2 UI 侧实现

- `CoreSessionUpdate` 解码 `runId` / `confirmId`；`CoreOutcomeSummary` 只在
  `waiting_for_confirmation` 且两个句柄都存在时生成 `CommandConfirmation`。`needs_input` 没有恢复
  checkpoint，因此即便 reason code 错写成 `needs_confirmation` 也不会借这套 UI 假装可恢复。
- `AssistantState` 的 `.confirming` 态分开保存待办动作、确认理由、不透明句柄和「正在提交决定」状态；
  `AssistantController` 在确认/取消后继续按新的 `SessionUpdate` 分流到完成、再次确认或未完成。
- `VoiceCapsuleView` 展示「要做什么 / 为什么需要确认」两段信息和「取消 / 确认执行」两个按钮；提交中
  显示进度并禁用按钮，防止连点。确认态不显示通用返回按钮，避免本地离开 UI 却把核心挂起点遗留着。
- `VoicePanelController` 的确认态高度按新内容调整为 230 pt；面板仍是 `.nonactivatingPanel`，确认路径
  没有调用 `makeKey()`，不会主动改变 freshness 所依赖的前台应用。

### 2.3 已落地的数据流

`SessionUpdate` → `CoreSessionUpdate(runId, confirmId)` →
`CoreOutcomeSummary.CommandConfirmation` → `AssistantState.confirmation` → 用户决定 →
`CoreSession.confirm/cancel` → 新 `SessionUpdate` → 同一套 outcome/state 分流。

自动化测试覆盖：句柄解码、缺句柄 fail-closed、动作与理由分开保存、确认/取消走不同 RPC 抽象、按钮连点
只提交一次、关闭气泡会取消核心挂起点，以及恢复后再次挂起时替换为新 `confirmId`。

### 2.4 一条硬约束，已核实成立

**确认气泡不能让面板变成最前台/活跃窗口**，否则每一次确认都会被 freshness 检查判定为「世界变了」
而拒绝执行（见 1.5 节 `staleness()` 对 `front` 的比较）。已验证现状满足这条约束：

- `VoicePanel` 的 `styleMask` 含 `.nonactivatingPanel`（`VoicePanelController.swift:30`）——
  这是 AppKit 层面「不抢 key/main 状态」的机制。
- `src/perceive.ts` 读前台应用用的是 `frontmost is true`（`:31`、`:385`），这条判据只认
  「哪个进程是 frontmost」，与 `.nonactivatingPanel` 的语义直接对应。

做确认气泡 UI 时**不要**让按钮点击触发 `panel.makeKey()` 之类会抢 key window 的调用——
`show(preferTyping:)` 里已经有一处这样的调用（`VoicePanelController.swift:76`，只在
`preferTyping` 时触发），是唯一需要小心不要被复制到确认气泡分支里的先例。

## 3. 阶段 4–5 完成状态与阶段 6 剩余计划

以下从一份未纳入本仓库的实现计划文件里摘录；阶段 4–5 已执行，阶段 6 只保留尚未执行、且逐条核对
仍然成立的部分。
计划本身已知有错误（例如把 `-25211`/`-1743` 弄混过一次，本文档 1.4 节已用代码验证过正确对应关系）。
摘录条目不重复计划文件的完整论证，只给结论和验收标准；工程细节（数值预算、API 用法）留给动手时
对照实测数据。

### 阶段 4：AX 能力层（已完成）

- `apps/macos/Sources/BrightSightVoice/AX/` 已实现底层调用、调度、动作面、指纹、受控执行、
  Electron/CEF 兼容与 frame 生命周期；Swift 注册 `ax.observe` / `ax.perform`，Node 侧 `src/ax.ts`
  提供 fail-closed 的类型化封装。
- 自动化覆盖与未授权环境下无法完成的真实 AX 验收，集中记录在
  [`phase-4-implementation.md`](phase-4-implementation.md)，不把跳过的 live 测试写成通过。

### 阶段 5：决策与策略接上 AX（TS，已完成）

落地情况见第 1.7 节，实现相对当初计划的几处出入如实记在这里：

- 计划说「`resolveArgs` 按 `ActionSpec.kind` 分派」。实际做法是把分派提到 `src/capability.ts`
  的 `planOf`/`ADAPTERS`，`resolveArgs` 函数体一字未动，只负责脚本动作的 argv。
  理由是安全重查（注册表 / 白名单 / 破坏性）必须发生在解析 argv **之前**，
  分派留在 `resolveArgs` 里做不到这一点。
- 计划说 policy「按 effect/risk 判闸」。实际第四道闸只按 effect 判，不绕道 risk——
  risk 的兜底档是 `caution`，拿它当唯一判据等于「认得出才拦、认不出就放行」。
- 计划说 `verify.ts` 需要「执行前记签名、执行后按同签名重新定位」的通用契约。实际这件事
  由 Swift 侧在 `ax.perform` 内部完成（阶段 4 已实现的属性指纹复验），Node 侧只把结论
  折成一条 `ax_target_state`。在 Node 侧再做一遍等于重复实现，且拿不到真实 AX 引用。
- 计划要新增一个 `CapabilityEffect` 词表。实际复用了 `src/ax.ts` 已有的 `AxEffect`——
  两者词表逐字相同，按「新逻辑从已有逻辑延伸而非并列新增」应复用。
  `protocol.ts` 的 `CapabilityEffect` 改为 re-export，线值随之从 `create` 变成 `draft`
  （Swift 的 `CoreCapability` 不解析该字段，无 Swift 改动）。
- **「新旧分支同时命中」的测试已补**：`test/surface.test.ts` 断言脚本 id 与 AX offerId 撞车时
  脚本优先（`offersFrom` 跳过同 id 的 AX offer），`test/capability.test.ts` 断言
  `ADAPTERS[0] === scriptAdapter` 且顺序即语义。不是只测 AX 顺风路径。
- 一处 5.5 实现时发现的计划缺口，已就地补掉：两级 head 的 `AX:<OP>` 代表项不在动作面 id 集合里，
  只把 `j.action` 交给 policy 会被当成「未提供的选项」整条拦掉——AX 路径在生产里根本走不通。
  `executionActionId()` 把 action 与 targetId 两半合成执行层认的那个 id。

### 阶段 6：权限与打包

- Accessibility 权限结果在进程内缓存，用户运行期开关不会自动生效，需要轮询
  `AXIsProcessTrusted()` 直到通过。
- **签名稳定性是阻塞项**：TCC 记录绑定签名身份，ad-hoc 签名每次构建都变，会导致 Accessibility
  权限静默失效（表现为「设置里开关是开的但实际无权限」）。签名身份策略未定，见第 6 节。
- `NSAppleEventsUsageDescription` 文案需要更新为如实说明会观察和操作用户指定的应用
  （Accessibility 权限本身不通过 `Info.plist` 声明）。

### 阶段 5.8：同名目标消歧（已完成，计划外）

不在原计划里。动因是「模型看到两条一模一样的选项」这堵墙：动作面里 `AX CLICK：Repository`
可能同时出现六条，字面完全相同，模型无从选起，而这恰好是 jev 这类**约束选择模型**最没有
退路的地方——它只能从给定 id 里挑一个，不能反问、不能输出别的。

做法与官方指导对齐（`docs.typesafe.ai/primitives`：「当选项可能有歧义时，用清楚的描述文字
让选项可区分」），落点是每个选项的说明文字，不是题干里的 state。官方同一份文档把
「Large Irrelevant State」列为 jev 的已知失败模式（*Context grows, accuracy falls*），所以
**只给撞名的 offer 补上下文**，唯一的选项一个字都不加。

三级兜底，逐级只在上一级失效时才启用：

| 级别 | 做法 | 真机实测 |
| --- | --- | --- |
| 1 | 祖先子树文字，从直接父节点逐级向上，最多 3 层 | Chrome 的 GitHub 页面 8 组同名，四组分别在第 1、1、2、3 层区分开 |
| 2 | 位置序数词（「从上往下第 N 个」） | Ghostty 焦点窗口 7 个 `label` 退化成 role 的无名按钮，靠它从 2 个上下文拉到 6 个 |
| — | 到此为止 | 剩下 1 对同名、同容器、同像素坐标——**不存在可用来区分的信息，不编造** |

几个刻意的选择：

- **序数词而非坐标。** 官方 jaggedness 文档把「计数、数字/十六进制/RGB」列为 jev 的弱项，
  把 `(1412, 137)` 丢给它是用它最不擅长的形式表达一个它本可以直接读懂的顺序。
- **位置按需读，不进逐节点批量读取。** 几何只对文字兜不住的那几个元素有意义，而遍历预算是
  500 节点 / 150ms，而真机实测（Chrome 的 GitHub 页面，焦点窗口范围、按生产口径每节点读
  10 个属性）整棵树是 528 节点 / 109ms——余量只有 27%，给每个节点多读两个属性是拿常规路径
  去补一条罕见路径。

  > 订正：本节初稿写的是「整棵树正好顶满 150ms」。那个数字来自更早一次 `application`
  > 范围（包含菜单栏）的测量，焦点窗口范围下是 109ms。结论方向不变，但余量的量级不同，
  > 下一个调预算的人需要的是后面这个数。
- **坐标完全相同的目标共用一个序号。** 各编一个号是在编造一个不存在的区分。
- **`decide.ts` 零改动。** `targetOpts[o.id] = o.summary` 里的 summary 本来就是那道单选题里
  每个选项的说明文字，也就是官方所说的 criteria。改 summary 等于改 criteria。

真机逼出来的两个缺陷（单元测试全绿时都活着）：

1. **一对重叠毙掉整组。** 原先写的是「有目标位置重叠就整组放弃编号」。Ghostty 那 7 个按钮里
   恰好有两个压在同一点上，于是另外五个本来分得开的也一起没了编号。改成并列序号。
2. **序号被自己截掉。** 原先「拼完再统一截断」，而序号拼在末尾，文字一长就把刚拼上的序号截没。
   表面现象是「几何兜底没生效」，实际是生效了又被抹掉。改成先给序号留位再截文字。
   原有的那条测试只断言了长度没超上限——全绿，而真机上序号已经不在了。

### 阶段 5.9：钉死模型版本（已完成，计划外）

`src/decide.ts` 三处 `systemOne` 调用都没传 `model`，SDK 的缺省是 `jev-latest`——一个**会往前
滚的别名**。漂移的后果不是报错而是行为变化：同一句话、同一个动作面，某天开始选另一个目标，
而留痕里看不出任何异常。现在 pin 到 `jev-1.13.0`，并把响应里的 `model` 记进 `backend`
（形如 `jev/jev-1.13.0`）——pin 了不等于对面一定照办，两个值不一致时这是唯一能看出来的地方。

配套一条源码门禁：数 `.systemOne(` 与 `model: JEV_MODEL` 的出现次数，新加一个调用点忘了 pin
会当场红。只靠现有的两条行为测试挡不住第四个调用点。

## 4. 核对中发现、写不进文档正文的问题

- **`session.ts` 的 `terminalCode()` 有一处可能错误的结局映射**，追踪链路：
  `policy.ts:136-138` 在通过 spec/template 检查、但置信度低于阈值时返回
  `{ kind: "ask", actionId: id }`——注意 `actionId` 是一个**真实动作 id**，不是字面量 `"ASK"`。
  `loop.ts:355` 把「`kind === "ask"`」（不管 `actionId` 是什么）一律路由到 `state.status = "needs_input"`。
  但 `session.ts:159-162` 的 `terminalCode()` 用 `last.actionId === "ASK"` 来区分
  `needs_clarification` 和 `needs_confirmation`——于是这条真实可达的低置信度路径会被判成
  `needs_confirmation`（「请批准这个有风险的动作」），而语义上它应该是 `needs_clarification`
  （「我不确定，请说清楚一点」）。这条已经写进第 6 节未决事项，因为怎么改牵动一个既有测试
  （见下一条）。
- **`test/session.test.ts:108-115` 那个标注「profile 闸」的用例，实际测的不是 profile 闸真实会
  走到的路径**：它手工构造 `state("needs_input", [step({actionId: TAB, reasons: ["Chrome profile
  ... 需要当场确认"]})])`，但按真实的 `loop.ts` 控制流，profile 闸命中时 `policy()` 返回的是
  `kind: "confirm"`（`src/policy.ts:144`），`loop.ts:361-392` 会把它路由到
  `waiting_for_confirmation`，不是 `needs_input`——真正走 `needs_input` 分支的 profile 闸场景
  在这份测试里并不存在，`waiting_for_confirmation` 版本的 profile 闸测试在别处
  （`test/session.test.ts:448-452`）。这个手工构造的用例本身没有断言错，只是它起的名字和注释
  暗示了一条测试代码没有真的验证过的可达路径。

## 5. 验证证据

在本仓库根目录实际执行（无真实副作用；有副作用的测试默认 skip，未设置 `BRIGHTSIGHT_LIVE`）：

```
$ npm run check     # tsc --noEmit && node --test 'test/**/*.test.ts'
tests 413
pass 410
fail 0
skipped 3
```

```
$ npm run voice:test    # swift test --package-path apps/macos
Executed 115 tests, with 1 test skipped and 0 failures (0 unexpected)
```

（阶段 5 验收时重跑的数字。Node 从 345 涨到 413，全部是阶段 5 的新增覆盖；Swift 侧阶段 5
一行未改，115/1/0 是回归结果。3 条 skipped 是既有的 `BRIGHTSIGHT_LIVE` 门禁用例。
阶段 4 验收时是 345/342/3，本段此前记的 337/334/3 与 74 是更早一次执行的残留，已作废。）

阶段 5 逐步的门禁数字（每步实现完当场跑 `npm run check`，只增不减）：

| 步 | 内容 | tests / pass / fail / skipped |
|---|---|---|
| 5.0 | 搬家：`capability.ts` 收敛解析与投递 | 351 / 348 / 0 / 3 |
| 5.1 | AX 执行面（`axAdapter`、verify、redact） | 363 / 360 / 0 / 3 |
| 5.2 | 能力标签自算 + 跨语言门禁 | 372 / 369 / 0 / 3 |
| 5.3 | 动作面合并与 policy 分流 | 386 / 383 / 0 / 3 |
| 5.4 | 两级决策 head | 394 / 391 / 0 / 3 |
| 5.5 | 恢复路径与目标重认领 | 402 / 399 / 0 / 3 |
| 5.6 | 切片路径与 `needs_input` 收手 | 410 / 407 / 0 / 3 |
| 收口 | 对抗性复核补测（见下） | 413 / 410 / 0 / 3 |

**对抗性复核补掉的两个缺陷**（复核本身在实现当轮因故未执行，补做时用先红后绿的复现测试确认，
不是读代码读出来的结论）：

1. **AX 动作恢复时被 Chrome profile 闸误伤。** `resumeLoop` 判 `staleness` 要知道待执行动作
   归属哪个 app，原先去 `offerSet.axSpecs` 里按挂起时的 offerId 查——而恢复时的 `offerSet`
   是拿**新 frame** 重建的，旧 offerId 在里面必然查不到，`app` 恒为 `undefined`。
   `staleness` 的缺省是收紧的（`undefined` 按 Chrome 处理），于是一次与 Chrome 毫无关系的
   Finder 点击，会因为 Chrome profile 探测结果变了而被 `blocked`。那一行修复代码在 AX 路径上
   恒不生效，等于死代码。改为从 `pending.target.app`（挂起时记下的目标身份）取，
   脚本动作仍按 id 查 `specs`——它的 id 是冻结常量，跨挂起有效。
2. **挂起留痕原样落下了 AX 的 offerId。** 同一个值在 `judge` 事件里叫 `targetId` 并被明确
   指纹化（Swift 现铸、外部来源），在 `suspend` 事件里却占用了 `actionId` 这个白名单字段，
   等于换个字段名就绕开了脱敏。改为按 `pending.target` 是否存在分流字段名；`redact.ts`
   无需改动——「白名单之外一律指纹化」这条缺省自动接住了它。

`npm run check` **不包含** Swift 测试——`package.json` 里 `check` = `typecheck && test`，
`voice:test` 是单独一条脚本，两者没有相互调用关系。两边测试要分别跑。

## 6. 未决事项（需要用户拍板）

下面 1–8 是设计分叉，拍板前不改行为。9 起是原先就记在这里的工程未决。

1. **Session 的 Interface 认在哪。** 维持「RPC 方法表 + `cli.ts:cmdServe` 装配」（现状），
   还是把 SDK / journal / profile / execute / resume 闭包收成唯一生产 Adapter、
   `cmdRun` 明确降级为调试绕过？设计 §5.1 要的是 `AgentSession.handle` 藏住循环；
   实现里没有这个类型。
2. **CapabilityAdapter 何时立 Seam。** 等 AX 第二个 Adapter 出现再 replace-don't-layer，
   还是现在只立接口、用一个 Script Adapter 包 `REGISTRY` / `loop.performAction`？
   现在抽空端口是多余间接；AX 落地时若在 `resolveArgs` 旁边再开 id 分支，才是更糟的叠加。
3. **闭环模型 Seam 写在哪。** `LoopDeps.decide` / `judge(TypeSafeClient)`（现状，真有两个
   Adapter），还是保留 `DecisionBackend` 给未来两级 `route/pick`？`probe` 是否继续走
   另一套选项集（全量 sdef、policy 不传 template/profile）？
4. **顺风 execute 要不要跑 freshness。** 现在就塞进 `performAction`，还是等动态动作面再放进
   perform 内部？当前只有两条冻结脚本，观察与执行间隔是一次模型往返；误报（任何滚动/切应用）
   可能比缺口更伤。
5. **`needs_input` 要不要对称恢复。** 追问一律新开 handle，还是补 checkpoint/resume？
   语音条要不要「回答追问」入口？与此独立、但现在就在骗人的是 `terminalCode()`：低置信度
   ask 带真实 `actionId` 时会被报成 `needs_confirmation` 且无 `confirmId`（见第 4 节）。
   翻译层是否立刻停止这条映射，是可以单独拍的。
6. **`protocol.ts` 与 Swift 影子如何对账。** 继续人读契约 + 平行测试（现状，行上限单位与
   未知 error code 已分叉），还是生成 / CI 对常量？过期的「CommandExecutor 解析中文 stdout」
   叙述已从协议注释删掉；`RESERVED_CLIENT_METHODS` 名字仍像预约，实际 confirm/cancel 已接通。
7. **挂起不落盘是否升格为设计不变量。** 把「可恢复会话」改口为「同一 `serverId` 内可恢复」，
   避免和设计 §3 的 Session 持久化、§5.1 的「隐藏持久化」打架。现状是刻意 fail-closed：
   重启后「那条指令执行没执行」没人能答。
8. **Compact 的 Native Launcher 与本地重试，是否允许继续绕过 Session。** 打开本机 App
   按设计可以不走模型；`lastSubmittedCommand` 铸新 key 重试、`unfinished` 折成 `failure`，
   与「UI 不拥有业务状态」有张力。
9. **`staleness()` 把 `front`/`window` 也计入 freshness 判定，是否过严。** `src/policy.ts:204-207`
   的注释里已经写明这是刻意选择（「用户说好时同意的是他当时看到的那件事，宁可误伤」），
   当前两个真实动作（开标签页、记笔记）都不读这两个字段，所以目前不会因此拦住任何真实场景。
   等阶段 4 引入依赖窗口内容的 AX 动作后，这条判据的严格程度是否合适需要用真实场景重新评估——
   现在没有证据说它是错的，只是没被用到过。与第 4 条相关，但第 4 条问的是「顺风路径要不要检」，
   这一条问的是「检了这三项是否过严」。
10. **阶段 6 签名身份策略未定。** 开发机要求配置 Apple Development 证书（权限稳定），还是接受
    ad-hoc 签名、每次构建后手动 `tccutil reset Accessibility <bundle-id>`？影响阶段 6.2 的实现形态
    和日常调试流程。
11. **阶段 5.6 文本模型凭证未提供。** 目前的凭证只有 `TYPESAFE_API_KEY`（`src/session.ts:408`，
    模型判断用）。阶段 5.6「切片切不出时才调文本模型」需要一个独立的文本模型 base_url 与 key，
    用哪家、是否复用现有凭证之外的新凭证，需要用户提供——**本文档不读取、不询问任何 key 的值**，
    只记环境变量名待补。在拿到凭证前，5.6 只能实现切片路径，缺值时如实返回「需要补充信息」。
12. **AX 预算仍需真实应用调优。** 阶段 4 已选定保守指纹（进程、窗口、AX 路径、role/subrole、
    identifier、title、value）并把预算做成可注入保护上限；当前未授权 XCTest 宿主无法采集真实应用
    节点数和耗时。调优不阻塞阶段 4 的 fail-closed 实现，但必须在阶段 6 稳定签名和 TCC 后完成，
    详见 `phase-4-implementation.md`。
13. **AX 环境问题没有跨线通道。** 三件事是同一个缺口的三面，建议一起做，否则阶段 6 会撞上「权限
    没开」在 Node 侧与内部错误无法区分：
    - `AXClient` 已经算出 `AXFailureKind.permission`（`AXClient.swift:21-39`），`AXRuntime.coreError`
      却把所有 `AXCallError` 塌缩成 `CoreError(.internalError, …)`，线协议错误码表
      （`CoreProtocol.swift` 的 `CoreErrorCode`）里也没有 permission 档；
    - `AXPokeOutcome` 被 `AXRuntime.observe` 显式丢弃，写 `AXManualAccessibility` 失败只表现为
      动作面变小；
    - 要跨线就得动线协议，牵出第 6 条（影子对账）里 PROTOCOL_VERSION 与未知错误码降级的既有分歧。
14. **`ax.perform` 的 `artifacts` 恒为空数组。** Swift 侧没有 artifacts 生产路径
    （`AXModels.swift` 的 `AXPerformResult.json` 恒发 `[]`），Node 侧 `src/ax.ts` 却要求它必须是
    数组。设计 §5.2 的 `ActionResult` 里有这个字段，等真有产出再接，现在别为了对齐去删。
15. **`AXRuntime.observe` 每次建两次 application。** 一次给 Chromium 兼容探测、一次给遍历本身。
    两次都是本地 `AXUIElementCreateApplication` 加 `AXUIElementSetMessagingTimeout`，没有副作用，
    只是多余；真接线后如果要压观察延迟，这是第一处可以省的地方。

16. **`TYPE_TEXT` 取 `span` 时不 trim，与 Notes 的口径不同。** `sourceValue` 由调用方传入
    span 的取值：Notes 传的是修剪过的标题（它同时就是笔记标题），AX 传的是片段原文
    （「逐字进 value」的直接后果）。两者语义不同但共用一个函数，差异留在调用方并已注释。
    要不要统一成都 trim，需要拍板。
17. **空串来源按缺输入收手。** 设计只点名「来源缺失 / 还没值」两种情况，实现把「取到空串」
    也一并当缺输入（fail-closed，理由是空串会让「输入框被清空」看起来像一次成功输入）。
    如果认为「输入一个空串」是合法动作，需要显式放行。
18. **缺输入时「缺什么」没有透给用户。** 具体文案目前只在 `outcome.result.errors` 里，
    `loop.ts` 只推一句通用的「这一步需要更多信息才能执行」，`session.ts` 的
    `needs_clarification` 分支也不展示 `exec.errors`。要不要透出属产品决定。
19. **`cmdRun` 没有接 AX。** 它没有 RPC peer，`ax` 上下文恒为空，所以 `bright-sight run`
    只能走脚本动作。附带一个后果：`performAx` 的 dry-run 分支返回
    `status: "executed"` + `verify.ok: true`，`verify` 会把它判成通过——这条路径目前只在测试里
    可达，但如果将来给 `cmdRun` 接上 AX，它会打印出一次假的「验证通过」。
20. **`planOf` 的兜底措辞沿用旧文案。** 设计写的是「没有对应的能力适配器」，实现沿用了
    「不在执行模板注册表里」（既有测试按它的片段断言）。两个适配器都不认领时最常见的情形
    确实是「注册表外的脚本动作」，但措辞已经不够准确。
21. **`src/execute.ts` 与 `src/capability.ts` 之间有模块循环。** `execute` 向 `capability`
    提供 `resolveArgs` / `sourceValue`，`capability` 向 `execute` 提供 `runAction`。
    Node ESM 与 `tsc` 都正常，测试全绿。若不接受循环，可把 `resolveArgs` 下沉到 `capability.ts`
    或第三个模块——属重构，未做。

## 7. 尚未做过的人工验收清单

以下项目没有自动化测试覆盖（`VoicePanelControllerTests` 明确只测 `shouldHide()` 这个纯函数，
见 `apps/macos/Tests/BrightSightVoiceTests/VoicePanelControllerTests.swift` 的注释：真实 `NSPanel`/
`NSWorkspace` 行为没法在 `swift test` 里可靠测出），需要用户手动走一遍。

### 7.1 长驻进程模型

1. **同一进程处理连续两条指令**：`npm run voice:open` 打包运行，连续说两条不同指令，
   期间用 `ps aux | grep bright-sight` 观察 `serve` 子进程 pid——两条指令之间 pid 应保持不变
   （对应 `CoreSession.swift:204-207` 的 pid 复用逻辑）。
2. **kill 掉核心后自动重启**：指令执行间隙，`kill <pid>` 杀掉步骤 1 里看到的 node 进程，
   紧接着再说一条指令——预期能成功执行（核心自动重新 `launch()`），且 pid 变了。
3. **反复崩溃后停止自动重启**：60 秒内连续 kill 掉核心 3 次以上，第 4 次指令预期收到
   「执行核心反复退出，已经停止自动重启」这类错误（对应 `launchBudget = 3` / `launchWindow = 60s`，
   `CoreSession.swift:19-20`），而不是又一次冷启动尝试。
4. **执行中途 `kill -9` 不触发自动重试**：发一条真实会执行的指令（比如让它开一个标签页），
   在它跑到一半时 `kill -9` 掉核心进程——预期这条指令返回「结局未知」一类的错误，**不**自动重发，
   且不应该看到重复的副作用（比如没有意外多开出第二个标签页）。这是幂等设计里唯一兜不住的缺口
   （`CoreSession.swift:141-147` 的注释原话），需要人确认它确实呈现为「显式报错」而不是「悄悄重试」。
5. **打包后的 App 用的是内置核心，不是开发机上的仓库副本**：把仓库整个移动到另一个临时目录
   （或者改一下仓库里 `bin/bright-sight.js` 打一个能观察到的标记），保持 `npm run voice:open`
   打包出的 App 不动，重新运行它——预期行为不受仓库移动影响，因为 `CoreLocator.resolve()` 优先用
   `Bundle.main.resourceURL` 下的 `core/`（`CoreLocator.swift:32-37`），不会退回到仓库路径。
6. **协议版本不匹配时的行为**：没有简单的手动触发办法（需要人为改一侧的 `PROTOCOL_VERSION`），
   如果要验收，预期现象是核心进程被终止且收到「协议版本对不上」的错误（`CoreSession.swift:407-417`）。

### 7.2 浮窗行为

1. **拖动不会弹回**：把浮窗拖到屏幕任意位置，完整走一次语音交互（listening → finalizing →
   working → result），观察面板水平位置是否保持在拖动后的位置不回弹；`hide()` 再 `show()` 之后
   应该回到顶部居中（对应 `VoicePanelController.swift:87-91` 的注释与 `resize(for:)` 实现）。
2. **图钉能压住全屏应用**：点亮图钉按钮后，把另一个应用切到全屏，确认面板依然可见
   （对应 `applyPinned()` 把 `panel.level` 从 `.floating` 换成 `.statusBar`，
   `VoicePanelController.swift:131-133`）。
3. **失焦自动隐藏，执行中例外**：不点亮图钉时，切到 Finder，面板应该隐藏；发一条会激活 Chrome
   的指令（比如打开标签页），面板在 `working`/`confirming`/`result`/`failure` 这几个阶段应该
   全程可见，不会因为 Chrome 被激活而把自己藏起来
   （`exemptFromAutoHide`，`VoicePanelController.swift:15`）。
4. **图钉按钮的视觉状态**：确认点亮/熄灭图钉时按钮本身的图标或样式会跟着变化（这一项在代码里
   没有找到具体的按钮实现文件，本次未核实图钉按钮本身在哪个文件、用的是什么图标资源——
   留给验收时直接在界面上确认即可，不依赖代码定位）。
5. **确认气泡端到端**：触发一条需要 profile 确认的真实指令，确认气泡应同时显示原始指令与确认理由；
   点「取消」不应产生 Apple Event，点「确认执行」后应继续执行并显示新结局。点击按钮不应使
   Bright Sight 变成前台应用；提交期间两个按钮应禁用，快速连点也只执行一次。

### 7.3 AX 能力层

阶段 4 的 Finder 只读观察、专用控件执行和 Electron/CEF poke 验收，需要阶段 6 提供稳定签名与
Accessibility 授权。具体步骤和自动化已覆盖边界见 [`phase-4-implementation.md`](phase-4-implementation.md)。
