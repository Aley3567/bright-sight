# 收敛清单：从现在到「App 能用」还差什么

写给**接手这件事的下一个对话**。截至 2026-09-20，分支 `feat/ax-capability-layer`
（`44ed02a`），尚未合回 `main`。

## 0. 先读这几条，否则会重蹈覆辙

**全绿不等于能跑。** 这个项目有 423 个 Node 测试 + 129 个 Swift 测试，全绿。但 Swift 那批
测的是 `FakeAXStore`——我们自己对 macOS 的假设，不是 macOS。已经被真机打脸三次：

- `AXUIElementCopyActionNames` 对 Finder 的 `AXSplitter` 返回通用失败码 `-25200` 而不是
  `ActionUnsupported`，146 个节点里有 21 个这样的元素，一次正常观察被整个带走；
- 几何兜底里「位置重叠就整组放弃编号」，实测某窗口 7 个无名按钮中恰有两个同坐标，
  把另外五个能区分的也毙了；
- 位置序号拼在文字末尾再统一截断，文字一长就把刚拼上的序号截没——生效了又被自己抹掉，
  而原有测试只断言了长度没超上限，全绿。

**所以：涉及 AX 的改动，一律要有真机证据。** 已有两条真机测试可用：

```
BRIGHTSIGHT_LIVE=1 npm run voice:test -- --filter AXRuntimeLiveTests
```

`testDisambiguationContextSeparatesDuplicateLabelsOnTheFrontmostApp` 会把每组同名目标的
实际上下文逐条打出来。**看不懂的数字不能当成通过**——上面第三条缺陷就是靠「为什么是 4 个
而不是 6 个」这个问题查出来的。

**测试要做变异验证。** 写完让它红一次再让它绿，否则你不知道它在测什么。

**本仓的安全约束**（来自 `CLAUDE.md`，不要违反）：
- 排查凭证问题时不读取 token/key 字段，只看名称、base_url 和日志；需要认证的测试让用户自己带 token 跑
- kill/重启 GUI 应用前先确认窗口无未保存内容，优先走优雅退出；验证类操作不要覆盖剪贴板

## 1. 阻塞级：不做这两条，AX 对浏览器完全无效

### 1.1 `depth` 不在协议里，而 depth 6 看不见网页内容

真机实测（Chrome 开着 GitHub，焦点窗口范围，生产口径每节点读 10 个属性）：

| 预算 depth/nodes/ms | 可动作元素 | 遍历节点 | 耗时 | 截断原因 |
| --- | --- | --- | --- | --- |
| **6 / 500 / 150（当前生产值）** | **4** | 22 | 18ms | depth |
| 10 / 500 / 1000 | 42 | 330 | 64ms | depth |
| 12 / 2000 / 1000 | 42 | 516 | 101ms | depth |
| 20 / 5000 / 3000 | 42 | 528 | 109ms | 完成 |

生产只能看到 4 个窗口按钮。**页面上那 42 个元素一个都进不了动作面**，所以阶段 5.8 做的
同名目标消歧对 Chrome 等于没做。

- 现状：`src/ax.ts` 的 `AxObserveParams` 只有 `scope/pid/offset/pageSize`，**没有 depth**；
  `AXModels.swift` 的 `AXObserveParams.init(json:)` 同样不解析它；
  `AXTraversalBudget.protectiveDefault` 是 `maxDepth: 6, maxNodes: 500, maxMilliseconds: 150, pageSize: 80`
- 落点：Swift `AXModels.swift` + Node `src/ax.ts` + `src/cli.ts:237` 的调用点 +
  `test/ax.test.ts` 末尾的跨语言门禁（它真去读 Swift 源文本比对字面量）
- 建议值：depth 12、nodes 800、ms 保持 150（实测整棵树 109ms，余量 27%）
- **验收标准**：真机上对 Chrome 的 GitHub 页面观察，动作面里出现 40 个以上可动作元素；
  `truncated` 不再报 `depth`；跨语言门禁绿；观察耗时仍在 150ms 内

> 注意：不同页面树规模不同，150ms 是在**一个**页面上测的。建议同时测几个重页面
> （长列表、复杂表单）再定 ms，或把 ms 也做成可调。

### 1.2 `bright-sight run` 完全用不了 AX

`cmdRun` 没有 RPC peer，`ax` 上下文恒为空，所以命令行路径永远退化成只有脚本动作。
AX 只在 `cmdServe`（`src/cli.ts:237` 附近，也就是 Swift App 走的那条）上活着。

附带一个**会骗人的分支**：`src/capability.ts` 的 `performAx` 在 dry-run 时返回
`status: "executed"` + `verify.ok: true`，`verify.ts` 会把它判成通过。目前只在测试里可达，
但给 `cmdRun` 接上 AX 的那一刻，它会打印一次假的「验证通过」。

- **验收标准**：要么 `bright-sight run` 能走 AX 且 dry-run 明确不报「验证通过」，
  要么显式把 `cmdRun` 降级为「调试绕过、不支持 AX」并在 `--help` 与 README 里写明
  （这对应未决事项 #1 的拍板）

## 2. 功能完整性

### 2.1 模型看不到「还有没给它看的」

`src/cli.ts:239` 把 `observeAX` 返回的 `truncated` 和 `nextOffset` 直接丢弃，只留
`{ frameId, pid, app, offers }`。动作面被截断时模型不知道，会在一个残缺的集合里硬选，
而且**没有任何办法翻页**。

- **验收标准**：动作面被截断时，模型能从选项说明或 state 里知道「还有未展示的目标」；
  留痕里能看出这次观察是不是截断的

### 2.2 AX 权限失败在线上无法与内部错误区分（未决 #13，三件一起做）

`AXClient` 已经算出 `AXFailureKind.permission`（`AXClient.swift:21-39`），但
`AXRuntime.coreError` 把所有 `AXCallError` 塌缩成 `CoreError(.internalError, …)`，
线协议错误码表（`CoreProtocol.swift` 的 `CoreErrorCode`）里也没有 permission 档。
同时 `AXPokeOutcome` 被 `AXRuntime.observe` 显式丢弃——`AXManualAccessibility` 写失败
只表现为「动作面变小」，没人知道为什么。

这会在阶段 6 直接撞上：**用户没开权限**和**代码有 bug**，在 Node 侧看起来一模一样。

- 要动线协议，牵出未决 #6（`protocol.ts` 与 Swift 影子如何对账）
- **验收标准**：手动关掉 Accessibility 权限后跑一条指令，用户看到的是「需要授权」
  而不是「内部错误」

## 3. 阶段 6：权限与打包（App 真正能交付的前提）

### 3.1 签名身份策略（未决 #10，**需要你拍板**）

TCC 记录绑定签名身份，ad-hoc 签名每次构建都变，会导致 Accessibility 权限静默失效
（表现为「系统设置里开关是开的，但实际无权限」）。

现状：本机已经能跑真机 AX 测试，用的是 `Apple Development: <开发者>` 证书。

两条路：
1. 开发机要求配置 Apple Development 证书（权限稳定，但需要证书）
2. 接受 ad-hoc 签名，每次构建后手动 `tccutil reset Accessibility <bundle-id>`

### 3.2 权限运行期变化不生效

`AXIsProcessTrusted()` 的结果在进程内缓存，用户在运行期打开开关不会自动生效。
需要轮询直到通过。

- **验收标准**：App 运行中去系统设置打开 Accessibility，回到 App 不重启就能用

### 3.3 `NSAppleEventsUsageDescription` 文案

需要如实说明会观察和操作用户指定的应用。（Accessibility 权限本身不通过 `Info.plist` 声明。）

## 4. 人工验收：一项都没做过

自动化测不了，必须人在真机上走一遍。完整步骤在
[`agent-v2-progress.md`](agent-v2-progress.md) 第 7 节与
[`phase-4-implementation.md`](phase-4-implementation.md) 末尾。

**4.1 长驻进程模型（6 项）**：同一进程处理连续两条指令 pid 不变；kill 核心后自动重启；
60 秒内崩 3 次后停止自动重启；执行中途 `kill -9` 显式报错且**不**自动重试、不产生重复副作用；
打包后的 App 用内置核心而不是仓库副本；协议版本不匹配的行为。

**4.2 浮窗行为（5 项）**：拖动后位置保持、`hide()`/`show()` 回到顶部居中；图钉压住全屏应用；
失焦自动隐藏但执行中例外；图钉按钮视觉状态；确认气泡端到端（取消不产生 Apple Event、
提交期间按钮禁用、快速连点只执行一次、点击不把 App 变成前台）。

**4.3 AX 能力层（3 项）**：
1. Finder 或另一款非 Chromium 应用的真实只读树规模、耗时与截断原因（用于定 §1.1 的预算）
2. **在专用测试控件中真的执行一次**文字替换、普通按钮点击、菜单选择，并核对动作后回读
   —— 到目前为止 `ax.perform` **一次都没有在真实应用上跑过**，今天的真机验证全是观察
3. Electron/CEF 进程首次 `AXManualAccessibility` poke 真的成功、AX 树真的建出来了
   （自动化只能证明「写失败会被如实回报」，证明不了「这次写入成功」）

## 5. 需要你拍板的设计分叉（21 条未决事项）

完整原文在 [`agent-v2-progress.md`](agent-v2-progress.md) 第 6 节。按影响排序：

| # | 事情 | 不拍板的后果 |
| --- | --- | --- |
| 10 | 签名身份策略 | 阶段 6 无法落地，见 §3.1 |
| 11 | 文本模型凭证 | 只有 `TYPESAFE_API_KEY`；阶段 5.6「切片切不出时调文本模型」没有凭证，缺值时只能返回「需要补充信息」。**只记环境变量名，不读取 key 的值** |
| 12 | AX 预算调优 | 就是 §1.1 |
| 1 | Session 的 Interface 认在哪 | 决定 §1.2 怎么收口 |
| 5 | `needs_input` 要不要对称恢复 | 附带一个**现在就在骗人**的问题：`terminalCode()` 在低置信度 ask 带真实 `actionId` 时会报成 `needs_confirmation` 且无 `confirmId` |
| 6 | `protocol.ts` 与 Swift 影子如何对账 | 阻塞 §2.2（要动线协议） |
| 2 3 4 7 8 9 | 其余设计分叉 | 不拍板不改行为，现状可用 |
| 16 17 18 20 | 措辞与边界口径 | 可带病上线 |

## 6. 已知但可以带病上线

- **#14** `ax.perform` 的 `artifacts` 恒为空数组——Swift 侧没有生产路径，等真有产出再接
- **#15** `AXRuntime.observe` 每次建两次 application（兼容探测一次、遍历一次），只是多余，
  真要压观察延迟时这是第一处可省的
- **#21** `src/execute.ts` 与 `src/capability.ts` 之间有模块循环，Node ESM 与 `tsc` 都正常，
  测试全绿；不接受的话可把 `resolveArgs` 下沉
- **文档过时**：`README.md` 里「真正能发出去的只有两条」已经不准确（AX 动作面之后不止）；
  `docs/architecture.md` 的模块表没有 `ax.ts` / `capability.ts` 两行

## 7. 建议的执行顺序

1. §1.1 depth 进协议 —— 不做这条，后面所有浏览器场景都是空转
2. §4.3 第 2 项真机执行一次 AX 动作 —— **这是整个 AX 链路第一次真的动手**，
   很可能还会暴露一批像 `-25200` 那样的东西
3. §2.1 接上 `nextOffset`/`truncated`
4. §3 阶段 6 权限与打包（需要先拍 §5 的 #10）
5. §2.2 权限错误跨线（需要先拍 #6）
6. §1.2 `cmdRun` 收口（需要先拍 #1）
7. §4.1 / §4.2 人工验收
8. §6 文档订正

## 8. 门禁（每次改动后都要过）

```
npm run check        # tsc --noEmit + 423 项 Node 测试
npm run voice:test   # 129 项 Swift 测试
npm run voice:build  # 打包 + 签名
BRIGHTSIGHT_LIVE=1 npm run voice:test -- --filter AXRuntimeLiveTests   # 真机 AX
```

全部 exit 0 才算过。**真机那条不能省**——本文档开头那三个缺陷，没有一个是前三条抓出来的。
