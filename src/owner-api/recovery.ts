// Terminal-side owner proof for the Secure Enclave app:
//  `agent-outbox recover` writes <state>/recovery-token (32 random bytes, base64url, 0600, created O_EXCL|O_NOFOLLOW, valid
//  30 minutes, one use) and appends an audit row. The app reads the file and sends the token in enroll/verify, which lets it enrol
//  ONE new Secure Enclave key (setup on an existing install, a lost Mac, a changed Touch ID set). Nothing is approved or sent by it.
//  Honest limit: anything running as the user can run this; in hardened mode the new key stays untrusted until the owner runs the
//  sudo command. The token is never printed: it is only read from disk.
// src/bin.ts dispatches to runRecover(), which returns the process exit code.
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { paths } from "../core/paths";
import { b64u } from "./b64";

export const RECOVERY_TTL_MS = 30 * 60_000;
const WELL_FORMED = /^[A-Za-z0-9_-]{43}$/;

/** Reads a token file: a regular file (never through a symlink) owned by this user, closed to group/other, holding exactly one
 *  well-formed token. `maxAgeMs` (by the file's mtime) makes it expire. Null for anything else. */
export function readTokenFile(path: string, maxAgeMs?: number): { token: string; mtimeMs: number } | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 256 || st.uid !== process.getuid!() || (st.mode & 0o077) !== 0) return null;
    if (maxAgeMs !== undefined && Date.now() - st.mtimeMs > maxAgeMs) return null;
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    const text = buf.toString("utf8").trim();
    return WELL_FORMED.test(text) ? { token: text, mtimeMs: st.mtimeMs } : null;
  } finally { closeSync(fd); }
}

/** The recovery token on disk: valid for 30 minutes after it was written, and for one use. */
export class RecoveryToken {
  constructor(readonly path: string, private ttlMs = RECOVERY_TTL_MS) {}
  /** The valid token file, or null. An expired file is deleted on sight. */
  private read(): { token: string; mtimeMs: number } | null {
    const t = readTokenFile(this.path, this.ttlMs);
    if (t === null) {
      const expired = readTokenFile(this.path);
      if (expired) this.consume();
    }
    return t;
  }
  /** True while a valid, unexpired token file exists. */
  get active(): boolean { return this.read() !== null; }
  /** When the token stops working (ISO), or null when none is valid. */
  expiresAt(): string | null {
    const t = this.read();
    return t ? new Date(t.mtimeMs + this.ttlMs).toISOString() : null;
  }
  matches(candidate: string | undefined | null): boolean {
    const t = this.read();
    if (t === null || typeof candidate !== "string") return false;
    const a = Buffer.from(t.token, "utf8"), b = Buffer.from(candidate, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }
  /** One use (or Cancel recovery): deletes the file. True when a file was there. */
  consume(): boolean { try { unlinkSync(this.path); return true; } catch { return false; } }
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
  // Refuse when the state dir is not ours or is open to others: the token (and the pin the app then writes) would not be private.
  try {
    const st = lstatSync(paths.state);
    if (!st.isDirectory() || st.uid !== process.getuid!() || (st.mode & 0o077) !== 0) {
      console.error(`${paths.state} is not a directory owned by you and closed to others (mode 0700); not writing a recovery token.`);
      return 1;
    }
  } catch {
    console.error(`${paths.state} doesn't exist: Agent Outbox has not been started on this Mac yet, so there is nothing to recover.`);
    return 1;
  }
  const rt = new RecoveryToken(paths.recoveryToken);
  try { rt.create(); } catch (e) {
    console.error(`Could not write ${paths.recoveryToken}: ${(e as Error).message}`);
    return 1;
  }
  if (existsSync(paths.db)) {
    try {
      const { openDb } = await import("../db");
      const { audit } = await import("../core/store");
      const db = openDb(paths.db);
      try { audit(db, "cli", "recovery.create", null, {}); } finally { db.close(); }
    } catch (e) { console.error(`(Could not write the audit row: ${(e as Error).message})`); }
  }
  console.log("Recovery is open for 30 minutes. In Agent Outbox, press Set up Touch ID. If you didn't run this, press Cancel recovery in the app.");
  return 0;
}
