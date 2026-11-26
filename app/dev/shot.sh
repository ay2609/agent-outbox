#!/bin/sh
# Launches the app against the mock owner API, captures its window to <out.png> and quits it. Usage: app/dev/shot.sh out.png [VAR=value ...]
# (window capture works even when the screen is locked; a whole-screen capture would show the lock screen)
here="$(cd "$(dirname "$0")" && pwd)"
out="$1"; shift
pkill -f ".build/debug/AgentOutbox" 2>/dev/null; sleep 1
rm -rf /tmp/ao-b
env "$@" "$here/run-dev.sh" > /tmp/ao-b-app.log 2>&1 &
sleep "${SHOT_WAIT:-9}"
id=$(swift "$here/windows.swift" AgentOutbox 2>/dev/null | awk '/^[0-9]+ /{id=$1} /layer 0 onscreen 1/{print id; exit}')
echo "window id: $id"
screencapture -x -l "$id" "$out"
pkill -f ".build/debug/AgentOutbox" 2>/dev/null
sleep 1
pgrep -fl "mock-server" || echo "mock server stopped with the app"
