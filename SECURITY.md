# Security

Report vulnerabilities privately: on GitHub, open the **Security** tab and choose **Report a vulnerability**. Please don't open a public issue for anything that could let a message be sent, or a contact changed, without the user's approval.

**The guarantee:** a message leaves your Mac only if the executor has verified a signature from one of your approval passkeys over a manifest listing that exact message (recipient, service and SHA-256 of the text), the approval is unexpired and unused, and Stop is off. Agents have no send, approve or settings path.

A new install starts **live**, not dry: the approval above is what stands between an agent's draft and a sent message, and it is needed for every send. Settings has a **Dry run** switch that logs approved messages instead of sending them; switching back to Live needs a fresh Touch ID sign-in. Installs from before this change keep the mode they had. Live also covers contacts: a **new** contact, an edit or an undo is only written to your Mac's Contacts after you approve it with Touch ID. Contacts are never added automatically, and the executor refuses any contact change that has no verified approval (a row that claims it needs none is moved back to review).

**Touch ID in the Mac app.** Agent Outbox.app can approve with a Secure Enclave key instead of a browser passkey (Touch ID only, no password fallback). The app shows every message before it asks for Touch ID and signs exactly the bytes it showed. The same rule holds: the executor checks the signature against the pinned keys. A program running as you could still pop a Touch ID sheet with its own wording, so Touch ID should only appear right after you press Approve in Agent Outbox; if it appears at any other time, press Cancel.

**Simple mode** (the default) trusts approval keys stored in a file you own, so a program running as you outside a sandbox could add its own key. **Hardened mode** moves them to a root-owned file (Settings > "Harden your install") and closes that gap.

**Not defended:** an administrator or root compromise, malware that controls your browser while you approve, and approving something you didn't read.
