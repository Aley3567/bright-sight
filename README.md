# bright-sight · 明视

macOS 上的「一句话 → 意图 → 受控动作」闭环：在命令行给它一句自然语言指令，
模型做**类型化判断**，经策略层过闸后用 AppleScript / Apple Event 操作
Google Chrome 与备忘录（Notes），最后**由代码回读验证动作真的生效了**。

感知不看屏幕像素：来源是**无障碍树**与**应用脚本字典（sdef）**，不截图、不做 OCR、不认图标。
动作面从系统自己长出来——扫描全盘 `.app` 的 sdef 解析出所有可脚本化命令，
数量取决于你机器上装了什么（跑一下 `bright-sight surface` 看本机的数），
**其中绝大多数代码从没见过**，也没有为任何单个应用写过发现或决策代码。

决策交给 [TypeSafe](https://typesafe.ai) 的 System One 模型：它只回答类型化选择题并返回概率分布，
**不生成任何文本**。控制流完全归代码所有。

## 状态

Phase 1 已闭环：`observe → judge → act → verify` 四步跑通一条跨应用两步指令。

```sh
bright-sight run "搜一下 TypeScript 的 erasableSyntaxOnly，把链接存进备忘录" --execute
```

不带 `--execute` 时是 dry-run：只打印计划与每一步解析后的完整 argv，不投递任何 Apple Event。

输入通道是命令行文本。闭环的正确性判据（逐字校验、四道硬闸、返回值 + 快照 diff）与指令
从哪来无关，所以先把判据钉死在自带标点的可靠输入上，别的输入通道见下文的 Roadmap。

## 这个项目值得看的地方是安全边界，不是功能数量

它能做的事只有两件（开标签页、建笔记）。真正花力气的是「怎么保证它只做这两件」。

### 一、标识符 / 值两层分离

|            | 来源                                     | 可否拼进脚本文本 | 校验                    |
| ---------- | ---------------------------------------- | ---------------- | ----------------------- |
| **标识符** | sdef（磁盘上的系统文件）、代码常量       | 可以             | 须过字符集白名单        |
| **值**     | 用户原话、模型输出、**页面回读**、剪贴板 | **永远不可以**   | 只走 `argv`             |

AppleScript 的 `note`、`body`、`window` 是关键字不是字符串，无法经 argv 传递——
这是客观限制，所以标识符必须允许插值；但标识符只来自 sdef 和代码常量，不受用户输入
与模型输出影响，字符集校验是纵深防御。

值这一侧零例外：`execFile`（无 shell）+ `on run argv`（值不进字符串字面量），
两层「无需转义」叠加，转义需求归零。`src/osa.ts` 是唯一 spawn `osascript` 的出口。

### 二、五态策略，只有一条路通向真实副作用

`src/policy.ts` 把一个带概率的判断收敛成五种结论之一：

`execute` / `confirm` / `ask` / `wait` / `ignore`

后四态都不产生副作用。这一层**零 IO、零网络、纯函数**——它是安全边界，安全边界必须能被
穷举测试，而能被穷举测试的前提是它不依赖外部世界。需要外部信息（比如 profile 探测结果）
一律作为参数传进去。

### 三、四道独立硬闸，取或

```
blocked = spec.risk === "destructive"                   // 动作面构建期固定，模型碰不到
       || judgement.destructive > THRESHOLDS.destructive // 模型只能加，不能减
       || template.effect === "destroy"                  // 模板自带，抓 sdef 误标

// 第四道只管 Chrome：前三道回答「这件事该不该做」，它回答「在谁的登录态里做」
       || (spec.app === CHROME_APP && profileGate.kind !== "allowed")
```

代码里不存在任何路径让模型的概率**降低**拦截强度。模型的 `destructive` 只能把 safe 的
动作抬进 confirm，不能把 destructive 的动作放行。

缺省值一律 fail-closed：`PolicyInput.profile` 省略等于「没探测过」，于是 Chrome 动作一律走
confirm。省略等于放行的话，换一个入口接线时忘了传，就成了静默的安全漏洞。

### 四、执行走允许清单，不是风险黑名单

黑名单的失败模式是「没想到的都放行」，而动作面是从 sdef 自动生成的——无法预先枚举系统
会长出什么命令，所以黑名单在这个架构下是结构性错误。

最典型的例子是 Chrome 的 `execute` 命令（`Execute a piece of javascript`）：在黑名单下它会被
判 `safe` 并一路放行到「模型产出的字符串在浏览器里执行」。在允许清单下它**根本不进执行
注册表**，模型即便选中也发不出去。运行时注册表里只有两条可执行模板：
`Google Chrome.make-tab` 与 `Notes.make-note`。

### 五、verify 全部由代码判定

模型不参与自证结果——让模型判断自己刚才做成没有，等于把「做成了」的定义权交给可能
出错的那一方。两类证据都要：脚本自己的返回值（做了什么），以及执行前后各取一次的
只读快照差分（世界变了没有）。只有返回值会骗人（返回成功但对象没落地），只有 diff
会误判（别的程序同时也在改）。

实际检查项包括：退出码、回读格式前缀、标签页数增量、落点 `origin` 匹配、笔记数增量、
**回读笔记实际落在哪个容器**、正文含目标 URL。

终止也不信任模型的 `DONE`：

```
done ⟺ 模型选了 DONE ∧ 至少执行过一步 ∧ 每个执行过的步骤 verify.ok === true
```

外加三条不经模型的代码兜底：`LIMITS.maxSteps = 6`、重复守卫（同一动作配同一组解析参数
被第二次提议即阻断）、连续 `WAIT` 上限（默认 2 次，超过说明模型在原地打转）。

## 运行要求

- **macOS**。依赖 Apple Event 与应用脚本字典，没有跨平台计划。
- **Node ≥ 24**。用的是原生 TypeScript 类型剥离，**没有构建步骤**，直接跑 `.ts`。
- **自动化权限**。首次执行时系统会弹窗要求授予「终端 / 你的 IDE」控制
  System Events、Notes 与 Google Chrome 的权限。拒绝的话 `run` 会在轻快照那一步就失败。
- **`TYPESAFE_API_KEY`**。`run` 与 `probe` 要调模型，需要它；`surface`、`profile`、`journal` 不需要。
- 依赖只有一个运行时包（`@typesafe-ai/sdk`），加上 `typescript` 与 `@types/node` 两个开发依赖。
  「零运行时依赖」是刻意维持的方向，加依赖之前先问：省下的几十行值不值一处对外耦合。

## 安装与上手

```sh
git clone https://github.com/Aley3567/bright-sight.git
cd bright-sight
npm install
npm run check                 # tsc --noEmit && node --test，应当全绿
node bin/bright-sight.js surface
```

`npm link` 之后可以直接用 `bright-sight` 这个命令，下文都按它写；
不想 link 就把 `bright-sight` 换成 `node bin/bright-sight.js`。

第一次跑一条真指令，建议按这个顺序：

```sh
# 1. 先看动作面长出了什么，以及白名单过滤后真正递给模型的选项
bright-sight surface

# 2. 看清楚会落在哪个 Chrome profile 上（此时允许名单是空的，一律「待确认」）
bright-sight profile

# 3. dry-run：打印每一步解析出的完整 argv，不发任何 Apple Event
export TYPESAFE_API_KEY=<你的 key>
bright-sight run "搜一下 erasableSyntaxOnly，把链接存进备忘录"

# 4. 确认无误再真跑。执行前会当场问一句要不要在当前 profile 下执行
bright-sight run "搜一下 erasableSyntaxOnly，把链接存进备忘录" --execute
```

dry-run 只能演练到第一步，这是设计使然而不是缺陷：第二步的参数依赖第一步的真实回读
（浏览器最终停在哪个地址），不执行就拿不到。所以 dry-run 的 `结果: blocked` 是正常的。

## 命令参考

```sh
bright-sight run "<一句话>" [--execute] [--engine <名字>]
bright-sight surface [--all] [--rebuild]
bright-sight probe ["<一句话>"]
bright-sight journal [<文件名或路径>]
bright-sight profile [allow <目录名> | forget <目录名>]
bright-sight help
```

| 命令 | 说明 |
|---|---|
| `run` | 走完 `observe → judge → act → verify` 闭环。**默认 dry-run**，`--execute` 才真发 Apple Event。`--engine` 取 `google` / `duckduckgo` / `bing`，默认 `google`。 |
| `surface` | 看动作面：从 sdef 自动长出来的全部命令，以及白名单过滤后真正递给模型的选项。`--all` 打印全部动作，`--rebuild` 绕过磁盘缓存重建（装了新应用但 mtime 没动时的自救手段）。 |
| `probe` | 只决策不执行的连通性探针，走 route → pick 两级，面向全量动作面。不给指令时用一条内置的默认指令。 |
| `journal` | 不带参数列出历史 run（最近 20 条）；带文件名回放那一次的四步事件，并提示其中有几条是未脱敏的原文。参数含 `/` 时按路径处理，否则在留痕目录里找。 |
| `profile` | 不带子命令时打印设置路径、允许名单、当前在用的 profile 与全部 profile 的「允许 / 待确认」状态；`allow <目录名>` 加进名单，`forget <目录名>` 移出。 |

注意 `profile` 没有 `list` 子命令——列表就是不带子命令的那条路径。

### 环境变量

| 变量 | 用途 | 默认 |
|---|---|---|
| `TYPESAFE_API_KEY` | 模型凭证，由 `@typesafe-ai/sdk` 读取 | 无，`run` / `probe` 必需 |
| `BRIGHTSIGHT_ENGINE` | 搜索引擎（`google` / `duckduckgo` / `bing`） | `google` |
| `BRIGHTSIGHT_JOURNAL` | 逐字等于 `full` 才把原文落进留痕 | 脱敏（只落指纹） |
| `BRIGHTSIGHT_LIVE` | 设为 `1` 才跑有真实副作用的测试 | 不跑 |

环境变量只用于**行为开关**，不用于存放因机而异的配置——那些落在 `~/.bright-sight/config.json`。

## Chrome profile：看清楚会落在谁的登录态里

`tell application "Google Chrome"` 把事件投给系统里那个 Chrome，投给谁由「哪个实例在跑」决定。
而 **Chrome 的脚本字典里根本没有 profile 这个概念**——全文没有任何 profile 命令，
`window` 只有 `mode`（normal / incognito）。所以「让它用某个 profile」这件事在 AppleScript 侧无解。

能做的是另一件事：**执行前先探测当前正在用的是哪个 profile，陌生的就停下来问一句。**

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

探测走两条路交叉印证：`Local State` 的 `last_active_profiles`，以及各 profile 目录下
`Preferences` 的 mtime。两路对不上就如实报出来——`Local State` 的写入滞后于实际切换若干秒，
刚切过 profile 时它还停在上一个。

答应过一次之后，**目录名**（`Default` 或 Chrome 分配的序号目录）会被记进
`~/.bright-sight/config.json`。记的不是显示名：显示名是你自己起的，常常就是真名或邮箱。
探测失败那条路不记——连是哪个都不知道，记什么都是假的，所以只对这一次放行。

在非交互环境（CI、管道）下没有人可问，这时不会假装问过：策略层会把它拦成 `confirm` 并说清原因。

dry-run 不受这道闸限制：它压根不发 Apple Event，也就无所谓落在谁的登录态里，拦住它的唯一
效果是让人连 argv 都看不到。但探测结论照样会打出来，好让你在加 `--execute` 之前就知道
需要先确认什么。

两条路径都要有，缺一条都不行：只有 CLI 当场问，换一个入口调 loop 就悄悄绕过了整道闸；
只有 policy 兜底，用户每次都得先改配置再重跑。

## 隐私与本地数据

运行时状态全部写在 `~/.bright-sight/`：

| 路径 | 内容 |
|---|---|
| `journal/<runId>.jsonl` | 每一步的判断依据，append-only |
| `config.json` | Chrome 允许名单（目录名）与留痕指纹盐 |
| `surface.json` | 动作面缓存，即「这台机器装了哪些可脚本化应用」 |

### 留痕默认只落指纹

不脱敏的话，journal 会攒下**你说过的每一句话、看过的每一个窗口标题、打开的每一个网址、
写进备忘录的每一段正文**。所以默认落盘的是指纹而不是内容：每个外部字符串只留字符数与
一段 HMAC 前 8 位。

```jsonc
// 默认（BRIGHTSIGHT_JOURNAL 未设）
{"phase":"act","redacted":true,"data":{"ok":true,"argv":[{"len":57,"h":"7b2e0af4"}]}}

// BRIGHTSIGHT_JOURNAL=full
{"phase":"act","redacted":false,"data":{"ok":true,"argv":["https://www.google.com/search?q=…"]}}
```

这保住了留痕真正的用途——「第 2 步开的地址和第 1 步产出的是不是同一个」「哪条判据没过」
——同时让记录本身读不出内容。

几个刻意的选择：

- **HMAC 而不是裸哈希。** 常见网站和窗口标题的候选集很小，裸哈希可以用彩虹表还原。
  盐每台机器随机生成一次、只存家目录，跨机器无从反推。
- **`redacted` 字段逐条标注。** 留痕是 append-only 的，同一个文件可以跨越一次配置变更。
  回放时判据是「不等于 `true`」而不是「等于 `false`」：这个字段是后加的，早于它的记录里
  根本没有这一项，按 `=== false` 判会把那些**确实是原文**的旧记录静默当成安全的。
- **保留下来没有指纹化的只有结构**：应用名、动作 id、判据名、概率、耗时、通过与否。
  全抹掉的话留痕就只剩一串无法分辨的哈希，连「哪一步没过」都答不出来。
- **文件权限显式给出**（目录 `0o700`、文件 `0o600`），不听凭 umask。作者机器上 umask 恰好是
  077 看不出问题，别人机器上默认是 022，同机的其他用户就读得到了。
- 仓库的 `.gitignore` 也挡了一遍 `~/.bright-sight/` 的内容，以防有人把它软链或复制进来。

## 架构

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
   │            scripts.ts    冻结的脚本模板注册表（执行允许清单就是它的键集）
   │            osa.ts        唯一 spawn osascript 的出口，argv 传参边界
   ├─ verify    verify.ts     返回值 + 计数 diff + 定向回读
   └─ 留痕      journal.ts    JSONL 落盘 + 本地 ULID
                redact.ts     外部字符串 → 加盐指纹，默认开
```

闸门与配套：

| 模块 | 职责 |
|---|---|
| `chrome.ts` | Chrome profile 探测（`Local State` 与 `Preferences` mtime 两路交叉印证） |
| `settings.ts` | `~/.bright-sight/config.json`：允许名单与指纹盐 |
| `confirm.ts` | TTY 上当场拍板；非 TTY 时不假装问过 |
| `loop.ts` | 四步编排，全部依赖都是函数参数，可纯内存跑完整个控制流 |
| `config.ts` | 应用白名单、搜索引擎模板、代码兜底上限 |
| `cli.ts` | `run` / `surface` / `probe` / `journal` / `profile` |

`osa.ts` / `scripts.ts` / `policy.ts` 是安全核心，**刻意保持为独立文件**——藏进 `execute.ts`
就没有单一可审计对象了。

`chrome.ts` 读盘、`policy.ts` 不读盘，这条分工也是刻意的：策略层的「零 IO、纯函数」
必须一眼可验，所以探测结果作为参数传进去，而不是在里面读。

### 中文切片：枚举边界，不猜边界

中文没有空格，`\b` 词边界结构性失效：「搜一下typescript装饰器把链接存进备忘录」里，
`把` 是边界还是内容，正则判不了。

`spans.ts` 不做分词，做**锚点对枚举**：收集动词触发词、目标触发词、结构词、引号、
ASCII/数字连续段的位置，对每个动词锚点的结束位置向后枚举每一个锚点起始位置，产出所有区间。
锚点通常 3–6 个，候选十来个而非 O(n²) 爆炸，并有数量与长度上限兜底。

边界被穷举之后**让模型挑**——它只 pick，代码逐字复制，并强制校验选中片段必须是原话的
逐字子串（改一个字就拒绝）。

## 限制与已知边界

写在前面，免得你读完代码才发现：

- **不能切 Chrome profile，只能看清楚 + 问。** AppleScript 没有 profile 概念，这是外部限制，
  不是待办事项。如果你需要「在指定 profile 下执行」，这个项目给不了。
- **只支持两个应用、两条可执行动作**：Chrome 开标签页、Notes 建笔记。动作面能解析出全机
  所有可脚本化命令，但真正能发出去的就这两条。扩展意味着写新的脚本模板并过 `osacompile` 门禁。
- **阈值是初始猜测，还没用评测集标定。** `THRESHOLDS`（`execute: 0.75` / `complete: 0.6` /
  `destructive: 0.3`）应当在标注评测集上按「误执行代价」调出来，当前值是凭手感定的。
  这是策略不是常量，别把它当作调过的数。
- **输入通道只有命令行文本，语音尚未实现**，见下一节。
- **dry-run 只能演练一步**，原因见上文。
- **依赖 TypeSafe 的 System One 模型**，换一个只会生成文本的模型需要重写 `decide.ts` 的
  整个答案校验层——「模型只回答选择题」是这个架构的前提，不是可替换细节。
- AppleScript 侧踩过的四类坑（远程引用 -1700、`container of` 不能链式、没有文档的保留字表、
  位置定位静默指错对象）记在 `src/scripts.ts` 文件头与 `CLAUDE.md` 第四节，改模板前先读。

## Roadmap：语音输入（Phase 2，尚未实现）

`src/bar/` 目前是空目录，只有一份 README。**空目录不是遗漏，是本轮明确划出去的范围。**
语音输入不属于 `observe → judge → act → verify` 四步中的任何一步，它是第五件事：输入通道。

先做命令行而不是先接语音，理由有两条，也是这个项目做取舍的方式：

1. 命令行文本自带标点，中文切片器在有标点输入上的可靠性远高于无标点的转写。先在可靠输入上
   把闭环的判据钉死，再去接不可靠输入——出问题时才分得清是切片器不行还是转写不行。
2. 闭环的正确性判据与指令从哪来无关。先做语音，只会让这些判据在一个更吵的环境里被验证。

语音归 Phase 2，与 `is_command` 判断、`source: "voice"` 一起做——那个判断在命令行下
结构性恒为真，只有接了语音才有意义。细节见 `src/bar/README.md`。

## 测试

```sh
npm test          # node --test 'test/**/*.test.ts'
npm run typecheck # tsc --noEmit
npm run check     # 上面两条，提交前跑
npm run test:live # BRIGHTSIGHT_LIVE=1，跑有真实副作用的那几条
```

当前 `npm run check` 全绿：202 条测试，199 通过，3 条 live 测试默认 skip。

按「要不要真实副作用」分三档：

1. **无条件跑**（`npm test` 的绝大多数）。纯函数零 IO（`spans` 中文语料、`policy` 属性测试、
   `scripts` 纯字符串断言）、真实 IO 零网络（解析提交进仓库的 sdef fixture）、假 fetch 零网络
   （注入 `fetch`，**断言请求体比断言响应值钱**：每个 span 都是原话逐字子串、criteria 不含
   白名单外应用）、真实子进程（`osa.test.ts` 喂 `"` `\` 换行 emoji 以及 shell 注入样本，
   断言逐字节原样返回，一次性证明 argv 不变式）。
2. **静态语法门禁**。`test/compile.test.ts` 用 `osacompile` 把每个脚本模板编译一遍，
   只编译、不执行、不发 Apple Event，所以也无条件跑。它挡的是 AppleScript 那张**没有文档的
   保留字表**（已踩中 `after`、`at`、`st`）——踩中只会在真跑的那一刻报 -2741。
   这条测试自带阳性对照：拿一段已知会失败的脚本去编译，确认门禁本身没有失效。
3. **真实副作用**（`BRIGHTSIGHT_LIVE=1` 才跑）。真建一条笔记、真开一个标签页，按 id 回读验证，
   再按 id 删掉 / 关掉。别人跑 `npm test` 不该被要求先去系统设置里授自动化权限，
   也不该在别人的备忘录里凭空多出几条笔记。其中一条专门压住 `window 1` 那个缺陷：
   开完标签页后再造一个窗口顶到最前面，证明按 id 仍然找得回来，按位置就会读错。

`node:test` 扁平 `test()`，全仓 0 处 `describe`。

新增判据时要补一个「新旧分支同时可能命中」的测试：只测新逻辑的顺风路径，会让
「判据装错了位置」「把不该管的也管了」这类缺陷全绿通过。

## 许可证

MIT，见 [LICENSE](LICENSE)。

在这个仓库里写代码之前请先读 [CLAUDE.md](CLAUDE.md)——那里写的是「什么能进仓库」，
尤其是零硬编码与隐私默认值这两条。
