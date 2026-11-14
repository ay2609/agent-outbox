# Agent Outbox: architecture

Any AI agent on this Mac (Claude Code or any MCP client) can **draft** iMessages: one at a time, or as personalised batches built from a spreadsheet or your contacts. No agent can **send**. Drafts land in a dashboard on `http://localhost:<port>` where you read, edit and approve them. Only an approval signed with your passkey (Touch ID) lets a separate, small executor send them through Messages.app.

Interface details (routes, tables, manifest and pin formats) are in [design/CONTRACTS.md](design/CONTRACTS.md). The threat model in plain words is in [../SECURITY.md](../SECURITY.md).

## 1. Goals and non-goals

**Goals**
1. Draft-only access for every agent: an MCP server plus a CLI. Neither has a send verb.
2. Robust ingest: CSV/TSV, XLSX/XLS/ODS/Numbers, vCard, JSON/JSONL, pasted tables. Column auto-mapping, phone normalisation, dedupe, matching to existing contacts, proposed new contacts.
3. Personalisation: deterministic merge fields (`{{first_name}}`) plus optional per-recipient rewriting by the agent, with lint warnings.
4. A local dashboard: review, edit inline, approve or skip per message, stop. AI drafts, you approve, it sends.
5. A send gate that holds against a confused or prompt-injected agent that has tools, and (in hardened mode) against one that has an unsandboxed shell as your user.
6. Contact management in your address book: new contacts after a duplicate check, edits only with approval, everything undoable.

**Non-goals:** reading replies or chat history, group chats, reactions, other channels, multiple users, access from other devices.

## 2. The invariant

> A message leaves this Mac only if the executor itself has verified a WebAuthn assertion from one of your **pinned** approval passkeys over a manifest that lists that exact draft (id, recipient, service, SHA-256 of the body), the approval is unexpired and unused, and the kill switch is off.

The executor never trusts a `status` column. Any edit after approval changes the body hash, so the item no longer matches and needs a fresh approval.

### Defences

| Threat | Defence |
|---|---|
| An agent "helpfully" sends | No send tool in the MCP server, CLI or agent API. A test enumerates the agent API routes and rejects any route that writes approvals, sends, passkeys, sessions or settings. The send code lives only in the executor. |
| An agent edits the database to mark drafts approved | The executor re-verifies the passkey signature and the hashes; `status` is advisory. |
| An agent inserts its own public key and forges approvals | The executor reads keys only from the pin file (section 3). In hardened mode that is root-owned. |
| An agent runs `osascript` against Messages itself | The macOS Automation permission for Messages is granted only to the executor binary. |
| An agent swaps the executor binary or edits its plist | A new binary has a different code identity, so macOS withholds the permission until you allow it again. Hardened runtime blocks `DYLD_*` injection. |
| Replay of an old approval | Each approval has a single-use id and a `not_after` (24 h); the executor records consumed approvals. Passkey signature counters are not relied on (iCloud passkeys report 0). |
| Another website or local program calling the dashboard | Bound to `127.0.0.1`; `Host` allowlist (DNS rebinding); `Origin` plus a custom header on every change; session cookie from a passkey sign-in; a fresh passkey assertion per approval. |
| An agent reads or writes the DB through the API | The agent API is a unix socket (mode 0600) with draft-only routes. |

### Pin modes

The executor must decide whose keys to trust. There are exactly two sources, and no other.

| | Hardened | Simple (default) |
|---|---|---|
| Pin file | `/usr/local/etc/agent-outbox/passkeys.json` (root:wheel, 0444, fixed path) | `<state>/passkeys.json` (your user, 0600) |
| Checks | uid 0, no group/other write, every ancestor directory root-owned, `O_NOFOLLOW` | regular file, `O_NOFOLLOW`, owned by your uid, not group/world-writable; the state directory likewise |
| Chosen when | the root file exists | the root file does not exist |
| If invalid | the executor holds; it never falls back to the user file | the executor holds |
| Who can change it | root (you, with `sudo`) | anything running as you |

The dashboard writes the user pin file whenever the approval keys or the policy (`live_allowed`, `contacts_live_allowed`) change. Hardened mode is the user pin file copied to the root path by one command that the dashboard shows, with a SHA-256 check first. In simple mode a policy change takes effect at once, so turning live sending on needs a fresh sign-in passkey assertion.

### What is and is not covered

| Level | Agent behaviour | Simple mode | Hardened mode |
|---|---|---|---|
| L1 | Uses the MCP/CLI tools, or a sandboxed shell. Includes prompt injection through imported data. | Covered. No send path exists. | Covered. |
| L2 | Runs as your user outside a sandbox and tampers with your files. | Not covered: it can write its own key into the user pin file. | Partly covered: the keys and the live switch are root-owned. Still possible: rewriting the dashboard so a fake confirm sheet gets the approval key signed for other content; adding its own key to the dashboard's database so the next re-run of the harden command installs it; re-sending approved messages inside the 24 h window by deleting `sends` rows; undoing a Stop; binding the dashboard port while the server is down. |
| L3 | Root, or your Apple ID. | Out of scope. | Out of scope. |

**Future hardening (not built).** Isolate the trust anchor from your user: a hidden service user `_outbox` runs the server as a LaunchDaemon from root-owned files and owns the database (mode 0600), the agent API becomes a socket in an `_outbox`-owned directory, and the executor (which must stay in your GUI session for Messages) stops touching the database and instead asks the server over a socket for the next item and its signed approval, verifies it against the root pin, sends and reports back. The server consumes an item when it hands it out, so a fake executor can only cause a non-send. The cost is one root setup script and a root re-install for every update.

## 3. Components

```
 Agents (Claude Code, any MCP client, scripts)
   |  MCP stdio: outbox_* tools (draft-only)       CLI: `outbox ...` (draft-only)
   v                                               v
 +------------------------- outboxd (Bun + Hono) -------------------------------+
 | Agent API   unix socket   <state>/run/agent.sock                              |
 |   drafts, batches, imports, contacts search. NO approve, NO send routes.      |
 | Dashboard   127.0.0.1:<port> (default 7477), origin http://localhost:<port>   |
 |   passkey sign-in, edit, approve (passkey assertion), skip, stop, settings     |
 | Ingest pipeline, personalisation, lint, compose (optionally spawns `claude`)  |
 +----------------- SQLite (WAL)  <state>/outbox.db ---------------------------+
                                        ^ polls every 3 s
 +------------------ outbox-exec (Swift, launchd, own macOS grants) ------------+
 | verify approvals (CryptoKit P-256) against the PIN FILE                       |
 | send via NSAppleScript -> Messages.app (iMessage, SMS relay), right away      |
 | contacts: CNContactStore export -> cache; apply auto/approved changes        |
 | transports: dry (log only, default) | live (needs pin policy + signed manifest)|
 +-------------------------------------------------------------------------------+
```

| Process | Language | Runs as | Why separate |
|---|---|---|---|
| `outboxd` | TypeScript on Bun | LaunchAgent `io.github.ay2609.agent-outbox` | Everything that changes often (UI, ingest). Cannot send. |
| `outbox-mcp` | TypeScript on Bun | stdio child of each agent session | Thin client of the agent socket; validation stays in one place. |
| `outbox` CLI | TypeScript on Bun | on demand | The same agent API, for scripts. |
| `outbox-exec` | Swift | LaunchAgent `io.github.ay2609.agent-outbox.exec` | Small and rarely rebuilt (macOS grants follow the binary); independently verifies the gate; fast native Contacts access. |

State directory: `~/Library/Application Support/agent-outbox` (`OUTBOX_HOME` overrides): `outbox.db`, `config.json`, `passkeys.json` (the user pin), `run/agent.sock`, `imports/`, `logs/`, `contacts-export.json`.

## 4. Stack decisions

| Concern | Choice | Reason |
|---|---|---|
| Send transport | Messages.app via AppleScript from the executor | It sends as you, free, with no extra server. Alternatives either send from someone else's number, need a large server, or need a phone in hand per message. |
| Runtime | Bun | Built-in SQLite, runs TypeScript directly, `fetch` over unix sockets. |
| HTTP | Hono | Tiny and Bun-native; a full framework is too heavy for one user. |
| DB | `bun:sqlite`, raw SQL, one schema file, zod at the edges | Few moving parts; the Swift executor reads the same tables. |
| UI | React + Vite single-page app, plain CSS | Passkey calls and inline editing need JavaScript anyway. |
| Passkeys | `@simplewebauthn/server` and `/browser` | A passkey's private key never leaves the Secure Enclave or iCloud Keychain; TOTP secrets would sit on disk where agents can read them. |
| Ingest | papaparse, SheetJS (from its own CDN, not the stale npm package), libphonenumber-js, a small vCard parser | Standard and robust. |
| MCP | `@modelcontextprotocol/sdk` stdio, pinned | Every common MCP client can load a stdio server. |
| Executor | Swift `.app`, ad-hoc signed with hardened runtime | One frozen binary holds the Messages and Contacts grants; CNContactStore is much faster than AppleScript for thousands of contacts; CryptoKit gives a second, independent signature check. |

## 5. Data model (SQLite)

All ids are UUIDv7 text (time-sortable); times are ISO-8601 UTC text. The schema is `src/db/schema.sql`.

- `contacts` (`source` macos/import/manual, names, `phones_json`, `emails_json`, tags), `contact_handles` (E.164 or lowercased email to contact; the lookup index)
- `imports`, `import_rows` (raw and normalised row, match: matched/new/ambiguous/invalid, issues)
- `batches` (status drafting/review/approved/sending/done/cancelled), `drafts` (handle, service, body, version, status, warnings, proposed contact), `draft_revisions`
- `approvals` (batch id, the exact manifest bytes that were signed, the raw WebAuthn fields, `not_after`, `consumed_at`, `revoked_at`)
- `sends` (draft, approval, attempt, transport dry/live, result sent/failed/unknown, a snapshot of the handle and body hash actually sent)
- `contact_writes`; and for contact management `contact_change_sets`, `contact_changes`, `contact_approvals`, `contact_applies`
- `passkeys` (purpose `login` or `approve`; the dashboard's copy), `sessions` (hashed token, expiry), `webauthn_challenges`
- `settings`: `transport`, `kill_switch`, `kill_reason`, `breaker_on_failure`, `contacts_transport`
- `audit_log`: append-only `at, actor, action, target, details`

## 6. Approval manifest (shared by TypeScript and Swift)

The server builds the manifest, stores the **exact bytes** in `approvals.manifest`, and uses `sha256(bytes)` (32 raw bytes) as the WebAuthn challenge. The executor hashes the stored bytes, compares them with the `challenge` in `clientDataJSON`, then parses the JSON. Neither side has to re-canonicalise.

```json
{"v":2,"approval_id":"...","batch_id":"...","created_at":"2026-11-10T08:00:00Z",
 "not_after":"2026-11-11T08:00:00Z","rp_id":"localhost","origin":"http://localhost:7477",
 "transport":"dry",
 "items":[{"draft_id":"...","to":"+15551234567","service":"auto",
           "body_sha256":"<hex of sha256(utf8 body)>","name":"Sam Lee","create_contact":null}]}
```

Per item, before sending, the executor checks: `type == "webauthn.get"`; `origin` equals the pin's origin; `rpIdHash == sha256(rp_id)`; the user-present and user-verified flags; an ECDSA P-256 signature over `authenticatorData || sha256(clientDataJSON)` with a pinned approval key; `now < not_after`; the approval is not consumed or revoked; the draft's current handle, service and body hash equal the item's; the transport is allowed (below); the kill switch is off. `rp_id` and `origin` come from the pin file, never from the database.

Transport: the manifest records `dry` or `live` when it is built, and the confirm sheet shows a LIVE banner. The executor sends live only if the signed manifest says live and the effective pin's policy has `live_allowed`. A dry-signed approval always goes to the dry log, whatever the database setting says later.

## 7. Agent surface (MCP tools and CLI)

Draft-only; every tool returns ids and a dashboard link.
- `outbox_search_contacts`, `outbox_get_contact`
- `outbox_create_draft`, `outbox_create_batch`, `outbox_add_items`, `outbox_submit_batch`, `outbox_cancel_batch`
- `outbox_update_draft`, `outbox_update_drafts`: only while not approved; each edit creates a revision
- `outbox_list_batches`, `outbox_get_batch`: status, including sent and failed
- `outbox_ingest_file`, `outbox_get_import`, `outbox_set_mapping`, `outbox_batch_from_import`
- `outbox_propose_contacts`, `outbox_contacts_from_import`, `outbox_get_contact_changes`
- `outbox_sync_contacts`: asks the executor for a contacts refresh

## 8. Dashboard

- **Inbox**: contact change sets and message batches in review, with counts and warning chips. A persistent "Simple mode" badge (or "Hardened" chip) links to Settings.
- **Batch**: one card per draft with name, handle, service, an editable body, warnings, an include toggle, "new contact" badges. Sticky footer `Approve N` opens a confirm sheet (recipients, warnings, the dry-run notice or a LIVE banner; the approval is valid a fixed 24 h), then Touch ID. "Stop all sending" is always visible and needs no passkey.
- **Compose** ("Ask Claude"): pick contacts, a tag or an import and type instructions; the server runs `claude -p` with only the outbox MCP tools allowed and the result lands as a batch in review. Shown only if a `claude` command is found and `compose` is not `"off"`.
- **Imports**: upload, confirm the mapping, see matched/new/ambiguous/invalid rows.
- **Contacts**: search, and **Changes**: a before-to-after card per proposed change, approve, reject, and undo for applied changes.
- **Activity**: the send log, failures and the audit log.
- **Settings**: passkeys, the pin status, "Harden your install" with the one sudo command, the `live_allowed` and `contacts_live_allowed` checkboxes, the dry/live transports, Stop/Resume.

Lint warnings concern draft content: an unresolved `{{field}}`, an empty merge value, a duplicate recipient in the batch, the same recipient pending in another batch, messaged in the last 7 days, an invalid or non-mobile number, a body over 1,000 characters, a body identical to the template when personalisation was asked for.

## 9. Ingest pipeline

1. Store the raw upload immutably (`<state>/imports/<sha256>.<ext>`).
2. Parse: sniff the encoding (BOM, UTF-16, Latin-1 fallback) and delimiter; first sheet by default (selectable); skip blank rows; detect the header row.
3. Map columns: header synonyms plus value sniffing (share of cells that parse as phones or emails). Each target field gets a confidence; below 0.8 the mapping needs confirmation. Unmapped columns stay available as `{{column_slug}}` merge variables.
4. Normalise: phones to E.164 with libphonenumber-js (default region US) with a non-mobile flag; lowercase emails; split or join names.
5. Dedupe rows by handle.
6. Match: an exact handle match in `contact_handles` is `matched`; the same name with a different number is `ambiguous` (you pick); otherwise `new` with a proposed contact.

## 10. Executor details

- One Swift package, `exec/`. Subcommands: `run` (daemon loop), `selftest` (temp dirs only, dry transport), `contacts-export`, `verify <approval_id>` (prints verdicts, sends nothing), `version`. No subcommand sends arbitrary text.
- Messages send: `NSAppleScript` in-process (no `osascript` child), with text and handle passed as escaped string literals, never interpolated. Addressing is by handle with the `participant "<handle>" of (1st account whose service type = iMessage)` form, never by chat GUID. `auto` tries iMessage, then SMS (which needs Text Message Forwarding) if iMessage errors before hand-off. A successful `send` only means "handed to Messages", so the status is `sent` unconfirmed; delivery cannot be confirmed without reading `chat.db`, which would need Full Disk Access.
- Failure semantics: an AppleScript error before hand-off is `failed` and retryable (3 times) inside the same approval. Anything ambiguous, or a crash mid-send, is `unknown` and never retried automatically.
- Sending: once an approval verifies, its items go out right away, one at a time with a fixed 2 s gap. The safety nets are the signature, the 24 h window, Stop (with a short undo) and a circuit breaker that stops everything on any send error.
- Packaging: `exec/build.sh` builds `exec/build/OutboxExec.app` (`CFBundleIdentifier` `io.github.ay2609.agent-outbox.exec`, display name "Agent Outbox", `LSUIElement`, usage strings for Apple Events and Contacts). The LaunchAgent's program is the inner executable, so macOS charges the executor and not a terminal or Bun.
- Code signing: **ad-hoc, with hardened runtime**. Ad-hoc grants are pinned to the code hash, so every rebuild makes macOS ask again for Messages and Contacts. That is deliberate: a stable signing identity would survive rebuilds, but its key would sit on this Mac where a rogue program could sign its own Messages-capable binary with it. A frozen hash means only the binary you built and allowed can drive Messages. Keep the executor small so it rarely changes.
- Contacts: it exports the address book through CNContactStore into a JSON file the server imports (on request and every 30 minutes once access is granted), applies new contacts after a live duplicate check, and applies approved edits and undos. See the contact management section of the contracts.
- Self-protection: the executor refuses to run (it holds and shows why) if the database contains a trigger, or a view named like one of its tables.

## 11. Setup

See the README. In short: `./install.sh`, open the dashboard, create the sign-in and approval passkeys, try dry mode, optionally harden, then allow live sending and answer the macOS prompts for "Agent Outbox".
