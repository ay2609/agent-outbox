#!/bin/bash
# Smoke run of the BUILT bundle (scripts/build-app.sh first): starts dist/Agent Outbox.app in dev mode against a temp state dir
# and checks that the real bundled server comes up socket-only, the owner API refuses callers without the app's token, and
# quitting the app stops the server. Dev mode never registers login items, runs launchctl or `claude`; nothing touches the real
# state directory. Needs a logged-in GUI session (the app opens a window). Kills only the processes it started.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APPBIN="$ROOT/dist/Agent Outbox.app/Contents/MacOS/Agent Outbox"
[ -x "$APPBIN" ] || { echo "build the app first: scripts/build-app.sh"; exit 2; }
H="$(mktemp -d /tmp/aos.XXXX)"   # short: a unix socket path is limited to 103 bytes
fail() { echo "FAIL: $*"; [ -n "${APP:-}" ] && kill -TERM "$APP" 2>/dev/null; exit 1; }

OUTBOX_HOME="$H" AGENT_OUTBOX_DEV=1 AGENT_OUTBOX_SKIP_MIGRATION=1 AGENT_OUTBOX_SKIP_ONBOARDING=1 "$APPBIN" >"$H.app.log" 2>&1 &
APP=$!
for _ in $(seq 1 40); do [ -S "$H/run/owner.sock" ] && break; sleep 0.25; done
[ -S "$H/run/owner.sock" ] || fail "owner.sock never appeared (see $H.app.log, $H/logs)"
SRV="$(pgrep -P "$APP" | head -1)"
[ -n "$SRV" ] || fail "no server child"
ps -o command= -p "$SRV" | grep -q "Contents/MacOS/agent-outbox server --app-auth-fd 3" || fail "child is not the bundled server"

[ "$(stat -f %Lp "$H/run/owner.sock")" = 600 ] || fail "owner.sock is not 0600"
[ "$(stat -f %Lp "$H/run")" = 700 ] || fail "run/ is not 0700"
[ "$(stat -f %Lp "$H")" = 700 ] || fail "state dir is not 0700"
if lsof -nP -a -p "$APP,$SRV" -iTCP >/dev/null 2>&1; then fail "a bundled process has a TCP socket"; fi
curl -s --unix-socket "$H/run/owner.sock" http://agent-outbox/api/status | grep -q '"app_auth"' || fail "status without the token was not 401 app_auth"
curl -s -H 'Origin: http://example.com' --unix-socket "$H/run/owner.sock" http://agent-outbox/api/status | grep -q '"browser_refused"' || fail "Origin was not refused"
grep -q '"v": 4' "$H/passkeys.json" || fail "user pin is not v4"
grep -qi 'token' "$H/logs/"*.log && fail "a log mentions a token"
echo "server $SRV up: owner.sock 0600 in 0700 run/, no TCP, 401/403 as expected, pin v4"

kill -TERM "$APP"
for _ in $(seq 1 20); do kill -0 "$SRV" 2>/dev/null || break; sleep 0.25; done
kill -0 "$SRV" 2>/dev/null && { kill -TERM "$SRV"; fail "server outlived the app"; }
[ -e "$H/run/owner.sock" ] && fail "owner.sock left behind"
rm -rf "$H" "$H.app.log"
echo "APP SMOKE PASSED"
