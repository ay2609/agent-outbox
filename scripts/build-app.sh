#!/bin/bash
# Builds dist/Agent Outbox.app (Apple silicon, macOS 14+, ad-hoc signed). Needs bun, swift and Xcode command line tools.
# Run with the Bash sandbox off when driven by Claude (swift, codesign and bun write outside the working directory).
#
#   scripts/build-app.sh
#
# Env (optional):
#   BUILD_NUMBER         CFBundleVersion (default: git commit count; the update check compares this, so it must only go up)
#
# Bundle layout:
#   Contents/MacOS/Agent Outbox          SwiftUI shell (app/ SwiftPM target AgentOutbox)
#   Contents/MacOS/agent-outbox          bun-compiled server | mcp | cli
#   Contents/Helpers/OutboxExec.app      the executor, unchanged (own bundle id, entitlements, runtime)
#   Contents/Resources/AppIcon.icns      from app/Resources/icon-512.png
# There is no web dashboard: the app is the only interface, and the server is started socket-only (--app-auth-fd).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
APP_NAME="Agent Outbox"
APP="$ROOT/dist/$APP_NAME.app"
STAGE="$ROOT/dist/stage"
APP_ID="io.github.ay2609.agent-outbox"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"
[ -n "$VERSION" ] || { echo "cannot read version from package.json" >&2; exit 1; }
BUILD_NUMBER="${BUILD_NUMBER:-$(git rev-list --count HEAD 2>/dev/null || echo 1)}"
FEED_URL="https://agent-outbox.halcyn.dev/updates/appcast.xml"

[ "$(uname -m)" = arm64 ] || echo "warning: building on $(uname -m); the app is arm64-only" >&2

rm -rf "$APP" "$STAGE"
mkdir -p "$STAGE"

echo "== 1/5 bun binary (src/bin.ts -> agent-outbox)"
bun install --frozen-lockfile >/dev/null
bun build --compile --target=bun-darwin-arm64 src/bin.ts --outfile "$STAGE/agent-outbox" >/dev/null

echo "== 2/5 SwiftUI shell (swift build -c release --arch arm64)"
# With only the Command Line Tools, the newest SDK can lack the SwiftUI macro plugin (@State fails to expand). Then fall back
# to the newest MacOSX26*.sdk. Override with SWIFT_SDK=/path/to/MacOSX.sdk. Full Xcode (CI) builds with the default SDK.
SDK_ARGS=()
if [ -n "${SWIFT_SDK:-}" ]; then SDK_ARGS=(--sdk "$SWIFT_SDK")
elif xcode-select -p 2>/dev/null | grep -q CommandLineTools; then
  FALLBACK_SDK="$(ls -d /Library/Developer/CommandLineTools/SDKs/MacOSX26*.sdk 2>/dev/null | grep -v 'MacOSX26.sdk$' | sort -V | tail -1)"
  [ -n "$FALLBACK_SDK" ] && SDK_ARGS=(--sdk "$FALLBACK_SDK")
fi
# A failed compile must stop the build (a stale binary from an earlier run would otherwise be bundled).
SWIFT_LOG="$(mktemp)"
if ! (cd app && swift build -c release --arch arm64 ${SDK_ARGS[@]+"${SDK_ARGS[@]}"} >"$SWIFT_LOG" 2>&1); then
  grep -v '^\[' "$SWIFT_LOG" | grep -v "ld: warning: search path" >&2; rm -f "$SWIFT_LOG"; echo "swift build failed" >&2; exit 1
fi
grep -v '^\[' "$SWIFT_LOG" | grep -v "ld: warning: search path" | grep -E "error|warning: .*AgentOutbox" || true; rm -f "$SWIFT_LOG"
SWIFT_BIN="$(cd app && swift build -c release --arch arm64 ${SDK_ARGS[@]+"${SDK_ARGS[@]}"} --show-bin-path 2>/dev/null)"
[ -x "$SWIFT_BIN/AgentOutbox" ] || { echo "swift build failed: $SWIFT_BIN/AgentOutbox not found" >&2; exit 1; }

echo "== 3/5 executor (exec/build.sh)"
(cd exec && ./build.sh >/dev/null)
EXEC_APP="$ROOT/exec/build/OutboxExec.app"
[ -d "$EXEC_APP" ] || { echo "executor app missing" >&2; exit 1; }

echo "== 4/5 assembling $APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Helpers" "$APP/Contents/Resources"
cp "$SWIFT_BIN/AgentOutbox" "$APP/Contents/MacOS/$APP_NAME"
cp "$STAGE/agent-outbox" "$APP/Contents/MacOS/agent-outbox"
ditto "$EXEC_APP" "$APP/Contents/Helpers/OutboxExec.app"
# The executor's login item (SMAppService.agent(plistName:) looks in Contents/Library/LaunchAgents).
mkdir -p "$APP/Contents/Library/LaunchAgents"
cp "$ROOT/app/Resources/LaunchAgents/io.github.ay2609.agent-outbox.exec.plist" "$APP/Contents/Library/LaunchAgents/"
# Icon: the app mark, from the 512 px PNG (the 1024 px slot is upscaled).
ICONSET="$STAGE/AppIcon.iconset"
mkdir -p "$ICONSET"
SRC_PNG="$ROOT/app/Resources/icon-512.png"
for size in 16 32 128 256 512; do
  sips -z $size $size "$SRC_PNG" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$SRC_PNG" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key><string>$APP_ID</string>
	<key>NSContactsUsageDescription</key><string>Agent Outbox reads your contacts so you can review drafts, and adds the contacts you approved.</string>
	<key>NSAppleEventsUsageDescription</key><string>Agent Outbox sends the iMessages you approved, through Messages.</string>
	<key>CFBundleName</key><string>$APP_NAME</string>
	<key>CFBundleDisplayName</key><string>$APP_NAME</string>
	<key>CFBundleExecutable</key><string>$APP_NAME</string>
	<key>CFBundleIconFile</key><string>AppIcon</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleShortVersionString</key><string>$VERSION</string>
	<key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
	<key>LSMinimumSystemVersion</key><string>14.0</string>
	<key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
	<!-- LSUIElement=false: a normal Dock app with a window. A menu-bar-only app would set true;
	     the bundle works either way. -->
	<key>LSUIElement</key><false/>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSPrincipalClass</key><string>NSApplication</string>
	<key>NSHumanReadableCopyright</key><string>MIT License</string>
	<!-- agent-outbox://inbox | batch/<id> | contacts/changes/<id> | imports/<id> | groups/<id>: navigation only (Links.swift). -->
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleURLName</key><string>$APP_ID</string>
			<key>CFBundleURLSchemes</key>
			<array><string>agent-outbox</string></array>
		</dict>
	</array>
	<!-- Read by Updater.swift: a Sparkle-format appcast, check-only (no Sparkle framework: see Updater.swift). -->
	<key>AOUpdateFeedURL</key><string>$FEED_URL</string>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist" >/dev/null

echo "== 5/5 codesign (ad-hoc, hardened runtime), inner to outer"
SIGN=(codesign --force --sign - --options runtime)
# 1. the executor: same identifier, entitlements and runtime as exec/build.sh gave it (Messages/Contacts grants hang on this)
"${SIGN[@]}" --identifier "io.github.ay2609.agent-outbox.exec" --entitlements "$ROOT/exec/entitlements.plist" "$APP/Contents/Helpers/OutboxExec.app"
# 2. the bun server: only the JIT entitlement (see scripts/bun-entitlements.plist for the test that proves it is enough)
"${SIGN[@]}" --identifier "$APP_ID.server" --entitlements "$ROOT/scripts/bun-entitlements.plist" "$APP/Contents/MacOS/agent-outbox"
# 3. the outer app: hardened runtime, only the two permission-request entitlements in scripts/app-entitlements.plist (macOS
#    attributes the login-item sender's Contacts/Automation prompts to this app). It must never gain get-task-allow /
#    allow-jit / allow-dyld-environment-variables / disable-library-validation (checked below).
"${SIGN[@]}" --identifier "$APP_ID" --entitlements "$ROOT/scripts/app-entitlements.plist" "$APP"

echo "== verify"
codesign --verify --deep --strict --verbose=1 "$APP"
codesign -dvv "$APP" 2>&1 | grep -E 'Identifier|flags|Signature|TeamIdentifier' || true
if codesign -d --entitlements :- "$APP" 2>/dev/null | grep -E 'get-task-allow|allow-jit|allow-dyld-environment-variables|disable-library-validation'; then
  echo "outer app has forbidden entitlements" >&2; exit 1
fi
echo "   outer app entitlements: addressbook + apple-events only"
for f in "$APP/Contents/MacOS/$APP_NAME" "$APP/Contents/MacOS/agent-outbox"; do
  [ "$(lipo -archs "$f")" = arm64 ] || { echo "$f is not arm64-only" >&2; exit 1; }
done
echo "   architectures: arm64 only"
SIZE="$(du -sh "$APP" | cut -f1)"
echo "== built $APP ($SIZE, version $VERSION build $BUILD_NUMBER)"
