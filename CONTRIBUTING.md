# Contributing

Thanks for helping. Two rules come before everything else:

1. **Never weaken the send gate.** No agent-facing surface (MCP tool, CLI verb, agent API route) may send, approve, or change settings or passkeys. A test enumerates the agent API routes and fails if one appears. If a change touches approvals, the executor's verification or the pin files, say so in the pull request and add tests for the failure cases.
2. **Keep dry mode the default.** A fresh install must not send anything or touch Contacts until the user turns live sending on.

Also: no development or test run may send a message or open Messages or Contacts. Tests use temporary state directories and the dry transport.

## Setup

You need macOS 14+, [Bun](https://bun.sh) and the Xcode Command Line Tools.

```sh
bun install
bunx tsc --noEmit -p .        # typecheck
bun test                      # unit and integration tests
bun run web:build             # build the dashboard into web/dist
cd exec && ./build.sh         # build and ad-hoc sign the executor
exec/build/OutboxExec.app/Contents/MacOS/outbox-exec selftest   # run from the repo root; must end with 0 failed
```

`./build.sh` regenerates `exec/Sources/OutboxExecCore/EmbeddedSchema.swift` from `src/db/schema.sql`, so edit the schema in one place only.

## Dev server

Use a throwaway state directory and a port that is not your real install's:

```sh
OUTBOX_HOME=$TMPDIR/ao OUTBOX_PORT=7478 bun run src/server.ts
```

Open `http://localhost:7478`. For the dashboard with hot reload, `bun run web:dev`.

## End-to-end tests

- `bun tests/e2e/approve.e2e.ts` drives the real dashboard in Chromium with a virtual authenticator (register, sign in, approve) and checks that an approval row exists. It needs Playwright's Chromium: `bunx playwright install chromium`.
- `tests/e2e/exec-roundtrip.sh` checks that an approval signed in the dashboard verifies in the Swift executor and produces dry sends, and that a tampered body is refused. Build the executor first.

## Layout

| Path | What |
|---|---|
| `src/` | Bun/TypeScript server: agent API, MCP server, CLI, ingest, personalisation, dashboard API |
| `web/` | React dashboard (Vite) |
| `exec/` | Swift executor (the only code that can send) |
| `deploy/` | LaunchAgent plist templates filled in by `install.sh` |
| `docs/` | `ARCHITECTURE.md` and the interface contracts in `docs/design/` |
| `tests/` | Integration and end-to-end tests |

## Pull requests

- Keep them small and focused; describe what changed and why.
- Add or update tests, and run the typecheck, `bun test` and the executor self-test before you push. CI runs the same four steps on macOS.
- If you change the database schema, the manifest format or the pin file, update `docs/design/CONTRACTS.md` in the same pull request: the TypeScript and Swift sides must agree.
- Shell scripts must work with the Bash 3.2 that ships with macOS, and must never use `sudo`.
- No personal data in code, tests, fixtures or screenshots: use obviously fake names and numbers (the `555` range).

## Security issues

Report them privately; see [SECURITY.md](SECURITY.md).
