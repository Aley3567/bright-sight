# Bright Sight V2 设计

本文处于决策阶段，只写会影响实现的结构、约束和验收；规划能力不代表已经实现。

仓库里现在实际有的是：冻结脚本白名单上的 observe → judge → policy → act → verify 闭环、长驻 JSON-RPC、Compact 确认气泡。对照见 [`agent-v2-progress.md`](agent-v2-progress.md)。读到「已实现」四个字时，只相信那一段自己划定的范围，不要把整节 Session / Capability / 事件流都当成落地。

## 1. 产品主线

Bright Sight 接收语音、文字或定时触发，理解目标后操作浏览器和桌面软件。信息不足就追问，动作有风险就确认，界面变化就重新观察，执行后用代码验证。用户纠正过的做法可以沉淀为候选记忆，经检查和确认后复用。

全系统只有一条因果链：

```text
输入 → Session → 当前动作面 → 决策 → Policy → 执行与验证 → 结果
         ▲                                              │
         └──────────── 追问 / 确认 / 用户纠正 ───────────┘
```

这条链是方案的组织原则。语音、浏览器、Accessibility、定时任务和自进化都接入同一条链，不各自复制控制流。

## 2. 两种产品模式

Bright Sight 只有一个 Agent 和一条 Session 因果链，界面提供两种可切换的投影，不复制执行逻辑。

> **状态：产品设计已确定，Workspace 尚未实现。** 当前 macOS 顶部胶囊只是 Compact Mode 的早期实现，
> 不能因为本文定义了 Workspace、事件流和记忆管理界面就假设仓库里已经存在这些能力。

### 2.1 Compact Mode

Compact Mode 是默认入口，服务快速发起和低打扰使用：

- 输入文字或按住说话；
- 显示当前动作的短摘要；
- 承接追问、风险确认、停止和最终结果；
- 提供“查看详情”与“有问题”入口。

它不保存自己的任务状态，也不根据按钮点击或 CLI 输出推断任务是否成功。显示内容应全部来自 Session
事件与代码验证结果。

> **落地差：** 当前胶囊投影的是一次 `session.handle` / `confirm` 的 `SessionUpdate`，不是
> §2.3 的 `BrightSightEvent` 流。追问、查看详情、有问题入口都还没有；`needs_input` 被呈现为
> 未完成。Native Launcher 打开本机 App 不经 Session。这些与「UI 不拥有业务状态」的张力见
> progress 未决分叉。

### 2.2 Workspace Mode

Workspace Mode 是同一个 Session 的展开式审阅和纠正界面，不是第二个 Agent，也不是另一条执行链。
它至少提供：

- `History`：历史 Session 及其完成、阻塞或取消结局；
- `Current Run`：当前目标、约束、确认点和验证结果；
- `Steps`：脱敏后的语义步骤、effect、执行状态与证据；
- `Feedback`：修改意图、实体、目标、步骤或验收条件；
- `Memory`：查看候选记忆的来源、版本、作用域和验证，执行启用、暂停、拒绝、回滚与遗忘。

Compact 与 Workspace 必须共享 `sessionId`、`runId`、确认恢复点和事件流。切换模式不会新建 Session；
Workspace 默认只读同一份运行投影，只有用户明确提交纠正或记忆操作时才写入。

### 2.3 UI 事件接口

UI 不解析 CLI `stdout`。核心产生统一事件，CLI、Compact 和 Workspace 使用不同 Adapter 投影同一事件流：

```ts
type BrightSightEvent =
  | { kind: "session_updated"; sessionId: string; update: SessionUpdate }
  | { kind: "run_started"; sessionId: string; runId: string; goal: Goal }
  | { kind: "step_updated"; runId: string; step: JournalStep }
  | { kind: "confirmation_requested"; runId: string; request: ConfirmationRequest }
  | { kind: "verification_finished"; runId: string; result: VerifyResult }
  | { kind: "memory_candidate_created"; sessionId: string; memoryId: string };
```

展示态可以细分为 `idle / listening / deciding / acting / verifying / done / confirm / error`，但它们不替代
`SessionStatus`。前者是 UI 投影，后者是调用方需要处理的协议结局。

## 3. 生命周期与隔离

Workspace、Session、Run、模型上下文和 Memory 必须分开。它们解决的问题和保留期限不同：

| 层级 | 生命周期 | 权威内容 |
|---|---|---|
| Workspace | 长期 | Session 索引、运行投影、纠正与记忆管理入口 |
| Session | 一个明确目标 | 目标、约束、验收条件、已确认决定、产物引用和未决问题 |
| Run | 一次规划与执行尝试 | 当前计划、步骤、确认恢复点、验证结果和失败证据 |
| Model Context | 一次模型调用 | 当前模型完成这一步所需的最小任务包 |
| Memory | 跨 Session | 用户确认过的偏好、别名和版本化流程 |

Workspace 不是模型上下文，Session 也不是完整聊天记录。完整日志进入 journal；模型只接收从权威状态构建的
有限任务包。

### 3.1 续接、重跑与拆分规则

以下情况继续同一个 Session，并在需要重新规划时创建新 Run：

- 目标和验收条件没有改变；
- 只是页面状态变化、执行失败或需要更换操作路径；
- 用户纠正了目标中的一个参数；
- Browser Adapter 失败后改用 Accessibility Adapter；
- 更换模型，但仍处理同一个目标；
- Compact 展开为 Workspace，或确认后从保存点继续。

以下情况拆成有父子关系的子 Session：

- 子任务可以独立验收或并行完成；
- 需要不同模型、网站、账号或权限范围；
- 子任务失败不应污染主任务；
- 操作风险较高，需要单独确认与审计；
- 当前上下文过长，但仍需保留与原目标的关系。

以下情况新建无继承关系的 Session：用户切换了目标或操作对象、验收条件发生实质变化，或者原任务已经完成或
明确放弃。切换 UI 模式、模型或 Adapter 本身都不是新建 Session 的理由。

### 3.2 Session Snapshot 与模型任务包

Run 之间以及父子 Session 之间传递结构化状态，不复制整段对话、工具输出或模型推理：

```ts
type SessionSnapshot = {
  goal: Goal;
  constraints: Constraint[];
  entities: Entity[];
  decisions: Decision[];
  artifacts: ArtifactRef[];
  unresolved: Question[];
  lastVerifiedState?: VerifiedState;
  memorySuggestions: MemoryRef[];
};

type WorkPacket = {
  sessionId: string;
  runId: string;
  objective: string;
  acceptanceCriteria: string[];
  relevantState: SessionSnapshot;
  allowedCapabilities: CapabilityDescriptor[];
  requiredConfirmations: CapabilityEffect[];
  contextBudget: number;
};
```

模型是可替换 Adapter，只消费 `WorkPacket`，返回计划、缺失信息、结果证据或阻塞原因。模型不能直接拥有
Session 的权威状态。接近上下文预算时，Session Module 从 journal 生成可核对的 checkpoint 和新的
`SessionSnapshot`；原始记录仍留在 journal，不因压缩而丢失，也不继续全部注入模型。

### 3.3 隔离不变量

1. 一个 Run 只能属于一个 Session；子 Session 通过显式父 ID 和结果引用关联。
2. 子 Session 只向父 Session 返回结构化结果、证据和产物引用，不回灌完整上下文。
3. 模型更换不得改变 Policy、已确认范围和验收条件。
4. UI 模式不拥有业务状态；关闭 Workspace 不会中断 Session，除非用户明确停止。
5. Memory 只能作为决策前建议输入，不能成为绕过 Policy 或 Capability Runtime 的执行通道。

## 4. 保留与补齐

V1 已经有四块可靠基础：

- `policy.ts`：纯函数风险闸和 Chrome profile 闸。
- `scripts.ts`、`osa.ts`：冻结脚本与 `argv` 参数通道。
- `verify.ts`：执行回读加外部探针，不让模型自证成功。
- `journal.ts`：脱敏审计记录。

V2 补齐五件事：

1. 动态动作：从当前网页或窗口生成候选，执行前检查它是否仍然有效。
2. 可恢复会话：追问或确认后，从原任务继续。
3. 双模式投影：Compact 快速发起，Workspace 审阅和纠正，两者共享同一 Session。
4. 有限上下文：Run、模型任务包和长期记忆分开，换模型或压缩上下文不丢权威状态。
5. 可验证记忆：把明确偏好、别名和成功路径保存为稳定语义，不保存坐标和临时节点。

## 5. 两个核心执行 Module

### 5.1 Session Module

目标形状：CLI、语音条和调度器只调用一个入口。

```ts
interface AgentSession {
  handle(input: UserInput, signal?: AbortSignal): Promise<SessionUpdate>;
}
```

Session Module 应隐藏目标状态、模型调用、多步循环、追问、确认、取消和持久化。

> **状态：线上结局已落地，Module 本身还没有。** 仓库里没有 `AgentSession` 这个类型。
> Compact 走的是 `session.handle` / `confirm` / `cancel` 这组 RPC 方法
> （[`src/session.ts`](../src/session.ts) 的 `makeSessionMethods`）；SDK、journal、profile、
> execute 和 `resume` 闭包的生产装配在 [`src/cli.ts`](../src/cli.ts) 的 `cmdServe`。
> `bright-sight run` 直接调 `runLoop`，不经过 Session。权威状态是进程内 `RunState`，
> 不是本节后面的 `SessionSnapshot`。把生产装配收到哪一层，见 progress 未决分叉。

**已落地的是一次调用的结局类型**，权威定义在 [`src/protocol.ts`](../src/protocol.ts) 的
`SessionStatus`，本文不复制它。形状与本文早先草拟的七态不同，差别是有理由的：`handle`
的返回值是**一次调用的结局**，不是内部状态机的快照。`idle`、`paused` 从来不会跨出接口；
`running` 出现了只能折成 `blocked`（`session.ts:214`——一个没收敛的 run 不能被说成做完了）；
`waiting_for_clarification` 落地名为 `needs_input`。内部状态机仍然可以比这四态更细，那是
`loop.ts` 的事，不进协议。

`waiting_for_confirmation` 保存恢复位置（已执行步骤、artifacts、待确认动作与参数），`session.confirm`
从原处继续，不把整段历史重新解释成一条新命令（`src/loop.ts` 的 `resumeLoop`/`resumeSteps`）。
挂起只活在同一 `serverId` 的进程内存里，重启后旧 `confirmId` 全部作废——这是刻意的 fail-closed，
不是「可恢复会话」的磁盘实现。`needs_input` 目前**没有**对应的挂起/恢复机制——它只是把状态定住
并返回，见 [`docs/agent-v2-progress.md`](agent-v2-progress.md) 的未决事项。

### 5.2 Capability Runtime

> **状态：尚未实现。** 下面的 `CapabilityAdapter`、`ActionOffer`、`ActionResult` 是阶段 4
> （AX 能力层）的设计草案，仓库里还没有对应符号。已经落地的只有线上协议里的
> `CapabilityDescriptor` 与 `CapabilityEffect`（见 `src/protocol.ts`）。读到这一节时不要
> 假设它存在。

脚本、浏览器和 macOS Accessibility 是三个 Adapter，共用一个 Seam：

```ts
interface CapabilityAdapter {
  prepare(input: PrepareInput): Promise<CapabilityFrame>;
  perform(
    frame: CapabilityFrame,
    action: SelectedAction,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
}
```

`prepare` 负责观察并生成当前动作面。`perform` 内部完成 freshness 检查、真实操作、立即记账和代码验证；调用方拿不到“只执行、不验证”的入口。

```ts
type ActionOffer = {
  id: string;                 // 只在当前 frame 有效
  operation: "CLICK" | "TYPE_TEXT" | "SELECT" | "OPEN" | "WAIT";
  target: { ref: string; role: string; label: string; state?: object };
  effect: "read" | "navigate" | "draft" | "submit" | "change" | "destroy";
  risk: "safe" | "caution" | "destructive";
};

type ActionResult = {
  status: "executed" | "rejected_stale" | "failed" | "effect_unknown";
  artifacts: Artifact[];
  verify: VerifyResult;
  nextFrame?: CapabilityFrame;
};
```

`effect_unknown` 表示副作用可能已经发生，但回读被中断。系统在这里停止，禁止自动重试。

## 6. 动态决策

浏览器和 Accessibility Adapter 每次观察后生成新动作面。模型一次选择操作类型和目标；每种操作只能看到兼容目标。代码只消费被选操作对应的目标答案。

文字输入按以下顺序取值：用户原话、会话 artifact、已确认偏好、枚举值。只有 `TYPE_TEXT` 缺少可复制值时才调用文本模型，输出仍需通过字段 schema。

模型不能生成 selector、坐标、脚本、shell 命令或 JavaScript。节点引用由 Adapter 创建；旧 frame 中的引用不能带入新 frame。

这部分借用 Jev 的动态动作面、真实节点引用和 freshness guard，但保留 Bright Sight 的 Policy 与独立验证：

Jev 只作为动作面实现参考，不承载 Bright Sight 的 Session、上下文或长期记忆。即使 Jev 或其模型上下文
重启、耗尽或被替换，任务目标、确认范围、checkpoint 和验证证据仍由 Session Module 持有，并通过新的
`WorkPacket` 继续；不能把 Jev 内部对话当作权威任务状态。

- <https://github.com/browser-use/jev-ultrafast/blob/main/jev_ultrafast/model.py>
- <https://github.com/browser-use/jev-ultrafast/blob/main/jev_ultrafast/snapshot.js>
- <https://github.com/browser-use/jev-ultrafast/blob/main/jev_ultrafast/agent.py>

## 7. 三个 Adapter

### Script Adapter

现有 Chrome 和 Notes 动作先原样包入新 Seam。新增动作仍要提供冻结源码、参数 schema、effect、超时、产物和验证方法。sdef 只提供候选能力，不自动扩大执行白名单。

### Browser Adapter

Browser Adapter 默认操作自己创建的 tab。用户明确说“当前页面”时，才申请接管现有 tab。

观察包括可见 DOM/ARIA 控件及其值、选中态、展开态、禁用态和相关局部上下文。执行前核对 document、URL、表单状态、目标身份、可见性和遮挡。第一版不支持 frame、shadow root、canvas、上传、弹窗新 tab、任意 JavaScript 和复杂键盘控件；遇到这些情况返回 `blocked`。

### Accessibility Adapter

第一版只支持启动应用、聚焦并替换文本、点击常见控件、选择明确菜单项。元素引用由进程、窗口、AX 路径和属性共同核对，数组下标不能单独作为执行依据。

“填写文字”与“发送、发布、应用设置”始终是两个动作。窗口变化会使旧动作失效；系统不提供坐标点击或任意按键串作为逃生阀。

## 8. Policy

置信度回答“系统有没有理解”，effect 回答“动作会造成什么后果”。两者分开判断：低置信度触发追问，高风险触发确认。

| effect | 默认处置 |
|---|---|
| `read` | 自动执行 |
| `navigate` | 在受控窗口内自动执行 |
| `draft` | 自动填写，不发送 |
| `submit` | 首次或目标变化时确认 |
| `change` | 按可逆性和影响范围确认 |
| `destroy` | 始终确认；定时任务默认禁止 |

Adapter 和技能都不能降低 Policy 给出的限制。`DONE` 只是模型提出完成；Session 根据每一步的验证结果决定最终状态。

## 9. 语音输入

### 9.1 交互

第一版采用按住说话、松开提交：

- macOS：右 Command，已确定。
- Windows：待决策；当前建议右 Ctrl。Windows 键会与系统快捷键竞争，右 Alt 在部分键盘布局上是 AltGr，Caps Lock 带锁定状态。
- partial transcript 只用于界面预览。
- 松键后得到 final transcript，Session 才能据此执行。
- “取消”“停一下”是高优先级控制事件。

快捷键允许用户改绑，平台差异只存在输入层，不进入 Session Module。

界面只保留一个顶部浮动胶囊，而不是把语音、文字和执行状态拆成三个产品入口。空闲态同时提供“按住右 Command 说话”和“输入文字”；菜单栏图标可显示或隐藏胶囊，右键菜单提供同样的替代入口。语音与文字最终都提交同一种文字命令，进入同一条 Session 因果链。

“打开指定软件”作为 Native Launcher 能力处理。它只对本机已安装应用做规范化后的精确匹配，启动完成以后检查系统返回的运行实例；名称模糊或多义时不猜测。该能力不需要辅助功能权限，也不应为每个应用复制一份特例。

语音反馈属于 Session 输出通道。开始执行时可以播报短确认，例如“好的，我来处理”；结束时只朗读核心返回并经过验证的结果，例如“已经打开 Chrome”。UI 不根据按钮点击或脚本返回值自行编造完成反馈。用户可以随时关闭语音反馈，视觉状态仍完整保留。

语音交互必须可打断、可返回。监听态提供完成和取消；转录与执行态提供停止，并允许把当前 transcript 带回文字编辑；失败态保留在屏幕上，提供修改、重新说和重试。助手实际播报时显示输出波形并允许单独停止播报，波形生命周期以 TTS 的开始和结束事件为准，不用固定时长伪装。

### 9.2 中文 ASR 选择

供应商公布的准确率口径不同，不能据此直接选“最佳”。我们用自己的短命令语料做一次 bake-off，候选分为两组：

**云端候选**

- 豆包大模型流式 ASR：支持双向流式、请求级热词、上下文、标点和 ITN。
- 阿里云 Qwen/Fun-ASR Realtime：支持流式输入、中文提示和热词。
- 腾讯云实时 ASR：支持普通话、粤语及请求级临时热词。

**本地候选**

- sherpa-onnx：跨 macOS/Windows，可部署中文 streaming Zipformer、Paraformer、SenseVoice 等模型。
- Apple Speech：作为 macOS 基线；是否可离线取决于 locale 和系统返回的 `supportsOnDeviceRecognition`，且不能解决 Windows 主路径。
- Whisper：作为离线准确率基线，不作为第一版流式交互的默认实现。

官方资料：

- <https://www.volcengine.com/docs/6561/1354871?lang=zh>
- <https://help.aliyun.com/zh/model-studio/asr-model>
- <https://cloud.tencent.com/document/product/1093/40996>
- <https://k2-fsa.github.io/sherpa/onnx/index.html>
- <https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition>

测试集由用户真实说话录制，覆盖：普通指令、中英混说、应用名、人名、网址、数字、连续两步任务、环境噪声和自我修正。每个候选使用相同音频、相同热词和相同分句条件。

评分只看五项：

1. 命令槽位准确率：应用、动作、对象、内容有没有听对。
2. 中文字符错误率。
3. 项目名和应用名的热词召回率。
4. 松键到 final transcript 的延迟。
5. 失败率、成本和离线可用性。

中文识别质量优先于成本。供应商结论由这轮测试产生，设计文档不预设赢家。

## 10. 纠正、记忆与自进化

### 10.1 三种纠正

纠正分成三个层级，不能因为都叫“纠正”就共用一套权限：

| 层级 | 适用情况 | 默认处置 |
|---|---|---|
| 自动执行纠正 | stale、页面变化、安全替代路径、验证明确失败 | 当前 Run 重新观察后有限重试，不形成长期规则 |
| 用户任务纠正 | 意图、实体、目标、步骤或验收条件有误 | 修改当前 Session，保留旧 Run，新建 Run |
| 记忆纠正 | 用户希望以后继续采用同一种做法 | 生成候选，验证并明确范围后才启用 |

自动执行纠正最多尝试两次，每次必须重新观察和规划，不能机械重复相同动作。`effect_unknown`、目标或账号
变化、意图多义、高风险动作以及连续失败必须停止并交给用户。

系统可以自动修复当前执行，也可以自动生成候选记忆，但不能自动永久启用一条新记忆。用户提交纠正后，
当前 Session 可以立即采用；是否跨 Session 保留是另一项明确决定。

### 10.2 审计与长期记忆分离

journal、preference、alias 和 skill 分开存储：

- journal 记录“发生过什么”，包括脱敏步骤、验证结果和 artifact 引用，不参与长期偏好检索；
- preference 记录用户明确选择的结构化偏好；
- alias 记录用户说法与稳定实体的显式映射；
- skill 记录有前置条件、输入、语义步骤和成功判据的版本化流程。

例如，“打开 GitHub 用户 `aley3567` 的主页”应由意图与实体解析直接得到稳定目标，不需要记忆；
“打开我的 GitHub”只有在用户明确绑定后，才形成 `我的 GitHub → github_profile/aley3567` 的 alias。

长期记忆不得保存整段日常对话、普通 Run 的模型上下文、坐标、selector、DOM/AX 临时节点、frame 内
`ActionOffer.id`、临时 argv、模型生成代码或权限扩大规则。原始纠正文本默认不保留；需要保留时由用户
单独选择。

### 10.3 Memory Registry 与检索 Seam

Memory Registry 的外部 Interface 保持窄小：

```ts
interface MemoryRetrieval {
  suggest(context: DecisionContext): Promise<MemorySuggestion[]>;
}

interface CorrectionIntake {
  record(input: ExplicitCorrection): Promise<MemoryCandidate>;
}

interface MemoryLifecycle {
  validate(id: string): Promise<ValidationResult>;
  activate(id: string, consent: ActivationConsent): Promise<MemoryVersion>;
  suspend(id: string): Promise<MemoryVersion>;
  reject(id: string): Promise<MemoryVersion>;
  forget(id: string): Promise<void>;
}
```

`DecisionContext` 只能使用决策前已经稳定存在的 `sessionId`、应用或站点、任务族、意图、实体和请求
effect，不能用执行完成后才知道的完整动作序列。Session 在决策前调用 `suggest`；返回值只是建议，仍需
经过正常决策、Policy、Capability Runtime 与验证。

作用域按 `session → app/site → task family → global` 从窄到宽。当前用户原话和本次显式纠正优先于
所有记忆；同层冲突时追问，模型评分不能静默覆盖用户明确规则。candidate 只供 Workspace 展示或
`use_once`，只有 active 版本可以跨 Session 自动召回。

### 10.4 候选晋升与生命周期

用户纠正后走同一条晋升链：

```text
失败证据 + 用户的新做法
        → 当前 Session 采用
        → 生成候选记忆
        → 权限、输入与作用域检查
        → fixture / dry-run 与负例验证
        → 用户查看步骤、effect、范围和来源
        → 选择仅本次或版本化启用
        → 可查看、暂停、拒绝、回滚与遗忘
```

显式、低风险、结构化 preference 可以在用户点击“始终如此”后直接启用；alias 与多步 skill 必须展示
目标或步骤、作用域、effect 和验证方案后再启用。运行成功次数只增加证据，不能代替首次同意。被拒绝的
版本不可重新激活；新候选生成新版本，不覆写旧候选。

Memory Registry 至少记录 `id`、`version`、`kind`、`status`、`scope`、`body`、`evidenceRefs`、
`validation`、`consent`、`retention` 与时间戳。写入必须原子化；Compact 与 Workspace 并发提交时按
版本检测冲突。

技能保存稳定语义操作、结构化输入和验证条件，不保存 Adapter 的临时引用。一次纠正不能直接修改执行
白名单、Policy、系统提示或已有 schedule 的固定技能版本。

## 11. 定时任务

schedule 绑定固定版本技能和输入，不保存 prompt、坐标或临时节点。触发时创建新 Session，重新观察并重新走 Policy。技能升级不会静默改变旧 schedule。

无人值守任务遇到 `submit`、`change`、`destroy`、登录态变化或验证失败时停止并通知。启用定时任务前，必须以同版本、同输入手动跑通一次。

## 12. 不变量

1. 一个决定最多执行一次。
2. 执行前检查 freshness，执行后由代码验证。
3. 模型输出不能直接成为可执行代码、selector 或坐标。
4. 观察不得覆盖剪贴板、抢占窗口或产生业务副作用。
5. 用户纠正不能直接扩大权限。
6. 高风险动作不会因为来自技能或定时任务而绕过 Policy。
7. 新 Adapter 动作必须同时声明 effect、过期判据、错误语义和验证方法。

## 13. 实施顺序

> 本节的 Phase 0–6 是**产品路线**的编号。实施计划另有一套「阶段 0–6」的编号，两者不对应
> （例如本节 Phase 2 是语音与 ASR，实施计划的阶段 2 是 RPC 进程模型改造）。引用阶段号时
> 必须带上出处，否则指的是哪件事无法判断。

| 阶段 | 交付 | 验收重点 |
|---|---|---|
| 0 | Session、Capability Seam、事件流、现有动作迁移 | 现有行为不变；追问与确认可恢复；事件协议足以投影同一 Run；执行必验证 |
| 1 | Browser Adapter | 搜索、填写、点击；stale、遮挡、导航中断均不误操作 |
| 2 | 按键语音与中文 ASR | partial 无副作用；松键后低延迟得到可靠 final transcript |
| 3 | Accessibility Adapter | 打开应用、写草稿、常见控件；窗口变化使旧动作失效 |
| 4 | Workspace、RunProjection、任务纠正 | Compact 与 Workspace 共用 Session；旧 Run 可审计；纠正创建新 Run |
| 5 | Memory Registry、版本化偏好/别名/技能 | 决策前可召回；候选经过验证和同意；支持暂停、拒绝、回滚和遗忘 |
| 6 | schedule | 固定技能版本与输入；重新观察并经过 Policy；高风险和未知副作用停止 |

Phase 0 不接浏览器 DOM、不接语音、不新增可执行动作。它先把后续能力共用的两条 Interface 钉稳，并证明 V1 的安全性质没有被重构破坏。

## 14. 决策树

需要交给协作者并行研究的问题、任务说明和统一回填格式见 [`agent-v2-collaboration-brief.md`](agent-v2-collaboration-brief.md)。主设计只保留最终裁决。

已经确定：

- 主架构采用一条因果链、两个核心执行 Module、三个执行 Adapter。
- 产品提供 Compact 与 Workspace 两种投影，但共享 Session、Run 和事件流。
- Workspace、Session、Run、模型上下文与 Memory 使用不同生命周期；模型只接收有限 `WorkPacket`。
- 自动执行纠正限于当前 Run；跨 Session 学习必须生成候选并由用户明确启用。
- 第一版记忆覆盖结构化 preference、显式 alias 和候选 skill，禁止保存临时 DOM/AX 引用。
- macOS 使用右 Command 按住说话，松开提交。
- 第一版采用菜单栏入口加顶部单胶囊；语音和文字共用一个 Session 输入面。
- 助手反馈分为执行确认与验证后结果，均由核心产生，UI 只负责展示和朗读。
- 中文 ASR 必须以用户真实语料实测，不按宣传材料直接定供应商。

下一步按此顺序决策：

```text
D1 语音能否上传云端？
 ├─ 可以：云端候选 bake-off，准确率优先
 ├─ 不可以：本地模型 bake-off
 └─ 必须兼顾离线：云端主路 + 本地降级，但实现复杂度最高

D2 Windows 按键是什么？
D3 ASR 候选实测后选主路与降级策略
D6 高风险动作和定时任务怎样授权？
D7 数据保留与删除策略是什么？
```

每次只决定一个节点。决定会写回本节，相关实现才进入下一阶段。
