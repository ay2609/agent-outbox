// Contact changes: the owner's side. Builds a contacts manifest from the exact stored payloads, turns its bytes into a
// WebAuthn challenge, verifies the signature (approval passkeys only), re-checks every item, records the approval; also
// reject, cancel, revoke (Stop) and the creation of undo sets. Same crypto and conventions as approval.ts, but a separate
// table and a separate manifest kind ("contacts"), so a contacts approval can never be replayed as a send approval.
import type { Database } from "bun:sqlite";
import { generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { newId, nowIso } from "../db";
import {
  ContactValidationError, checkStoredPayload, contactBefore, getContactChanges, getContactSet, rowToContactChange,
  type ContactBefore,
} from "../core/contact-changes";
import { audit, getSettings } from "../core/store";
import type { ContactChange, ContactChangeSet, ContactManifest, ContactManifestItem, ContactUndoPayload } from "../core/types";
import type { OwnerConfig } from "./config";
import { b64u, fromB64u, isB64u, sha256Hex } from "./b64";
import { ApiError, badRequest, conflict, notFound } from "./errors";
import { FailureLimiter, listPasskeys, storeChallenge, takeChallenge, type PasskeyRow } from "./auth";
import { APPROVAL_HOURS, challengeBytes } from "./approval";
import { pinContactsLiveAllowed } from "./status";

/** Changes still waiting for something (the owner, the executor). `failed`, `rejected`, `applied` and `undone` are over. */
const OPEN = ["pending", "auto_queued", "review", "approved"]; // auto_queued: legacy value, migrated to review at open

// ---------- manifest ----------
export const contactManifestItem = (ch: Pick<ContactChange, "id" | "kind" | "target_macos_id" | "payload_json">): ContactManifestItem => ({
  change_id: ch.id, kind: ch.kind, target_macos_id: ch.target_macos_id, payload_sha256: sha256Hex(ch.payload_json),
});

export function buildContactManifest(cfg: Pick<OwnerConfig, "rpId" | "origin">, setId: string, changes: ContactChange[], notAfterHours: number,
  transport: "dry" | "live" = "dry", approvalId: string = newId(), now: Date = new Date()): { manifest: ContactManifest; bytes: string } {
  const manifest: ContactManifest = {
    v: 1, kind: "contacts", transport, approval_id: approvalId, set_id: setId, created_at: now.toISOString(),
    not_after: new Date(now.getTime() + notAfterHours * 3600_000).toISOString(),
    rp_id: cfg.rpId, origin: cfg.origin, contact_items: changes.map(contactManifestItem),
  };
  // Serialised exactly once; these bytes are stored verbatim and hashed.
  return { manifest, bytes: JSON.stringify(manifest) };
}

// ---------- coverage by live approvals ----------
export interface ContactApprovalRow { id: string; set_id: string; manifest: string; not_after: string; revoked_at: string | null; created_at: string }
export function parseContactManifest(a: Pick<ContactApprovalRow, "manifest">): ContactManifest | null {
  try { const m = JSON.parse(a.manifest) as ContactManifest; return m && m.kind === "contacts" && Array.isArray(m.contact_items) ? m : null; } catch { return null; }
}
export function liveContactApprovals(db: Database, setId?: string): ContactApprovalRow[] {
  return setId
    ? db.query<ContactApprovalRow, [string, string]>("SELECT * FROM contact_approvals WHERE set_id = ? AND revoked_at IS NULL AND not_after > ?").all(setId, nowIso())
    : db.query<ContactApprovalRow, [string]>("SELECT * FROM contact_approvals WHERE revoked_at IS NULL AND not_after > ?").all(nowIso());
}
/** A change is consumed once the executor has a contact_applies row for it (applied, failed or interrupted: never retried). */
export const contactChangeConsumed = (db: Database, changeId: string): boolean =>
  !!db.query("SELECT 1 FROM contact_applies WHERE change_id = ?").get(changeId);

/** The live, unconsumed approval that covers this change exactly as it is now (same kind, target and payload hash), or null. */
export function coveringContactApproval(db: Database, ch: ContactChange, live: ContactApprovalRow[] = liveContactApprovals(db, ch.set_id)): string | null {
  const cur = JSON.stringify(contactManifestItem(ch));
  for (const a of live) {
    if (a.set_id !== ch.set_id) continue;
    const item = parseContactManifest(a)?.contact_items.find((i) => i.change_id === ch.id);
    if (item && JSON.stringify(item) === cur && !contactChangeConsumed(db, ch.id)) return a.id;
  }
  return null;
}

// ---------- set status ----------
/** Brings a set's status in line with its changes after an OWNER action. `applying` is the executor's: kept while nothing is in review. */
export function refreshSetStatus(db: Database, setId: string): void {
  const set = getContactSet(db, setId);
  if (!set || set.status === "cancelled") return;
  const n: Record<string, number> = {};
  for (const r of db.query("SELECT status, COUNT(*) AS n FROM contact_changes WHERE set_id = ? GROUP BY status").all(setId) as { status: string; n: number }[]) n[r.status] = r.n;
  const open = OPEN.reduce((a, k) => a + (n[k] ?? 0), 0);
  let next: ContactChangeSet["status"];
  if ((n.review ?? 0) > 0) next = "review";
  else if (set.status === "applying") next = "applying";
  else if ((n.approved ?? 0) > 0) next = "approved";
  else if (open > 0) next = set.status === "review" ? "drafting" : set.status;
  else next = Object.keys(n).some((k) => k !== "rejected") ? "done" : "cancelled";
  if (next !== set.status) db.query("UPDATE contact_change_sets SET status = ?, updated_at = ? WHERE id = ?").run(next, nowIso(), setId);
}

// ---------- options ----------
export interface ContactApproveOptionsResult {
  challenge_id: string;
  options: Awaited<ReturnType<typeof generateAuthenticationOptions>>;
  manifest: ContactManifest;
  /** The exact payload_json of every item. The browser re-hashes each and compares with manifest.contact_items[].payload_sha256. */
  payloads: Record<string, string>;
  /** Why the manifest is live when the `contacts_transport` setting isn't: it undoes changes that were made live. Otherwise null. */
  live_reason: "undo_of_live" | null;
  /** Display only (not signed): the cached card each edit or undo is about, and for an undo the change it reverses. */
  display: Record<string, { before: ContactBefore | null; original: { kind: string; payload: unknown } | null }>;
}

function originalOf(db: Database, ch: ContactChange): ContactChange | null {
  if (ch.kind !== "undo") return null;
  const id = (ch.payload as Partial<ContactUndoPayload>).undo_of ?? ch.undo_of;
  const r = id ? db.query("SELECT * FROM contact_changes WHERE id = ?").get(id) : null;
  return r ? rowToContactChange(r) : null;
}

/** Everything that must hold for this change to be signed now. Throws a 409 whose message tells the owner what to do. */
function checkApprovable(db: Database, ch: ContactChange, live: ContactApprovalRow[]): void {
  const ref = { change_id: ch.id };
  const ok = ch.status === "review" || ch.status === "approved";
  if (!ok) {
    throw conflict("change_not_approvable", `A change that is ${ch.status} can't be approved.`, ref);
  }
  if (ch.status === "approved" && coveringContactApproval(db, ch, live)) throw conflict("already_approved", "A change is already in an approval that hasn't been used.", ref);
  if (contactChangeConsumed(db, ch.id)) throw conflict("change_consumed", "That change was already attempted; it can't be approved again.", ref);
  try { checkStoredPayload(ch.kind, ch.payload_json); }
  catch (e) { if (e instanceof ContactValidationError) throw conflict("payload_invalid", `A change isn't valid: ${e.message}`, ref); throw e; }
  if ((ch.kind === "update" || ch.kind === "undo") && !ch.target_macos_id) throw conflict("no_target", "A change has no contact to act on.", ref);
  if (ch.kind === "undo") {
    const p = ch.payload as ContactUndoPayload;
    const o = originalOf(db, ch);
    if (!o || o.status !== "applied" || !contactChangeConsumed(db, o.id)) throw conflict("undo_target_gone", "The change this undoes isn't applied (any more).", ref);
    const target = o.kind === "create" ? o.result_macos_id : o.target_macos_id;
    if (target !== ch.target_macos_id || p.undo_kind !== o.kind || p.after_fingerprint !== (o.after_fingerprint ?? "")
      || p.before_vcard_sha256 !== (o.kind === "update" && o.before_vcard ? sha256Hex(o.before_vcard) : null)) {
      throw conflict("undo_mismatch", "This undo no longer matches the change it reverses. Ask for a new undo.", ref);
    }
  }
}

export async function contactApproveOptions(cfg: OwnerConfig, db: Database, setId: string, changeIds: string[]): Promise<ContactApproveOptionsResult> {
  const set = getContactSet(db, setId);
  if (!set) throw notFound("Contact change set not found.");
  if (set.status === "cancelled") throw conflict("set_cancelled", "This set was cancelled.");
  const unique = [...new Set(changeIds)];
  if (unique.length === 0) throw badRequest("Pick at least one change.");
  if (unique.length > 500) throw badRequest("At most 500 changes per approval.");
  const all = getContactChanges(db, setId);
  const byId = new Map(all.map((c) => [c.id, c]));
  const live = liveContactApprovals(db, setId);
  const picked: ContactChange[] = [];
  for (const id of unique) {
    const ch = byId.get(id);
    if (!ch) throw badRequest("A change isn't in this set.", { change_id: id });
    checkApprovable(db, ch, live);
    picked.push(ch);
  }
  picked.sort((a, b) => a.position - b.position);
  const passkeys = listPasskeys(db, "approve");
  if (passkeys.length === 0) throw conflict("no_passkeys", "Register an approval passkey first (Settings).");

  // An undo of a change that went in live must go in live too (a dry undo would log and leave the card as it is). That needs
  // the effective pin's contacts_live_allowed, since the executor would otherwise apply it dry.
  const settingTransport = getSettings(db).contacts_transport;
  const undoesLive = picked.some((c) => {
    const o = originalOf(db, c);
    return !!o && o.transport === "live";
  });
  const transport: "dry" | "live" = settingTransport === "live" || undoesLive ? "live" : "dry";
  const live_reason = settingTransport !== "live" && undoesLive ? "undo_of_live" as const : null;
  if (live_reason && !pinContactsLiveAllowed(cfg)) {
    throw conflict("pin_not_contacts_live_allowed", "This undoes changes that were made live, so it has to be applied live too, but the pin doesn't allow live contact changes. In Settings, tick \"Allow live contact changes\" (in hardened mode, then run the harden command again).");
  }
  const { manifest, bytes } = buildContactManifest(cfg, setId, picked, APPROVAL_HOURS, transport);
  const digest = challengeBytes(bytes);
  const options = await generateAuthenticationOptions({
    rpID: cfg.rpId, userVerification: "required", timeout: 120_000, challenge: digest,
    allowCredentials: passkeys.map((p) => ({ id: p.credential_id, transports: JSON.parse(p.transports_json) })),
  });
  const stored = b64u(digest);
  if (options.challenge !== stored) throw new Error("challenge encoding mismatch");
  // purpose 'approve' is shared with send approvals; the set id goes in the batch_id column (no FK) and the manifest's kind tells them apart.
  const challenge_id = storeChallenge(cfg, db, { purpose: "approve", challenge: stored, approval_id: manifest.approval_id, manifest: bytes, batch_id: setId });
  audit(db, "owner", "contact_approval.options", setId, { challenge_id, approval_id: manifest.approval_id, count: picked.length, transport });
  return {
    challenge_id, options, manifest, live_reason,
    payloads: Object.fromEntries(picked.map((c) => [c.id, c.payload_json])),
    display: Object.fromEntries(picked.map((c) => {
      const o = originalOf(db, c);
      return [c.id, { before: c.kind === "create" ? null : contactBefore(db, c), original: o ? { kind: o.kind, payload: o.payload } : null }];
    })),
  };
}

// ---------- verify ----------
export interface ContactApproveVerifyResult { approval_id: string; manifest_sha256: string; count: number; not_after: string; credential_id: string; transport: "dry" | "live" }

/** Items whose row, kind, target or payload hash no longer match what was signed. */
export function changedContactItems(db: Database, manifest: ContactManifest): { change_id: string; reason: string }[] {
  const out: { change_id: string; reason: string }[] = [];
  for (const item of manifest.contact_items) {
    const r = db.query("SELECT * FROM contact_changes WHERE id = ?").get(item.change_id);
    if (!r) { out.push({ change_id: item.change_id, reason: "missing" }); continue; }
    const ch = rowToContactChange(r);
    if (ch.set_id !== manifest.set_id) out.push({ change_id: ch.id, reason: "wrong_set" });
    else if (ch.kind !== item.kind) out.push({ change_id: ch.id, reason: "kind_changed" });
    else if (ch.target_macos_id !== item.target_macos_id) out.push({ change_id: ch.id, reason: "target_changed" });
    else if (sha256Hex(ch.payload_json) !== item.payload_sha256) out.push({ change_id: ch.id, reason: "payload_changed" });
  }
  return out;
}

export async function contactApproveVerify(cfg: OwnerConfig, db: Database, limiter: FailureLimiter, setId: string, challengeId: string,
  response: AuthenticationResponseJSON): Promise<ContactApproveVerifyResult> {
  limiter.check();
  const ch = takeChallenge(db, challengeId, "approve"); // single use, gone from here on even if verification fails
  if (ch.batch_id !== setId || !ch.manifest || !ch.approval_id) throw new ApiError(400, "challenge_invalid", "That request belongs to a different set.");
  const bytes = ch.manifest;
  const digest = challengeBytes(bytes);
  if (b64u(digest) !== ch.challenge) throw new ApiError(500, "internal", "Stored approval is inconsistent.");
  const manifest = JSON.parse(bytes) as ContactManifest;
  if (manifest.kind !== "contacts" || manifest.v !== 1 || manifest.set_id !== setId || !Array.isArray(manifest.contact_items) || manifest.contact_items.length === 0) {
    throw new ApiError(400, "challenge_invalid", "That request isn't a contacts approval.");
  }
  if (manifest.not_after <= nowIso()) throw new ApiError(400, "approval_expired", "This approval window already passed. Start again.");

  const pk = db.query<PasskeyRow, [string]>("SELECT * FROM passkeys WHERE credential_id = ?").get(response.id);
  if (!pk) { limiter.fail(); throw new ApiError(401, "approval_failed", "That passkey isn't registered here."); }
  if (pk.purpose !== "approve") { limiter.fail(); throw new ApiError(401, "approval_failed", "That passkey can't approve changes. Use your approval key."); }
  let newCounter: number;
  try {
    const v = await verifyAuthenticationResponse({
      response, expectedChallenge: ch.challenge, expectedOrigin: cfg.origin, expectedRPID: cfg.rpId, requireUserVerification: true,
      credential: { id: pk.credential_id, publicKey: fromB64u(pk.public_key_cose_b64), counter: pk.counter, transports: JSON.parse(pk.transports_json) },
    });
    if (!v.verified) throw new Error("not verified");
    newCounter = v.authenticationInfo.newCounter;
  } catch (e) {
    limiter.fail();
    throw new ApiError(401, "approval_failed", `The passkey signature didn't verify: ${(e as Error).message}`);
  }
  const { authenticatorData, clientDataJSON, signature } = response.response;
  for (const [k, v] of Object.entries({ authenticatorData, clientDataJSON, signature })) {
    if (!isB64u(v)) throw badRequest(`${k} must be base64url.`);
  }

  const result = db.transaction((): ContactApproveVerifyResult => {
    const set = getContactSet(db, setId);
    if (!set || set.status === "cancelled") throw conflict("set_cancelled", "This set was cancelled.");
    const changed = changedContactItems(db, manifest);
    if (changed.length) throw conflict("contact_changed", "Some changes were altered after you opened the approval. Nothing was approved. Review them and approve again.", { changed });
    const live = liveContactApprovals(db, setId);
    for (const item of manifest.contact_items) {
      const cur = rowToContactChange(db.query("SELECT * FROM contact_changes WHERE id = ?").get(item.change_id));
      checkApprovable(db, cur, live);
    }
    const t = nowIso();
    db.query(`INSERT INTO contact_approvals(id, set_id, manifest, manifest_sha256, credential_id, authenticator_data_b64, client_data_json_b64,
              signature_b64, not_after, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(manifest.approval_id, setId, bytes, sha256Hex(bytes), pk.credential_id, authenticatorData, clientDataJSON, signature, manifest.not_after, t);
    for (const item of manifest.contact_items) {
      db.query("UPDATE contact_changes SET status = 'approved', error = NULL WHERE id = ? AND status IN ('review','approved')").run(item.change_id);
    }
    refreshSetStatus(db, setId);
    db.query("UPDATE passkeys SET counter = ? WHERE credential_id = ?").run(newCounter, pk.credential_id);
    audit(db, "owner", "contact_approval.create", manifest.approval_id, {
      set_id: setId, count: manifest.contact_items.length, credential_id: pk.credential_id, manifest_sha256: sha256Hex(bytes),
      not_after: manifest.not_after, transport: manifest.transport,
    });
    return { approval_id: manifest.approval_id, manifest_sha256: sha256Hex(bytes), count: manifest.contact_items.length, not_after: manifest.not_after, credential_id: pk.credential_id, transport: manifest.transport };
  }).immediate();
  limiter.reset();
  return result;
}

// ---------- reject / cancel ----------
/** review (or approved but no longer covered by a live approval) -> rejected. Anything else is refused, naming the change. */
export function rejectContactChanges(db: Database, setId: string, changeIds: string[], actor: string): { rejected: number } {
  return db.transaction(() => {
    const set = getContactSet(db, setId);
    if (!set) throw notFound("Contact change set not found.");
    const unique = [...new Set(changeIds)];
    if (unique.length === 0) throw badRequest("Pick at least one change.");
    const live = liveContactApprovals(db, setId);
    const rows = unique.map((id) => {
      const r = db.query("SELECT * FROM contact_changes WHERE id = ? AND set_id = ?").get(id, setId);
      if (!r) throw badRequest("A change isn't in this set.", { change_id: id });
      return rowToContactChange(r);
    });
    for (const ch of rows) {
      const free = ch.status === "review" || (ch.status === "approved" && !coveringContactApproval(db, ch, live));
      if (!free) throw conflict("change_not_rejectable", ch.status === "approved" ? "A change is already approved. Stop or cancel the set to hold it back." : `A change that is ${ch.status} can't be rejected.`, { change_id: ch.id });
    }
    const t = nowIso();
    for (const ch of rows) db.query("UPDATE contact_changes SET status = 'rejected', error = NULL WHERE id = ?").run(ch.id);
    refreshSetStatus(db, setId);
    db.query("UPDATE contact_change_sets SET updated_at = ? WHERE id = ?").run(t, setId);
    audit(db, actor, "contact_changes.reject", setId, { change_ids: rows.map((c) => c.id) });
    return { rejected: rows.length };
  }).immediate();
}

/** Stops everything in the set that hasn't been applied: queued, review and approved changes become rejected, the set's
 *  live approvals are revoked, and the set is cancelled. Applied changes are untouched (they can be undone). */
export function cancelContactSet(db: Database, setId: string, actor: string): { rejected: number; revoked_approvals: number } {
  return db.transaction(() => {
    const set = getContactSet(db, setId);
    if (!set) throw notFound("Contact change set not found.");
    if (set.status === "cancelled") throw conflict("set_closed", "This set is already cancelled.");
    const t = nowIso();
    const rev = revokeContactApprovals(db, { setId }, actor, "set cancelled");
    const r = db.query(`UPDATE contact_changes SET status = 'rejected' WHERE set_id = ? AND status IN ('pending','auto_queued','review','approved')
                        AND NOT EXISTS (SELECT 1 FROM contact_applies a WHERE a.change_id = contact_changes.id)`).run(setId);
    db.query("UPDATE contact_change_sets SET status = 'cancelled', updated_at = ? WHERE id = ?").run(t, setId);
    db.query("DELETE FROM webauthn_challenges WHERE purpose = 'approve' AND batch_id = ?").run(setId);
    audit(db, actor, "contact_changes.cancel", setId, { rejected: r.changes, revoked_approvals: rev.approvals });
    return { rejected: r.changes, revoked_approvals: rev.approvals };
  }).immediate();
}

// ---------- revocation (Stop) ----------
export interface ContactRevokeResult { approvals: number; changes: number; approval_ids: string[]; change_ids: string[]; at: string }
/** Revokes contact approvals and drops their still-`approved`, unconsumed changes back to review (the executor refuses a revoked
 *  approval anyway; this keeps the dashboard honest). IMMEDIATE. */
export function revokeContactApprovals(db: Database, where: { setId?: string; all?: boolean }, actor: string, why: string): ContactRevokeResult {
  return db.transaction((): ContactRevokeResult => {
    let rows = db.query<ContactApprovalRow, []>("SELECT * FROM contact_approvals WHERE revoked_at IS NULL").all();
    if (where.setId) rows = rows.filter((a) => a.set_id === where.setId);
    const t = nowIso();
    const changeIds: string[] = [];
    const sets = new Set<string>();
    for (const a of rows) {
      db.query("UPDATE contact_approvals SET revoked_at = ? WHERE id = ?").run(t, a.id);
      sets.add(a.set_id);
      for (const i of parseContactManifest(a)?.contact_items ?? []) {
        const r = db.query(`UPDATE contact_changes SET status = 'review' WHERE id = ? AND status = 'approved'
                            AND NOT EXISTS (SELECT 1 FROM contact_applies x WHERE x.change_id = contact_changes.id)`).run(i.change_id);
        if (r.changes) changeIds.push(i.change_id);
      }
      audit(db, actor, "contact_approval.revoke", a.id, { why });
    }
    for (const s of sets) refreshSetStatus(db, s);
    return { approvals: rows.length, changes: changeIds.length, approval_ids: rows.map((a) => a.id), change_ids: changeIds, at: t };
  }).immediate();
}

/** Part of undoing a Stop within two minutes: clears revoked_at on the contact approvals that stop revoked (still unexpired) and
 *  puts their changes back to approved if they are still in review. */
export function restoreContactApprovals(db: Database, ids: string[], changeIds: string[], revokedAt: string, actor: string): { approvals: number; changes: number } {
  const wanted = new Set(changeIds);
  const t = nowIso();
  let approvals = 0, changes = 0;
  const sets = new Set<string>();
  for (const id of ids) {
    const a = db.query<ContactApprovalRow, [string]>("SELECT * FROM contact_approvals WHERE id = ?").get(id);
    if (!a || a.revoked_at !== revokedAt || a.not_after <= t) continue;
    db.query("UPDATE contact_approvals SET revoked_at = NULL WHERE id = ? AND revoked_at = ?").run(id, revokedAt);
    approvals++; sets.add(a.set_id);
    const m = parseContactManifest(a);
    const changed = new Set(m ? changedContactItems(db, m).map((c) => c.change_id) : []);
    for (const it of m?.contact_items ?? []) {
      if (!wanted.has(it.change_id) || changed.has(it.change_id)) continue;
      changes += db.query("UPDATE contact_changes SET status = 'approved' WHERE id = ? AND status = 'review'").run(it.change_id).changes;
    }
  }
  for (const s of sets) refreshSetStatus(db, s);
  if (approvals) audit(db, actor, "contact_approval.restore", null, { approvals, changes });
  return { approvals, changes };
}

// ---------- undo ----------
/** Why this change can't be undone right now, or null. Undo is for an applied create or edit the executor has a record for. */
export function undoBlockReason(db: Database, ch: ContactChange): string | null {
  if (ch.status !== "applied") return ch.status === "undone" ? "it was already undone" : `it is ${ch.status}, not applied`;
  if (ch.kind !== "create" && ch.kind !== "update") return "only an added or edited contact can be undone";
  const ap = db.query<{ result: string | null }, [string]>("SELECT result FROM contact_applies WHERE change_id = ?").get(ch.id);
  if (!ap || ap.result !== "applied") return "the sender has no record of applying it";
  const target = ch.kind === "create" ? ch.result_macos_id : ch.target_macos_id;
  if (!target) return "it has no recorded contact to restore";
  // The executor records a fingerprint for every applied change, dry or live. Without one (a record from before that) there is
  // nothing to check the card against, so the undo can't be made safely.
  if (!ch.after_fingerprint) return "no fingerprint of the card after the change was saved, so it can't be checked before undoing";
  if (ch.transport !== "dry" && ch.kind === "update" && !ch.before_vcard) return "no snapshot of the card before the change was saved";
  if (db.query("SELECT 1 FROM contact_changes WHERE undo_of = ? AND kind = 'undo' AND status IN ('pending','review','approved','applied')").get(ch.id)) return "an undo for it is already waiting";
  return null;
}

/** Makes one new set (source `undo`, title "Undo: <original title>") per original set, with a kind='undo' change in review for
 *  each id. The owner then approves it through the normal Touch ID flow. All or nothing. */
export function createUndoSets(db: Database, changeIds: string[], actor: string): { sets: { set_id: string; count: number }[] } {
  return db.transaction(() => {
    const unique = [...new Set(changeIds)];
    if (unique.length === 0) throw badRequest("Pick at least one change to undo.");
    if (unique.length > 500) throw badRequest("At most 500 changes per undo.");
    const bySet = new Map<string, ContactChange[]>();
    const problems: { change_id: string; reason: string }[] = [];
    for (const id of unique) {
      const r = db.query("SELECT * FROM contact_changes WHERE id = ?").get(id);
      if (!r) throw notFound("A change wasn't found.");
      const ch = rowToContactChange(r);
      const why = undoBlockReason(db, ch);
      if (why) { problems.push({ change_id: id, reason: why }); continue; }
      bySet.set(ch.set_id, [...(bySet.get(ch.set_id) ?? []), ch]);
    }
    if (problems.length) throw conflict("not_undoable", `${problems.length} change${problems.length === 1 ? " can't" : "s can't"} be undone: ${problems[0]!.reason}.`, { problems });
    const t = nowIso();
    const out: { set_id: string; count: number }[] = [];
    for (const [origSetId, list] of bySet) {
      const orig = getContactSet(db, origSetId);
      const setId = newId();
      db.query("INSERT INTO contact_change_sets(id, title, created_by, source, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
        .run(setId, `Undo: ${orig?.title ?? "contact changes"}`.slice(0, 200), actor, "undo", "review", t, t);
      list.sort((a, b) => a.position - b.position).forEach((ch, position) => {
        const payload: ContactUndoPayload = {
          undo_of: ch.id, undo_kind: ch.kind as "create" | "update",
          before_vcard_sha256: ch.kind === "update" && ch.before_vcard ? sha256Hex(ch.before_vcard) : null,
          after_fingerprint: ch.after_fingerprint!, // undoBlockReason refused anything without one
        };
        db.query(`INSERT INTO contact_changes(id, set_id, position, kind, target_contact_id, target_macos_id, payload_json, requires_approval,
                    status, note, created_at, undo_of) VALUES (?,?,?,?,?,?,?,1,'review',?,?,?)`)
          .run(newId(), setId, position, "undo", ch.target_contact_id, ch.kind === "create" ? ch.result_macos_id : ch.target_macos_id, JSON.stringify(payload),
            ch.kind === "create" ? "removes the contact that was added" : "puts the card back as it was", t, ch.id);
      });
      audit(db, actor, "contact_changes.undo_request", setId, { of_set: origSetId, change_ids: list.map((c) => c.id) });
      out.push({ set_id: setId, count: list.length });
    }
    return { sets: out };
  }).immediate();
}
