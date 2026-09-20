#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$APP_ROOT/../.." && pwd)"
BUILD_MODE="${BRIGHTSIGHT_VOICE_BUILD_MODE:-debug}"
APP_PATH="$REPO_ROOT/dist/Bright Sight.app"
EXECUTABLE="$APP_ROOT/.build/$BUILD_MODE/BrightSightVoice"

swift build --package-path "$APP_ROOT" -c "$BUILD_MODE"

mkdir -p "$(dirname "$APP_PATH")"

if [[ -d "$APP_PATH" ]]; then
  /bin/rm -rf "$APP_PATH"
fi

mkdir -p "$APP_PATH/Contents/MacOS" "$APP_PATH/Contents/Resources"
cp "$EXECUTABLE" "$APP_PATH/Contents/MacOS/BrightSightVoice"
cp "$APP_ROOT/Resources/Info.plist" "$APP_PATH/Contents/Info.plist"

CORE_PATH="$APP_PATH/Contents/Resources/core"
mkdir -p "$CORE_PATH/node_modules/@typesafe-ai"
cp -R "$REPO_ROOT/bin" "$CORE_PATH/bin"
cp -R "$REPO_ROOT/src" "$CORE_PATH/src"
cp "$REPO_ROOT/package.json" "$CORE_PATH/package.json"
cp -R "$REPO_ROOT/node_modules/@typesafe-ai/sdk" "$CORE_PATH/node_modules/@typesafe-ai/sdk"

# App 靠这两个文件认出「这里是核心」（CoreLocator.looksLikeCoreRoot）。少拷一个的后果不是报错，
# 是运行时静默回退到磁盘上某个仓库副本，或者干脆 missingCore——都要等到第一条指令才暴露。
for required in "bin/bright-sight.js" "package.json"; do
  if [[ ! -f "$CORE_PATH/$required" ]]; then
    echo "核心没有拷全：缺 $required" >&2
    exit 1
  fi
done

plutil -lint "$APP_PATH/Contents/Info.plist"

SIGN_IDENTITY="${BRIGHTSIGHT_SIGN_IDENTITY:-}"
if [[ -z "$SIGN_IDENTITY" ]]; then
  SIGN_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -1)"
fi
if [[ -n "$SIGN_IDENTITY" ]]; then
  codesign --force --deep --timestamp=none --sign "$SIGN_IDENTITY" "$APP_PATH"
  echo "Signed with: $SIGN_IDENTITY"
else
  codesign --force --deep --sign - "$APP_PATH"
  echo "Warning: no stable code-signing identity found; using ad-hoc signing"
fi

echo "$APP_PATH"
echo "开发期不想每次打包：bash apps/macos/scripts/dev-run.sh（swift run + 仓库根走环境变量）"

if [[ "${1:-}" == "--open" ]]; then
  open "$APP_PATH"
fi
