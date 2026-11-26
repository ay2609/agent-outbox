// Owner-side state that is not a route: the Secure Enclave key table, first-run state, the pin policy, the pin-file writer,
// single-use owner challenges and the failure limiter. (Browser passkeys, sessions and WebAuthn are gone; the legacy tables stay in
// the schema, unused. The ONLY read of the legacy `passkeys` table is the `setup_done` seed in schema.sql.)
import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { newId, nowIso } from "../db";
import { audit } from "../core/store";
import { DEFAULT_PIN_POLICY, type PinFile, type PinPolicy } from "../core/types";
import type { OwnerConfig } from "./config";
import { sha256Hex } from "./b64";
import { ApiError } from "./errors";

// ---------- native (Secure Enclave) keys: public halves held by Agent Outbox.app ----------
export interface NativeKeyRow {
  key_id: string; public_key_x963_b64: string; label: string; status: "pending" | "active" | "revoked";
  enroll_challenge: string; enroll_expires_at: string; created_at: string; activated_at: string | null; revoked_at: string | null;
}
export const listNativeKeys = (db: Database, status?: NativeKeyRow["status"]): NativeKeyRow[] =>
  status
    ? db.query<NativeKeyRow, [string]>("SELECT * FROM native_keys WHERE status = ? ORDER BY activated_at, key_id").all(status)
    : db.query<NativeKeyRow, []>("SELECT * FROM native_keys ORDER BY created_at, key_id").all();
export const nativeKeyCount = (db: Database, status: NativeKeyRow["status"] = "active"): number =>
  db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM native_keys WHERE status = ?").get(status)?.n ?? 0;

/** First run is a stored fact (`settings.setup_done`), not a key count: revoking every key later does not reopen it. */
export const firstRun = (db: Database): boolean =>
  (db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'setup_done'").get()?.value ?? "0") === "0";
export function markSetupDone(db: Database): void {
  db.query("INSERT INTO settings(key, value) VALUES ('setup_done','1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
}

// ---------- pin policy (the user's choice; takes effect at once in simple mode, and in hardened mode only once the harden command is re-run) ----------
/** Reads a stored pin policy. Extra fields are ignored; only live_allowed and contacts_live_allowed count. A stored policy without
 *  contacts_live_allowed is valid and means "contacts stay dry". */
export function normalizePolicy(p: unknown): PinPolicy | null {
  if (!p || typeof p !== "object") return null;
  const r = p as Record<string, unknown>;
  if (typeof r.live_allowed !== "boolean") return null;
  return typeof r.contacts_live_allowed === "boolean"
    ? { live_allowed: r.live_allowed, contacts_live_allowed: r.contacts_live_allowed }
    : { live_allowed: r.live_allowed };
}
export function getPinPolicy(db: Database): PinPolicy {
  const r = db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'pin_policy'").get();
  if (!r) return { ...DEFAULT_PIN_POLICY };
  try { return normalizePolicy(JSON.parse(r.value)) ?? { ...DEFAULT_PIN_POLICY }; } catch { return { ...DEFAULT_PIN_POLICY }; }
}
export function setPinPolicy(db: Database, p: PinPolicy, actor: string): void {
  db.query("INSERT INTO settings(key, value) VALUES ('pin_policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(p));
  audit(db, actor, "pin_policy.set", null, p);
}

// ---------- pin files ----------
/** Pin v4: active Secure Enclave keys by activation time then key id (may be none), and the policy with both booleans. */
export function buildPinFile(db: Database): PinFile {
  const policy = getPinPolicy(db);
  return {
    v: 4,
    keys: listNativeKeys(db, "active").map((k) => ({ kind: "secure-enclave" as const, credential_id: k.key_id, x963: k.public_key_x963_b64, label: k.label })),
    policy: { live_allowed: policy.live_allowed, contacts_live_allowed: policy.contacts_live_allowed === true },
  };
}
/** The exact bytes the server writes to the user pin (and the harden command installs), built from the database. */
export const pinText = (db: Database): string => JSON.stringify(buildPinFile(db), null, 2) + "\n";
/** Owner-only (0600), written to a temp file and renamed over the old one. */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
/** Always writes the user pin (<state>/passkeys.json, 0600, atomic), even with no keys, and never deletes it: in simple mode the
 *  sender trusts it directly; in hardened mode it is the candidate the harden command installs. An empty `keys` pin makes the
 *  executor refuse everything. Called at every start (when the bytes differ) and after every activation, revocation and policy change. */
export function writePinFiles(cfg: OwnerConfig, db: Database): PinFile {
  const pin = buildPinFile(db);
  writeAtomic(cfg.userPinFile, pinText(db));
  return pin;
}
export function userPinSha256(cfg: OwnerConfig): string | null {
  try { return existsSync(cfg.userPinFile) ? sha256Hex(readFileSync(cfg.userPinFile)) : null; } catch { return null; }
}
const shq = (s: string): string => (/^[A-Za-z0-9_./:@+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** The harden command, one line for Terminal: sha256-check the user pin, install it root-owned at the root pin path (the
 *  sender then trusts only that file), then print what is installed so it can be compared with the app. Null until the user pin
 *  exists (it always does after the first start). Run it again after any key or policy change.
 *  With `db`, the checksum is of the pin built from the database, not of whatever the file holds now: a user pin edited
 *  outside the app then fails the check and nothing is installed. */
export function installCommand(cfg: OwnerConfig, db?: Database): string | null {
  if (!userPinSha256(cfg)) return null;
  const sha = db ? sha256Hex(Buffer.from(pinText(db), "utf8")) : userPinSha256(cfg)!;
  const src = cfg.userPinFile, dest = cfg.rootPinFile;
  return `echo '${sha}  ${src.replace(/'/g, `'\\''`)}' | shasum -a 256 -c - && sudo install -d -o root -g wheel -m 755 ${shq(dirname(dest))} && ` +
    `sudo install -o root -g wheel -m 444 ${shq(src)} ${shq(dest)} && plutil -p ${shq(dest)}`;
}

// ---------- owner challenges (schema v7): approvals and Touch ID confirmations, single use ----------
export interface OwnerChallengeRow {
  id: string; kind: "send" | "contacts" | "reauth"; action: string | null; target: string | null;
  approval_id: string | null; manifest: string | null; challenge: string; expires_at: string;
}
export function storeOwnerChallenge(cfg: Pick<OwnerConfig, "challengeTtlMs">, db: Database, row: {
  kind: OwnerChallengeRow["kind"]; action?: string | null; target?: string | null; approval_id?: string | null; manifest?: string | null; challenge: string;
}): string {
  db.query("DELETE FROM owner_challenges WHERE expires_at < ?").run(nowIso());
  const id = newId();
  db.query("INSERT INTO owner_challenges(id, kind, action, target, approval_id, manifest, challenge, expires_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, row.kind, row.action ?? null, row.target ?? null, row.approval_id ?? null, row.manifest ?? null, row.challenge,
      new Date(Date.now() + cfg.challengeTtlMs).toISOString());
  return id;
}
/** Fetches AND deletes in one IMMEDIATE transaction: a challenge can be used once, whether or not the attempt then succeeds.
 *  Unknown, used, wrong kind/action/target, or older than its TTL: 400. `expect.target` null means "must have no target". */
export function takeOwnerChallenge(db: Database, id: string, expect: { kind: OwnerChallengeRow["kind"]; action?: string | null; target?: string | null }): OwnerChallengeRow {
  const row = db.transaction(() => {
    const r = db.query<OwnerChallengeRow, [string]>("SELECT * FROM owner_challenges WHERE id = ?").get(id);
    if (r) db.query("DELETE FROM owner_challenges WHERE id = ?").run(id);
    return r;
  }).immediate();
  if (!row) throw new ApiError(400, "challenge_invalid", "That request is unknown or was already used. Start again.");
  if (row.expires_at < nowIso()) throw new ApiError(400, "challenge_expired", "That request expired (5 minutes). Start again.");
  if (row.kind !== expect.kind) throw new ApiError(400, "challenge_invalid", "That request was made for something else.");
  if (expect.action !== undefined && row.action !== expect.action) throw new ApiError(400, "challenge_invalid", "That confirmation was made for something else.");
  if (expect.target !== undefined && row.target !== expect.target) throw new ApiError(400, "challenge_invalid", "That request belongs to something else.");
  return row;
}

// ---------- rate limit ----------
export class FailureLimiter {
  private fails: number[] = [];
  constructor(private max: number, private windowMs: number) {}
  private prune(): void { const cut = Date.now() - this.windowMs; this.fails = this.fails.filter((t) => t > cut); }
  check(): void {
    this.prune();
    if (this.fails.length >= this.max) {
      const retry = Math.max(1, Math.ceil((this.fails[0]! + this.windowMs - Date.now()) / 1000));
      throw new ApiError(429, "rate_limited", `Too many failed attempts. Try again in ${Math.ceil(retry / 60)} min.`, { retry_after_s: retry });
    }
  }
  fail(): void { this.prune(); this.fails.push(Date.now()); }
  reset(): void { this.fails = []; }
  get idle(): boolean { this.prune(); return this.fails.length === 0; }
}
/** One limiter per route (the owner is the only client, so there is no session to key on). */
export class LimiterSet {
  private m = new Map<string, FailureLimiter>();
  constructor(private max: number, private windowMs: number) {}
  for(route: string): FailureLimiter {
    let l = this.m.get(route);
    if (!l) { l = new FailureLimiter(this.max, this.windowMs); this.m.set(route, l); }
    return l;
  }
}
