#!/usr/bin/env bash
# swift run 跑起来的 App 没有 .app 包，Bundle.main.resourceURL 底下也就没有 core/，
# 于是第一条指令就是 missingCore——等于每改一行 Swift 都要先打一次包。
#
# 这里把仓库根用环境变量交给 App（CoreLocator 的开发期回退）。路径从脚本自身位置推出来，
# 不写死任何人的家目录：这个仓库会被 clone 到别的地方。
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$APP_ROOT/../.." && pwd)"

if [[ ! -f "$REPO_ROOT/bin/bright-sight.js" || ! -f "$REPO_ROOT/package.json" ]]; then
  echo "在 $REPO_ROOT 下没找到 bin/bright-sight.js 与 package.json，这不像仓库根" >&2
  exit 1
fi

# BRIGHTSIGHT_VOICE_LOG_CORE=1 会把核心的 stderr 转到终端。默认丢弃：那里面可能有用户原话，
# 而 App 的 stderr 在双击启动时会被系统收走，等于绕开 src/redact.ts 攒一份明文。
exec env BRIGHTSIGHT_CORE_ROOT="$REPO_ROOT" swift run --package-path "$APP_ROOT" BrightSightVoice "$@"
