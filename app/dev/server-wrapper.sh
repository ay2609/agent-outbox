#!/bin/sh
# AGENT_OUTBOX_SERVER_BIN target for development. The app runs it as `<this> server --app-auth-fd 3` with fd 3 = the token pipe
# and stdin = the lifeline, exactly like Contents/MacOS/agent-outbox. By default it starts the mock owner API (app/dev/mock-server.ts).
# Set AGENT_OUTBOX_DEV_REAL=<repo> to run that repo's real server instead.
here="$(cd "$(dirname "$0")" && pwd)"
[ "$1" = "server" ] && shift
BUN="${BUN:-$(command -v bun || echo /opt/homebrew/bin/bun)}"
if [ -n "$AGENT_OUTBOX_DEV_REAL" ]; then
  cd "$AGENT_OUTBOX_DEV_REAL" && exec "$BUN" run src/server.ts "$@"
fi
exec "$BUN" run "$here/mock-server.ts" "$@"
