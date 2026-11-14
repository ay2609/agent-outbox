// Passkey registration and login, owner sessions, login rate limiting and the pin-file writer.
//
// Two passkey purposes (CONTRACTS v2 item 1): `login` (signs in, shown by iOS as "Sign in to Outbox") and `approve`
// (signs approvals, shown as "APPROVE SENDING (Outbox)"). Login and reauth only ever accept login keys; approvals only
// approve keys; the pin file lists approve keys only. So a login assertion harvested from a tampered dashboard can never
// satisfy the executor, and an approval sheet during a login is recognisable on the system's own Touch ID prompt.
//
// Registration rules:
//  - no session ("open"): purpose login needs zero login keys; purpose approve needs zero approve keys AND no login key.
//    The count check and the insert happen in ONE immediate transaction (two first registrations can't both win).
//  - session + fresh reauth ("additional"): any purpose.
//  - session only ("setup"): the first approve key, right after the login key was enrolled (session < 30 minutes old).
// P-256 (ES256, COSE alg -7) only, because the Swift executor verifies with P-256. We store both the COSE key (for
// @simplewebauthn) and the 65-byte x963 key (for the pin file).
import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { cose, decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";

const COSEKEYS = cose.COSEKEYS;
import { newId, nowIso } from "../db";
import { audit } from "../core/store";
import { DEFAULT_PIN_POLICY, type PasskeyPurpose, type PinFile, type PinPolicy } from "../core/types";
import type { OwnerConfig } from "./config";
import { b64u, fromB64u, randomToken, sha256Hex } from "./b64";
import { ApiError, badRequest, unauthorized } from "./errors";

export interface PasskeyRow {
  credential_id: string; public_key_cose_b64: string; public_key_x963_b64: string; counter: number;
  transports_json: string; label: string; purpose: PasskeyPurpose; user_handle: string; created_at: string;
}

export const PURPOSE_USER: Record<PasskeyPurpose, string> = { login: "Sign in to Outbox", approve: "APPROVE SENDING (Outbox)" };

export const passkeyCount = (db: Database, purpose?: PasskeyPurpose): number =>
  purpose
    ? db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM passkeys WHERE purpose = ?").get(purpose)?.n ?? 0
    : db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM passkeys").get()?.n ?? 0;
export const listPasskeys = (db: Database, purpose?: PasskeyPurpose): PasskeyRow[] =>
  purpose
    ? db.query<PasskeyRow, [string]>("SELECT * FROM passkeys WHERE purpose = ? ORDER BY created_at, credential_id").all(purpose)
    : db.query<PasskeyRow, []>("SELECT * FROM passkeys ORDER BY created_at, credential_id").all();

// ---------- COSE -> x963 ----------
/** COSE EC2 P-256 key (CBOR) -> 65-byte uncompressed point 0x04 || x || y. Throws for anything but ES256 / P-256. */
export function coseToX963(coseKey: Uint8Array<ArrayBuffer>): Buffer {
  const k = decodeCredentialPublicKey(coseKey) as Map<number, unknown>;
  const kty = k.get(COSEKEYS.kty), alg = k.get(COSEKEYS.alg), crv = k.get(COSEKEYS.crv);
  const x = k.get(COSEKEYS.x), y = k.get(COSEKEYS.y);
  if (kty !== 2 || alg !== -7 || crv !== 1) throw new Error("Only ES256 (P-256) passkeys are supported.");
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) {
    throw new Error("Malformed P-256 public key.");
  }
  return Buffer.concat([Buffer.from([0x04]), x, y]);
}

// ---------- pin policy (the user's choice; takes effect at once in simple mode, and in hardened mode only once the harden command is re-run) ----------
/** Reads a pin policy. Extra fields (the old pacing limits in already-installed pins) are ignored; only live_allowed and
 *  (v4) contacts_live_allowed count. A pin without contacts_live_allowed is valid and means "contacts stay dry". */
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
/** v2 pin: APPROVE keys only, plus the policy floors and ceilings the executor enforces. */
export function buildPinFile(cfg: OwnerConfig, db: Database): PinFile {
  return {
    v: 2, rp_id: cfg.rpId, origin: cfg.origin,
    keys: listPasskeys(db, "approve").map((p) => ({ credential_id: p.credential_id, x963: p.public_key_x963_b64, label: p.label })),
    policy: getPinPolicy(db),
  };
}
/** The exact bytes the dashboard writes to the user pin (and the harden command installs), built from the database. */
export const pinText = (cfg: OwnerConfig, db: Database): string => JSON.stringify(buildPinFile(cfg, db), null, 2) + "\n";
/** Owner-only (0600), written to a temp file and renamed over the old one. */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
/** Called after any registration or policy change. Always writes the user pin (<state>/passkeys.json, 0600, atomic): in simple
 *  mode the sender trusts it directly; in hardened mode it is the candidate the harden command installs. Nothing is written
 *  while there is no approve key (an empty pin is refused by the executor). */
export function writePinFiles(cfg: OwnerConfig, db: Database): PinFile {
  const pin = buildPinFile(cfg, db);
  if (pin.keys.length === 0) return pin;
  writeAtomic(cfg.userPinFile, pinText(cfg, db));
  return pin;
}
export function userPinSha256(cfg: OwnerConfig): string | null {
  try { return existsSync(cfg.userPinFile) ? sha256Hex(readFileSync(cfg.userPinFile)) : null; } catch { return null; }
}
const shq = (s: string): string => (/^[A-Za-z0-9_./:@+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** The harden command, one line for Terminal: sha256-check the user pin, install it root-owned at the root pin path (the
 *  sender then trusts only that file), then print what is installed (credential ids and labels) so it can be compared with
 *  the dashboard. Null until the user pin exists. Run it again after any key or policy change.
 *  With `db`, the checksum is of the pin the dashboard builds from its own keys and policy, not of whatever the file holds
 *  now: a user pin edited outside the dashboard then fails the check and nothing is installed. */
export function installCommand(cfg: OwnerConfig, db?: Database): string | null {
  if (!userPinSha256(cfg)) return null;
  const sha = db ? sha256Hex(Buffer.from(pinText(cfg, db), "utf8")) : userPinSha256(cfg)!;
  const src = cfg.userPinFile, dest = cfg.rootPinFile;
  return `echo '${sha}  ${src.replace(/'/g, `'\\''`)}' | shasum -a 256 -c - && sudo install -d -o root -g wheel -m 755 ${shq(dirname(dest))} && ` +
    `sudo install -o root -g wheel -m 444 ${shq(src)} ${shq(dest)} && plutil -p ${shq(dest)}`;
}

// ---------- challenges ----------
function purgeChallenges(db: Database): void {
  db.query("DELETE FROM webauthn_challenges WHERE expires_at < ?").run(nowIso());
}
export function storeChallenge(cfg: OwnerConfig, db: Database, row: {
  purpose: "register" | "login" | "approve"; challenge: string; approval_id?: string | null; manifest?: string | null; batch_id?: string | null;
}): string {
  purgeChallenges(db);
  const id = newId();
  db.query("INSERT INTO webauthn_challenges(id, purpose, challenge, approval_id, manifest, batch_id, expires_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, row.purpose, row.challenge, row.approval_id ?? null, row.manifest ?? null, row.batch_id ?? null,
      new Date(Date.now() + cfg.challengeTtlMs).toISOString());
  return id;
}
export interface ChallengeRow {
  id: string; purpose: string; challenge: string; approval_id: string | null; manifest: string | null; batch_id: string | null; expires_at: string;
}
/** Fetches AND deletes in one IMMEDIATE transaction: a challenge can be used once, whether or not the attempt then succeeds. */
export function takeChallenge(db: Database, id: string, purpose: "register" | "login" | "approve"): ChallengeRow {
  const row = db.transaction(() => {
    const r = db.query<ChallengeRow, [string]>("SELECT * FROM webauthn_challenges WHERE id = ?").get(id);
    if (r) db.query("DELETE FROM webauthn_challenges WHERE id = ?").run(id);
    return r;
  }).immediate();
  if (!row || row.purpose !== purpose) throw new ApiError(400, "challenge_invalid", "That request is unknown or was already used. Start again.");
  if (row.expires_at < nowIso()) throw new ApiError(400, "challenge_expired", "That request expired (5 minutes). Start again.");
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
/** One limiter per (route, session). Every request reaches us from 127.0.0.1, so a global limiter would let a local
 *  agent spamming bad sign-in assertions lock the owner out of approving. Requests without a valid session share "anon". */
export class LimiterSet {
  private m = new Map<string, FailureLimiter>();
  constructor(private max: number, private windowMs: number) {}
  for(route: string, sessionToken?: string): FailureLimiter {
    if (this.m.size > 500) for (const [k, v] of this.m) if (v.idle) this.m.delete(k);
    const key = `${route}|${sessionToken ? sha256Hex(sessionToken).slice(0, 24) : "anon"}`;
    let l = this.m.get(key);
    if (!l) { l = new FailureLimiter(this.max, this.windowMs); this.m.set(key, l); }
    return l;
  }
}

// ---------- registration ----------
export type RegisterKind = "open" | "setup" | "additional";
interface RegisterMeta { kind: RegisterKind; purpose: PasskeyPurpose; label: string; user_handle: string }

/** The lock. Throws unless a registration of this kind and purpose is allowed right now. Called at options time and
 *  again, inside the insert transaction, at verify time. */
export function registerGate(db: Database, kind: RegisterKind, purpose: PasskeyPurpose): void {
  const sameCount = passkeyCount(db, purpose), loginCount = passkeyCount(db, "login");
  let ok: boolean;
  if (kind === "open") ok = purpose === "login" ? sameCount === 0 : sameCount === 0 && loginCount === 0;
  else if (kind === "setup") ok = purpose === "approve" && sameCount === 0 && loginCount > 0;
  else ok = true;
  if (!ok) {
    throw new ApiError(403, "registration_locked", kind === "open"
      ? "A passkey is already registered. Sign in to add another."
      : "That key was already set up.");
  }
}

export async function registerOptions(cfg: OwnerConfig, db: Database, o: { label: string; purpose: PasskeyPurpose; kind: RegisterKind }) {
  registerGate(db, o.kind, o.purpose);
  const same = listPasskeys(db, o.purpose);
  // One user.id per purpose: authenticators replace a resident credential with the same rp + user.id, so the two
  // purposes must differ. Extra keys of one purpose (another phone) share their purpose's id.
  const user_handle = same[0]?.user_handle || b64u(Buffer.from(crypto.getRandomValues(new Uint8Array(32))));
  const options = await generateRegistrationOptions({
    rpName: "Agent Outbox", rpID: cfg.rpId, userID: fromB64u(user_handle),
    userName: PURPOSE_USER[o.purpose], userDisplayName: PURPOSE_USER[o.purpose],
    attestationType: "none", timeout: 120_000,
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    supportedAlgorithmIDs: [-7],
    // Only same-purpose keys are excluded: excluding the login key would stop one phone from also holding the approve key.
    excludeCredentials: same.map((p) => ({ id: p.credential_id, transports: JSON.parse(p.transports_json) })),
  });
  const meta: RegisterMeta = { kind: o.kind, purpose: o.purpose, label: o.label, user_handle };
  const challenge_id = storeChallenge(cfg, db, { purpose: "register", challenge: options.challenge, manifest: JSON.stringify(meta) });
  return { challenge_id, options, purpose: o.purpose };
}

export async function registerVerify(cfg: OwnerConfig, db: Database, limiter: FailureLimiter, args: {
  challenge_id: string; response: RegistrationResponseJSON; sessionOk: boolean; label?: string;
}): Promise<{ passkey: Omit<PasskeyRow, "public_key_cose_b64">; first: boolean; purpose: PasskeyPurpose; pin: PinFile }> {
  limiter.check();
  const ch = takeChallenge(db, args.challenge_id, "register");
  const meta = JSON.parse(ch.manifest ?? "{}") as Partial<RegisterMeta>;
  const purpose: PasskeyPurpose = meta.purpose === "login" ? "login" : "approve";
  const kind: RegisterKind = meta.kind === "additional" || meta.kind === "setup" ? meta.kind : "open";
  if (kind !== "open" && !args.sessionOk) throw new ApiError(403, "registration_locked", "Sign in to add another passkey.");
  registerGate(db, kind, purpose); // early, so a stale challenge fails before any crypto
  let v;
  try {
    v = await verifyRegistrationResponse({
      response: args.response, expectedChallenge: ch.challenge, expectedOrigin: cfg.origin, expectedRPID: cfg.rpId,
      requireUserVerification: true, supportedAlgorithmIDs: [-7],
    });
  } catch (e) {
    limiter.fail();
    throw new ApiError(400, "registration_failed", `Passkey registration failed: ${(e as Error).message}`);
  }
  if (!v.verified || !v.registrationInfo) { limiter.fail(); throw new ApiError(400, "registration_failed", "Passkey registration failed."); }
  const { credential } = v.registrationInfo;
  let x963: Buffer;
  try { x963 = coseToX963(credential.publicKey); } catch (e) { throw badRequest((e as Error).message); }
  const t = nowIso();
  // The count check and the insert are ONE immediate transaction: two simultaneous first registrations can't both pass.
  const { row, first } = db.transaction(() => {
    registerGate(db, kind, purpose);
    const n = passkeyCount(db, purpose);
    const label = (args.label ?? meta.label ?? "").trim().slice(0, 60) || (purpose === "login" ? `Sign-in key ${n + 1}` : `Approval key ${n + 1}`);
    const row: PasskeyRow = {
      credential_id: credential.id, public_key_cose_b64: b64u(credential.publicKey), public_key_x963_b64: b64u(x963),
      counter: credential.counter, transports_json: JSON.stringify(credential.transports ?? args.response.response.transports ?? []),
      label, purpose, user_handle: meta.user_handle ?? "", created_at: t,
    };
    try {
      db.query(`INSERT INTO passkeys(credential_id, public_key_cose_b64, public_key_x963_b64, counter, transports_json, label, purpose, user_handle, created_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(row.credential_id, row.public_key_cose_b64, row.public_key_x963_b64, row.counter, row.transports_json, row.label, row.purpose, row.user_handle, row.created_at);
    } catch { throw new ApiError(409, "duplicate_credential", "That passkey is already registered."); }
    audit(db, "owner", "passkey.register", row.credential_id, { label, purpose, first: n === 0 });
    return { row, first: n === 0 };
  }).immediate();
  const pin = writePinFiles(cfg, db);
  const { public_key_cose_b64: _omit, ...pub } = row;
  return { passkey: pub, first, purpose, pin };
}

// ---------- assertions (login, reauth) ----------
export async function loginOptions(cfg: OwnerConfig, db: Database) {
  const keys = listPasskeys(db, "login");
  if (keys.length === 0) throw new ApiError(409, "no_passkeys", "No sign-in passkey is registered yet.");
  const options = await generateAuthenticationOptions({
    rpID: cfg.rpId, userVerification: "required", timeout: 120_000,
    allowCredentials: keys.map((p) => ({ id: p.credential_id, transports: JSON.parse(p.transports_json) })),
  });
  const challenge_id = storeChallenge(cfg, db, { purpose: "login", challenge: options.challenge });
  return { challenge_id, options };
}

/** Verifies a login-purpose assertion (single-use challenge, UV required, LOGIN key only). Returns the credential id that signed it. */
export async function verifyLoginAssertion(cfg: OwnerConfig, db: Database, limiter: FailureLimiter, challenge_id: string,
  response: AuthenticationResponseJSON): Promise<string> {
  limiter.check();
  const ch = takeChallenge(db, challenge_id, "login");
  const pk = db.query<PasskeyRow, [string]>("SELECT * FROM passkeys WHERE credential_id = ?").get(response.id);
  if (!pk) { limiter.fail(); throw unauthorized("That passkey isn't registered here."); }
  if (pk.purpose !== "login") { limiter.fail(); throw unauthorized("That passkey can't be used to sign in."); }
  let counter: number;
  try {
    const v = await verifyAuthenticationResponse({
      response, expectedChallenge: ch.challenge, expectedOrigin: cfg.origin, expectedRPID: cfg.rpId, requireUserVerification: true,
      credential: { id: pk.credential_id, publicKey: fromB64u(pk.public_key_cose_b64), counter: pk.counter, transports: JSON.parse(pk.transports_json) },
    });
    if (!v.verified) throw new Error("not verified");
    counter = v.authenticationInfo.newCounter;
  } catch {
    limiter.fail();
    throw unauthorized("Passkey check failed.");
  }
  db.transaction(() => db.query("UPDATE passkeys SET counter = ? WHERE credential_id = ?").run(counter, pk.credential_id)).immediate();
  limiter.reset();
  return pk.credential_id;
}

// ---------- sessions ----------
export function createSession(cfg: OwnerConfig, db: Database, userAgent: string): { token: string; expires: Date } {
  const token = randomToken();
  const expires = new Date(Date.now() + cfg.sessionTtlMs);
  db.query("DELETE FROM sessions WHERE expires_at < ?").run(nowIso());
  db.query("INSERT INTO sessions(token_sha256, created_at, expires_at, user_agent) VALUES (?,?,?,?)")
    .run(sha256Hex(token), nowIso(), expires.toISOString(), userAgent.slice(0, 200));
  return { token, expires };
}
export function sessionValid(db: Database, token: string | undefined): boolean {
  if (!token || token.length > 200) return false;
  const r = db.query<{ expires_at: string }, [string]>("SELECT expires_at FROM sessions WHERE token_sha256 = ?").get(sha256Hex(token));
  return !!r && r.expires_at > nowIso();
}
/** Age of a valid session in ms, or null. Used to allow the setup-time approve-key registration without a second Touch ID. */
export function sessionAgeMs(db: Database, token: string | undefined): number | null {
  if (!sessionValid(db, token)) return null;
  const r = db.query<{ created_at: string }, [string]>("SELECT created_at FROM sessions WHERE token_sha256 = ?").get(sha256Hex(token!));
  return r ? Date.now() - Date.parse(r.created_at) : null;
}
export function destroySession(db: Database, token: string | undefined): void {
  if (token) db.query("DELETE FROM sessions WHERE token_sha256 = ?").run(sha256Hex(token));
}
