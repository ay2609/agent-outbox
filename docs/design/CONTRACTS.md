# Interface contracts

Read [../ARCHITECTURE.md](../ARCHITECTURE.md) first. These are the fixed interfaces between the parts of the system: the core service, ingest and personalisation, the dashboard API, and the Swift executor. TypeScript and Swift share the database schema, the manifest and the pin file, so change one of those only together with this document.

The document has a base spec (sections 1 to 4), then later revisions that override it where they differ (v2 to v4). Paths, labels and pin modes below are current.

## Conventions
- Bun 1.4, TypeScript strict, ESM. Run TS directly with `bun run`; tests with `bun test` (files `*.test.ts` next to the code or in `tests/`).
- DB: `openDb(path?)` / `getDb()` from `src/db/index.ts`; the schema is `src/db/schema.sql` (authoritative, shared with Swift). Shared helpers are in `src/core/store.ts`, types in `src/core/types.ts`, paths in `src/core/paths.ts`. Extend `store.ts` only by adding functions, never by changing existing signatures.
- ids are `newId()` (UUIDv7); times are `nowIso()`.
- base64 columns are **base64url without padding**.
- Tests set `OUTBOX_HOME` to a temp dir, or use `openDb(":memory:")`. Never touch a real state directory (`~/Library/Application Support/agent-outbox`) in tests.
- **Nothing may send a message or open Messages/Contacts during development.** The Swift `live` transport is compiled but never run; Contacts access is never requested.

## 1. Core service, agent API, MCP, CLI (`src/server.ts`, `src/agent-api/`, `src/mcp/`, `src/cli/`, `src/core/*` except files listed under others)
- `src/server.ts` starts:
  - the agent API: `Bun.serve({ unix: paths.agentSocket, fetch: agentApp.fetch })`. Remove a stale socket first; chmod it 0600.
  - the owner app: `Bun.serve({ hostname: "127.0.0.1", port: PORT (from config.json or OUTBOX_PORT, default 7477), fetch: ownerApp.fetch })`, with `ownerApp` imported from `src/owner-api/index.ts`.
  - the contacts-export importer (`src/core/contacts-sync.ts`): when `paths.contactsExport` changes, upsert `source='macos'` contacts and rebuild `contact_handles`. It normalises phones with the ingest library's `normalizePhone`. The export format is in section 4 below.
- Agent API (Hono, JSON, prefix `/v1`). The header `X-Outbox-Client: <label>` becomes `created_by`/actor `agent:<label>`.
  - Batches and drafts:
    - `POST /v1/drafts` — `{to | contact_id, body, service?, notes?, title?}` → a one-draft batch in `review`.
    - `POST /v1/batches` — `{title, template?, instructions?, items?:[{to|contact_id, body?, vars?, recipient_name?, proposed_contact?, service?}], submit?:boolean}`.
    - `POST /v1/batches/:id/items` — add items while the batch is `drafting`.
    - `POST /v1/batches/:id/submit` — `drafting` → `review`.
    - `GET /v1/batches?status=` and `GET /v1/batches/:id` (with drafts and their send results).
    - `PATCH /v1/drafts/:id` — `{body}` while not approved; actor `agent`.
  - Contacts:
    - `GET /v1/contacts?q=&limit=` — search name, handle, org, tags.
    - `GET /v1/contacts/:id`.
    - `POST /v1/contacts/sync` — inserts an `exec_requests` row `contacts_export`.
  - Imports:
    - `POST /v1/imports` — `{path} | {text, filename?} | {base64, filename}`, plus optional `sheet` and `kind`; uses the ingest library's `ingestFile`.
    - `GET /v1/imports/:id`.
    - `PUT /v1/imports/:id/mapping` — the ingest library's `setMapping`.
    - `POST /v1/imports/:id/batch` — the ingest library's `batchFromImport`.
  - **Forbidden on the agent API:** any route that writes `approvals`, `sends`, `contact_writes`, `passkeys`, `sessions`, `webauthn_challenges` or `settings`, or sets a draft or batch status to `approved|sending|sent|done`. A test enumerates the route table and asserts this.
  - After any body change, call the ingest library's `lintBatch(db, batchId)`.
  - Every response for a batch includes `dashboard_url` = `${ORIGIN}/#/batch/<id>`.
- MCP server `src/mcp/index.ts`:
  - stdio, `@modelcontextprotocol/sdk` 1.32.2.
  - Tools as in ARCHITECTURE §7, each a thin call to the agent socket (`fetch("http://outbox/v1/...", { unix: paths.agentSocket })`).
  - If the socket is missing, return a clear "outboxd isn't running" error.
  - Tool descriptions must say plainly that drafts are never sent without the user's approval in the dashboard.
- CLI `src/cli/index.ts` (`outbox <cmd>`) with the same verbs: `draft`, `batch create|show|list|submit`, `import`, `mapping`, `contacts search`, `sync-contacts`, `status`. It uses the agent socket.
- Compose (`src/core/compose.ts`): `startCompose({instructions, contact_ids?, import_id?, tag?, title?}) → {job_id}` and `getComposeJob(job_id)`. It spawns `claude -p --model sonnet --strict-mcp-config --mcp-config <agent-outbox only> --allowedTools "mcp__agent-outbox__*"` (binary from `claude_path` in config.json, else `PATH`, else `~/.local/bin/claude`), with `ANTHROPIC_API_KEY` removed from the environment and a system prompt that tells it to create exactly one batch and submit it. Jobs are kept in memory, with logs under `paths.logs`. It is used by the dashboard, which hides compose when no `claude` binary is found or `compose` is `"off"`.

## 2. Ingest, personalisation, lint (`src/ingest/`, `src/personalize/`)
Exports (exact names):
- `src/ingest/normalize.ts`:
  - `normalizePhone(raw: string, region?: string /* "US" */): { e164: string | null; valid: boolean; mobile: boolean | null; raw: string }`
  - `normalizeEmail(raw): string | null`
  - `normalizeHandle(input): { handle: string | null; kind: "phone" | "email" | null; valid: boolean; mobile: boolean | null }`
  - `splitName(full): { given_name; family_name }`
  - `slug(header): string`
- `src/ingest/parse.ts`:
  - `parseFile(bytes: Uint8Array, filename: string, opts?: { sheet?: string; kind?: string }): ParsedTable`
  - `parseText(text: string, hint?: string): ParsedTable` (pasted CSV/TSV/markdown table/vCard/JSON).
  - `ParsedTable = { kind, sheets: string[], sheet: string | null, columns: string[], rows: Record<string,string>[], warnings: string[] }`
- `src/ingest/mapping.ts`:
  - `guessMapping(table): Mapping`
  - `Mapping = { fields: Partial<Record<"display_name"|"given_name"|"family_name"|"phone"|"email"|"org"|"notes"|"tags", {column: string, confidence: number}>>, vars: Record<string /*slug*/, string /*column*/>, confirmed: boolean }`
- `src/ingest/ingest.ts`:
  - `ingestFile(db, {bytes, filename, created_by, sheet?, kind?}): ImportSummary` stores the raw bytes immutably at `paths.imports/<sha256>.<ext>`, writes `imports` and `import_rows`, and matches against `contact_handles`.
  - `setMapping(db, import_id, mapping): ImportSummary` re-normalises and re-matches.
  - `getImport(db, id): ImportSummary & { rows: … }`
  - `ImportSummary = { import_id, filename, kind, sheet, sheets, columns, mapping, needs_confirmation: boolean, counts: {matched,new,ambiguous,invalid,duplicate}, preview: first 10 normalized rows }`
- `src/personalize/template.ts`:
  - `renderTemplate(template, vars): { body: string; unresolved: string[]; empty: string[] }`. Syntax: `{{first_name}}`, plus `{{first_name|there}}` for a fallback.
  - `listVars(template): string[]`
  - Standard vars: `first_name, last_name, full_name, name, org`, plus every import column slug.
- `src/personalize/lint.ts`:
  - `lintDraft(draft: Draft, ctx: LintContext): Warning[]` (pure).
  - `lintBatch(db, batch_id): void` builds the ctx (duplicates in the batch, the same handle pending in other batches, sends to this handle in the last 7 days, the template) and writes `warnings_json` for every draft.
- `src/personalize/from-import.ts`: `batchFromImport(db, import_id, {title, template, created_by, source, per_row_bodies?: Record<number,string>, create_new_contacts?: boolean /*default true*/, include?: number[] /*row indexes*/}): { batch_id, drafts: number, skipped: {row_index, reason}[] }`
  - Rows that are `invalid` or `duplicate` are skipped.
  - `new` rows get a `proposed_contact` (and `create_contact` per the option).
  - `ambiguous` rows are drafted with an `ambiguous_contact` warning and no `contact_id`.

## 3. Dashboard API and passkeys (`src/owner-api/`, `web/`)
- Export `ownerApp: Hono` from `src/owner-api/index.ts`. It serves the `web/dist` SPA and `/api/*`.
- Passkeys:
  - `@simplewebauthn/server` 14 with `rpID = RP_ID`, `origin = ORIGIN` from paths.ts, and `userVerification: "required"`.
  - Registration is open only while there are zero passkeys. Later passkeys need a logged-in session plus a fresh assertion.
  - **Setup token.** Open (no-session) registration also needs a one-time `setup_token`, in the body of both `POST /api/auth/register/options` and `/verify`:
    - Lifecycle: at server start, with no sign-in (login) key, load `<state>/setup-token` if it is a well-formed (43 base64url characters), private (0600, ours, regular, not a symlink) file; otherwise generate 32 random bytes as base64url and write it there (0600, atomic, `O_EXCL | O_NOFOLLOW` temp file then rename). It is kept in memory and printed once as `first-run setup: open http://localhost:<port>/#/setup?token=<token>`. Registering the first sign-in key deletes the file and clears the memory; if a sign-in key already exists at start, a leftover file is deleted.
    - Missing → 403 `setup_token_required`; wrong → 403 `setup_token_invalid` (constant-time compare, `timingSafeEqual` on equal-length buffers). Both count as failures in the register limiter. The gate (`registration_locked`) is checked first.
    - Session-based enrolment (the approval key after sign-in, later keys with reauth) needs no token.
    - `GET /api/auth/state` carries `setup_token_required` (true while no sign-in key exists). No API ever returns the token.
    - The web reads it from the hash (`#/setup?token=...`), keeps it in memory and sessionStorage, strips it from the URL with `history.replaceState`, and sends it as `setup_token`. `install.sh` prints the link after a fresh install; `install.sh --setup-link` prints it (read-only).
  - After any registration of an approval key, or any policy change, write the **user pin** `<state>/passkeys.json` (PinFile format, mode 0600). In hardened mode, also show the harden command (see "Pin file" in section 4).
  - COSE → x963: extract x and y from the COSE EC2 key and prepend 0x04.
- Sessions: random 32-byte token in an HttpOnly, SameSite=Strict cookie (`Secure` is off when the origin is `http://localhost…`, which is loopback, and some browsers drop `Secure` cookies on http), stored as sha256 in `sessions`, 30-day expiry. Every `/api` mutation requires the session plus the header `X-Outbox: 1`.
- Approval:
  - `POST /api/batches/:id/approve/options {draft_ids}` (the approval window is a fixed 24 h; see v3)`
    - Builds the `Manifest` (types.ts) for those drafts. They must be in `review`, `failed` or `skipped`→included; `rejected` and `sent` are refused.
    - `bytes = JSON.stringify(manifest)`; challenge = the 32 raw bytes of `sha256(bytes)`. Pass a `Uint8Array` to `generateAuthenticationOptions`, and check in the library source that it base64url-encodes the bytes unchanged.
    - Stores a `webauthn_challenges` row with the manifest, and returns `{challenge_id, options, manifest}`.
  - `POST /api/batches/:id/approve/verify {challenge_id, response}`
    - Verifies with `verifyAuthenticationResponse` (`requireUserVerification: true`).
    - Re-checks that every draft's handle, service and sha256(body) still equal the manifest's.
    - Inserts an `approvals` row (manifest bytes verbatim, plus the raw authenticatorData, clientDataJSON and signature from the response).
    - Sets those drafts to `approved` and the batch to `approved`, then audits.
- Other routes:
  - Batches: `GET /api/batches`, `GET /api/batches/:id`.
  - Drafts:
    - `PATCH /api/drafts/:id {body?, service?, create_contact?, handle?}` (actor `owner`, the dashboard user; re-lint).
    - `POST /api/drafts/:id/skip`.
    - `POST /api/batches/:id/cancel`.
  - Stop and resume:
    - `POST /api/stop` sets kill_switch=1 and `revoked_at` on all unconsumed approvals. It needs a session but no passkey.
    - `POST /api/resume` sets kill_switch=0.
  - Settings: `GET|PATCH /api/settings`. Setting `transport=live` requires a fresh sign-in passkey assertion.
  - Imports: `POST /api/imports` (multipart upload), `GET /api/imports/:id`, `PUT /api/imports/:id/mapping`, `POST /api/imports/:id/batch` (all via the ingest library).
  - Contacts: `GET /api/contacts?q=`.
  - Activity and status: `GET /api/activity` (sends plus audit, paged), `GET /api/status` (`exec_status` row, `pin.mode`, the effective pin and its policy, counts).
  - Compose: `POST /api/compose`, `GET /api/compose/:job` (`src/core/compose.ts`).
- SPA (`web/`): React 19 + Vite, mobile-first, installable PWA (manifest + icons), no CSS framework.
  - Pages: Inbox, Batch (card per draft, inline edit, include toggles, sticky approve footer showing the count), Compose, Imports (upload → mapping confirm → create batch), Contacts, Activity, Settings (passkeys, pin mode and status, "Harden your install", transport, the live-allowed checkboxes, kill switch).
  - A permanent red "Stop all sending" control, and a persistent "Simple mode" badge or "Hardened" chip.
  - If a fetch is redirected or returns 401, do a full reload.
- Local-only hardening:
  - The server binds `127.0.0.1:<port>`; `rp_id` is `localhost` and the origin `http://localhost:<port>`. `OUTBOX_RP_ID` and `OUTBOX_ORIGIN` are test-only overrides.
  - Requests whose `Host` is not `localhost:<port>` or `127.0.0.1:<port>` are rejected (DNS rebinding). Page loads on `127.0.0.1` redirect to `localhost`, since passkeys are bound to `localhost`.
  - The `Origin` plus `X-Outbox` check stays: other localhost ports are same-site, so it matters here.
- Dev and E2E: `OUTBOX_HOME=$TMPDIR/ao OUTBOX_PORT=7478 bun run src/server.ts`. `tests/e2e/approve.e2e.ts` uses Playwright Chromium with a CDP virtual authenticator (`WebAuthn.addVirtualAuthenticator`: ctap2, internal, hasUserVerification, isUserVerified) to run register → login → approve and asserts an `approvals` row exists.

## 4. Executor and deployment (`exec/`, `deploy/`, `install.sh`)
- A SwiftPM package in `exec/`, Swift 6.4 with the Command Line Tools. `exec/build.sh` builds release and assembles `exec/build/OutboxExec.app`:
  - `Contents/MacOS/outbox-exec` plus an `Info.plist` with `CFBundleIdentifier` `io.github.ay2609.agent-outbox.exec`, display name "Agent Outbox", `NSAppleEventsUsageDescription` and `NSContactsUsageDescription`, `LSUIElement` true.
  - Signed with `codesign --force -s - --options runtime --identifier io.github.ay2609.agent-outbox.exec --entitlements exec/entitlements.plist` (`com.apple.security.automation.apple-events` = true).
- Subcommands:
  - `run [--once]` — the daemon loop, polling every 3 s.
  - `selftest` — runs in a temp dir and touches no real state.
  - `verify <approval_id>` — prints the per-item verdicts and sends nothing.
  - `contacts-export` — not run during development.
  - `version`.
- Reads the DB at `$OUTBOX_HOME/outbox.db` (default `~/Library/Application Support/agent-outbox`) through the SQLite3 C API, with busy_timeout 5000 and WAL.
- Pin file (the keys and policy the executor trusts). There are exactly two sources, and the root file wins:
  - **Hardened:** `/Library/Application Support/agent-outbox/passkeys.json` (root:wheel, 0444; a compiled-in constant, not configurable; under `/Library` because it and `/Library/Application Support` are root-owned on every Mac, the latter root:admin 755, which the ancestor check accepts since it only needs uid 0 and no group/other write). If it exists the executor uses ONLY it. It is refused unless the file is a regular file opened with `O_NOFOLLOW`, owned by uid 0, not group- or world-writable, with every ancestor directory root-owned and not group- or world-writable. If it exists but is invalid the executor holds: there is no fallback to the user pin, so there is no downgrade path.
  - **Simple:** if no root file exists, `<state>/passkeys.json`: a regular file opened with `O_NOFOLLOW`, owned by the executor's uid, not group- or world-writable, in a state directory that is likewise owned by that uid and not group- or world-writable. It is trusted for live sending and live contact changes when its policy allows them. No other pin source exists.
  - `PinFile` carries the mode (`hardened` or `simple`). Every live gate uses "trusted pin plus policy", never "root verified".
  - `rp_id` and `origin` come from the pin file, never from the DB.
  - The harden command the dashboard shows checks the user pin's sha256 first (against the pin the dashboard builds from its own keys and policy, so a file edited outside the dashboard fails the check), then installs it: `sudo install -d -o root -g wheel -m 755 '/Library/Application Support/agent-outbox'` (only the new leaf directory is created and set; `/Library/Application Support` itself is untouched) and `sudo install -o root -g wheel -m 444 <user pin> '/Library/Application Support/agent-outbox/passkeys.json'` (the path has a space, so it is single-quoted), then prints the installed key ids and labels so they can be compared with the dashboard.
  - The dashboard's status reports `pin.mode`, the effective pin and its policy. In simple mode a policy change takes effect at once, so turning `live_allowed` or `contacts_live_allowed` ON needs a fresh sign-in passkey assertion; in hardened mode the change needs the command re-run (the dashboard compares its candidate with the installed pin).
- Verification (ARCHITECTURE §6), per approval:
  - base64url-decode the fields.
  - `sha256(manifest bytes)` base64url == `clientData.challenge`.
  - `clientData.type == "webauthn.get"`, `clientData.origin == pin.origin`.
  - `authData[0..<32] == sha256(pin.rp_id)`; flags UP (0x01) and UV (0x04).
  - `P256.Signing.PublicKey(x963Representation:)` checks the DER signature over `authData ‖ sha256(clientDataJSON)`.
  - The credential_id is in the pin file; `now < not_after`; `revoked_at` is null; `manifest.batch_id == approvals.batch_id`.
  - Per item: the draft exists in that batch, and handle, service and sha256(body) match.
- Scheduling:
  - Settings come from the DB (kill_switch, breaker; v3 removed pacing, caps and quiet hours).
  - Live only if the signed manifest says live AND the effective pin's policy allows it (see v2); otherwise dry.
  - On a send error with the breaker on, set kill_switch=1 and audit.
- An item is consumed when a `sends` row has result `sent` or `unknown`, or after 3 `failed` attempts.
- Per draft:
  - Before sending, if `create_contact=1` and `proposed_contact_json` is set and no `contact_writes` row exists, create the contact (live: CNSaveRequest into the iCloud container if present, plus a group "Outbox imports"; dry: log), then record it.
  - Status flow: `approved` → `sending` → `sent|failed|unknown`. The batch is `done` when every approved draft is terminal.
  - Audit as actor `exec`.
- Dry transport: append `{"at","draft_id","approval_id","to","service","body"}` to `$OUTBOX_HOME/logs/dry-sends.jsonl`.
- Live transport: NSAppleScript in-process. Pass text and handle as AppleScript string literals escaped for `\` and `"`; never build script text from unescaped input. Use the participant form; `auto` = iMessage, then SMS on an error before hand-off.
- Heartbeat: upsert `exec_status` every loop.
- Contacts export format (written atomically to `$OUTBOX_HOME/contacts-export.json`): `{"exported_at", "contacts":[{"macos_id","given_name","family_name","nickname","org","phones":[{"raw","label"}],"emails":[{"email","label"}]}]}`. Handles `exec_requests` of kind `contacts_export`, and also runs every 30 min when Contacts access is granted.
- `deploy/`:
  - LaunchAgent plist templates `io.github.ay2609.agent-outbox.plist` (`<bun> run src/server.ts`, working directory = the repo) and `io.github.ay2609.agent-outbox.exec.plist` (program `OutboxExec.app/Contents/MacOS/outbox-exec run`, `AssociatedBundleIdentifiers` = the bundle id), with `__HOME__`, `__REPO__`, `__BUN__`, `__STATE__`, `__PATH__` placeholders that `install.sh` fills in (XML-escaped; the state directory path contains a space). Logs go to `<state>/logs/outboxd.{out,err}.log` and `<state>/logs/outbox-exec.{out,err}.log`.
  - `install.sh` and `uninstall.sh` at the repo root are the only things that load or unload them (`launchctl bootstrap` and `bootout` on `gui/$UID`). Neither uses sudo. Re-running `install.sh` rebuilds the executor, which changes its code hash, so macOS asks again for the Messages and Contacts permissions.
- `selftest` must cover: a valid approval sends (dry), a tampered body, a wrong origin, a wrong rp_id, an unpinned key, expiry, revocation, the kill switch, the daily cap, a consumed approval not re-sent, a bad signature, and the UV flag missing. It generates keys and assertions with CryptoKit.

## v2 changes: security fixes (binding)
1. **Two passkey purposes.** `passkeys.purpose` is `login` or `approve`.
   - First-time setup enrols two passkeys, each with its own `user_handle` and user name:
     - user.name "Sign in to Outbox"
     - user.name "APPROVE SENDING (Outbox)"
   - The operating system shows the account name on its own passkey sheet, which is trusted UI. So if a tampered dashboard asks for the approval key during a login, the user can tell.
   - Login and reauth use `allowCredentials` of the login keys only. Approve options use the approve keys only.
   - The pin file holds only approve keys.
2. **Manifest v2** has `"transport": "dry" | "live"`, taken from the settings when the options are built and shown prominently in the confirm sheet ("LIVE — these will really be sent"). outbox-exec:
   - sends live only if `manifest.transport == "live"` AND `pin.policy.live_allowed`
   - sends dry if the manifest says dry
   - ignores the DB `transport` setting for an approval that is already signed
3. **PinFile v2** adds a `policy` (see `PinPolicy`, `DEFAULT_PIN_POLICY` in types.ts).
   - outbox-exec clamps the DB settings to the policy floors and ceilings, and fails closed on a missing or invalid policy.
   - The dashboard writes the user pin (`<state>/passkeys.json`) with the policy the user chose. `live_allowed` is a checkbox. In hardened mode going live needs a sudo re-install of the pin; in simple mode it needs a fresh sign-in assertion.
   - The install command the dashboard shows must:
     - check the candidate's sha256 before installing: `echo '<sha>  <path>' | shasum -a 256 -c - && sudo install …`
     - then print the credential ids and labels it installed, so the user can compare them with the dashboard
   - `/api/status` flags any pin key the user can't see among the approve passkeys, and any count mismatch.
4. **Proposed contacts** must have exactly one handle, equal to the draft's `handle` (see the ProposedContact doc comment).
   - Agent API, ingest, owner API, approval build and the Swift executor each enforce this. Extra handles are dropped when the proposal is built, and refused at manifest build and at execution.
   - The confirm sheet shows the whole proposed contact.
5. **Settings** gain `kill_reason` (`owner` | `breaker` | `''`), and the kill switch counts as ON if its row is missing.
   - Stop sets reason `owner` and revokes approvals.
   - The breaker sets `breaker` and does NOT revoke; the resume dialog wording follows the reason.
6. **`sends`** gains `handle` and `body_sha256`, a snapshot of what was actually sent, written by outbox-exec.
7. **Expiry or rejection of an approval returns its unconsumed drafts to `review`**, and the executor writes a visible `exec_status.last_error` and an audit row.
   - The user can then re-approve them. The owner API treats a draft as approvable if no live (unexpired, unrevoked, verifiable) approval covers it.
8. **Every TypeScript read-then-write transaction** uses `db.transaction(fn).immediate()`.

## v3 changes: simpler sending (binding). AI drafts, the user approves, it sends
- **Removed:** pacing, bursts, the daily cap, quiet hours, `scheduled_for` handling, send-time estimates, approval-window choice and the expiry-vs-schedule warnings. The settings rows are deleted (schema.sql). `Settings` = transport, kill_switch, kill_reason, breaker_on_failure.
- **outbox-exec:** once an approval verifies, its items send right away, one at a time, with a fixed 2 s gap between consecutive sends. This is a constant and not configurable. The `scheduled_for` column is ignored.
- **Kept:** verification, the kill switch/Stop (with undo), the breaker, and retries (3 per approval). Kept with the same rules: the dry/live choice, which stays signed into the manifest, and crash recovery to `unknown`.
- **`PinPolicy` = `{ live_allowed }` only.** Readers must IGNORE extra policy fields: a pin written by an earlier version may carry old pacing fields, so it must keep working without a reinstall. A missing `policy` still fails closed for live.
- **Approvals:** `not_after` is a fixed 24 h; there is no selector in the UI. Expiry still returns unconsumed drafts to review.
- **Lint warnings stay:** they concern draft content, not timing.

## v4: native contact management
Schema: the "v4" block at the end of `src/db/schema.sql`. Types: the "v4" block at the end of `src/core/types.ts`. These two are fixed; this section is binding for both the TypeScript and Swift sides.

**Design choices:**
- Contacts approvals use a new table `contact_approvals` and a separate manifest (`kind: "contacts"`, `contact_items`) rather than rows in `approvals`. `approvals.batch_id` is NOT NULL, and keeping the two manifest kinds apart means a contacts approval can never be replayed as a send approval, or the other way round.
- `contact_applies` (executor-written, `UNIQUE(change_id)`) is the consumption record, like `sends`. A change is applied at most once and never retried. A failed change can be re-proposed.
- Undo compares a canonical **fingerprint** (`after_fingerprint`), not a modification date: CNContact has no public modification date.
- Extra safety on auto creates: a name collision or the daily cap sends a create to review (below).

### Validation (TS on propose AND Swift at apply, the same rules)
- Names (given/family/nickname/org) and group names: each ≤ 100 characters. No C0/C1 control characters, U+2028/2029, U+202A–202E or U+2066–2069. Emoji are fine. Trim surrounding whitespace.
- create: given_name or family_name non-empty; at least one valid handle; ≤ 5 phones (valid E.164, normalised with `normalizePhone`) and ≤ 5 emails (`normalizeEmail`); ≤ 5 groups. Duplicate handles inside one payload are refused.
- update: `target_macos_id` non-empty; at least one effective change. `set` keys are only given_name/family_name/nickname/org. The add lists follow the same handle and group rules.
- Unknown payload keys are refused (both sides), so nothing unsigned rides along.
- `payload_json` = `JSON.stringify(payload)` written once by TS. Swift parses it and never re-serialises it for hashing.

### Canonical fingerprint (Swift computes, stores in `after_fingerprint`; TS only copies it)
sha256 hex of the UTF-8 JSON `{"e":[sorted lowercased emails],"f":family,"g":given,"n":nickname,"o":org,"p":[sorted E.164 phones]}`, with keys in that order, no whitespace, and phones normalised to E.164 (unparseable ones kept raw). Groups are not included.

### Lifecycle
- **create (auto):** TS inserts with `requires_approval=0` and `status='auto_queued'`, unless at propose time the cache (`contact_handles`) already has one of its handles. Then TS converts it itself (rule "convert" below) into an `update` with `status='review'`, `requires_approval=1` and note "already in Contacts". outbox-exec, for each `auto_queued` create (oldest first) and immediately before saving:
  1. Kill switch on → nothing. Contacts access not granted → hold (row stays queued; `exec_status.last_error` says Contacts access is needed).
  2. Re-validate the payload. Invalid → `failed`.
  3. **Live lookup** in CNContactStore of every phone and email (`CNContact.predicateForContacts(matching: CNPhoneNumber)` and `predicateForContacts(matchingEmailAddress:)`):
     - one contact hit → convert to an update for that contact (`review`, note "already in Contacts")
     - more than one distinct contact hit → `failed`, error "matches N contacts"
  4. **Name collision:** an existing contact with the same given+family (case- and diacritic-insensitive, both non-empty) and none of the handles → `review`, `requires_approval=1`, note "same name as an existing contact". It stays kind `create` and needs the user's approval in a manifest.
  5. **Daily cap:** more than 100 auto creates applied in the last 24 h (`contact_applies` with approval_id NULL) → `review`, note "daily auto-create limit". This is a constant.
  6. Otherwise save. The contact goes in the iCloud container (default container if there's none), the group "Outbox imports" plus any payload groups (each created in that container if missing). Write the `contact_applies` row, then on the change: `applied`, `transport`, `result_macos_id`, `after_fingerprint` and `applied_at`.
  - Transport for auto creates: live iff setting `contacts_transport='live'` AND the effective pin is trusted and has `policy.contacts_live_allowed == true`; otherwise dry.
  - Dry appends `{"at","change_id","approval_id":null,"kind","target_macos_id","payload"}` to `$OUTBOX_HOME/logs/dry-contacts.jsonl`. It marks the change applied with transport dry and `result_macos_id` = `"dry:<change_id>"`, and doesn't touch Contacts.
  - The lookups in steps 3–4 still use the real ContactsProvider in dry mode (reads only).
- **Convert** (create → update, used by TS and Swift): `set` = the create's non-empty name fields that differ from the existing card; `add_phones`/`add_emails` = the create's handles not on the card; `add_groups` = the create's groups; `from_create: true`. If nothing would change → status `rejected`, note "already in Contacts, nothing to change".
- **update / undo / create-in-review:** they sit in `review` until the owner approves a contacts manifest that lists them. The set's status is `review` while any change is in review. The executor then, per unconsumed, unrevoked `contact_approvals` row:
  - Verify exactly as for send approvals (same crypto, pin, origin, rp_id, UP+UV, not_after, revoked_at), plus:
    - `manifest.kind == "contacts"`, `v == 1`
    - `manifest.set_id == contact_approvals.set_id`
    - `contact_items` non-empty
    - **per item:** the row exists in that set; kind and target_macos_id equal; sha256(payload_json) equals; the row isn't consumed (no `contact_applies`)
  - A failing item is skipped and goes back to `review` with the reason in `error`; the other items still apply.
  - Transport: live iff `manifest.transport == "live"` AND the pin has `contacts_live_allowed`; otherwise dry. The DB setting is ignored for a signed manifest.
  - The send path must now reject any manifest that has a `kind` key, or that lacks `items`.
  - Apply **update:** fetch by identifier (missing → failed). Snapshot `before_vcard`. Set the `set` fields; add the phones/emails not already present (label mobile / home if blank); add the groups. Save. Record the fingerprint.
  - Apply **create** (approved): as an auto create from step 6. It still re-runs the live handle lookup: a hit → `failed` "already in Contacts", never a duplicate.
  - Apply **undo of an update:**
    - The target's current fingerprint must equal the payload's `after_fingerprint`, and sha256(original before_vcard) must equal `before_vcard_sha256`; otherwise failed, "edited since the change".
    - Restore each `set` field from the before snapshot; remove the phones/emails that the update added; remove the groups it added.
    - Set the original change to `undone`.
  - Apply **undo of a create:** the original must have been an outbox create (applied, with a `contact_applies` row) and the current fingerprint must equal `after_fingerprint`. Then delete the contact and set the original to `undone`.
  - Undo of a dry change is applied dry (log only), whatever the manifest says.
  - Crash recovery: a `contact_applies` row with a NULL `finished_at` becomes `unknown`, and the change becomes `failed` with error "interrupted".
- **After any tick that applied a live change:** run the contacts export, so the cache and agent searches see the change. Set status `done` when no change in the set is `pending|auto_queued|review|approved`.
- **Kill switch and Stop:** with the kill switch on, nothing contact-related applies. Stop also revokes every unconsumed `contact_approvals` row; expiry or revocation returns its unconsumed items to `review`.
- **Tamper check:** `gatedTables` gains contact_changes, contact_change_sets, contact_approvals and contact_applies; `prepare()` requires them to exist.

### Agent API (still draft-only; every route audits actor `agent:<label>`)
- `POST /v1/contact-changes` — `{title, creates?: ContactCreatePayload[], updates?: [{contact_id, set?, add_phones?, add_emails?, add_groups?}]}`
  - `contact_id` is a cache id; it must have a `macos_id` (source macos), else 400.
  - Creates use the auto/convert rule above; updates go to `review`.
  - At most 500 changes per call. Returns `{set_id, dashboard_url: ORIGIN/#/contacts/changes/<id>, counts:{auto_queued, review, rejected}, changes:[{id, kind, status, note}]}`.
- `POST /v1/imports/:id/contact-changes` — `{title?, first_name_prefix?, first_name_suffix?, include?: number[], groups?: string[]}`
  - `matched` rows → update `set.given_name = prefix + existing.given_name + suffix`, using the CACHE contact's name. Only when that changes something: a given_name that already starts with the prefix and ends with the suffix is skipped as "already done".
  - `new` rows → creates from the normalised row (given/family with the prefix and suffix, phone_e164, email, org).
  - `ambiguous`, `invalid` and `duplicate` rows are skipped with reasons. The result is the same shape plus `skipped:[{row_index, reason}]`.
- `GET /v1/contact-changes?status=` and `GET /v1/contact-changes/:id` — the set plus its changes, each with a parsed payload, and for each update the cache contact's current values (a `before` object for display).
- **Forbidden:** writing `contact_approvals` or `contact_applies`; any undo; setting a change to approved/applied/undone or a set to approved/applying/done. The route-table test asserts this.

### MCP / CLI
- MCP tools:
  - `outbox_propose_contacts` — POST /v1/contact-changes
  - `outbox_contacts_from_import` — `{import_id, first_name_prefix?, first_name_suffix?, include?, groups?}`
  - `outbox_get_contact_changes` — `{set_id}`, or none for a list
- The descriptions say plainly that new contacts are added automatically (after a live duplicate check), that edits to existing contacts wait for the user's Touch ID approval, and that every change can be undone by the user.
- CLI: `outbox contacts propose --file <json>`, `outbox contacts from-import <import_id> [--suffix X] [--prefix X]`, `outbox contacts changes [<set_id>]`.

### User API + dashboard
- Sets and changes:
  - `GET /api/contact-changes?status=` (list) and `GET /api/contact-changes/:id` (set + changes + display `before`).
  - `POST /api/contact-changes/:id/reject {change_ids}` sets review → rejected.
  - `POST /api/contact-changes/:id/cancel` sets the set to cancelled, and its queued/review changes to rejected.
- Approval:
  - `POST /api/contact-changes/:id/approve/options {change_ids}` takes changes in `review`, or ones `approved` but not covered by a live approval.
    - Builds a ContactManifest (24 h; transport from `contacts_transport`) and stores a `webauthn_challenges` row. Reuse `purpose='approve'` and put the set id in the `batch_id` column (it has no FK). The manifest's `kind` tells the two apart.
    - Returns `{challenge_id, options, manifest, payloads: {change_id: payload_json}}`. The browser re-hashes every payload and compares with the manifest before showing the sheet.
  - `POST /api/contact-changes/:id/approve/verify {challenge_id, response}`
    - Verify with the approve passkeys. Re-check every item (kind, target, payload sha, status).
    - Insert a `contact_approvals` row; set the items to `approved` and the set to `approved`; audit.
- Undo: `POST /api/contact-changes/undo {change_ids}`.
  - For each `applied` create/update with a `contact_applies` row, it makes a new set (source `undo`, title "Undo: <orig title>") with `kind='undo'` rows in `review`, payload per ContactUndoPayload, and target_macos_id = the original `result_macos_id` (create) or `target_macos_id` (update).
  - Returns the new set id. The user then approves it through the same Touch ID flow.
- Settings:
  - `contacts_transport` goes in GET/PATCH /api/settings. Setting it to live needs a fresh passkey assertion AND an installed pin with contacts_live_allowed (else 409 with the way forward).
  - The pin policy gains a `contacts_live_allowed` checkbox, saved on tick, in the user pin.
  - `/api/status` reports `pin_contacts_live_allowed`.
- Stop revokes `contact_approvals` too.
- Dashboard:
  - **Contacts → Changes** (`#/contacts/changes` list, `#/contacts/changes/<id>` detail):
    - a card per change with a before → after diff and the note
    - include toggles, Reject, and a sticky "Approve N with Touch ID" footer
    - a confirm sheet that renders from the manifest + payloads ("LIVE: these will change your Contacts" when live)
    - history with an Undo button per applied change and "Undo all" per set
  - The Inbox lists contact sets in review above message batches.

### v4 revisions: these override the rules above where they differ
- **Names:** invisible and default-ignorable code points are refused on both sides. The list is in `src/core/contact-changes.ts` and `ContactModel.swift`; ZWJ and VS16 are allowed for emoji. Strings are never trimmed silently: Swift refuses any string with leading or trailing whitespace (TS trims before storing).
- **An auto create goes to review instead of applying** when any of these hold:
  - it has only one of given/family name (also when one is emoji-only)
  - its name **skeleton** collides with an existing card, where the skeleton is NFKC, then invisibles and emoji/symbols stripped, then Cyrillic/Greek look-alikes mapped to Latin, then folded for case and diacritics. A collision is a "given family" match, or the nickname matching an existing full name, given name or nickname. TS checks the cache at propose time; Swift checks the live address book.
  - it joins a group that already exists, other than "Outbox imports"
  - more than 100 **live** auto creates have applied in the last 24 h (dry ones don't count)
- **Snapshot:** `before_vcard` holds a canonical JSON snapshot `{"v":1,given_name,family_name,nickname,org,phones,emails,groups}` (sorted keys), not a vCard. vCard serialisation needs the notes key, and notes need an entitlement we don't have; no fetch may use the notes key.
- **Undo of a create** is refused if the card has details outside the fingerprint (addresses, birthday, dates, URLs, relations, social, IM, job, department, photo, middle name, prefix, suffix).
- **Undo transport:** the manifest is live if `contacts_transport` is live OR it includes an undo of a live change.
- **Stop** moves queued auto creates to review ("held by Stop"). The executor re-checks the approval's revocation and expiry, and set cancellation, right before each write.
- **Start-up:** the executor starts without the v4 tables (contacts are disabled with a note, sends keep working).
