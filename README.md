# bright-sight · 明视

不看屏幕像素的 macOS 桌面智能体。

感知来自**无障碍树**与**应用脚本字典（sdef）**，不截图、不做 OCR、不认图标。
动作面从系统自己长出来——扫描全盘 `.app` 的 sdef，一台普通 Mac 上实测长出 751 个动作、
覆盖 30 个可脚本化应用，**其中绝大多数我们从没见过**。
没有为任何单个应用写过发现或决策代码。

决策交给 [TypeSafe](https://typesafe.ai) 的 Jev（System One 模型）：它只回答类型化选择题
并返回概率分布，**不生成任何文本**。控制流完全归代码所有。

## 状态

Phase 1 已闭环：`observe → judge → act → verify` 四步跑通一条跨应用两步指令。

```
bright-sight run "搜一下 TypeScript 的 erasableSyntaxOnly，把链接存进备忘录" --execute
```

默认 dry-run，只打印计划与每步解析后的完整 argv；`--execute` 才真发 Apple Event。

## 核心不变式：标识符 / 值 两层分离

整个执行器只需记住这一条：

|            | 来源                                        | 可否拼进脚本文本 | 校验                    |
| ---------- | ------------------------------------------- | ---------------- | ----------------------- |
| **标识符** | sdef（磁盘上的系统文件）、代码常量          | 可以             | 须过 `/^[a-z][a-z ]*$/` |
| **值**     | 用户原话、模型输出、**页面回读**、剪贴板    | **永远不可以**   | 只走 `argv`             |

AppleScript 的 `note`、`body`、`window` 是关键字不是字符串，无法经 argv 传递——
这是客观限制，所以标识符必须允许插值；但标识符只来自 sdef 和代码常量，
不受用户输入与模型输出影响，字符集校验是纵深防御。

值这一侧零例外：`execFile`（无 shell）+ `on run argv`（不进字符串字面量），
两层「无需转义」叠加，转义需求归零。`osa.ts` 是唯一 spawn `osascript` 的出口。

## 三道独立硬闸

```
blocked = spec.risk === "destructive"                   // 构建期固定表，模型碰不到
       || judgement.destructive > THRESHOLDS.destructive // 模型只能加，不能减
       || template.effect === "destroy"                  // 模板自带，抓 sdef 误标
```

取**或**。代码里不存在任何路径让模型的概率**降低**拦截强度。

执行走**允许清单**而非风险黑名单。黑名单的失败模式是「没想到的都放行」，
而动作面是从 sdef 自动生成的——无法预先枚举系统会长出什么命令，
所以黑名单在这个架构下是结构性错误。

最典型的例子：Chrome 的 `execute` 命令（`Execute a piece of javascript`）在黑名单下
会被判 `safe` 并一路放行到「模型生成的字符串在浏览器里执行」。
在允许清单下它**根本不进执行注册表**，模型即使选中也发不出去。

## verify 全部由代码判定

模型不参与自证结果。检查项包括退出码、回读格式前缀、标签页增量、
落点 `origin` 匹配、笔记数增量、**回读笔记实际落在哪个容器**、正文含目标 URL。

终止不信任模型的 `DONE`：

```
done ⟺ 模型选了 DONE ∧ 每条 StepRecord 的 verify.ok === true ∧ 目标产物齐备
```

外加三条不经模型的代码兜底：`MAX_STEPS = 6`、重复守卫（同一动作+argv 被提议第二次强制阻断）、
决策消费一次（副作用发生**之前**置空，重试不会建两条笔记）。

## 模块

```
src/
  osa.ts       唯一 spawn osascript 的出口，argv 传参边界
  scripts.ts   冻结的脚本模板注册表（执行允许清单就是它的键集）
  policy.ts    纯代码阈值链 → 5 态 + reasons[]，零 IO 零网络
  surface.ts   白名单过滤 + 任务层动作
  actions.ts   sdef 解析、make 展开、动作面磁盘缓存
  spans.ts     中文候选片段过度生成（锚点对枚举，不做分词）
  decide.ts    问题集构建 + 答案校验
  execute.ts   三道硬闸 + 参数解析 + 前后计数 + 回读解析
  verify.ts    返回值 + 计数 diff + 定向回读
  journal.ts   JSONL 落盘 + 本地 ULID
  loop.ts      四步编排
  perceive.ts  轻/全快照 + 选中文本
  cli.ts       run | surface | probe | journal
```

`osa.ts` / `scripts.ts` / `policy.ts` 是安全核心，**刻意保持为独立文件**——
藏进 `execute.ts` 就没有单一可审计对象了。

## 中文切片：枚举边界，不猜边界

中文没有空格，`\b` 词边界结构性失效：「搜一下typescript装饰器把链接存进备忘录」里，
`把` 是边界还是内容，正则判不了。

`spans.ts` 不做分词，做**锚点对枚举**：收集动词触发词、目标触发词、结构词、引号、
ASCII/数字连续段的位置，对每个动词锚点的结束位置向后枚举每一个锚点起始位置，
产出所有区间。锚点通常 3–6 个，候选十来个而非 O(n²) 爆炸。

边界被穷举了，**让模型挑**——它只 pick，代码逐字复制，并强制校验
选中片段必须是原话的逐字子串（改一个字就拒绝）。

## 运行

需要 Node ≥ 24（原生 TypeScript 类型剥离，无构建步骤）与 macOS 自动化权限。

```sh
npm install
npm run check          # tsc --noEmit && node --test
bright-sight surface   # 看动作面
bright-sight run "..." # dry-run
```

`BRIGHTSIGHT_LIVE=1` 才跑会产生真实副作用的测试（默认 skip，
别的机器 `npm test` 不需要自动化权限）。
`BRIGHTSIGHT_ENGINE` 选搜索引擎（google / duckduckgo / bing）。

运行时状态写在 `~/.bright-sight/`：动作面缓存与 JSONL 运行日志。
**日志逐条记录用户原话、窗口标题、URL、笔记正文**，已在 `.gitignore` 里排除。

## 测试

四类，沿用「真实 IO + 临时目录 / 真实子进程」而非 mock 抽象层：

1. **纯函数零 IO**：`spans` 中文语料表、`policy` 属性测试、`scripts` 纯字符串断言
   （每个模板含 `on run argv`、`item N of argv` 出现数 == arity、`src` 不含 `${`）
2. **真实 IO 零网络**：解析提交进仓库的 sdef fixture，断言不随本机 app 版本漂移
3. **假 fetch 零网络**：注入 `fetch`，**断言请求体比断言响应值钱**——
   每个 span 都是原话逐字子串、criteria 不含白名单外应用
4. **真实子进程**：`osa.test.ts` 喂 `"` `\` 换行 emoji `'; do shell script "echo pwned"`
   `$(whoami)`，断言逐字节原样返回——一次性证明 argv 不变式

`node:test` 扁平 `test()`，全仓 0 处 `describe`。
