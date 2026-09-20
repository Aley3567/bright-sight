# 架构

改代码前先读这里，再读 [design.md](design.md)。产品形态与尚未落地的结构看 [agent-v2-design.md](agent-v2-design.md)，已落地与未落地的差别看 [agent-v2-progress.md](agent-v2-progress.md)。

这份文档只写**仓库里现在实际长什么样**：模块职责、数据流向、层与层之间的边界。规划中的 Capability Runtime、事件流、Workspace、Memory 不在这里。具体某个函数怎么实现，看代码和内联注释。

## 三条生产入口，一条旁路

权威状态不在同一处。闭环本身是 `loop.ts` 的 `runLoop` / `resumeLoop`；谁来装配依赖、谁能从确认处继续，因入口而异。

```
文字 / 语音（final transcript）
        │
        ├─ CLI `run`     cli.ts:cmdRun     直接 runLoop。撞上确认只打印后退出，没有 session.confirm
        ├─ CLI `serve`   cli.ts:cmdServe   现场拼 SDK/journal/profile/execute，把 resume 闭包交给 session.ts
        │                     │
        │                     └─ JSON Lines RPC（protocol.ts 人读契约；rpc.ts Node Peer）
        │                            │
        │                            └─ Compact 胶囊  CoreSession.swift → CommandExecuting
        │                                   Native Launcher（打开本机 App）在 Session 之外
        └─ CLI `probe`   probe.ts          旁路：JevBackend.route/pick + 全量 sdef，不经 Loop / REGISTRY / verify
```

进程内权威是 `RunState`；挂起活在 `session.ts` 的内存 Map（同一 `serverId` 内可 `session.confirm`，重启即作废）；线上结局是 `SessionUpdate`（不含 checkpoint / argv）；journal 是脱敏审计，回放填不回挂起。

## 数据流

```
一句话指令
   │
   ├─ observe   perceive.ts   生产接 snapshotLight：前台应用、窗口标题、运行列表
   │                          snapshotFull / selectedText 已实现但零生产调用方；elements / selection 恒为空
   ├─ 动作面    actions.ts    扫全盘 .app 解析 sdef → ActionSpec（带磁盘缓存）
   │            surface.ts    REGISTRY 键集 ∩ ALLOWED_APPS + 任务层动作（ASK/WAIT/DONE/BLOCKED/UNSUPPORTED）
   │            spans.ts      中文候选片段枚举
   ├─ judge     decide.ts     闭环走 judge(TypeSafeClient)→Decision；DecisionBackend 只服务 probe
   ├─ 策略      policy.ts     纯函数阈值链 + 四道硬闸 → 5 态 + reasons[]
   ├─ act       execute.ts    参数解析 + 回读解析（resolveArgs 按模板 id 两个硬编码分支）
   │            scripts.ts    冻结的脚本模板注册表（2 条可执行：make-tab / make-note）
   │            osa.ts        唯一 spawn osascript 的出口，argv 传参边界
   ├─ verify    verify.ts     返回值 + 计数 diff + 定向回读；模型不自证
   ├─ 编排      loop.ts       observe→judge→policy→act→verify；确认挂起 / 验证失败换路是两条恢复路径
   ├─ 会话投影  session.ts    params 校验 + RunState→SessionUpdate + confirm 三态表。生产接线在 cli.ts
   └─ 留痕      journal.ts    JSONL 落盘 + 本地 ULID
                redact.ts     外部字符串 → 加盐指纹，默认开
```

## 模块职责

| 模块 | 职责 | 边界 |
|---|---|---|
| `perceive.ts` | 从无障碍树取快照 | 只读取不改变，不碰剪贴板。生产 observe 接 `snapshotLight` |
| `actions.ts` | 扫 sdef 生成动作面，带磁盘缓存 | 唯一写 `surface.json` 的地方。`kind` 只构造 `"script"` |
| `surface.ts` | 允许清单过滤，拼任务层动作 | 执行允许清单就是 `scripts.ts` 的键集。每次 handle 重取的仍是这张冻结表 |
| `spans.ts` | 中文候选片段枚举 | 纯函数，零 IO |
| `decide.ts` | 构建选择题，校验模型答案 | 闭环走 `judge(client)`。`DecisionBackend` 不是闭环 Seam |
| `policy.ts` | 五态收敛 + 四道硬闸 | **零 IO、零网络、纯函数**。需要外部信息一律作为参数传入 |
| `execute.ts` | 参数解析、回读解析 | 不自己 spawn，走 `osa.ts` |
| `scripts.ts` | 脚本模板注册表 | 模板内容冻结，值永不插值进脚本文本 |
| `osa.ts` | 唯一 spawn `osascript` 的出口 | `execFile` 无 shell，值只走 argv |
| `verify.ts` | 返回值加快照 diff 判定 | 模型不参与，全部由代码判定 |
| `loop.ts` | 四步编排与确认挂起 | 全部依赖都是函数参数。`waiting_for_confirmation` 可 resume；`needs_input` 不能 |
| `session.ts` | RPC 方法表 + RunState 翻译 + confirm 三态 | 不拼 SDK/journal/execute。生产装配在 `cli.ts` 的 `cmdServe` |
| `protocol.ts` | Swift ↔ Node 的人读契约 | 不含实现。Swift 侧是会漂移的影子 `CoreProtocol.swift`，无 codegen |
| `rpc.ts` | JSON Lines Peer | 零 IO。once 认 `requestKey`，与 session 三态正交 |
| `probe.ts` | 连通性探针 | 走两级 `route/pick` + 全量 sdef，不执行。不是闭环入口 |
| `journal.ts` | JSONL 落盘 | 显式 `0o700` / `0o600`。不认识 redact，策略由调用方注入 |
| `redact.ts` | 外部字符串转加盐指纹 | 默认开，未知 phase 走全量指纹化 |
| `chrome.ts` | Chrome profile 探测 | 读盘，结果作为参数交给 `policy.ts` |
| `settings.ts` | `~/.bright-sight/config.json` | 存目录名不存显示名。不覆盖 App 侧 UserDefaults |
| `confirm.ts` | TTY 上当场拍板 | 非 TTY / serve 传 `ask: null`，不假装问过 |
| `config.ts` | 应用白名单、搜索引擎模板、代码兜底上限 | |
| `cli.ts` | 命令入口与生产装配 | `run` 直接 loop；`serve` 拼 SessionDeps；`journal` / `profile` / `probe` 各有独立不变量 |

## 三条不变量

这三条是架构的地基，改动前想清楚：

1. **`osa.ts` 是唯一 spawn 点。** 任何新增的 Apple Event 都必须从这里出去，否则 argv 不变式就有了缺口。
2. **`policy.ts` 零 IO。** 它是安全边界，必须能被穷举测试。需要外部信息就加参数，不要在里面读盘或发请求。
3. **执行允许清单等于 `scripts.ts` 的键集。** 不存在第二处定义。加动作意味着加模板，加模板意味着过 `osacompile` 门禁。

## 为什么安全核心是三个独立文件

`osa.ts`、`scripts.ts`、`policy.ts` 刻意不合并。藏进 `execute.ts` 就没有单一可审计对象了，而这三个文件加起来的行数决定了「审一遍要多久」。

## 不在这份文档里的

- 每个模块内部怎么实现：看代码和内联注释
- 为什么安全边界这样划：看 [design.md](design.md)
- 产品形态与尚未落地的 Module：看 [agent-v2-design.md](agent-v2-design.md)
- 已落地与未落地、未决分叉：看 [agent-v2-progress.md](agent-v2-progress.md)
- 怎么跑测试、怎么加新动作：看 [CONTRIBUTING.md](../CONTRIBUTING.md)
- AppleScript 的坑：看 `src/scripts.ts` 文件头
- Compact 胶囊：看 [apps/macos/README.md](../apps/macos/README.md)
