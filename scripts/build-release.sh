#!/bin/bash
# Prepares a release: app + DMG + sha256, the update feed and the site's download text, then a GitHub release.
#
#   scripts/build-release.sh [--dry-run] [--no-build]
#
#   --dry-run   build everything and write the feed to dist/appcast.xml, but do NOT touch site/, tag, or run `gh release`
#               (the gh command is printed instead). Safe to run any time.
#   --no-build  reuse the DMG already in dist/ (for re-running after a failure)
#
# Order of a real release (the owner does each step; this script never pushes or deploys):
#   1. bump "version" in package.json (the feed compares the build number, which is the git commit count by default)
#   2. scripts/build-release.sh          builds, writes site/public/updates/appcast.xml + the site's version/size text,
#                                        and runs `gh release create vX.Y.Z <dmg> <dmg>.sha256`
#   3. commit site/ changes, git push
#   4. cd site && npx wrangler@4 deploy
#
# Updates: the app checks the appcast (Sparkle-format RSS, see app/Sources/AgentOutbox/Updater.swift) and links the
# user to the release page; it never downloads or installs anything itself, so no EdDSA signing key is involved.
# Integrity comes from HTTPS and the sha256 published with the release.
# Run with the Bash sandbox off when driven by Claude (swift, codesign, hdiutil, gh).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
DRY=0; BUILD=1
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --no-build) BUILD=0 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
REPO="ay2609/agent-outbox"
APP="$ROOT/dist/Agent Outbox.app"

if [ "$BUILD" = 1 ]; then ./scripts/build-dmg.sh; else ./scripts/build-dmg.sh --no-build; fi
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
BUILD_NUMBER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")"
NAME="Agent-Outbox-$VERSION-apple-silicon.dmg"
DMG="$ROOT/dist/$NAME"
[ -f "$DMG" ] || { echo "missing $DMG" >&2; exit 1; }
TAG="v$VERSION"
SIZE_BYTES="$(stat -f %z "$DMG")"
SIZE_MB="$(python3 -c "print(round($SIZE_BYTES/1e6))")"
DL_URL="https://github.com/$REPO/releases/download/$TAG/$NAME"
PAGE_URL="https://github.com/$REPO/releases/tag/$TAG"
FEED_REL="site/public/updates/appcast.xml"
if [ "$DRY" = 1 ]; then FEED_OUT="$ROOT/dist/appcast.xml"; else FEED_OUT="$ROOT/$FEED_REL"; fi

# The build number must only go up, or nobody is offered the update.
if [ -f "$ROOT/$FEED_REL" ]; then
  LAST="$(grep -o '<sparkle:version>[0-9]*' "$ROOT/$FEED_REL" | grep -o '[0-9]*$' | sort -n | tail -1 || true)"
  if [ -n "${LAST:-}" ] && [ "$BUILD_NUMBER" -le "$LAST" ]; then
    echo "build number $BUILD_NUMBER is not above the published $LAST (set BUILD_NUMBER or commit first)" >&2
    [ "$DRY" = 1 ] || exit 1
  fi
fi

echo "== appcast -> $FEED_OUT"
mkdir -p "$(dirname "$FEED_OUT")"
python3 -I - "$ROOT/$FEED_REL" "$FEED_OUT" "$VERSION" "$BUILD_NUMBER" "$DL_URL" "$PAGE_URL" "$SIZE_BYTES" <<'PY'
import re, sys, time
old, out, version, build, dl, page, size = sys.argv[1:]
pub = time.strftime("%a, %d %b %Y %H:%M:%S +0000", time.gmtime())
item = f"""    <item>
      <title>Agent Outbox {version}</title>
      <pubDate>{pub}</pubDate>
      <link>{page}</link>
      <sparkle:version>{build}</sparkle:version>
      <sparkle:shortVersionString>{version}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
      <enclosure url="{dl}" length="{size}" type="application/x-apple-diskimage"/>
    </item>
"""
try:
    prev = re.findall(r"    <item>.*?</item>\n", open(old).read(), re.S)
except FileNotFoundError:
    prev = []
prev = [p for p in prev if f"<sparkle:version>{build}<" not in p]
doc = f"""<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Agent Outbox</title>
    <link>https://agent-outbox.halcyn.dev</link>
{item}{''.join(prev)}  </channel>
</rss>
"""
open(out, "w").write(doc)
PY
xmllint --noout "$FEED_OUT" 2>/dev/null || python3 -c "import sys,xml.dom.minidom as m; m.parse(sys.argv[1])" "$FEED_OUT"

if [ "$DRY" = 0 ]; then
  echo "== site download text (version $VERSION, ${SIZE_MB} MB)"
  python3 -I - "$ROOT/site/public/index.html" "v$VERSION" "$SIZE_MB" "$DL_URL" <<'PY'
import re, sys
p, ver, mb, url = sys.argv[1:]
s = open(p).read()
s = re.sub(r'(<span data-ao="version">)[^<]*', r'\g<1>' + ver, s)
s = re.sub(r'(<span data-ao="size">)[^<]*', r'\g<1>' + mb + ' MB', s)
s = re.sub(r'(<a class="button" data-dl href=")[^"]*', r'\g<1>' + url, s)
open(p, "w").write(s)
PY
fi

NOTES="Agent Outbox $VERSION for Apple silicon Macs (macOS 14+). Free and not notarized: on first launch use System Settings > Privacy & Security > Open Anyway. sha256: $(cut -d' ' -f1 "$DMG.sha256")"
GH=(gh release create "$TAG" "$DMG" "$DMG.sha256" --repo "$REPO" --title "Agent Outbox $VERSION" --notes "$NOTES")
if [ "$DRY" = 1 ]; then
  echo "== dry run: nothing published. Would run:"
  printf '   '; printf '%q ' "${GH[@]}"; echo
  echo "   and write $FEED_REL plus the site's version/size text"
else
  git rev-parse "$TAG" >/dev/null 2>&1 && { echo "tag $TAG already exists" >&2; exit 1; }
  echo "== gh release create $TAG"
  "${GH[@]}"
  echo "next: commit site/, git push, then: cd site && npx wrangler@4 deploy"
fi
