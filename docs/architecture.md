# 架构

改代码前先读这里，再读 [design.md](design.md)。

这份文档只写不常变的东西：模块职责、数据流向、层与层之间的边界。具体某个函数怎么实现，看代码和内联注释，不在这里重复。

## 数据流

```
一句话指令
   │
   ├─ observe   perceive.ts   轻/全快照：前台应用、窗口标题、运行列表、选中文本
   ├─ 动作面    actions.ts    扫全盘 .app 解析 sdef → ActionSpec（带磁盘缓存）
   │            surface.ts    允许清单过滤 + 任务层动作（ASK/WAIT/DONE/BLOCKED/UNSUPPORTED）
   │            spans.ts      中文候选片段枚举
   ├─ judge     decide.ts     构建类型化选择题 → 模型只 pick，代码校验答案
   ├─ 策略      policy.ts     纯函数阈值链 + 四道硬闸 → 5 态 + reasons[]
   ├─ act       execute.ts    参数解析 + 前后计数 + 回读解析
   │            scripts.ts    冻结的脚本模板注册表
   │            osa.ts        唯一 spawn osascript 的出口，argv 传参边界
   ├─ verify    verify.ts     返回值 + 计数 diff + 定向回读
   └─ 留痕      journal.ts    JSONL 落盘 + 本地 ULID
                redact.ts     外部字符串 → 加盐指纹，默认开
   └─ 纠正      evolution.ts  明确 feedback → 候选 → 验证 → 版本化启用
```

## 模块职责

| 模块 | 职责 | 边界 |
|---|---|---|
| `perceive.ts` | 从无障碍树取快照 | 只读取不改变，不碰剪贴板 |
| `actions.ts` | 扫 sdef 生成动作面，带磁盘缓存 | 唯一写 `surface.json` 的地方 |
| `surface.ts` | 允许清单过滤，拼任务层动作 | 执行允许清单就是 `scripts.ts` 的键集 |
| `spans.ts` | 中文候选片段枚举 | 纯函数，零 IO |
| `decide.ts` | 构建选择题，校验模型答案 | 不接触密钥本身，凭证由 SDK 从环境变量读 |
| `policy.ts` | 五态收敛 + 四道硬闸 | **零 IO、零网络、纯函数**。需要外部信息一律作为参数传入 |
| `execute.ts` | 参数解析、前后计数、回读解析 | 不自己 spawn，走 `osa.ts` |
| `scripts.ts` | 脚本模板注册表 | 模板内容冻结，值永不插值进脚本文本 |
| `osa.ts` | 唯一 spawn `osascript` 的出口 | `execFile` 无 shell，值只走 argv |
| `verify.ts` | 返回值加快照 diff 判定 | 模型不参与，全部由代码判定 |
| `journal.ts` | JSONL 落盘 | 显式 `0o700` / `0o600` |
| `redact.ts` | 外部字符串转加盐指纹 | 默认开，未知 phase 走全量指纹化 |
| `chrome.ts` | Chrome profile 探测 | 读盘，结果作为参数交给 `policy.ts` |
| `settings.ts` | `~/.bright-sight/config.json` | 存目录名不存显示名 |
| `evolution.ts` | 纠正证据、候选、版本与保留清理 | 不改 Policy/白名单；原始纠正不进入普通运行上下文 |
| `confirm.ts` | TTY 上当场拍板 | 非 TTY 时不假装问过 |
| `loop.ts` | 四步编排 | 全部依赖都是函数参数，可纯内存跑完整个控制流 |
| `config.ts` | 应用白名单、搜索引擎模板、代码兜底上限 | |
| `cli.ts` | 命令入口 | |

## 三条不变量

这三条是架构的地基，改动前想清楚：

1. **`osa.ts` 是唯一 spawn 点。** 任何新增的 Apple Event 都必须从这里出去，否则 argv 不变式就有了缺口。
2. **`policy.ts` 零 IO。** 它是安全边界，必须能被穷举测试。需要外部信息就加参数，不要在里面读盘或发请求。
3. **执行允许清单等于 `scripts.ts` 的键集。** 不存在第二处定义。加动作意味着加模板，加模板意味着过 `osacompile` 门禁。

## 为什么安全核心是三个独立文件

`osa.ts`、`scripts.ts`、`policy.ts` 刻意不合并。藏进 `execute.ts` 就没有单一可审计对象了，而这三个文件加起来的行数决定了「审一遍要多久」。

## 不在这份文档里的

- 每个模块内部怎么实现：看代码和内联注释
- 为什么这样设计：看 [design.md](design.md)
- 怎么跑测试、怎么加新动作：看 [CONTRIBUTING.md](../CONTRIBUTING.md)
- AppleScript 的坑：看 `src/scripts.ts` 文件头

