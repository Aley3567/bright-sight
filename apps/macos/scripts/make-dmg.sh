#!/usr/bin/env bash
set -euo pipefail

# 出对外分发的 dmg。和 build-app.sh 的分工：那个管「这台机器上有个能跑的 App」，
# 这个管「这个 App 能离开这台机器」。
#
# 与开发构建的三处不同，每一处都是为了让包在别人机器上成立：
#   1. release 构建。debug 包体积大一截、启动慢，那是开发循环的取舍，不该发给用户。
#   2. 强制 ad-hoc 签名。开发机默认优先 Apple Development 证书（本机授权才稳定），
#      但那张证书会过期，过期后发出去的包会失效；对外那一份只签一次、cdhash 固定。
#   3. 附一份打开说明。没公证的包第一次双击一定被 Gatekeeper 拦，这条不写清楚，
#      用户会以为包是坏的。

APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$APP_ROOT/../.." && pwd)"
APP_NAME="Bright Sight"
APP_PATH="$REPO_ROOT/dist/$APP_NAME.app"

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_ROOT/Resources/Info.plist")"
DMG_PATH="$REPO_ROOT/dist/$APP_NAME-$VERSION.dmg"

STAGE="$(mktemp -d)"
trap '/bin/rm -rf "$STAGE"' EXIT

BRIGHTSIGHT_VOICE_BUILD_MODE=release \
BRIGHTSIGHT_SIGN_IDENTITY="-" \
  bash "$APP_ROOT/scripts/build-app.sh"

if [[ ! -d "$APP_PATH" ]]; then
  echo "构建没有产出 $APP_PATH" >&2
  exit 1
fi

cp -R "$APP_PATH" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

cat > "$STAGE/第一次打开看这里.txt" <<'TXT'
Bright Sight 没有经过 Apple 公证，所以第一次打开会被系统拦下。这不是包坏了。

macOS 14 及更早：
  在「应用程序」里右键点 Bright Sight → 选「打开」→ 弹窗里再点一次「打开」。

macOS 15 及更新：
  系统已经不允许用右键绕过了。请打开「系统设置 → 隐私与安全性」，
  在「安全性」一节里找到刚被拦下的那条提示，点「仍要打开」。

两种系统都可以用的替代办法（终端里执行一次，之后双击即可）：
  xattr -dr com.apple.quarantine "/Applications/Bright Sight.app"

首次运行会依次要三项权限，都点允许：
  - 辅助功能：观察和操作你指定的应用
  - 麦克风：接收你按住右 Command 说的话
  - 语音识别：把说的话转成文字

还需要一个 TypeSafe 的 API key。写进 ~/.zshrc 之后重启 App 生效：
  export TYPESAFE_API_KEY=<你的 key>
TXT

/bin/rm -f "$DMG_PATH"
hdiutil create \
  -volname "$APP_NAME $VERSION" \
  -srcfolder "$STAGE" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

echo "$DMG_PATH"
echo "这是对外分发的那一份（release + ad-hoc 签名，未公证）。"
