# Security

Report vulnerabilities privately: on GitHub, open the **Security** tab and choose **Report a vulnerability**. Please don't open a public issue for anything that could let a message be sent, or a contact changed, without the user's approval.

**The guarantee:** a message leaves your Mac only if the executor has verified a Touch ID signature from one of your approval keys over a manifest listing that exact message (recipient, service and SHA-256 of the text), the approval is unexpired and unused, and Stop is off. Agents have no send, approve or settings path.

**How it is built**
- The Agent Outbox app is the only owner interface. There is no browser dashboard and no network listener: the owner API is a Unix socket that only the app can use, and agents get a separate draft-only API.
- Approval keys live in the Mac's Secure Enclave and need Touch ID for every signature. There is no password fallback.
- The executor is the only judge. It verifies the signature against a pin file (version 4) and never trusts the database or the app.
- Enrolling a key needs the new key's own Touch ID signature plus one proof from the owner: the first-run setup token, or `agent-outbox recover` run in Terminal. Recovery opens a 30-minute window that is visible in the app, which can cancel it.
- If the Mac's enrolled fingerprints change, all keys stop working and approval must be set up again.

A new install starts **live**; the approval above is needed for every send. Settings has a **Dry run** switch that logs approved messages instead of sending them; switching back to Live needs Touch ID. Live also covers contacts: a **new** contact, an edit or an undo is only written to your Contacts after you approve it. Contacts are never added automatically, and the executor refuses any contact change without a verified approval.

**Simple mode** (the default) keeps the pin file in a folder you own, so a program running as you outside a sandbox could add its own key to it. It still can't sign without your finger. **Hardened mode** moves the pin to a root-owned file (Settings > "Harden your install", one sudo command you run yourself) and then a new key needs an administrator.

**Not defended:** an administrator or root compromise, someone with both your login password and your finger, a compromised macOS or Secure Enclave, and approving something you didn't read.
