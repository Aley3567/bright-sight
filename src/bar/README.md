# bar/ — 语音条 UI

语音条已经迁移到原生 macOS 应用 [`apps/macos`](../../apps/macos)。这里不再存放实现，避免 Node CLI 与 SwiftUI 各维护一套界面状态。

输入通道与 observe → judge → act → verify 分开：语音和文字最终都提交同一种文字命令，核心闭环不需要知道文字来自麦克风还是键盘。
