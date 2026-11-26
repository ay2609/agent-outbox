// Native approval: Secure Enclave keys held by Agent Outbox.app (SECURITY.md has the security model).
//
// Signature format: ECDSA P-256/SHA-256, DER, over
//   M = utf8("agent-outbox/se/v1") || 0x00 || utf8(TAG) || 0x00 || DIGEST     (DIGEST = 32 raw bytes)
//   send     sha256(manifest bytes)          contacts  sha256(manifest bytes)
//   reauth   sha256(challenge)               enroll    sha256(challenge || x963)
// The executor only ever checks send/contacts signatures, against keys in the PIN FILE. The server verifies everything here
// before it writes a row, but the server is not the security boundary: the executor's pin-file check is.
//
// Channels: the app talks over <state>/run/owner.sock ("app", per-launch token in X-Outbox-App), the browser over
// loopback TCP ("tcp"). App-only and tcp-only routes are enforced in index.ts's gate via isAppOnly / isTcpOnly.
import type { Context, Hono } from "hono";
import type { Database } from "bun:sqlite";
import { createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";
import { z } from "zod";
import { newId, nowIso } from "../db";
import { audit } from "../core/store";
import type { ContactManifest, Manifest } from "../core/types";
import type { OwnerConfig } from "./config";
import { ApiError, badRequest, conflict, forbidden, notFound } from "./errors";
import { b64u, fromB64u, isB64u, sha256Buf, sha256Hex } from "./b64";
import {
  type FailureLimiter, type NativeKeyRow, firstRun, listNativeKeys, nativeKeyCount, passkeyCount, sessionAgeMs, takeChallenge, verifyLoginAssertion,
  writePinFiles,
} from "./auth";
import { commitApproval, revokeApprovals } from "./approval";
import { commitContactApproval, revokeContactApprovals } from "./contact-approval";
import { RecoveryToken } from "./recovery";
import { effectiveNativeKeyIds } from "./status";
import { reauthSchema, readJson, readJsonOptional } from "./schemas";

// ---------- channels ----------
export type Channel = "tcp" | "app";
/** The channel a request arrived on. Set only by server.ts (`fetch(req, { channel })`); a request can't choose it. Anything else is tcp. */
export const channelOf = (c: Context): Channel => ((c.env as { channel?: unknown } | undefined)?.channel === "app" ? "app" : "tcp");

const APP_ONLY: [string, RegExp][] = [
  ["POST", /^\/api\/batches\/[^/]+\/approve\/se-verify$/],
  ["POST", /^\/api\/contact-changes\/[^/]+\/approve\/se-verify$/],
  ["POST", /^\/api\/native-keys\/enroll\/(options|verify)$/],
  ["POST", /^\/api\/native-keys\/reauth\/options$/],
  ["POST", /^\/api\/app\/browser-link$/],
];
const TCP_ONLY: [string, RegExp][] = [
  ["POST", /^\/api\/native-keys\/enroll\/[^/]+\/confirm$/],
  ["POST", /^\/api\/auth\/link$/],
];
export const isAppOnly = (method: string, path: string): boolean => APP_ONLY.some(([m, re]) => m === method && re.test(path));
export const isTcpOnly = (method: string, path: string): boolean => TCP_ONLY.some(([m, re]) => m === method && re.test(path));

// ---------- the signed message ----------
export const SE_PREFIX = Buffer.from("agent-outbox/se/v1", "utf8");
export type SeTag = "send" | "contacts" | "reauth" | "enroll";
/** M(tag, digest): exact bytes the Secure Enclave signs and the executor re-derives. `digest` must be 32 raw bytes. */
export function seMessage(tag: SeTag, digest: Uint8Array): Buffer {
  if (digest.length !== 32) throw new Error("digest must be 32 bytes");
  return Buffer.concat([SE_PREFIX, Buffer.from([0]), Buffer.from(tag, "utf8"), Buffer.from([0]), Buffer.from(digest)]);
}

/** A 65-byte uncompressed P-256 point (0x04 || x || y) that is really on the curve; otherwise null. */
export function parseX963(b64: string): Buffer | null {
  if (!isB64u(b64) || b64.length !== 87) return null;
  const raw = Buffer.from(b64, "base64url");
  if (raw.length !== 65 || raw[0] !== 0x04) return null;
  try { publicKeyOf(raw); } catch { return null; }
  return raw;
}
function publicKeyOf(x963: Buffer) {
  return createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: x963.subarray(1, 33).toString("base64url"), y: x963.subarray(33, 65).toString("base64url") } });
}
/** ECDSA P-256/SHA-256 over `message`, DER signature. Never throws: anything malformed is just false. */
export function verifySe(x963: Buffer, message: Buffer, sigDer: Uint8Array): boolean {
  try { return cryptoVerify("sha256", message, { key: publicKeyOf(x963), dsaEncoding: "der" }, Buffer.from(sigDer)); } catch { return false; }
}
export const nativeKeyId = (x963: Buffer): string => b64u(sha256Buf(x963));
/** First 10 bytes of sha256(x963) as 5 groups of 4 uppercase hex digits, e.g. 0F5A-1C22-9B07-44DE-A3F1. */
export function fingerprint(x963: Buffer): string {
  return sha256Buf(x963).subarray(0, 10).toString("hex").toUpperCase().match(/.{4}/g)!.join("-");
}

// ---------- reauth by a Secure Enclave key ----------
export const RE_AUTH_ACTIONS = ["mode_live", "policy_live", "passkey_add", "native_key_add", "browser_link"] as const;
export type ReauthAction = (typeof RE_AUTH_ACTIONS)[number];
export const seReauthSchema = z.object({ challenge_id: z.string().min(1).max(100), key_id: z.string().min(1).max(100), signature: z.string().min(1).max(200) });
export type SeReauth = z.infer<typeof seReauthSchema>;
const NATIVE_CHALLENGE_TTL_MS = 5 * 60_000;

const activeKey = (db: Database, keyId: string): NativeKeyRow | null =>
  db.query<NativeKeyRow, [string]>("SELECT * FROM native_keys WHERE key_id = ? AND status = 'active'").get(keyId);

/** Verifies an `se_reauth` for `action`: single-use native challenge (consumed even when verification fails), an ACTIVE key, and a
 *  signature over M("reauth", sha256(challenge)). Throws 400/401. */
export function verifySeReauth(db: Database, limiter: FailureLimiter, r: SeReauth, action: ReauthAction): void {
  limiter.check();
  const row = db.transaction(() => {
    const x = db.query<{ id: string; key_id: string | null; action: string; challenge: string; expires_at: string }, [string]>("SELECT * FROM native_challenges WHERE id = ?").get(r.challenge_id);
    if (x) db.query("DELETE FROM native_challenges WHERE id = ?").run(r.challenge_id);
    return x;
  }).immediate();
  if (!row) throw new ApiError(400, "challenge_invalid", "That request is unknown or was already used. Start again.");
  if (row.expires_at < nowIso()) throw new ApiError(400, "challenge_expired", "That request expired (5 minutes). Start again.");
  if (row.action !== action) { limiter.fail(); throw new ApiError(400, "challenge_invalid", "That confirmation was made for something else."); }
  const key = activeKey(db, r.key_id);
  if (!key || (row.key_id && row.key_id !== r.key_id)) { limiter.fail(); throw new ApiError(401, "reauth_failed", "That key can't confirm this."); }
  if (!isB64u(r.signature)) throw badRequest("signature must be base64url.");
  const msg = seMessage("reauth", sha256Buf(fromB64u(row.challenge)));
  if (!verifySe(Buffer.from(key.public_key_x963_b64, "base64url"), msg, fromB64u(r.signature))) {
    limiter.fail();
    throw new ApiError(401, "reauth_failed", "The Touch ID confirmation didn't verify.");
  }
  limiter.reset();
}

/** The owner proof every sensitive route asks for today: a fresh sign-in passkey assertion (`reauth`) OR, from the app, a Secure
 *  Enclave `se_reauth` for the same action. */
export async function requireReauth(c: Context, cfg: OwnerConfig, limiterFor: (c: Context, route: string) => FailureLimiter,
  body: { reauth?: z.infer<typeof reauthSchema>; se_reauth?: SeReauth }, action: ReauthAction, missingMsg: string): Promise<void> {
  if (body.se_reauth) {
    if (channelOf(c) !== "app") throw forbidden("app_only", "A Touch ID confirmation from the app is only accepted over the app channel.");
    verifySeReauth(cfg.db(), limiterFor(c, "se_reauth"), body.se_reauth, action);
    return;
  }
  if (!body.reauth) throw new ApiError(403, "reauth_required", missingMsg);
  await verifyLoginAssertion(cfg, cfg.db(), limiterFor(c, "reauth"), body.reauth.challenge_id, body.reauth.response as any);
}

// ---------- link sessions (browser fallback login from the app) ----------
const LINK_TTL_MS = 5 * 60_000;
/** Is this session one created from a browser link, and younger than `maxAgeMs`? */
export function isLinkSession(db: Database, token: string | undefined, maxAgeMs: number): boolean {
  if (!token || sessionAgeMs(db, token) === null) return false;
  const r = db.query<{ created_at: string }, [string]>("SELECT created_at FROM session_links WHERE token_sha256 = ?").get(sha256Hex(token));
  return !!r && Date.now() - Date.parse(r.created_at) < maxAgeMs;
}

/** A link session made without an owner proof (the app channel alone: browser-link while a sign-in key exists) is worth a session,
 *  no more. It must not reach the "first approval key right after the sign-in key" shortcut unless that sign-in key was created in
 *  this same session (which needed the Touch ID confirmation browser-link asks for when no sign-in key exists). True = refuse it. */
export function linkSessionWithoutProof(db: Database, token: string | undefined): boolean {
  if (!token) return false;
  const r = db.query<{ created_at: string }, [string]>("SELECT created_at FROM session_links WHERE token_sha256 = ?").get(sha256Hex(token));
  if (!r) return false;
  const n = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM passkeys WHERE purpose = 'login' AND created_at >= ?").get(r.created_at)?.n ?? 0;
  return n === 0;
}

// ---------- se-verify (shared checks) ----------
const seVerifyBody = z.object({ challenge_id: z.string().min(1).max(100), key_id: z.string().min(1).max(100), signature: z.string().min(1).max(200) });

/** Takes the approval challenge (single use), checks it belongs to `ownerId` (batch or set), and verifies the key's signature over
 *  M(tag, sha256(manifest bytes)). Returns the exact manifest bytes. */
function checkSeApproval(db: Database, limiter: FailureLimiter, ownerId: string, body: z.infer<typeof seVerifyBody>, tag: "send" | "contacts"): { bytes: string; key: NativeKeyRow } {
  limiter.check();
  const ch = takeChallenge(db, body.challenge_id, "approve"); // single use (IMMEDIATE tx): gone from here on, even if verification fails
  if (ch.batch_id !== ownerId || !ch.manifest || !ch.approval_id) throw new ApiError(400, "challenge_invalid", "That request belongs to something else.");
  const digest = sha256Buf(ch.manifest);
  if (b64u(digest) !== ch.challenge) throw new ApiError(500, "internal", "Stored approval is inconsistent.");
  const key = activeKey(db, body.key_id);
  if (!key) { limiter.fail(); throw new ApiError(401, "approval_failed", "That key isn't active here."); }
  if (!isB64u(body.signature)) throw badRequest("signature must be base64url.");
  if (!verifySe(Buffer.from(key.public_key_x963_b64, "base64url"), seMessage(tag, digest), fromB64u(body.signature))) {
    limiter.fail();
    throw new ApiError(401, "approval_failed", "The Touch ID signature didn't verify.");
  }
  return { bytes: ch.manifest, key };
}

// ---------- enrollment ----------
const ENROLL_TTL_MS = 10 * 60_000;
const purgeNative = (db: Database): void => {
  const t = nowIso();
  db.query("DELETE FROM native_keys WHERE status = 'pending' AND enroll_expires_at < ?").run(t);
  db.query("DELETE FROM native_challenges WHERE expires_at < ?").run(t);
  db.query("DELETE FROM link_codes WHERE expires_at < ?").run(t);
  db.query("DELETE FROM session_links WHERE created_at < ?").run(new Date(Date.now() - 24 * 3600_000).toISOString());
};

/** Marks a pending key active (inside the caller's transaction) and audits it. */
function activatePending(db: Database, keyId: string, how: string): void {
  const t = nowIso();
  const r = db.query("UPDATE native_keys SET status = 'active', activated_at = ? WHERE key_id = ? AND status = 'pending' AND enroll_expires_at > ?").run(t, keyId, t);
  if (!r.changes) throw new ApiError(400, "enroll_expired", "That setup expired (10 minutes). Start again in the app.");
  audit(db, "owner", "native_key.activate", keyId, { how });
}
/** After an activation: setup counts as done (the first-run token goes), and the pin is rewritten with the new key. */
function afterActivation(cfg: OwnerConfig): void {
  cfg.setupToken.clear();
  writePinFiles(cfg, cfg.db());
}

export interface NativeKeyView { key_id: string; label: string; status: string; created_at: string; activated_at: string | null; revoked_at: string | null; in_effective_pin: boolean; fingerprint: string }

export function registerNativeApi(app: Hono, cfg: OwnerConfig, limiterFor: (c: Context, route: string) => FailureLimiter, deps: { startSession: (c: Context) => string }): void {
  const db = (): Database => cfg.db();
  const recovery = new RecoveryToken(cfg.recoveryTokenFile);
  const tx = <T>(fn: () => T): T => db().transaction(fn).immediate();

  // ---- Secure Enclave approval: send ----
  app.post("/api/batches/:id/approve/se-verify", async (c) => {
    const batchId = c.req.param("id");
    const body = await readJson(c, seVerifyBody);
    const { bytes, key } = checkSeApproval(db(), limiterFor(c, "approve"), batchId, body, "send");
    const manifest = JSON.parse(bytes) as Manifest;
    // A contacts challenge shares purpose 'approve'; its manifest has a `kind`. It can never be finished as a send approval.
    if ((manifest as { kind?: unknown }).kind !== undefined || !Array.isArray(manifest.items)) throw new ApiError(400, "challenge_invalid", "That request isn't a message approval.");
    if (manifest.not_after <= nowIso()) throw new ApiError(400, "approval_expired", "This approval window already passed. Start again.");
    const result = commitApproval(db(), { manifest, bytes, batchId, credentialId: key.key_id, authData: "", clientData: "", signature: body.signature, signer: "secure-enclave" });
    limiterFor(c, "approve").reset();
    return c.json({ ok: true, ...result, batch: db().query("SELECT * FROM batches WHERE id = ?").get(batchId) });
  });

  // ---- Secure Enclave approval: contacts ----
  app.post("/api/contact-changes/:id/approve/se-verify", async (c) => {
    const setId = c.req.param("id");
    const body = await readJson(c, seVerifyBody);
    const { bytes, key } = checkSeApproval(db(), limiterFor(c, "approve"), setId, body, "contacts");
    const manifest = JSON.parse(bytes) as ContactManifest;
    if (manifest.kind !== "contacts" || manifest.v !== 1 || manifest.set_id !== setId || !Array.isArray(manifest.contact_items) || manifest.contact_items.length === 0) {
      throw new ApiError(400, "challenge_invalid", "That request isn't a contacts approval.");
    }
    if (manifest.not_after <= nowIso()) throw new ApiError(400, "approval_expired", "This approval window already passed. Start again.");
    const result = commitContactApproval(db(), { manifest, bytes, setId, credentialId: key.key_id, authData: "", clientData: "", signature: body.signature, signer: "secure-enclave" });
    limiterFor(c, "approve").reset();
    return c.json({ ok: true, ...result, set: db().query("SELECT * FROM contact_change_sets WHERE id = ?").get(setId) });
  });

  // ---- keys ----
  app.get("/api/native-keys", (c) => {
    purgeNative(db());
    const inPin = effectiveNativeKeyIds(cfg);
    return c.json({
      keys: listNativeKeys(db()).map((k): NativeKeyView => ({
        key_id: k.key_id, label: k.label, status: k.status, created_at: k.created_at, activated_at: k.activated_at, revoked_at: k.revoked_at,
        in_effective_pin: inPin.has(k.key_id), fingerprint: fingerprint(Buffer.from(k.public_key_x963_b64, "base64url")),
      })),
    });
  });

  app.post("/api/native-keys/enroll/options", async (c) => {
    const body = await readJson(c, z.object({ x963: z.string().min(1).max(200), label: z.string().max(60).optional() }).strict());
    limiterFor(c, "enroll").check();
    const x963 = parseX963(body.x963);
    if (!x963) throw badRequest("That isn't a P-256 public key.");
    purgeNative(db());
    const keyId = nativeKeyId(x963);
    const challenge = b64u(randomBytes(32));
    const t = nowIso();
    const expires = new Date(Date.now() + ENROLL_TTL_MS).toISOString();
    const label = (body.label ?? "").trim().slice(0, 60) || "This Mac (Touch ID)";
    try {
      db().query(`INSERT INTO native_keys(key_id, public_key_x963_b64, label, status, enroll_challenge, enroll_expires_at, created_at) VALUES (?,?,?,'pending',?,?,?)`)
        .run(keyId, b64u(x963), label, challenge, expires, t);
    } catch { throw conflict("key_exists", "That key is already set up (or revoked). Make a new key in the app."); }
    audit(db(), "owner", "native_key.enroll_options", keyId, { label });
    // What the app should try first. A recovery token the owner made in Terminal wins; then the first-run token; then an existing key's
    // confirmation; otherwise the browser (a sign-in passkey).
    const proof = recovery.active ? "recovery_token" : firstRun(db()) && cfg.setupToken.active ? "setup_token" : nativeKeyCount(db()) > 0 ? "se_reauth" : "browser";
    return c.json({ key_id: keyId, challenge, fingerprint: fingerprint(x963), expires_at: expires, proof });
  });

  app.post("/api/native-keys/enroll/verify", async (c) => {
    const body = await readJson(c, z.object({
      key_id: z.string().min(1).max(100), signature: z.string().min(1).max(200),
      setup_token: z.string().max(200).optional(), recovery_token: z.string().max(200).optional(), se_reauth: seReauthSchema.optional(),
    }).strict());
    const limiter = limiterFor(c, "enroll");
    limiter.check();
    purgeNative(db());
    const row = db().query<NativeKeyRow, [string]>("SELECT * FROM native_keys WHERE key_id = ? AND status = 'pending'").get(body.key_id);
    if (!row) throw new ApiError(400, "enroll_invalid", "That setup is unknown or expired. Start again in the app.");
    const x963 = Buffer.from(row.public_key_x963_b64, "base64url");
    // Possession + Touch ID proof: the new key signs M(enroll, sha256(challenge || x963)).
    const digest = sha256Buf(Buffer.concat([fromB64u(row.enroll_challenge), x963]));
    if (!isB64u(body.signature) || !verifySe(x963, seMessage("enroll", digest), fromB64u(body.signature))) {
      limiter.fail();
      throw new ApiError(401, "enroll_failed", "The new key's Touch ID proof didn't verify.");
    }
    const login = passkeyCount(db(), "login"), nativeActive = nativeKeyCount(db());
    let how: string | null = null;
    if (body.setup_token !== undefined) {
      if (!(login === 0 && nativeActive === 0)) { limiter.fail(); throw new ApiError(403, "setup_token_invalid", "First-run setup is already done."); }
      if (!cfg.setupToken.matches(body.setup_token)) { limiter.fail(); throw new ApiError(403, "setup_token_invalid", "That setup link isn't valid. Run `agent-outbox setup-link` for the current one."); }
      how = "setup_token";
    } else if (body.recovery_token !== undefined) {
      if (!recovery.matches(body.recovery_token)) { limiter.fail(); throw new ApiError(403, "recovery_token_invalid", "That recovery token isn't valid (it lasts 30 minutes and works once). Run `agent-outbox recover` again."); }
      how = "recovery_token";
    } else if (body.se_reauth) {
      verifySeReauth(db(), limiterFor(c, "se_reauth"), body.se_reauth, "native_key_add");
      how = "se_reauth";
    }
    if (how === null) {
      if (login > 0) {
        return c.json({ status: "awaiting_browser", confirm_url: `${cfg.origin}/#/native-enroll/${row.key_id}` });
      }
      throw new ApiError(403, nativeActive > 0 ? "reauth_required" : "setup_token_required",
        nativeActive > 0 ? "Confirm with an existing Touch ID key to add another." : "Open the setup link (agent-outbox setup-link) to set up the first key.");
    }
    // The proof counts once: a recovery token is consumed together with the activation, in one transaction (the file delete follows).
    tx(() => {
      // Re-check inside the lock: two simultaneous first enrolments must not both win with one setup token.
      if (how === "setup_token" && !(passkeyCount(db(), "login") === 0 && nativeKeyCount(db()) === 0)) throw new ApiError(403, "setup_token_invalid", "First-run setup is already done.");
      activatePending(db(), row.key_id, how!);
    });
    if (how === "recovery_token") recovery.consume();
    afterActivation(cfg);
    limiter.reset();
    return c.json({ status: "active" });
  });

  app.get("/api/native-keys/enroll/:key_id", (c) => {
    purgeNative(db());
    const row = db().query<NativeKeyRow, [string]>("SELECT * FROM native_keys WHERE key_id = ?").get(c.req.param("key_id"));
    if (!row) throw notFound("That setup is unknown or expired.");
    return c.json({ status: row.status, label: row.label, fingerprint: fingerprint(Buffer.from(row.public_key_x963_b64, "base64url")) });
  });

  // The browser confirms a pending key with a fresh LOGIN passkey assertion (approval keys never reauth).
  app.post("/api/native-keys/enroll/:key_id/confirm", async (c) => {
    const body = await readJson(c, z.object({ reauth: reauthSchema }).strict());
    purgeNative(db());
    const keyId = c.req.param("key_id");
    const row = db().query<NativeKeyRow, [string]>("SELECT * FROM native_keys WHERE key_id = ? AND status = 'pending'").get(keyId);
    if (!row) throw new ApiError(400, "enroll_invalid", "That setup is unknown or expired. Start again in the app.");
    await verifyLoginAssertion(cfg, db(), limiterFor(c, "reauth"), body.reauth.challenge_id, body.reauth.response as any);
    tx(() => activatePending(db(), keyId, "browser_reauth"));
    afterActivation(cfg);
    return c.json({ status: "active" });
  });

  // Revoking only removes power (like Stop), so it needs no proof: session or app channel is enough.
  app.post("/api/native-keys/:key_id/revoke", async (c) => {
    await readJsonOptional(c, z.object({}).strict());
    const keyId = c.req.param("key_id");
    const out = tx(() => {
      const row = db().query<NativeKeyRow, [string]>("SELECT * FROM native_keys WHERE key_id = ?").get(keyId);
      if (!row) throw notFound("No such key.");
      if (row.status === "revoked") throw conflict("already_revoked", "That key is already revoked.");
      db().query("UPDATE native_keys SET status = 'revoked', revoked_at = ? WHERE key_id = ?").run(nowIso(), keyId);
      const a = revokeApprovals(db(), { credentialId: keyId }, "owner", "native key revoked");
      const k = revokeContactApprovals(db(), { credentialId: keyId }, "owner", "native key revoked");
      audit(db(), "owner", "native_key.revoke", keyId, { revoked_approvals: a.approvals, revoked_contact_approvals: k.approvals });
      return { revoked_approvals: a.approvals, revoked_contact_approvals: k.approvals };
    });
    writePinFiles(cfg, db());   // simple: effective at once. hardened: the root pin changes when the owner re-runs the command (status says so)
    return c.json(out);
  });

  // ---- reauth by SE key (app) ----
  app.post("/api/native-keys/reauth/options", async (c) => {
    const body = await readJson(c, z.object({ action: z.enum(RE_AUTH_ACTIONS) }).strict());
    if (nativeKeyCount(db()) === 0) throw conflict("no_native_keys", "Set up Touch ID approval in the app first.");
    purgeNative(db());
    const id = newId(), challenge = b64u(randomBytes(32));
    db().query("INSERT INTO native_challenges(id, key_id, action, challenge, expires_at) VALUES (?,?,?,?,?)")
      .run(id, null, body.action, challenge, new Date(Date.now() + NATIVE_CHALLENGE_TTL_MS).toISOString());
    return c.json({ challenge_id: id, challenge });
  });

  // ---- browser link (app -> browser) ----
  app.post("/api/app/browser-link", async (c) => {
    const body = await readJsonOptional(c, z.object({ se_reauth: seReauthSchema.optional() }).strict());
    const logins = passkeyCount(db(), "login");
    // With a sign-in passkey, a link is just a session (what the app channel already is). With none, a link session may register the
    // FIRST sign-in passkey, so it needs the owner: an active native key AND its fresh confirmation (never the app channel alone).
    if (logins === 0) {
      if (nativeKeyCount(db()) === 0) throw conflict("setup_first", "Set up Touch ID in the app (or the first-run link) before opening the dashboard.");
      if (!body.se_reauth) throw new ApiError(403, "reauth_required", "Confirm with Touch ID to open the dashboard in your browser.");
    }
    if (body.se_reauth) verifySeReauth(db(), limiterFor(c, "se_reauth"), body.se_reauth, "browser_link");
    purgeNative(db());
    const code = b64u(randomBytes(32));
    const expires = new Date(Date.now() + LINK_TTL_MS).toISOString();
    db().query("INSERT INTO link_codes(code_sha256, expires_at) VALUES (?,?)").run(sha256Hex(code), expires);
    audit(db(), "owner", "browser_link.create", null, {});
    return c.json({ url: `${cfg.origin}/#/link?code=${code}`, expires_at: expires });
  });

  // ---- /api/auth/link (browser): code -> session cookie ----
  app.post("/api/auth/link", async (c) => {
    const body = await readJson(c, z.object({ code: z.string().min(1).max(100) }).strict());
    const limiter = limiterFor(c, "link");
    limiter.check();
    const hash = sha256Hex(body.code);
    const ok = tx(() => {
      const r = db().query<{ expires_at: string }, [string]>("SELECT expires_at FROM link_codes WHERE code_sha256 = ?").get(hash);
      if (r) db().query("DELETE FROM link_codes WHERE code_sha256 = ?").run(hash);   // single use, valid or not
      return !!r && r.expires_at > nowIso();
    });
    if (!ok) { limiter.fail(); throw new ApiError(400, "link_invalid", "That link is unknown, expired or was already used. Open it again from the app."); }
    const token = deps.startSession(c);
    db().query("INSERT INTO session_links(token_sha256, created_at) VALUES (?,?)").run(sha256Hex(token), nowIso());
    audit(db(), "owner", "browser_link.use", null, {});
    limiter.reset();
    return c.json({ ok: true });
  });
}
