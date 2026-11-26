// Native approval: Secure Enclave keys held by Agent Outbox.app. Routes for approving (se-verify), enrolling and revoking keys,
// Touch ID re-authentication, and cancelling a recovery. The signature format lives in keys.ts.
import type { Context, Hono } from "hono";
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { nowIso } from "../db";
import { audit } from "../core/store";
import type { ContactManifest, Manifest } from "../core/types";
import type { OwnerConfig } from "./config";
import { ApiError, badRequest, conflict, notFound } from "./errors";
import { b64u, fromB64u, isB64u, sha256Buf } from "./b64";
import {
  type FailureLimiter, type NativeKeyRow, firstRun, listNativeKeys, markSetupDone, nativeKeyCount, storeOwnerChallenge, takeOwnerChallenge, writePinFiles,
} from "./auth";
import { commitApproval, revokeApprovals } from "./approval";
import { commitContactApproval, revokeContactApprovals } from "./contact-approval";
import { RecoveryToken } from "./recovery";
import { effectiveNativeKeyIds } from "./status";
import { readJson, readJsonOptional } from "./schemas";
import { fingerprint, nativeKeyId, parseX963, seMessage, verifySe } from "./keys";

export { SE_PREFIX, fingerprint, nativeKeyId, parseX963, seMessage, verifySe, type SeTag } from "./keys";

// ---------- reauth by a Secure Enclave key ----------
export const RE_AUTH_ACTIONS = ["mode_live", "policy_live", "native_key_add"] as const;
export type ReauthAction = (typeof RE_AUTH_ACTIONS)[number];
export const seReauthSchema = z.object({ challenge_id: z.string().min(1).max(100), key_id: z.string().min(1).max(100), signature: z.string().min(1).max(200) });
export type SeReauth = z.infer<typeof seReauthSchema>;

const activeKey = (db: Database, keyId: string): NativeKeyRow | null =>
  db.query<NativeKeyRow, [string]>("SELECT * FROM native_keys WHERE key_id = ? AND status = 'active'").get(keyId);

/** Verifies an `se_reauth` for `action` (and `target`: the pending key id for native_key_add, null otherwise): single-use challenge
 *  (consumed even when verification fails) bound to that action and target, an ACTIVE signer key that is not the target, and a
 *  signature over M("reauth", sha256(challenge)). Throws 400/401. */
export function verifySeReauth(db: Database, limiter: FailureLimiter, r: SeReauth, action: ReauthAction, target: string | null = null): void {
  limiter.check();
  let row;
  try { row = takeOwnerChallenge(db, r.challenge_id, { kind: "reauth", action, target }); }
  catch (e) { if (e instanceof ApiError && e.code === "challenge_invalid") limiter.fail(); throw e; }
  const key = activeKey(db, r.key_id);
  if (!key || (target !== null && key.key_id === target)) { limiter.fail(); throw new ApiError(401, "reauth_failed", "That key can't confirm this."); }
  if (!isB64u(r.signature)) throw badRequest("signature must be base64url.");
  const msg = seMessage("reauth", sha256Buf(fromB64u(row.challenge)));
  if (!verifySe(Buffer.from(key.public_key_x963_b64, "base64url"), msg, fromB64u(r.signature))) {
    limiter.fail();
    throw new ApiError(401, "reauth_failed", "The Touch ID confirmation didn't verify.");
  }
  limiter.reset();
}

/** The owner proof every sensitive route asks for: a Secure Enclave `se_reauth` for the same action. */
export function requireReauth(c: Context, cfg: OwnerConfig, limiterFor: (c: Context, route: string) => FailureLimiter,
  body: { se_reauth?: SeReauth }, action: ReauthAction, missingMsg: string): void {
  if (!body.se_reauth) throw new ApiError(403, "reauth_required", missingMsg);
  verifySeReauth(cfg.db(), limiterFor(c, "se_reauth"), body.se_reauth, action, null);
}

// ---------- se-verify (shared checks) ----------
const seVerifyBody = z.object({ challenge_id: z.string().min(1).max(100), key_id: z.string().min(1).max(100), signature: z.string().min(1).max(200) }).strict();

/** Takes the approval challenge (single use), checks it belongs to `ownerId` (batch or set), and verifies the key's signature over
 *  M(tag, sha256(manifest bytes)). Returns the exact manifest bytes. */
function checkSeApproval(db: Database, limiter: FailureLimiter, ownerId: string, body: z.infer<typeof seVerifyBody>, tag: "send" | "contacts"): { bytes: string; key: NativeKeyRow } {
  limiter.check();
  const ch = takeOwnerChallenge(db, body.challenge_id, { kind: tag, target: ownerId }); // single use (IMMEDIATE tx): gone from here on, even if verification fails
  if (!ch.manifest || !ch.approval_id) throw new ApiError(400, "challenge_invalid", "That request belongs to something else.");
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
  db.query("DELETE FROM owner_challenges WHERE expires_at < ?").run(t);
};

/** Marks a pending key active (inside the caller's transaction) and audits it. Setup counts as done from here on. */
function activatePending(db: Database, keyId: string, how: string): void {
  const t = nowIso();
  const r = db.query("UPDATE native_keys SET status = 'active', activated_at = ? WHERE key_id = ? AND status = 'pending' AND enroll_expires_at > ?").run(t, keyId, t);
  if (!r.changes) throw new ApiError(400, "enroll_expired", "That setup expired (10 minutes). Start again in the app.");
  markSetupDone(db);
  audit(db, "owner", "native_key.activate", keyId, { how });
}

export interface NativeKeyView { key_id: string; label: string; status: string; created_at: string; activated_at: string | null; revoked_at: string | null; in_effective_pin: boolean; fingerprint: string }

export function registerNativeApi(app: Hono, cfg: OwnerConfig, limiterFor: (c: Context, route: string) => FailureLimiter): void {
  const db = (): Database => cfg.db();
  const recovery = new RecoveryToken(cfg.recoveryTokenFile);
  const tx = <T>(fn: () => T): T => db().transaction(fn).immediate();

  // ---- Secure Enclave approval: send ----
  app.post("/api/batches/:id/approve/se-verify", async (c) => {
    const batchId = c.req.param("id");
    const body = await readJson(c, seVerifyBody);
    const { bytes, key } = checkSeApproval(db(), limiterFor(c, "approve"), batchId, body, "send");
    const manifest = JSON.parse(bytes) as Manifest;
    if (manifest.not_after <= nowIso()) throw new ApiError(400, "approval_expired", "This approval window already passed. Start again.");
    const result = commitApproval(db(), { manifest, bytes, batchId, credentialId: key.key_id, signature: body.signature });
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
    const result = commitContactApproval(db(), { manifest, bytes, setId, credentialId: key.key_id, signature: body.signature });
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
    // What the app should use. A recovery token the owner made in Terminal wins; then the first-run token; then an existing key's
    // confirmation; otherwise none (enroll/verify then asks for `agent-outbox recover`).
    const proof = recovery.active ? "recovery_token" : firstRun(db()) && cfg.setupToken.active ? "setup_token" : nativeKeyCount(db()) > 0 ? "se_reauth" : null;
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
    let how: string | null = null;
    if (body.setup_token !== undefined) {
      if (!firstRun(db())) { limiter.fail(); throw new ApiError(403, "setup_token_invalid", "First-run setup is already done."); }
      if (!cfg.setupToken.matches(body.setup_token)) { limiter.fail(); throw new ApiError(403, "setup_token_invalid", "That setup token isn't valid."); }
      how = "setup_token";
    } else if (body.recovery_token !== undefined) {
      if (!recovery.matches(body.recovery_token)) { limiter.fail(); throw new ApiError(403, "recovery_token_invalid", "That recovery token isn't valid (it lasts 30 minutes and works once). Run `agent-outbox recover` again."); }
      how = "recovery_token";
    } else if (body.se_reauth) {
      verifySeReauth(db(), limiterFor(c, "se_reauth"), body.se_reauth, "native_key_add", row.key_id);
      how = "se_reauth";
    }
    if (how === null) {
      throw new ApiError(403, "proof_required", "Confirm it's you first: run `agent-outbox recover` in Terminal, then press Set up Touch ID again.");
    }
    // The proof counts once: a recovery token is consumed together with the activation, in one transaction (the file delete follows).
    tx(() => {
      // Re-check inside the lock: two simultaneous first enrolments must not both win with one setup token.
      if (how === "setup_token" && !firstRun(db())) throw new ApiError(403, "setup_token_invalid", "First-run setup is already done.");
      activatePending(db(), row.key_id, how!);
    });
    if (how === "recovery_token") recovery.consume();
    cfg.setupToken.clear();
    writePinFiles(cfg, db());
    limiter.reset();
    return c.json({ status: "active" });
  });

  // Revoking only removes power (like Stop), so it needs no proof. The last active key may be revoked: the pin then lists no keys.
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

  // ---- reauth by SE key ----
  app.post("/api/native-keys/reauth/options", async (c) => {
    const body = await readJson(c, z.object({ action: z.enum(RE_AUTH_ACTIONS), target: z.string().min(1).max(100).optional() }).strict());
    if (body.action === "native_key_add" && body.target === undefined) throw badRequest("native_key_add needs the pending key's id as `target`.");
    if (body.action !== "native_key_add" && body.target !== undefined) throw badRequest("`target` is only for native_key_add.");
    if (nativeKeyCount(db()) === 0) throw conflict("no_native_keys", "Set up Touch ID approval in the app first.");
    purgeNative(db());
    if (body.action === "native_key_add" && !db().query("SELECT 1 FROM native_keys WHERE key_id = ? AND status = 'pending'").get(body.target!)) {
      throw new ApiError(400, "enroll_invalid", "That setup is unknown or expired. Start again in the app.");
    }
    const challenge = b64u(randomBytes(32));
    const id = storeOwnerChallenge(cfg, db(), { kind: "reauth", action: body.action, target: body.target ?? null, challenge });
    return c.json({ challenge_id: id, challenge });
  });

  // ---- recovery: cancel (removes power only, so no proof) ----
  app.post("/api/recovery/cancel", async (c) => {
    await readJsonOptional(c, z.object({}).strict());
    const cancelled = recovery.consume();
    audit(db(), "owner", "recovery.cancel", null, { cancelled });
    return c.json({ ok: true, cancelled });
  });
}

