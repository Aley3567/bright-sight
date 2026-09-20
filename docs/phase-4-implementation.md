# 阶段 4 实施记录

这份记录只覆盖 AX 能力层的落地边界与验收证据。产品设计见
[`agent-v2-design.md`](agent-v2-design.md)，阶段总进度见
[`agent-v2-progress.md`](agent-v2-progress.md)。

## 交付边界

1. Swift AX 底层：进程级 messaging timeout、批量属性读取、错误分类、`CFEqual` 身份比较。
2. 有界调度：QoS 优先、同进程单飞、跨进程并行、显式背压。
3. 动作面：对 focused window / application 做有预算的 BFS，返回分页 offer 与截断信息。
4. freshness：frame/offer 只在 Swift 内持有真实 AX 引用；执行前沿 AX 路径重定位，并核对进程、
   窗口签名、角色、标识、标题和值摘要。
5. 执行：只允许 offer 声明的 `CLICK`、`TYPE_TEXT`、`SELECT`、`OPEN`；不支持坐标和任意按键。
6. Electron/CEF：按进程实例缓存探测结果，`AXManualAccessibility` 每个进程实例最多写一次。
7. RPC：Swift 注册 `ax.observe` / `ax.perform`；Node 提供类型化反向调用与 fail-closed 响应校验。

## 分阶段门

- [x] A. 协议类型、方法注册表、frame 生命周期
- [x] B. AX 底层、树遍历、指纹与受控执行
- [x] C. 调度接线、Electron/CEF、CoreSession 入站分派
- [x] D. Node 封装、双端测试、文档收口

## 数值与人工验证

遍历预算必须是可注入配置，默认值只作为保护上限，不宣称来自真实应用调优。合并前记录实际测试使用的
macOS、应用、节点数、耗时与截断原因。真实 AX 权限、Electron 首次 poke、菜单选择和文本替换不能只靠
`swift test` 证明，最终必须列出人工验收缺口。

当前保护上限是 depth 6、nodes 500、wall-clock 150 ms、page size 80；调用方单页上限由
`AXWireLimits.maxPageSize` 给出（`apps/macos/Sources/BrightSightVoice/AX/AXModels.swift`），当前是
200，Node 侧 `src/ax.ts` 的 `AX_MAX_PAGE_SIZE` 是同一个数字。这两处字面量由 `test/ax.test.ts` 的
跨语言对照测试盯着——它直接读 Swift 源文件比对，而不是两边各断言一遍自己的常量。
这些数值只防止失控遍历，没有经过真实应用调优。

## 验证证据（2026-09-20 验收时重跑）

- 环境：macOS 15.6、arm64、Xcode 26.3。
- `swift test --package-path apps/macos`：115 项，114 通过，0 失败，1 项 live 测试跳过。
- `npm run check`：345 项，342 通过，0 失败，3 项既有 live 测试跳过。
- `npm run voice:build`：App 打包、`Info.plist` 校验和 Apple Development 签名均成功；
  另跑 `codesign --verify --deep --strict`，结果 `valid on disk` 且满足 Designated Requirement。
- 新增的可控 AX 测试直接覆盖：BFS 深度截断、分页、遍历中陈旧子节点降级、执行前指纹变化拒绝、
  文本替换后定向回读、frame TTL/单次消费、Electron/CEF TTL 与每进程实例一次 poke、调度背压与
  同进程单飞。
- 验收时补上的覆盖：`CLICK`/`SELECT`/`OPEN` 三条执行分支各自到达客户端并核对可观测变化、
  按下后无可观测变化判 `effect_unknown` 且不重按、按下后目标消失判 `executed`、
  operation 与 offer 不一致时在碰客户端之前拒绝、`AXRuntime` 的调度接线（frame 只能被执行一次、
  未知 frame 与非法参数都不触碰客户端、`pendingLimit` 背压当场拒绝）、poke 失败如实回报且不重试、
  非 Chromium bundle 从不被 poke、Chromium 探测真去读磁盘。
- `BRIGHTSIGHT_LIVE=1 swift test --package-path apps/macos --filter AXRuntimeLiveTests` 在当前测试宿主上
  因没有 Accessibility 权限而按设计跳过；测试目标固定为 Finder，只观察、不调用 `ax.perform`，也
  不会触发 Chromium/Electron 的 `AXManualAccessibility` 写入。

「跨语言对照测试有效」这条结论有阳性对照：把 `AXModels.swift` 的 `maxPageSize` 改成 201、
把 `CoreProtocol.swift` 的 `methodAXObserve` 改成 `"ax.observe.v2"` 之后，`test/ax.test.ts` 确实
红了两条，改回即绿。不证明工具在工作，全绿什么都不说明。

## 本轮收口修正（验收结论落地）

- `AXCompatibility.prepare` 由抛错改为返回 `AXPokeOutcome`：写 `AXManualAccessibility` 失败不再让整次
  `ax.observe` 失败。`claimPoke` 仍在尝试之前就消耗掉机会，所以失败也只发生一次；
  非 Chromium 应用与已退出进程根本不会被 poke。
- `AXSurfaceClient` 增加 `setManualAccessibility`；`AXSurfaceBuilder` / `AXActionPerformer` 从泛型参数
  改为持有 existential，`AXRuntime` 的 client 因此可注入。Swift 不给 `any P` 提供 self-conformance，
  泛型版本接受不了一个被抹掉具体类型的客户端——这条是实现时撞上的约束，不是风格偏好。
- `pageSize` 上限集中为 `AXWireLimits.maxPageSize`，并与 `src/ax.ts` 的 `AX_MAX_PAGE_SIZE` 之间加了
  跨语言对照测试（附阳性对照）。
- 删掉零引用的 `CoreProtocol.methodSessionDescribe`；`src/protocol.ts` 的 `AX_SERVER_METHODS`
  由对照测试真正用上，不再是悬空常量。

## 留给后续阶段的缺口

以下是验收时判定「不属于阶段 4 范围」的，是显式推迟，不是遗漏：

1. **权限失败跨不了线**（阶段 6）：`AXClient` 已经算出 `AXFailureKind.permission`，`AXRuntime`
   却把所有 `AXCallError` 塌缩成 `internal_error`，线协议错误码表里也没有 permission 档。后果是
   TCC 未授权在 Node 侧与内部错误无法区分——正好落在阶段 6 的核心失败模式上。
2. **`AXPokeOutcome` 目前无人消费**：`AXRuntime.observe` 显式丢弃它。它要和第 1 条一起跨线，
   否则「Chromium 应用没打开 AX 树」只能表现为动作面变小。
3. **`ax.perform` 的 `artifacts` 恒为空数组**：Swift 侧没有 artifacts 生产路径，Node 侧却要求它
   必须是数组。设计 §5.2 的 `ActionResult` 里有这个字段，等真有产出再接。
4. **`AXRuntime.observe` 每次建两次 application**：一次给 Chromium 兼容探测、一次给遍历本身。
   两次都是本地 create 加 set timeout，没有副作用，暂不改。

## 仍需人工验收

以下缺口依赖稳定签名与 TCC 授权，属于阶段 6 的权限/打包环境，不能用当前未授权 XCTest 宿主伪造通过：

1. Finder 或另一款非 Chromium 应用的真实只读树规模、耗时与截断原因，用于调整保护上限。
2. 在专用测试控件中执行文字替换、普通按钮点击和菜单选择，并核对动作后回读。
3. Electron/CEF 进程首次 `AXManualAccessibility` poke 以及同一进程实例不重复写入。

第 3 条现在多了一层含义：自动化测试已经能证明「写失败会被如实回报、同一进程实例只尝试一次、
非 Chromium 根本不尝试」，但证明不了「在那个 Electron 应用上这次写入真的成功、AX 树真的建出来了」。
后者只能靠人在真机上跑一次。
