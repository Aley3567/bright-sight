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
# 图标以成品 icns 进仓库、构建只搬运不生成：换一台构建机打出的包图标也一致
cp "$APP_ROOT/Resources/AppIcon.icns" "$APP_PATH/Contents/Resources/AppIcon.icns"

CORE_PATH="$APP_PATH/Contents/Resources/core"
mkdir -p "$CORE_PATH/node_modules/@typesafe-ai"
cp -R "$REPO_ROOT/bin" "$CORE_PATH/bin"
cp -R "$REPO_ROOT/src" "$CORE_PATH/src"
cp "$REPO_ROOT/package.json" "$CORE_PATH/package.json"
cp -R "$REPO_ROOT/node_modules/@typesafe-ai/sdk" "$CORE_PATH/node_modules/@typesafe-ai/sdk"

# Node 运行时也拷进包。没有这一份，用户得先自己装 Node 才能说话，而失败点落在
# 「第一条指令」上——那时包已经离开这台机器了，报错没人接得住。
# 只拷二进制；CoreSession 仍然用 `zsh -l` 起它，好让登录 shell 里的 TYPESAFE_API_KEY 能被读到。
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "找不到 node，核心跑不起来。装好 Node >=24 再打包。" >&2
  exit 1
fi

# package.json 声明了 engines.node >=24。构建机版本低了，打出来的包要到用户第一次
# 说话才炸，所以拦在这里。解析失败也拦——那说明 node 本身有问题，不该带病打包。
NODE_VERSION="$("$NODE_BIN" --version 2>/dev/null || true)"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')"
if [[ -z "$NODE_MAJOR" || "$NODE_MAJOR" -lt 24 ]]; then
  echo "构建机的 node 报的是「${NODE_VERSION:-读不出}」，但 package.json 要求 >=24。换一个再打包。" >&2
  exit 1
fi
cp "$NODE_BIN" "$CORE_PATH/node"
chmod +x "$CORE_PATH/node"

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
if [[ -z "$SIGN_IDENTITY" ]]; then
  SIGN_IDENTITY="-"
  echo "Warning: no stable code-signing identity found; using ad-hoc signing"
fi
# 对外分发用 BRIGHTSIGHT_SIGN_IDENTITY=- 显式强制 ad-hoc。证书签的包会随证书到期而失效，
# 而发出去的那一份只签这一次、cdhash 固定，TCC 授权对终端用户反而是稳的。
# 开发机保持默认（优先 Apple Development），否则每次重建都换签名，本机授权会静默失效。

# 内层先签，外层后签；而且**不能带 hardened runtime**：V8 要 JIT，带 runtime 就得配
# allow-jit 之类的 entitlements 而我们一个都没有。不带 runtime 就没有这层要求。
# node 官方二进制本身是带 runtime 的，重签正好把这层去掉。
if [[ -f "$CORE_PATH/node" ]]; then
  codesign --force --timestamp=none --sign "$SIGN_IDENTITY" "$CORE_PATH/node"
fi
codesign --force --deep --timestamp=none --sign "$SIGN_IDENTITY" "$APP_PATH"

# 签名没弄好不能等到用户下载后才发现。--strict 会把「签了但签得不完整」也算失败。
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

# 光验签名不够：ad-hoc 重签过的 node 完全可能签名有效却起不来（V8 的 JIT 被 runtime 挡住是
# 典型死法）。这里真的跑一次，把「包里的运行时是坏的」拦在打包机上。
if ! "$CORE_PATH/node" --version >/dev/null 2>&1; then
  echo "包里那份 node 起不来，别发这个包。" >&2
  exit 1
fi

echo "Signed with: $SIGN_IDENTITY"

echo "$APP_PATH"
echo "开发期不想每次打包：bash apps/macos/scripts/dev-run.sh（swift run + 仓库根走环境变量）"

if [[ "${1:-}" == "--open" ]]; then
  open "$APP_PATH"
fi
