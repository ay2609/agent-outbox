# Security

Report vulnerabilities privately: on GitHub, open the **Security** tab and choose **Report a vulnerability**. Please don't open a public issue for anything that could let a message be sent, or a contact changed, without the user's approval.

**The guarantee:** a message leaves your Mac only if the executor has verified a signature from one of your approval passkeys over a manifest listing that exact message (recipient, service and SHA-256 of the text), the approval is unexpired and unused, and Stop is off. Agents have no send, approve or settings path.

A new install starts **live**, not dry: the approval above is what stands between an agent's draft and a sent message, and it is needed for every send. Settings has a **Dry run** switch that logs approved messages instead of sending them; switching back to Live needs a fresh Touch ID sign-in. Installs from before this change keep the mode they had. Live also covers contacts: a **new** contact an agent proposes is added to your Mac's Contacts automatically after a duplicate check, with no Touch ID, while edits and undos need it.

**Simple mode** (the default) trusts approval keys stored in a file you own, so a program running as you outside a sandbox could add its own key. **Hardened mode** moves them to a root-owned file (Settings > "Harden your install") and closes that gap.

**Not defended:** an administrator or root compromise, malware that controls your browser while you approve, and approving something you didn't read.
