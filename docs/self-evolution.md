# 自进化：用户纠正驱动的记忆

这里的「自进化」不是让模型改写提示词、Policy 或可执行代码，而是把用户明确提交的纠正变成可查看、可验证、可回滚的偏好或短技能。

## 唯一闭环

```text
明确 feedback
  → CorrectionCase（原始纠正与失败证据）
  → candidate（偏好或 2–5 步语义技能）
  → fixture / dry-run 的代码判据
  → 用户启用
  → active
  → 有问题时暂停并产生修订候选
```

验证失败只能成为 `CorrectionCase.verifyFailures`，不能独立生成候选。候选也不能修改 `policy.ts`、`scripts.ts`、Chrome profile 允许名单或其它权限。

## 作用域与版本

作用域固定为 `application + taskKind`。同一作用域最多一个 `active` 版本：新版本启用时旧版本进入 `superseded`。状态只有：

- `candidate`：等待验证与确认。
- `active`：当前有效版本。
- `suspended`：负面反馈后暂停。
- `rejected`：用户明确拒绝。
- `superseded`：被新活动版本替代。

候选每次修改都会重新回到 `validation=pending`。只有带至少一个代码判据的 `validation=passed` 才能启用。

## 保存什么

运行时目录是 `~/.bright-sight/evolution/`：

| 文件 | 内容 |
|---|---|
| `corrections.jsonl` | 用户主动提交的完整纠正、run 引用和验证失败证据 |
| `memories.json` | 当前候选与版本化偏好/技能，不含整段对话历史 |
| `deletions.jsonl` | 不含纠正内容的删除审计 |

完整纠正只在用户调用 `feedback` 时保存；它不会进入普通 `run` 的模型上下文。技能只保存语义 `actionId` 与验证判据名，不保存坐标、selector、临时节点、argv 值或生成代码。

目录与文件显式申请 `0700/0600`。Windows 不实现 POSIX mode，但同一份代码在目标平台 macOS 上会生效。

## 保留与忘记

- 未采用候选：30 天。
- 暂停、拒绝或被替代版本：90 天。
- 活动版本：保留到用户主动忘记。
- `forget`：删除同一作用域全部版本及关联原始纠正，只留下不含内容的删除记录。

## 当前入口

```sh
# 根据既有 run 明确提交纠正；默认生成偏好候选
bright-sight feedback <runId> "以后先按时间筛选，再打开"

# 把一次已经包含 2–5 个已执行步骤的 run 保存为短技能候选
bright-sight feedback <runId> "这个步骤顺序才对" --skill

bright-sight memory
bright-sight memory validate <id> <fixture-or-dry-run-id>
bright-sight memory activate <id>
bright-sight memory suspend <id>
bright-sight memory reject <id>
bright-sight memory helpful <id>
bright-sight memory forget <id>

# 等价的自然语言指引入口
bright-sight memory 忘掉 <id>
bright-sight memory 暂停 <id>
bright-sight memory 恢复 <id>
```

`src/evolution.ts` 的 `suggest(scope)` 是 Session 与语音条未来接入的窄接口，只返回候选/活动记忆，不返回原始纠正对话。

## 长条 UI 契约

当前仓库还没有语音条宿主，`src/bar/` 只有 Phase 2 说明，因此这里不新增 UI 框架。未来长条在一次行为完成后临时显示：

```text
已按「先筛选再打开」完成    正确 · 有问题
```

点击「有问题」再展开五个意图：`use_once / activate / skip / revise / forget`。这些值由 `FEEDBACK_STRIP_ACTIONS` 导出，UI 不需要复制状态机。

## 定时授权边界

`authorizeScheduled` 只描述最终确定的安全契约，不负责调度：

- `read/navigate/draft` 不需要预授权。
- `submit/change` 必须精确绑定记忆版本、应用、目标、输入指纹和验证判据。
- 任一字段变化即失效。
- `destroy` 永远拒绝。

真正的 schedule 仍须在相应阶段复用现有 Policy 和 verify；本模块不会创建第二条执行路径。

