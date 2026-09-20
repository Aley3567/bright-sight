# bright-sight

bright-sight 是一个 macOS 命令行工具，把一句中文指令变成受控的应用操作，每一步执行完都由代码回读验证。

它只能做两件事：在 Chrome 里开标签页、在备忘录里建笔记。真正花力气的部分是保证它只做这两件。

```sh
bright-sight run "搜一下 TypeScript 的 erasableSyntaxOnly，把链接存进备忘录" --execute
```

它会先报出这一轮的边界条件，再逐步执行。输出结构如下（值随机器而变）：

```
指令: 「搜一下 TypeScript 的 erasableSyntaxOnly，把链接存进备忘录」
模式: 真实执行
选项: <N> 个（动作面共 <M> 条，白名单过滤后递给模型的就这些）
Chrome: 当前 Chrome profile <目录名> 不在允许名单内
留痕: ~/.bright-sight/journal/<runId>.jsonl（已脱敏，只落指纹）

当前 Chrome profile <目录名> 不在允许名单内
要在 <目录名> 下执行吗？答 y 会把它记进允许名单，以后不再问。[y/N] y

── 第 1 步 ──
  判断: Google Chrome.make-tab  置信 0.940 | 完整 0.980 | 破坏 0.010
  参数: ["https://www.google.com/search?q=..."]
  执行: 成功 820ms
  回读: tab_id=<id> | url=<落点地址> | title=<标题>
  通过 tab_appeared: ...
  通过 url_origin_match: ...

结果: done
```

每一步都打印判据名与通过与否。`产物:` 一节会标出某个值来自第几步的哪个字段，第二步的参数就取自那里。

不带 `--execute` 时是 dry-run，只打印每一步解析出的完整 argv，不投递任何 Apple Event。

## 能做什么，不能做什么

感知不看屏幕像素，来源是无障碍树和应用脚本字典（sdef），不截图也不做 OCR。动作面从系统自己长出来：扫描全盘 `.app` 的 sdef，解析出所有可脚本化命令。数量取决于你机器上装了什么，跑 `bright-sight surface` 看本机的数。

决策交给 [TypeSafe](https://typesafe.ai) 的 System One 模型，它只回答类型化选择题并返回概率分布，不生成任何文本。控制流完全归代码所有。

不能做的事，先说清楚：

- **不能指定 Chrome profile。** Chrome 的脚本字典里没有 profile 这个概念，AppleScript 侧无解。这个工具能做的是执行前探测当前在用哪个 profile，陌生的就停下来问。
- **动作面能解析出全机所有可脚本化命令，但真正能发出去的只有两条。** 扩展需要写新的脚本模板并通过 `osacompile` 门禁。
- **输入只有命令行文本。** 语音输入属于 Phase 2，`src/bar/` 目前只有一份说明文档。
- **dry-run 只能演练第一步。** 第二步的参数依赖第一步的真实回读，不执行就拿不到。所以 dry-run 不会走到 `done`，它会自己打印一句「dry-run 到此为止是正常的」。

## 运行要求

- **macOS。** 依赖 Apple Event 与应用脚本字典，没有跨平台计划。
- **Node ≥ 24。** 用原生 TypeScript 类型剥离，没有构建步骤，直接跑 `.ts`。
- **自动化权限。** 首次执行时系统会弹窗，要求授予终端或你的 IDE 控制 System Events、备忘录与 Chrome 的权限。拒绝的话 `run` 会在轻快照那一步失败。
- **`TYPESAFE_API_KEY`。** `run` 与 `probe` 要调模型；`surface`、`profile`、`journal` 不需要。

运行时依赖只有 `@typesafe-ai/sdk` 一个包，另有 `typescript` 与 `@types/node` 两个开发依赖。

## 安装

```sh
git clone https://github.com/Aley3567/bright-sight.git
cd bright-sight
npm install
npm run check          # tsc --noEmit && node --test，应当全绿
npm link               # 之后可以直接用 bright-sight 命令
```

不想 `npm link` 就把下文的 `bright-sight` 换成 `node bin/bright-sight.js`。

第一次跑真指令，建议按这个顺序：

```sh
# 看动作面长出了什么，以及白名单过滤后真正递给模型的选项
bright-sight surface

# 看清楚会落在哪个 Chrome profile 上（此时允许名单是空的，一律「待确认」）
bright-sight profile

# dry-run，只打印 argv 不发 Apple Event
export TYPESAFE_API_KEY=<你的 key>
bright-sight run "搜一下 erasableSyntaxOnly，把链接存进备忘录"

# 确认无误再真跑
bright-sight run "搜一下 erasableSyntaxOnly，把链接存进备忘录" --execute
```

## 用法

```sh
bright-sight run "<一句话>" [--execute] [--engine <名字>]
bright-sight surface [--all] [--rebuild]
bright-sight probe ["<一句话>"]
bright-sight journal [<文件名或路径>]
bright-sight profile [allow <目录名> | forget <目录名>]
bright-sight feedback <runId> "<哪里不对>" [--skill]
bright-sight memory [list | validate | activate | suspend | reject | helpful | forget]
bright-sight help
```

| 命令 | 说明 |
|---|---|
| `run` | 走完 observe 到 verify 的闭环。默认 dry-run，`--execute` 才真发 Apple Event。`--engine` 取 `google` / `duckduckgo` / `bing`，默认 `google` |
| `surface` | 看动作面。`--all` 打印全部动作，`--rebuild` 绕过磁盘缓存重建 |
| `probe` | 只决策不执行的连通性探针，面向全量动作面 |
| `journal` | 不带参数列出最近 20 条历史 run；带文件名回放那一次，并提示其中有几条是未脱敏的原文 |
| `profile` | 不带子命令时打印允许名单与当前在用的 profile；`allow` 加进名单，`forget` 移出。没有 `list` 子命令，列表就是不带子命令那条路径 |
| `feedback` | 用户明确提交一次纠正，生成候选偏好或 2–5 步短技能；不会自动启用 |
| `memory` | 查看、验证、启用、暂停、拒绝或忘记候选与版本 |

| 环境变量 | 用途 | 默认 |
|---|---|---|
| `TYPESAFE_API_KEY` | 模型凭证，由 SDK 读取 | 无，`run` 与 `probe` 必需 |
| `BRIGHTSIGHT_ENGINE` | 搜索引擎 | `google` |
| `BRIGHTSIGHT_JOURNAL` | 逐字等于 `full` 才把原文落进留痕 | 脱敏，只落指纹 |
| `BRIGHTSIGHT_LIVE` | 设为 `1` 才跑有真实副作用的测试 | 不跑 |

环境变量只用于行为开关。因机而异的配置落在 `~/.bright-sight/config.json`。

## Chrome profile

`tell application "Google Chrome"` 把事件投给系统里那个 Chrome，投给谁由「哪个实例在跑」决定。执行前会探测当前在用哪个 profile，不在允许名单里就当场问一句。

```
$ bright-sight profile
设置: ~/.bright-sight/config.json
允许名单: （空，任何 profile 都会先问一句）

当前在用: Default（<你给它起的显示名>）
  Local State: Default　Preferences mtime: Default

全部 profile:
  [待确认] Default　…
  [待确认] <另一个目录名>　…
```

探测走两条路交叉印证：`Local State` 的 `last_active_profiles`，以及各 profile 目录下 `Preferences` 的 mtime。两路对不上会如实报出来，因为 `Local State` 的写入滞后于实际切换若干秒。

答应过一次之后，**目录名**会记进 `~/.bright-sight/config.json`。记的不是显示名，显示名是你自己起的，常常就是真名或邮箱。

非交互环境（CI、管道）下没有人可问，这时不会假装问过，策略层会把它拦成 `confirm` 并说清原因。dry-run 不受这道闸限制，它压根不发 Apple Event。

## 隐私

运行时状态全部写在 `~/.bright-sight/`，目录 `0o700`、文件 `0o600`：

| 路径 | 内容 |
|---|---|
| `journal/<runId>.jsonl` | 每一步的判断依据，append-only |
| `config.json` | Chrome 允许名单与留痕指纹盐 |
| `surface.json` | 动作面缓存，即这台机器装了哪些可脚本化应用 |

不脱敏的话，journal 会攒下你说过的每一句话、看过的每一个窗口标题、打开的每一个网址、写进备忘录的每一段正文。所以默认落盘的是指纹：每个外部字符串只留字符数与一段加盐 HMAC 的前 8 位。

```jsonc
// 默认
{"phase":"act","redacted":true,"data":{"ok":true,"argv":[{"len":57,"h":"7b2e0af4"}]}}

// BRIGHTSIGHT_JOURNAL=full
{"phase":"act","redacted":false,"data":{"ok":true,"argv":["https://www.google.com/search?q=…"]}}
```

这保住了留痕真正的用途，比如「第 2 步开的地址和第 1 步产出的是不是同一个」「哪条判据没过」，同时让记录本身读不出内容。

盐每台机器随机生成一次，只存家目录。用加盐 HMAC 而不是裸哈希，是因为常见网站和窗口标题的候选集很小，裸哈希可以用彩虹表还原。

## 限制与已知问题

- **阈值是初始猜测，还没用评测集标定。** `THRESHOLDS` 的 `execute: 0.75` / `complete: 0.6` / `destructive: 0.3` 应当在标注评测集上按误执行代价调出来，当前值是凭手感定的。这是策略不是常量。
- **依赖 TypeSafe 的 System One 模型。** 换一个只会生成文本的模型需要重写 `decide.ts` 的整个答案校验层。「模型只回答选择题」是这个架构的前提，不是可替换细节。
- **本机 Chrome 与备忘录之外没有验证过。** 其它应用的 sdef 能解析，但没有执行模板。

## 文档

- [设计](docs/design.md)：安全边界怎么划的，四道硬闸、允许清单、verify 的判据来源
- [架构](docs/architecture.md)：模块职责与数据流，改代码前先读
- [贡献](CONTRIBUTING.md)：怎么跑测试、怎么加新动作
- [自进化](docs/self-evolution.md)：纠正、候选、反馈、版本与删除边界

## 许可证

MIT，见 [LICENSE](LICENSE)。
