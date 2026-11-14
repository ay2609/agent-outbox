// The one-time first-run setup token. While no sign-in key exists, registering one needs this token, so a local process
// that can reach localhost but can't read the user's files (e.g. a sandboxed agent) can't claim the first-run keys.
//
// Lifecycle: the server calls start() once. If there is no sign-in key it loads <state>/setup-token (when well-formed and
// private) or generates 32 random bytes (base64url) and writes it there (0600, atomic, never through a symlink). The value
// stays in memory. The first sign-in key's registration calls clear(), which deletes the file and forgets the value. If a
// sign-in key already exists at start, a leftover file is deleted. The token is never returned by any API.
import type { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { paths } from "../core/paths";
import { b64u } from "./b64";
import { passkeyCount } from "./auth";

/** 32 random bytes as unpadded base64url. */
const WELL_FORMED = /^[A-Za-z0-9_-]{43}$/;

export class SetupToken {
  private value: string | null = null;
  constructor(readonly path: string) {}

  /** Loads or generates the token when no sign-in key exists yet (returns it); otherwise removes any leftover file (returns null). */
  start(db: Database): string | null {
    if (passkeyCount(db, "login") > 0) { this.clear(); return null; }
    this.value = this.read() ?? this.generate();
    return this.value;
  }
  /** True while a token is held, i.e. open registration is guarded and possible. */
  get active(): boolean { return this.value !== null; }
  /** Constant-time comparison (equal-length buffers; the length of a token is public). */
  matches(candidate: string | undefined): boolean {
    if (this.value === null || typeof candidate !== "string") return false;
    const a = Buffer.from(this.value, "utf8"), b = Buffer.from(candidate, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }
  /** Forgets the token and deletes the file. */
  clear(): void {
    this.value = null;
    try { unlinkSync(this.path); } catch { /* not there */ }
  }

  /** The stored token, or null if the file is missing, malformed, not a regular file we own, or readable by others. */
  private read(): string | null {
    let fd: number;
    try { fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > 256 || st.uid !== process.getuid!() || (st.mode & 0o077) !== 0) return null;
      const buf = Buffer.alloc(st.size);
      readSync(fd, buf, 0, st.size, 0);
      const text = buf.toString("utf8").trim();
      return WELL_FORMED.test(text) ? text : null;
    } finally { closeSync(fd); }
  }
  private generate(): string {
    const token = b64u(randomBytes(32));
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    try { unlinkSync(tmp); } catch { /* none left over */ }
    // O_EXCL | O_NOFOLLOW: a planted file or symlink at the temp name is an error, never followed. The rename then replaces
    // whatever sits at the final name (a symlink is replaced, not written through).
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, token + "\n"); } finally { closeSync(fd); }
    renameSync(tmp, this.path);
    return token;
  }
}

/** The server's token, at <state>/setup-token. server.ts starts it; tests build their own instances over temp dirs. */
export const defaultSetupToken = new SetupToken(paths.setupToken);
