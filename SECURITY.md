# Security

## Reporting a vulnerability

Please report security problems privately. Use GitHub's private vulnerability reporting: open the repository's **Security** tab, choose **Report a vulnerability** (a security advisory on `ay2609/agent-outbox`). Please do not open a public issue for anything that could let a message be sent, or a contact changed, without the user's approval.

Include what you did, what you expected and what happened, plus macOS and Agent Outbox versions. You will get a reply as soon as the maintainer can; this is a small project, so please allow a few days.

Fixes to the send gate are the highest priority. See "What is defended" below for what counts as a break.

## What this project is protecting

Agent Outbox lets an AI agent prepare iMessages and contact changes while the human keeps the only ability to approve them. The invariant:

> A message leaves this Mac only if the executor has itself verified a passkey signature from one of the user's pinned approval keys over a manifest that lists that exact message (recipient, service and the SHA-256 of its text), the approval is unexpired and unused, and the kill switch is off.

The executor never trusts a `status` column in the database. Editing a message after approval changes its hash, so it no longer matches and needs a new approval.

## Threat model in plain words

### What is defended (simple mode and hardened mode)

- **An agent cannot send.** The MCP server, the CLI and the agent API have no send, approve or settings routes. A test walks the route table and fails if one appears. All the sending code is in the executor.
- **An agent cannot forge an approval through the tools.** An approval is a WebAuthn assertion made by a key whose private half lives in your Mac's Secure Enclave or iCloud Keychain and needs Touch ID. The signed manifest holds the exact recipient, service and body hash of every message, and the executor re-checks each one against the database before sending.
- **Prompt injection through data is covered.** A malicious spreadsheet row or web page can at most cause a bad draft, which you see and reject. It cannot reach a send path.
- **Two kinds of key.** Signing in to the dashboard and approving sending use different passkeys with different account names on the system sheet. Only the approval keys are trusted by the executor. A tampered dashboard that asks for the approval key during a sign-in is visible on the system sheet.
- **The executor is the only process with the Messages and Contacts permission.** macOS ties those permissions to the executor's code identity. Replacing or rebuilding the binary makes macOS ask again, so a swapped binary cannot silently inherit them. It is signed with the hardened runtime, which blocks injection through environment variables.
- **Dry mode is the default.** Nothing is sent until you tick "Allow live sending" and switch to live. The transport is signed into each approval, so a dry approval can never be replayed as a live one.
- **Stop.** One button halts all sending and revokes unused approvals; it needs a session but no passkey, because stopping is always safe. A circuit breaker does the same on any send error.
- **Single use and expiry.** Each approval is valid for 24 hours and is consumed per message.
- **Local only.** The dashboard binds to `127.0.0.1`, rejects requests with a foreign `Host` header (DNS rebinding), and checks `Origin` plus a custom header on every change. The agent API is a unix socket with mode 0600.

### What simple mode does NOT defend

In simple mode the executor reads its trusted approval keys from a file in your state directory, `<state>/passkeys.json`. Any program running as your user that is not confined by a sandbox can write that file, put in a key it controls, write a matching approval into the database and have it sent. That includes an AI agent with an unrestricted shell that decides to do it.

So simple mode is safe against agents using their tools and against prompt injection, but not against a shell-capable agent that is actively trying to get around the gate. Know which kind of agent you run.

### How hardened mode fixes that

Hardened mode keeps the trusted keys in `/usr/local/etc/agent-outbox/passkeys.json`, owned by root and not writable by anyone else. When that file exists the executor uses only it, and refuses to run if it is invalid; there is no fallback to the user file, so it cannot be downgraded by deleting or corrupting it. Settings > "Harden your install" shows a single command that checks the file's SHA-256 and installs it with `sudo`. Run it yourself, in Terminal, after reading it. An agent must never run it.

Hardened mode also keeps the "Allow live sending" switch in the root file, so no process running as your user can turn live sending on.

Hardened mode freezes the keys and live settings as they were when you ran the command. Running it again installs whatever the dashboard holds at that moment, and a program running as you can change that (the database is yours too), so only re-run it right after you yourself added a key or changed a live setting, and check the key list it prints. A "run the command again" notice you did not cause is a warning sign: do not run it.

Hardened mode relies on every directory above the root file (`/usr/local`, `/usr/local/etc`) being owned by root and closed to other writers. The executor checks this and holds if it is not true. If some installer later makes one of those directories yours (older Homebrew setups on Intel Macs own parts of `/usr/local`), a program running as you could move the root file away and drop the executor back to simple mode; the dashboard would then show "Simple mode" again.

### What neither mode defends

- **Root or administrator compromise** of the Mac, or access to your Apple ID.
- **Malware that drives your browser while you are approving.** It could show you one thing and sign another. The confirm sheet is rendered from the same manifest object that is hashed, but a program able to rewrite the dashboard code can still lie to you. Hardened mode narrows this but does not remove it.
- **You approving something you did not read.** The system sheet tells you that you are approving a batch, not what it says.
- **Replay and denial inside the approval window** by a program with write access to the database: it can delete send records and re-send already approved messages within the 24 hours, or undo a Stop. Hardened mode does not change this.
- **Another program binding the dashboard port** while the server is down. Passkeys are tied to the origin, so it cannot use your passkeys, but it could show a lookalike page.

A planned improvement is to run the server as a separate, hidden system user that owns the database, so that same-user programs cannot touch it. It needs more root-level setup and is not built.

## Supported versions

Only the latest release is supported.

## Hardening checklist

- Run `./install.sh`, then use the Settings button to harden before enabling live sending.
- Never grant Automation or Contacts access to Terminal, Bun or `osascript`; only to "Agent Outbox". A permission prompt you did not just cause is suspicious: click Don't Allow.
- Keep the agent sandboxed, and do not let it run `sudo`.
- Read each confirm sheet. It shows who will receive what, and a LIVE banner when messages will really be sent.
