// Terminal-side owner proofs for the Secure Enclave app (local-docs/APP-SECURITY-C.md section 4):
//  - `agent-outbox recover`    writes <state>/recovery-token (32 random bytes, base64url, 0600, created O_EXCL|O_NOFOLLOW, valid
//                              30 minutes, one use). It lets the app enrol ONE new Secure Enclave key when the old one is lost
//                              or invalidated and no browser passkey is available. Honest limit: anything running as the user
//                              can run this; in hardened mode the new key stays untrusted until the owner runs the sudo command.
//  - `agent-outbox setup-link` prints the one-time first-run link (what `./install.sh --setup-link` prints).
// src/bin.ts (track A) dispatches to runRecover() and runSetupLink(); both return the process exit code.
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { PORT, paths } from "../core/paths";
import { b64u } from "./b64";

export const RECOVERY_TTL_MS = 30 * 60_000;
const WELL_FORMED = /^[A-Za-z0-9_-]{43}$/;

/** Reads a token file: a regular file (never through a symlink) owned by this user, closed to group/other, holding exactly one
 *  well-formed token. `maxAgeMs` (by the file's mtime) makes it expire. Null for anything else. */
export function readTokenFile(path: string, maxAgeMs?: number): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 256 || st.uid !== process.getuid!() || (st.mode & 0o077) !== 0) return null;
    if (maxAgeMs !== undefined && Date.now() - st.mtimeMs > maxAgeMs) return null;
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    const text = buf.toString("utf8").trim();
    return WELL_FORMED.test(text) ? text : null;
  } finally { closeSync(fd); }
}

/** The recovery token on disk: valid for 30 minutes after it was written, and for one use. */
export class RecoveryToken {
  constructor(readonly path: string, private ttlMs = RECOVERY_TTL_MS) {}
  /** True while a valid, unexpired token file exists. */
  get active(): boolean { return readTokenFile(this.path, this.ttlMs) !== null; }
  matches(candidate: string | undefined | null): boolean {
    const t = readTokenFile(this.path, this.ttlMs);
    if (t === null || typeof candidate !== "string") return false;
    const a = Buffer.from(t, "utf8"), b = Buffer.from(candidate, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }
  /** One use: deletes the file. */
  consume(): void { try { unlinkSync(this.path); } catch { /* already gone */ } }
  /** Writes a fresh token (replacing any old one) and returns it. */
  create(): string {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const token = b64u(randomBytes(32));
    try { unlinkSync(this.path); } catch { /* none */ }
    // O_EXCL | O_NOFOLLOW: something planted at the name between the unlink and here is an error, never followed.
    const fd = openSync(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, token + "\n"); } finally { closeSync(fd); }
    return token;
  }
}

/** `agent-outbox recover`. */
export async function runRecover(): Promise<number> {
  process.umask(0o077);
  const rt = new RecoveryToken(paths.recoveryToken);
  let token: string;
  try { token = rt.create(); } catch (e) {
    console.error(`Could not write ${paths.recoveryToken}: ${(e as Error).message}`);
    return 1;
  }
  console.log(`Recovery token written to ${paths.recoveryToken} (valid for 30 minutes, one use).`);
  console.log("Open Agent Outbox and choose \"Set up Touch ID again\": the app reads it for you.");
  console.log("");
  console.log(`  ${token}`);
  console.log("");
  console.log("It lets the app add one new approval key. Nothing is approved or sent by it. In hardened mode the new key stays untrusted");
  console.log("until you run the command in Settings (it needs sudo). If you didn't ask for this, delete the file.");
  return 0;
}

/** `agent-outbox setup-link`: the one-time first-run link, or a note that setup is already done. */
export async function runSetupLink(): Promise<number> {
  const token = readTokenFile(paths.setupToken);
  if (!token) {
    console.log("No first-run setup is pending (the server removes the setup token once the first key is set up).");
    console.log(`If you lost access, run \`agent-outbox recover\` and re-enrol Touch ID in the app, or open http://localhost:${PORT}.`);
    return 1;
  }
  console.log(`http://localhost:${PORT}/#/setup?token=${token}`);
  return 0;
}
