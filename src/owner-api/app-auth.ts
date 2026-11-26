// The per-launch token of the app channel (local-docs/APP-SECURITY-C.md section 7). Agent Outbox.app generates 32 random
// bytes, passes them to `agent-outbox server --app-auth-fd N` on an inherited descriptor, and sends them back in the
// `X-Outbox-App` header over <state>/run/owner.sock. Only sha256(token) is kept, in memory: the token itself never reaches
// disk, env, argv, logs or TCP.
import { createHash, timingSafeEqual } from "node:crypto";

export const APP_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export class AppAuth {
  private hash: Buffer | null = null;
  /** Remembers sha256(token). Throws unless the token is 43 base64url characters. */
  set(token: string): void {
    if (!APP_TOKEN_RE.test(token)) throw new Error("app token must be 43 base64url characters");
    this.hash = createHash("sha256").update(token).digest();
  }
  /** True once a token was set (the app channel exists). */
  get active(): boolean { return this.hash !== null; }
  /** Constant-time comparison on the hashes (equal length, so no length leak). */
  matches(candidate: string | undefined | null): boolean {
    if (!this.hash || typeof candidate !== "string" || candidate.length > 200) return false;
    return timingSafeEqual(this.hash, createHash("sha256").update(candidate).digest());
  }
}

export const defaultAppAuth = new AppAuth();
