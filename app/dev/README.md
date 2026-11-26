# App development helpers

Run the SwiftUI app without a bundle, against a stand-in owner API, with a temp state dir. Never touches a real state directory,
LaunchAgents or login items.

```sh
cd app
swift build                       # on a Mac with only the Command Line Tools: swift build --sdk /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk
.build/debug/AgentOutbox --selfcheck      # headless checks: HTTP parser, socket preflight, socket client + peer pid, supervisor, migration, claude connect
dev/run-dev.sh                    # the app + dev/mock-server.ts, OUTBOX_HOME=/tmp/ao-b, OUTBOX_PORT=7485
dev/shot.sh out.png [VAR=1 ...]  # same, then writes a PNG of the app window (works on a locked screen) and quits
```

Environment the app honours:

| Variable | Effect |
|---|---|
| `OUTBOX_HOME`, `OUTBOX_PORT` | state directory (default `~/Library/Application Support/agent-outbox`) and dashboard port (default 7477). Keep `OUTBOX_HOME` short: a unix socket path is limited to 103 bytes |
| `AGENT_OUTBOX_SERVER_BIN` | server binary to supervise instead of `Contents/MacOS/agent-outbox`. It is run as `<bin> server --app-auth-fd 3` with fd 3 = token pipe, stdin = lifeline. `dev/server-wrapper.sh` is a ready target (mock API; `AGENT_OUTBOX_DEV_REAL=<repo>` runs that repo's `src/server.ts` instead) |
| `AGENT_OUTBOX_DEV=1` | never register login items (also implied when the app is not run from a real `.app`) |
| `AGENT_OUTBOX_SKIP_ONBOARDING=1` / `AGENT_OUTBOX_FORCE_ONBOARDING=1` | skip / show the first-run window |
| `AGENT_OUTBOX_SKIP_MIGRATION=1` | ignore old developer-install LaunchAgents |
| `AGENT_OUTBOX_DEV_OPEN_LOG=<file>` | dev runs never open a browser: URLs the app would open are appended to this file (check the Approve link there) |
| `AGENT_OUTBOX_DEV_APPEARANCE=light\|dark`, `AGENT_OUTBOX_DEV_SIZE=940x1100` | force the appearance / window size for screenshots |
| `AGENT_OUTBOX_DEV_SHEET=send\|send-live\|contacts\|contacts-live` | show the approval confirm sheet for a made-up approval (no Touch ID) |
| `AGENT_OUTBOX_DEV_MENU=1` | pop open the menu bar menu after launch (capture it with `screencapture -l <layer-101 window id>`) |
| `AGENT_OUTBOX_DEV_OPEN_BROWSER=/batch/<id>`, `AGENT_OUTBOX_DEV_ACTION=stop\|resume` | do what Approve / Stop all sending / Resume sending do, without a click |
| `AGENT_OUTBOX_START_STEP=0..4`, `AGENT_OUTBOX_LAUNCHAGENTS_DIR=<dir>` | first-run step to open; folder of fake old LaunchAgent plists for the migration screen (dev runs never call launchctl or `claude mcp add`) |
| `AGENT_OUTBOX_START_NAV=settings`, `AGENT_OUTBOX_START_PATH=batch:b1` | open a section / a batch (`set:<id>`, `group:<id>`) at launch, for screenshots |
