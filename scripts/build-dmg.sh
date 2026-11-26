#!/bin/bash
# Builds dist/Agent-Outbox-<version>-apple-silicon.dmg (+ .sha256) from dist/Agent Outbox.app.
#   scripts/build-dmg.sh [--no-build]     --no-build reuses the existing dist/Agent Outbox.app
# Run with the Bash sandbox off when driven by Claude (hdiutil, codesign).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
[ "${1:-}" = "--no-build" ] || ./scripts/build-app.sh
APP="$ROOT/dist/Agent Outbox.app"
[ -d "$APP" ] || { echo "missing $APP (run scripts/build-app.sh)" >&2; exit 1; }
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
[ "$(lipo -archs "$APP/Contents/MacOS/agent-outbox")" = arm64 ] || { echo "app is not arm64-only" >&2; exit 1; }
NAME="Agent-Outbox-$VERSION-apple-silicon.dmg"

STAGING="$(mktemp -d "$ROOT/dist/dmg-stage.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
ditto "$APP" "$STAGING/Agent Outbox.app"
ln -s /Applications "$STAGING/Applications"
cat > "$STAGING/Read Me.txt" <<'EOF'
Agent Outbox: your AI agents draft iMessages, you approve each one with Touch ID.

INSTALL
Drag Agent Outbox into Applications, then open it from Applications.

FIRST LAUNCH ("Open Anyway")
Agent Outbox is free and open source and is not notarized by Apple, so macOS
blocks the first launch. To allow it:
  1. Try to open Agent Outbox. macOS says it can't verify the developer. Click Done.
  2. Open System Settings > Privacy & Security and scroll to Security.
  3. Click "Open Anyway" next to Agent Outbox, then confirm with Touch ID or your password.
You only need to do this once per version. Managed Macs may not allow the exception.
Apple's instructions: https://support.apple.com/102445

REQUIREMENTS
Apple silicon Mac (M1 or newer), macOS 14 or later.

UPDATES
Each new version is a new download from
https://github.com/ay2609/agent-outbox/releases/latest
Because the app is not notarized, macOS asks again for Messages and Contacts
access after an update; allow them the same way.

Your messages, contacts and keys stay on this Mac, in
~/Library/Application Support/agent-outbox
EOF

codesign --verify --deep --strict "$STAGING/Agent Outbox.app"
rm -f "$ROOT/dist/$NAME" "$ROOT/dist/$NAME.sha256"
hdiutil create -volname "Agent Outbox" -srcfolder "$STAGING" -format UDZO -ov "$ROOT/dist/$NAME" >/dev/null
hdiutil verify "$ROOT/dist/$NAME" >/dev/null
(cd "$ROOT/dist" && shasum -a 256 "$NAME" > "$NAME.sha256")
echo "== packaged $ROOT/dist/$NAME ($(du -h "$ROOT/dist/$NAME" | cut -f1))"
cat "$ROOT/dist/$NAME.sha256"
