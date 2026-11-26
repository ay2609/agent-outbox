import Foundation
import AppKit

// Agent Outbox. `Agent Outbox --selfcheck` runs the headless checks and exits.
// Environment: OUTBOX_HOME (state dir, for tests and the UX round), AGENT_OUTBOX_SERVER_BIN (server binary
// override for development), AGENT_OUTBOX_DEV=1 (never register login items), AGENT_OUTBOX_SKIP_ONBOARDING=1,
// AGENT_OUTBOX_FORCE_ONBOARDING=1, AGENT_OUTBOX_SKIP_MIGRATION=1 (ignore old LaunchAgents).
// A closed pipe (the server exiting, a socket peer going away) must surface as a write error, never kill the app.
signal(SIGPIPE, SIG_IGN)
if CommandLine.arguments.contains("--selfcheck") {
    setvbuf(stdout, nil, _IONBF, 0)
    exit(SelfCheck.run())
}
AgentOutboxApp.main()
