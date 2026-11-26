# Agent Outbox

[agent-outbox.halcyn.dev](https://agent-outbox.halcyn.dev)

Let AI agents draft your iMessages, but never send them. Claude Code, or any other MCP client, writes drafts and personalised batches (from a spreadsheet, a vCard file or your contacts) into a dashboard on your own Mac. You read them, edit them and approve with Touch ID. Only then does a small separate program, the executor, send them through Messages.app. Everything runs locally: no server, account or cloud service.

The gate holds even when the agent is confused or prompt-injected: there is no send tool, no send API and no approve call for an agent to use, and the executor refuses anything not signed with your passkey.

![Reviewing a batch](docs/screenshots/batch.png)

## How it works

1. The agent calls `outbox_*` MCP tools (or the `outbox` CLI). They can only create and edit drafts.
2. You open `http://localhost:7477`, review each message, edit or skip any, and press Approve.
3. Touch ID signs a manifest listing every message's recipient and the SHA-256 of its exact text.
4. The executor checks the signature and that every message still matches, then hands it to Messages.app. A message edited after approval no longer matches and needs a new approval.

## Download

[**Download the latest Agent Outbox**](https://github.com/ay2609/agent-outbox/releases/latest) (a DMG for Apple silicon Macs, macOS 13 or newer).

1. Open the DMG and drag **Agent Outbox** into Applications.
2. Open it. The app is free and not notarized by Apple, so macOS blocks the first launch: open **System Settings > Privacy & Security**, click **Open Anyway** next to Agent Outbox, and confirm.
3. Follow the first-run steps in the app: connect your agent, then create your approval key with Touch ID.

You also need Messages signed in to your Apple ID (for SMS to non-iPhones, turn on Text Message Forwarding on your iPhone). Macs without Touch ID unlock approvals with the Mac password.

## Connect your agent

The app's **Connect Claude Code** button runs this for you:

```sh
claude mcp add --scope user agent-outbox -- "/Applications/Agent Outbox.app/Contents/MacOS/agent-outbox" mcp
```

For Claude Desktop, Cursor or any other MCP client, add a stdio server with that command and the argument `mcp`:

```json
{ "mcpServers": { "agent-outbox": { "command": "/Applications/Agent Outbox.app/Contents/MacOS/agent-outbox", "args": ["mcp"] } } }
```

Start a new agent session afterwards so the `outbox_*` tools load.

## First run

1. Create your approval key when the app asks. Touch ID is what authorises every send.
2. You start **live**: a message you approve with Touch ID is really sent. Nothing goes out without that approval, and every message needs its own. Contacts work the same way: new contacts, edits and undos your agent proposes wait for your Touch ID approval, and nothing is ever added to your Contacts automatically. Ask your agent to draft a text to yourself and try it. On the first send macOS asks whether "Agent Outbox" may control Messages, and on the first contacts sync it asks for Contacts. Allow both only for "Agent Outbox".

The **AI draft** page has ready-made prompts to paste into your agent (text one person, personalise a batch, work from a spreadsheet, add contacts, check what was sent), each with a Copy button.

## Simple and hardened mode

**Simple mode** (the default) keeps your approval keys in a file you own. That stops an agent using its tools, and prompt injection, from sending anything. It does not stop a program running as you, outside a sandbox, from planting its own key in that file.

**Hardened mode** moves the keys to a root-owned file, `/Library/Application Support/agent-outbox/passkeys.json`, and the executor then trusts only that. Settings > "Harden your install" shows the one sudo command. Run it yourself in Terminal; never let an agent run it. Do it before you rely on live sending, especially if an agent on this Mac has an unsandboxed shell.

## Dry run and live

You start live. To try things without sending anything, open Settings and switch **Sending** to **Dry run**: approved messages are only written to `~/Library/Application Support/agent-outbox/logs/dry-sends.jsonl` and Contacts is not touched. Switching back to **Live** asks for Touch ID. Live also means approved contact changes are really written to your Contacts; every new contact, edit and undo still needs its own Touch ID approval first (and you can undo them). (An install from before this change keeps the setting it had.)

Approved messages go out right away, 2 seconds apart (unless you turn on spreading, below). **Stop** halts everything and revokes unused approvals.

## Spreading out messages

If you send a lot at once, a burst can make a phone number or account look like spam. In Settings, **Spread out messages** (off by default) sends one message at a time with a random pause between them. Pick **Gentle** (30 to 90 seconds apart, up to 150 a day), **Careful** (2 to 5 minutes apart, up to 50 a day, nothing between 9 pm and 9 am), or **Custom** to set the pause, a daily limit (0 means none) and quiet hours yourself. Times use your Mac's clock. It also applies to dry runs, so a dry run shows the real schedule. Contact changes aren't spread out.

The approve sheet says how long a batch will take ("Sends over about 2 h 10 min"), and the batch page says when the next message goes. An approval normally lasts 24 hours; a long paced batch gets a longer window (its estimated length plus 12 hours, at most 7 days). If a batch would take more than 7 days, the sheet says how many messages fit and the rest would expire unsent. Only you can change this setting: agents can see it (the status call shows it, read-only) but not change it.

## MCP tools

All draft-only.

| Tool | Does |
|---|---|
| `outbox_search_contacts`, `outbox_get_contact` | Find people in your contacts |
| `outbox_create_draft` | One message |
| `outbox_create_batch`, `outbox_add_items`, `outbox_submit_batch` | A batch, optionally from a template with per-recipient fields |
| `outbox_update_draft`, `outbox_update_drafts`, `outbox_cancel_batch` | Edit or cancel before approval |
| `outbox_list_batches`, `outbox_get_batch` | Status, including what was sent |
| `outbox_ingest_file`, `outbox_get_import`, `outbox_set_mapping`, `outbox_batch_from_import` | Turn a CSV, XLSX, vCard or pasted table into a batch |
| `outbox_propose_contacts`, `outbox_contacts_from_import`, `outbox_get_contact_changes` | Propose new contacts or edits (both wait for your Touch ID approval; nothing is added automatically) |
| `outbox_list_groups`, `outbox_get_group`, `outbox_create_group`, `outbox_add_to_group`, `outbox_update_group`, `outbox_batch_from_group` | Saved groups of people (see below) |
| `outbox_sync_contacts` | Refresh the contact list |

The same API is available as a CLI: `"/Applications/Agent Outbox.app/Contents/MacOS/agent-outbox" cli --help`.

## Groups

A group is a saved list of people ("Book club"), kept by Agent Outbox itself. They are not groups in the macOS Contacts app (those show up as contact tags). An agent can save one from a spreadsheet, a pasted list or your contacts, add to it later, and draft a personalised message to everyone in it; a group only chooses who a draft is addressed to, so every message still needs your Touch ID approval. Groups live under Contacts, then Groups in the dashboard, where you can rename them, remove people, add people from your address book, and delete them (agents can't delete). A person stays in a group even if the contact is later removed from your address book.

## Configuration

Optional `~/Library/Application Support/agent-outbox/config.json`:

```json
{ "port": 7477 }
```

Environment overrides: `OUTBOX_HOME`, `OUTBOX_PORT`. Restart the app after changing the port.

## Uninstall

Quit Agent Outbox, turn off its login items in System Settings > General > Login Items, and drag it to the Trash. Your data stays in `~/Library/Application Support/agent-outbox` until you delete that folder.

## FAQ

**Why not give the agent AppleScript?** Then it can send anything, including text an attacker slipped into a file it read. Here the only program that can send checks a signature made with your finger.

**Why does macOS ask for permission again after an update?** The app and its sender are ad-hoc signed, so each build is a new app to macOS. That's deliberate: a long-lived signing key on your Mac could sign a rogue app. If sends fail with error -1743, run `tccutil reset AppleEvents io.github.ay2609.agent-outbox.exec` and allow the prompt again.

**Can it read my replies or send group messages?** No and no.

## Acceptable use

Only send messages you'd send yourself, to people who expect to hear from you. No spam or unsolicited bulk texting. You're responsible for everything sent from your account, and bulk texting from a personal number can get your Apple ID flagged.

MIT licensed. Security reports: see [SECURITY.md](SECURITY.md). Not affiliated with Apple; iMessage and Messages are Apple trademarks.

## Developers

Build the app yourself: `scripts/build-app.sh` (needs Bun and the Xcode Command Line Tools with Swift 6) writes `dist/Agent Outbox.app`; `scripts/build-dmg.sh` makes the DMG.

Or skip the app and run it from a checkout (macOS 14+, [Bun](https://bun.sh) 1.4+, Swift 6): `git clone https://github.com/ay2609/agent-outbox.git && cd agent-outbox && ./install.sh`. The installer builds the dashboard and the executor, starts two per-user LaunchAgents and registers the MCP server with Claude Code if `claude` is installed. It never uses sudo; re-running it upgrades. Options: `--port N`, `--no-mcp`, `--dry-run`, `--setup-link`, `--help`. Undo with `./uninstall.sh` (`--purge` also deletes the state folder). Then open the setup link it printed (`./install.sh --setup-link` reprints it).

```sh
bun install && bunx tsc --noEmit -p . && bun test
bun run web:build
cd exec && ./build.sh && build/OutboxExec.app/Contents/MacOS/outbox-exec selftest
OUTBOX_HOME=$TMPDIR/ao OUTBOX_PORT=7478 bun run src/server.ts   # dev server on a throwaway state dir
```

Never weaken the send gate: no agent-facing tool may send, approve or change settings. Keep the Touch ID approval for every send.
