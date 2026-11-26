#!/bin/sh
# Runs the built app against the mock owner API with a temp state dir. Usage: app/dev/run-dev.sh [extra env VAR=1 ...]
# Needs a prior `swift build` in app/ (on a Mac with only the Command Line Tools, add --sdk .../MacOSX26.5.sdk, see app/dev/README below).
here="$(cd "$(dirname "$0")" && pwd)"
export OUTBOX_HOME="${OUTBOX_HOME:-/tmp/ao-b}"
export AGENT_OUTBOX_SERVER_BIN="${AGENT_OUTBOX_SERVER_BIN:-$here/server-wrapper.sh}"
export AGENT_OUTBOX_DEV=1 AGENT_OUTBOX_SKIP_MIGRATION=1
mkdir -p "$OUTBOX_HOME"
exec "$here/../.build/debug/AgentOutbox" "$@"
