# Security

Report vulnerabilities privately: on GitHub, open the **Security** tab and choose **Report a vulnerability**. Please don't open a public issue for anything that could let a message be sent, or a contact changed, without the user's approval.

**The guarantee:** a message leaves your Mac only if the executor has verified a signature from one of your approval passkeys over a manifest listing that exact message (recipient, service and SHA-256 of the text), the approval is unexpired and unused, and Stop is off. Agents have no send, approve or settings path.

**Simple mode** (the default) trusts approval keys stored in a file you own, so a program running as you outside a sandbox could add its own key. **Hardened mode** moves them to a root-owned file (Settings > "Harden your install") and closes that gap.

**Not defended:** an administrator or root compromise, malware that controls your browser while you approve, and approving something you didn't read.
