# Bright Sight V2 进度记录

本文记录**已落地**的实现相对 V1 的行为变化、下一步任务和尚待用户拍板的问题；主设计的结构性决策
不在这里重复，见 [`agent-v2-design.md`](agent-v2-design.md)。**新的一段代码落地、一个决定拍板之后，
应该同步更新本文**（尤其是「当前实现状态」与「未决事项」两节），否则它会和
`agent-v2-design.md` 一样悄悄过期。

## 1. 现在实现到哪一步

RPC 化（阶段 0–3）已经落地；AX 能力层、决策与策略接 AX、权限打包（阶段 4–6）完全没开始。
下面按行为对比写，不按阶段号——阶段号本身不说明用户能感知到什么变化。

### 1.1 通信方式：从「每条指令 spawn 一次」到长驻双向 RPC

- **以前**：Swift 每条指令 `exec node bin/bright-sight.js run ... --execute`，spawn 一次、单向、
  靠 parse 中文 stdout 文本判断结果。
- **现在**：Swift 起一个长驻 Node 子进程，双方用 JSON Lines over stdio 互相发请求
  （`src/rpc.ts` 的 `createPeer`；Swift 侧 `apps/macos/Sources/BrightSightVoice/CoreBridge/CoreSession.swift`）。
  协议由 [`src/protocol.ts`](../src/protocol.ts) 唯一定义（`PROTOCOL_VERSION = 1`，`src/protocol.ts:55`）。
- 结局分类不再 match 中文文案：`src/session.ts` 的 `terminalCode()`（`src/session.ts:151`）纯从
  `RunState` 的结构推导；Swift 侧同理，`CoreOutcomeSummary.swift` 按 `reason.code` 分支
  （`apps/macos/Sources/BrightSightVoice/CoreBridge/CoreOutcomeSummary.swift:32-47`）。
- `cli.ts` 保留了原来一次性的 `cmdRun`（调试/测试用），新增 `serve` 子命令
  （`cmdServe`，`src/cli.ts:177`）跑长驻 RPC 服务端。

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

### 1.6 明确没做的部分（阶段 4–6，一行都没写）

- **AX 能力层**：动作面仍是 `src/scripts.ts` 里编译期写死的 2 个真实动作
  （`Google Chrome.make-tab`、`Notes.make-note`）+ 5 个任务层控制动作，不随当前界面变化。
  `src/types.ts` 的 `ActionSpec.kind` 预留了 `"ax"` 但未被任何代码使用（仅类型占位）。
- **动态决策**（多 head、动态 offers、按 effect/risk 判 policy）没有开始。
- **技能与自进化**、**定时任务**、**Windows/ASR**：均未动代码，属于另一轮协作决策包
  （见 [`agent-v2-collaboration-brief.md`](agent-v2-collaboration-brief.md)）。
- **`needs_input` 没有挂起/恢复机制**：只有 `waiting_for_confirmation` 有上面第 1.5 节那套
  checkpoint/resume；模型追问（`ASK`）落地为 `needs_input` 后，循环直接 `return`
  （`src/loop.ts:353-359`），没有等价的「回答后从原处继续」路径。语音条也没有对应的
  「回答追问」入口（第 6 节未决事项之一）。

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

## 3. 阶段 4–6 剩余计划

以下从一份未纳入本仓库的实现计划文件里摘录，**只摘尚未执行、且逐条核对过仍然成立的部分**；
计划本身已知有错误（例如把 `-25211`/`-1743` 弄混过一次，本文档 1.4 节已用代码验证过正确对应关系）。
摘录条目不重复计划文件的完整论证，只给结论和验收标准；工程细节（数值预算、API 用法）留给动手时
对照实测数据。

### 阶段 4：AX 能力层（Swift，全新，`apps/macos/Sources/BrightSightVoice/AX/`）

- 底层调用封装：进程级 messaging timeout、批量属性读、错误码二分辨别死/忙、`CFEqual` 做身份比较。
- 有界队列：按 QoS 分层，防止一个不响应的进程拖慢所有观察。
- 动作面生成：BFS + 三重预算截断（depth/nodes/wall-clock），大列表分页，未知 role 宽容降级。
- 执行：按属性指纹复验目标身份，不匹配返回 `rejected_stale`；不提供坐标点击或任意按键串
  （对应 `agent-v2-design.md` §12 不变量 3）。
- Electron/CEF 特判：`AXManualAccessibility` 需要 TTL 缓存、每进程只 poke 一次。
- 数值预算（depth/nodes/wall-clock 等）**没有默认值可用**，计划里给的是另一个项目的生产值，
  必须在阶段 4 落地后用真实应用重新量——已列入第 6 节未决事项。

### 阶段 5：决策与策略接上 AX（TS）

- `src/decide.ts` 从单 head 扁平决策改回「一个 operation head + 每种 operation 一个 target head」，
  只校验被选中 operation 对应的 target head。
- `src/surface.ts` 的 `offersFrom` 从「冻结脚本白名单交集」改为「冻结脚本 + 当前 frame 的 AX offers
  合并」。
- `src/policy.ts` 按 effect/risk 判闸（`agent-v2-design.md` §8 的表），现有 Chrome profile 闸
  （`profileBlock()`，`src/policy.ts:92`）保持不变。
- `src/execute.ts` 的 `resolveArgs` 从按字面量 id 硬编码分支改为按 `ActionSpec.kind` 分派；
  安全不变式必须保持——`ScriptTemplate.src` 是编译期冻结脚本，测试逐字断言不含 `${`
  （见 `test/compile.test.ts`，本次未重新核对具体行号）。AX 动作不生成脚本，走 RPC 传结构化参数。
- `src/verify.ts` 需要一个不按 `actionId` 字面量分支的通用契约：执行前记签名、执行后按同签名重新
  定位、比对状态变化。
- **必须补一个「新旧分支同时命中」的测试**：动态 offers 之后，同一条指令可能既命中冻结脚本动作
  又命中 AX offer，需要断言优先级顺序（精确冻结脚本 → AX 特化 → 兜底）确定且被测试覆盖，
  不能只测 AX 顺风路径。这条呼应项目 `CLAUDE.md` 五、「新增一条判据时要补一个新旧分支同时可能命中的测试」。

### 阶段 6：权限与打包

- Accessibility 权限结果在进程内缓存，用户运行期开关不会自动生效，需要轮询
  `AXIsProcessTrusted()` 直到通过。
- **签名稳定性是阻塞项**：TCC 记录绑定签名身份，ad-hoc 签名每次构建都变，会导致 Accessibility
  权限静默失效（表现为「设置里开关是开的但实际无权限」）。签名身份策略未定，见第 6 节。
- `NSAppleEventsUsageDescription` 文案需要更新为如实说明会观察和操作用户指定的应用
  （Accessibility 权限本身不通过 `Info.plist` 声明）。

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
tests 337
pass 334
fail 0
skipped 3
```

```
$ npm run voice:test    # swift test --package-path apps/macos
Executed 74 tests, with 0 failures (0 unexpected)
```

`npm run check` **不包含** Swift 测试——`package.json` 里 `check` = `typecheck && test`，
`voice:test` 是单独一条脚本，两者没有相互调用关系。两边测试要分别跑。

## 6. 未决事项（需要用户拍板）

1. **`needs_input` 追问缺 UI 入口，要不要跟确认气泡一起补**：模型追问（`ASK`）目前落地为
   `needs_input`，语音条没有「回答追问」的入口，`state.fail`/`.unfinished` 分支会把它当失败呈现
   （`CoreOutcomeSummary.swift:41`：`reason.code` 不是 `needsConfirmation` 时落到 `.unfinished`）。
   在阶段 3.3 只做确认气泡、还是把追问回答也一起接上——影响 2.3 节的工作量与 `loop.ts` 要不要给
   `needs_input` 也补一套 checkpoint/resume（目前只有 `waiting_for_confirmation` 有，见 1.6 节）。
2. **`terminalCode()` 的结局映射是否要改**：见第 4 节的详细追踪。改法本身不难（判据从
   `actionId === "ASK"` 换成更精确的信号，比如直接在 `PolicyResult` 里带一个原因标签），但会牵动
   `test/session.test.ts:103-116` 那组用例（尤其是标注「profile 闸」的那一处，其实该测的场景改名字
   之后会更清楚）。这不是本次改动范围内的决定，只报告发现。
3. **`staleness()` 把 `front`/`window` 也计入 freshness 判定，是否过严**：`src/policy.ts:204-207`
   的注释里已经写明这是刻意选择（「用户说好时同意的是他当时看到的那件事，宁可误伤」），
   当前两个真实动作（开标签页、记笔记）都不读这两个字段，所以目前不会因此拦住任何真实场景。
   等阶段 4 引入依赖窗口内容的 AX 动作后，这条判据的严格程度是否合适需要用真实场景重新评估——
   现在没有证据说它是错的，只是没被用到过。
4. **阶段 6 签名身份策略未定**：开发机要求配置 Apple Development 证书（权限稳定），还是接受
   ad-hoc 签名、每次构建后手动 `tccutil reset Accessibility <bundle-id>`？影响阶段 6.2 的实现形态
   和日常调试流程。
5. **阶段 5.6 文本模型凭证未提供**：目前的凭证只有 `TYPESAFE_API_KEY`（`src/session.ts:408`，
   模型判断用）。阶段 5.6「切片切不出时才调文本模型」需要一个独立的文本模型 base_url 与 key，
   用哪家、是否复用现有凭证之外的新凭证，需要用户提供——**本文档不读取、不询问任何 key 的值**，
   只记环境变量名待补。在拿到凭证前，5.6 只能实现切片路径，缺值时如实返回「需要补充信息」。
6. **AX 元素指纹字段与阶段 4 预算数值**：计划里的预算值（depth/nodes/wall-clock）来自另一个项目
   的生产环境，注释本身也说 Bright Sight 是交互式而非常驻采集，这些值未必适用；AX 路径 + 属性
   指纹取哪些字段业界没有标准方案。两者都需要阶段 4 代码落地后，用真实应用实测数据来定，
   不适合在实测前定死。

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
