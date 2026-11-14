# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/).

## 0.1.0 - 2026-11-13

Initial public release.

- Agents draft iMessages, personalised batches and contact changes through an MCP server, a CLI or a local socket. There is no send path in any of them.
- Dashboard on `http://localhost:7477` with Touch ID (platform passkey) sign-in and approval, a Stop button, and per-message editing.
- Approvals are signed manifests of the exact recipient, service and SHA-256 of each message body. A separate Swift executor verifies the signature against pinned keys before it sends anything.
- Import people from CSV, TSV, XLSX/XLS/ODS/Numbers, vCard, JSON/JSONL or pasted tables, with column mapping, phone normalisation and matching to your contacts.
- Contact management: new contacts are added after a duplicate check; edits need an approval; every change can be undone.
- Dry mode by default: approved messages are only written to a log until you switch to live sending.
- Simple mode (the approval keys live in your state directory) and hardened mode (a root-owned copy of the keys, installed with one sudo command you run yourself).
- First-run registration needs a one-time setup token (the link `install.sh` prints; `install.sh --setup-link` shows it again), so a local process can't claim the first keys before you.
- The hardened-mode key file lives at `/Library/Application Support/agent-outbox/passkeys.json`, which is root-owned on every Mac.
- `install.sh` and `uninstall.sh` for per-user LaunchAgents; no sudo needed to install.
