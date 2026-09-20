# Bright Sight Voice for macOS

这是 Bright Sight 的第一阶段原生客户端。它提供菜单栏入口、顶部浮动胶囊、右 Command 按住说话、Apple Speech 中文转录基线、文字输入和中文语音反馈。

`CommandExecuting` 已接入仓库原有的 observe → judge → act → verify 闭环。目前支持精确匹配并打开本机已安装应用，以及 Chrome 新建搜索标签页和备忘录新建笔记；只有启动回调成功或动作验证通过后，客户端才会显示和播报完成。

## 进程模型

核心是一个**长驻**的 `bright-sight serve`，两侧走 stdio 上的 JSON Lines 双向 RPC。人读契约在
`src/protocol.ts`；Swift 这侧是它的影子 `Sources/BrightSightVoice/CoreBridge/`，会漂移，对齐靠
平行测试而不是 codegen。`ax.observe` / `ax.perform` 已经接线：递给模型的选项里既有从 sdef 解析出
的脚本动作，也有从无障碍树观察出来的界面动作，后者的执行落在 Swift 这侧。
连续几条指令复用同一个 Node 进程；核心崩了下一条指令会把它拉起来，但**不会替你重发上一条**——
那条指令的副作用发生没有，这一侧看不见，只能由人决定。

## 运行

```sh
npm run voice:test
npm run voice:open
```

开发期不必每次打包：

```sh
bash apps/macos/scripts/dev-run.sh
```

`swift run` 出来的进程没有 .app 包，`Bundle.main.resourceURL` 底下没有 `core/`。这个脚本把仓库根
用 `BRIGHTSIGHT_CORE_ROOT` 交给 App（路径由脚本位置推导，不写死家目录）；没有设它时 App 还会从
可执行文件位置向上找同时有 `bin/bright-sight.js` 与 `package.json` 的目录。

两个只控制行为、不存数据的开关：

| 变量 | 作用 | 默认 |
|---|---|---|
| `BRIGHTSIGHT_CORE_ROOT` | 开发期核心位置回退 | 无，走应用包 |
| `BRIGHTSIGHT_VOICE_LOG_CORE` | 设为 `1` 才把核心 stderr 转到 App 的 stderr | 丢弃 |

核心 stderr 默认丢弃是有原因的：里面可能带用户原话，而落盘留痕默认脱敏（`src/redact.ts`），
在这一侧顺手写一份明文日志等于把脱敏白做。丢归丢，读还是要读——不读的话管道写满，核心会卡在
write 上不动。

构建后的可双击应用位于仓库根目录的 `dist/Bright Sight.app`。双击时即使应用已经在后台运行，也会重新显示顶部胶囊。菜单栏入口显示为 Bright Sight 图标加 `BS`，避免在图标较多时难以辨认。

首次运行会请求：

- 麦克风：采集按键期间的声音。
- 语音识别：将声音转成文字。
- 辅助功能：在其他应用前台时监听右 Command。
- 自动化：首次真实控制 Chrome 或备忘录时，由 macOS 请求对应权限。

自然语言决策仍需要 `TYPESAFE_API_KEY`。应用通过登录 shell 读取已有环境配置，不把凭证复制进应用包。

如果右 Command 没有响应，请在“系统设置 → 隐私与安全性 → 辅助功能”中允许 Bright Sight，然后重启应用。

应用启动时不会主动打开系统设置。需要授权右 Command 时，右击菜单栏 `BS`，选择“允许右 Command 快捷键…”。构建脚本会优先使用本机已有的 Apple Development 证书稳定签名，避免每次重建都产生新的临时权限身份。

## 交互

- 按住右 Command：开始录音并显示实时文字。
- 松开右 Command：结束录音，只在 final transcript 产生后提交。
- 监听时可选择“完成”提交或“取消”放弃；转录与执行中可随时返回修改或停止。
- 转录失败会保留在错误态，提供“修改”“重新说”和“重试”，不会自动消失。
- Bright Sight 播报语音时显示动态输出波形，并可单独停止播报。
- 单击菜单栏图标：显示或隐藏胶囊。
- 右击菜单栏图标：开始说话、输入文字、切换语音反馈或退出。
- 胶囊中的麦克风和文字按钮提供不依赖快捷键的替代入口。
- “打开我的微信”“打开 Safari”“启动系统设置”等精确应用启动指令走本机 Native Launcher；描述不明确或匹配到多个应用时不会猜测。

## 代码 Seam

- `SpeechTranscribing`：Apple Speech 只是一个 Adapter，云端中文 ASR 将实现同一 Interface。
- `CommandExecuting`：接收统一文字命令，返回 `CommandOutcome`。生产 Adapter 是 `CoreCommandExecutor`（JSON-RPC）；「打开某 App」在它内部走 Native Launcher，不经 Session。
- `SpeechSpeaking`：播放核心返回的短反馈，UI 不自行推断行动结果。
- UI 投影的是一次 `session.handle` / `confirm` 的 `SessionUpdate`，不是设计文档里的 `BrightSightEvent` 流。`needs_input` 没有回答入口，目前被呈现为未完成。
