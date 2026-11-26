// The approval flow: build a manifest, store its exact bytes as a single-use owner challenge, and record the approval once the
// app returns a Secure Enclave signature over M("send", sha256(bytes)) (the verify step lives in native.ts). Invariant: the executor
// only sends what a pinned key signed, so every choice here is about making the signed bytes exactly what the owner saw.
import type { Database } from "bun:sqlite";
import { newId, nowIso } from "../db";
import { audit, getBatch, getDrafts, getSettings, rowToDraft, setBatchStatus, setSetting } from "../core/store";
import { MANIFEST_ORIGIN, MANIFEST_RP_ID, type Draft, type DraftStatus, type Manifest, type ManifestItem, type ProposedContact, type Warning } from "../core/types";
import type { OwnerConfig } from "./config";
import { b64u, sha256Buf, sha256Hex } from "./b64";
import { badRequest, conflict, notFound } from "./errors";
import { planSends, type Plan } from "../core/pacing";
import { queuedAhead, readPaceState, sentSinceLocalMidnight } from "../core/pacing-db";
import { listNativeKeys, storeOwnerChallenge } from "./auth";

/** Draft states an approval may cover. `skipped` counts as re-included when the owner picks it, and `approved` is
 *  approvable again once its covering approval is dead (expired, revoked or consumed). */
export const APPROVABLE: DraftStatus[] = ["review", "failed", "skipped"];
/** Warnings that make a draft impossible to approve at all: there is nothing (or nowhere) to send. */
export const UNSENDABLE_WARNINGS = ["empty_body", "invalid_handle"] as const;
/** Warnings that hold a draft back until the owner includes it explicitly (one batch-level switch in the sheet, sent as include_anyway).
 *  Every other warning is advisory and never holds anything back. */
export const HELD_WARNINGS = ["unresolved_var", "duplicate_recipient"] as const;
const withCode = (ws: Warning[], codes: readonly string[]): Warning[] => ws.filter((w) => codes.includes(w.code));
export const unsendableWarnings = (ws: Warning[]): Warning[] => withCode(ws, UNSENDABLE_WARNINGS);
export const heldWarnings = (ws: Warning[]): Warning[] => withCode(ws, HELD_WARNINGS);

// ---------- proposed contacts: handles must be EXACTLY the draft's handle ----------
export function contactHandlesExact(pc: ProposedContact, handle: string): boolean {
  const phones = pc.phones ?? [], emails = pc.emails ?? [];
  if (handle.includes("@")) return phones.length === 0 && emails.length === 1 && emails[0]!.email.trim().toLowerCase() === handle.toLowerCase();
  return emails.length === 0 && phones.length === 1 && phones[0]!.e164 === handle;
}
/** The proposal reduced to exactly the draft's handle (extra phones and emails dropped; a missing one added). */
export function canonicalProposed(pc: ProposedContact, handle: string): ProposedContact {
  const out: ProposedContact = { ...pc, phones: [], emails: [] };
  if (handle.includes("@")) {
    const hit = (pc.emails ?? []).find((e) => e.email.trim().toLowerCase() === handle.toLowerCase());
    out.emails = [{ email: handle.toLowerCase(), label: hit?.label ?? "other" }];
  } else {
    const hit = (pc.phones ?? []).find((p) => p.e164 === handle);
    out.phones = [{ e164: handle, label: hit?.label ?? "mobile", ...(hit?.raw ? { raw: hit.raw } : {}) }];
  }
  return out;
}

export function manifestItem(d: Draft): ManifestItem {
  return {
    draft_id: d.id, to: d.handle, service: d.service, body_sha256: sha256Hex(d.body), name: d.recipient_name,
    create_contact: d.create_contact && d.proposed_contact ? d.proposed_contact : null,
  };
}

export function buildManifest(batchId: string, drafts: Draft[], notAfterHours: number,
  transport: "dry" | "live" = "dry", approvalId: string = newId(), now: Date = new Date()): { manifest: Manifest; bytes: string } {
  for (const d of drafts) {
    if (d.create_contact && d.proposed_contact && !contactHandlesExact(d.proposed_contact, d.handle)) {
      throw conflict("proposed_contact_mismatch", "A new contact's number or email doesn't match the message's recipient. Turn off \"Add to Contacts\" for it, or toggle it again.", { draft_id: d.id });
    }
  }
  const manifest: Manifest = {
    v: 2, transport, approval_id: approvalId, batch_id: batchId, created_at: now.toISOString(),
    not_after: new Date(now.getTime() + notAfterHours * 3600_000).toISOString(),
    rp_id: MANIFEST_RP_ID, origin: MANIFEST_ORIGIN, items: drafts.map(manifestItem),
  };
  // Serialised exactly once. These bytes are stored verbatim and hashed; nobody re-serialises them.
  return { manifest, bytes: JSON.stringify(manifest) };
}
/** The 32 raw challenge bytes for a manifest. */
export const challengeBytes = (bytes: string): Uint8Array<ArrayBuffer> => Uint8Array.from(sha256Buf(bytes));

// ---------- coverage by live approvals ----------
export interface ApprovalRow { id: string; batch_id: string; manifest: string; not_after: string; revoked_at: string | null; created_at: string }

export function parseManifest(a: Pick<ApprovalRow, "manifest">): Manifest | null {
  try { return JSON.parse(a.manifest) as Manifest; } catch { return null; }
}
/** An approval item is consumed once a send is sent|unknown, or after 3 failed attempts (rule). */
export function itemConsumed(db: Database, approvalId: string, draftId: string): boolean {
  const r = db.query<{ done: number; failed: number }, [string, string]>(
    `SELECT SUM(result IN ('sent','unknown')) AS done, SUM(result = 'failed') AS failed FROM sends WHERE approval_id = ? AND draft_id = ?`,
  ).get(approvalId, draftId);
  return (r?.done ?? 0) > 0 || (r?.failed ?? 0) >= 3;
}
/** Live = not revoked, not expired. (Per draft it must also be unconsumed: see coveringApproval.) */
export function liveApprovals(db: Database, batchId?: string): ApprovalRow[] {
  return batchId
    ? db.query<ApprovalRow, [string, string]>("SELECT * FROM approvals WHERE batch_id = ? AND revoked_at IS NULL AND not_after > ?").all(batchId, nowIso())
    : db.query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE revoked_at IS NULL AND not_after > ?").all(nowIso());
}
/** Is this draft, exactly as it is now, inside a LIVE (unexpired, unrevoked) approval that hasn't consumed it? (An edited
 *  draft no longer matches its signed item, so it is free to re-approve.) */
export function coveringApproval(db: Database, d: Draft, live: ApprovalRow[] = liveApprovals(db, d.batch_id)): string | null {
  const cur = JSON.stringify(manifestItem(d));
  for (const a of live) {
    if (a.batch_id !== d.batch_id) continue;
    const m = parseManifest(a);
    const item = m?.items.find((i) => i.draft_id === d.id);
    if (item && JSON.stringify(item) === cur && !itemConsumed(db, a.id, d.id)) return a.id;
  }
  return null;
}
/** Per-draft covering approval id for a whole batch (null = free to approve). */
export function coverageMap(db: Database, drafts: Draft[]): Map<string, string | null> {
  const live = new Map<string, ApprovalRow[]>();
  const out = new Map<string, string | null>();
  for (const d of drafts) {
    if (!live.has(d.batch_id)) live.set(d.batch_id, liveApprovals(db, d.batch_id));
    out.set(d.id, coveringApproval(db, d, live.get(d.batch_id)!));
  }
  return out;
}

function checkApprovable(db: Database, d: Draft): void {
  const ok = APPROVABLE.includes(d.status) || d.status === "approved";
  if (!ok) throw conflict("draft_not_approvable", `A ${d.status} message can't be approved.`, { draft_id: d.id });
  if (!d.body.trim()) throw conflict("draft_empty", "A message has no text.", { draft_id: d.id });
  if (!d.handle.trim()) throw conflict("draft_no_handle", "A message has no recipient.", { draft_id: d.id });
  if (coveringApproval(db, d)) throw conflict("already_approved", "A message is already in an approval that hasn't been used.", { draft_id: d.id });
  if (d.create_contact && d.proposed_contact && !contactHandlesExact(d.proposed_contact, d.handle)) {
    throw conflict("proposed_contact_mismatch", "A new contact's number or email doesn't match the message's recipient.", { draft_id: d.id });
  }
}

// ---------- options ----------
export type Signer = "secure-enclave";

export interface ApproveOptionsResult {
  challenge_id: string;
  /** The EXACT manifest bytes (a string). The challenge is sha256 of these, and the app signs M(tag, sha256 of these). */
  manifest_bytes: string;
  /** What to sign and which active keys may sign it. */
  se: { tag: "send"; key_ids: string[] };
  manifest: Manifest;
  /** What pacing means for this approval: the estimate shown in the sheet. `enabled: false` = right away, one every 2 s. */
  plan: Plan;
  /** Bodies for display. The app re-hashes each and compares with manifest.items[].body_sha256 before showing the sheet. */
  drafts: { draft_id: string; body: string; warnings: Warning[]; number_in_contact: boolean | null }[];
}

/** Every approval is valid for 24 hours (contact approvals always). A message approval's window grows with pacing: see planSends(). */
export const APPROVAL_HOURS = 24;

export async function approveOptions(cfg: OwnerConfig, db: Database, batchId: string, draftIds: string[],
  includeAnyway: string[] = []): Promise<ApproveOptionsResult> {
  const batch = getBatch(db, batchId);
  if (!batch) throw notFound("Batch not found.");
  if (batch.status === "drafting") throw conflict("batch_drafting", "This batch isn't submitted for review yet.");
  if (batch.status === "cancelled") throw conflict("batch_cancelled", "This batch was cancelled.");
  const unique = [...new Set(draftIds)];
  if (unique.length === 0) throw badRequest("Pick at least one message.");
  if (unique.length > 500) throw badRequest("At most 500 messages per approval.");
  const all = getDrafts(db, batchId);
  const byId = new Map(all.map((d) => [d.id, d]));
  const allow = new Set(includeAnyway);
  const picked: Draft[] = [];
  const held: string[] = [];
  const unsendable: string[] = [];
  for (const id of unique) {
    const d = byId.get(id);
    if (!d) throw badRequest("A message isn't in this batch.", { draft_id: id });
    checkApprovable(db, d);
    if (unsendableWarnings(d.warnings).length) unsendable.push(id); // never approvable, include_anyway or not
    else if (heldWarnings(d.warnings).length && !allow.has(id)) held.push(id);
    picked.push(d);
  }
  if (unsendable.length) {
    throw conflict("draft_unsendable", "Some messages are empty or have an invalid number, so they can't be sent.", { draft_ids: unsendable });
  }
  if (held.length) {
    throw conflict("warnings_unacknowledged", "Some messages have unfilled fields or are exact duplicates, and need an explicit \"include anyway\" before they can be approved.", { draft_ids: held });
  }
  picked.sort((a, b) => a.position - b.position);
  const nativeKeys = listNativeKeys(db, "active");
  if (nativeKeys.length === 0) throw conflict("no_native_keys", "Set up Touch ID approval in the app first.");

  const settings = getSettings(db);
  const transport = settings.transport;
  // The signed not_after is max(24 h, estimated finish + 12 h), at most 7 days, so a paced batch can't expire before it is done.
  const now = new Date();
  const nextSend = readPaceState(db).next_send_at;
  const plan = planSends({
    now, pacing: settings.pacing, queued: queuedAhead(db), count: picked.length, sentToday: sentSinceLocalMidnight(db, now),
    nextSendAt: nextSend ? new Date(nextSend) : null,
  });
  const { manifest, bytes } = buildManifest(batchId, picked, plan.window_hours, transport, newId(), now);
  const stored = b64u(challengeBytes(bytes));
  const challenge_id = storeOwnerChallenge(cfg, db, { kind: "send", target: batchId, challenge: stored, approval_id: manifest.approval_id, manifest: bytes });
  audit(db, "owner", "approval.options", batchId, { challenge_id, approval_id: manifest.approval_id, count: picked.length, transport, window_hours: plan.window_hours, paced: plan.enabled, signer: "secure-enclave" });
  return {
    challenge_id, manifest, manifest_bytes: bytes, plan,
    se: { tag: "send" as const, key_ids: nativeKeys.map((k) => k.key_id) },
    drafts: picked.map((d) => ({ draft_id: d.id, body: d.body, warnings: d.warnings, number_in_contact: numberInContact(db, d) })),
  };
}

/** null when the draft isn't linked to a contact; otherwise whether the draft's handle is one of that contact's handles. */
export function numberInContact(db: Database, d: Pick<Draft, "contact_id" | "handle">): boolean | null {
  if (!d.contact_id) return null;
  return !!db.query("SELECT 1 FROM contact_handles WHERE contact_id = ? AND handle = ?").get(d.contact_id, d.handle);
}

// ---------- verify ----------
export interface ApproveVerifyResult { approval_id: string; manifest_sha256: string; count: number; not_after: string; credential_id: string; transport: "dry" | "live" }

/** Draft ids whose handle, service, body hash or contact-creation payload no longer match what was signed. */
export function changedItems(db: Database, manifest: Manifest): { draft_id: string; reason: string }[] {
  const out: { draft_id: string; reason: string }[] = [];
  for (const item of manifest.items) {
    const r = db.query("SELECT * FROM drafts WHERE id = ?").get(item.draft_id);
    if (!r) { out.push({ draft_id: item.draft_id, reason: "missing" }); continue; }
    const d = rowToDraft(r);
    if (d.batch_id !== manifest.batch_id) out.push({ draft_id: d.id, reason: "wrong_batch" });
    else if (d.handle !== item.to) out.push({ draft_id: d.id, reason: "handle_changed" });
    else if (d.service !== item.service) out.push({ draft_id: d.id, reason: "service_changed" });
    else if (sha256Hex(d.body) !== item.body_sha256) out.push({ draft_id: d.id, reason: "body_changed" });
    else if (JSON.stringify(manifestItem(d).create_contact) !== JSON.stringify(item.create_contact)) out.push({ draft_id: d.id, reason: "contact_changed" });
  }
  return out;
}

export interface ApproveVerifyResult { approval_id: string; manifest_sha256: string; count: number; not_after: string; credential_id: string; transport: "dry" | "live" }

/** Records a verified Secure Enclave approval in ONE immediate transaction: every item is re-checked against the live drafts
 *  first. Rows carry empty authenticator/client data (the executor refuses a row that doesn't) and `credential_id = key_id`. */
export function commitApproval(db: Database, a: {
  manifest: Manifest; bytes: string; batchId: string; credentialId: string; signature: string;
}): ApproveVerifyResult {
  const { manifest, bytes, batchId } = a;
  // IMMEDIATE: the review reproduced SQLITE_BUSY_SNAPSHOT when a second connection wrote between our read and write.
  return db.transaction((): ApproveVerifyResult => {
    const changed = changedItems(db, manifest);
    if (changed.length) throw conflict("draft_changed", "Some messages changed after you opened the approval. Review them and approve again.", { changed });
    for (const item of manifest.items) {
      const d = rowToDraft(db.query("SELECT * FROM drafts WHERE id = ?").get(item.draft_id));
      checkApprovable(db, d);
    }
    const t = nowIso();
    db.query(`INSERT INTO approvals(id, batch_id, manifest, manifest_sha256, credential_id, authenticator_data_b64, client_data_json_b64,
              signature_b64, not_after, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(manifest.approval_id, batchId, bytes, sha256Hex(bytes), a.credentialId, "", "", a.signature, manifest.not_after, t);
    for (const item of manifest.items) {
      db.query("UPDATE drafts SET status = 'approved', updated_at = ? WHERE id = ?").run(t, item.draft_id);
    }
    setBatchStatus(db, batchId, "approved", "owner");
    audit(db, "owner", "approval.create", manifest.approval_id, {
      batch_id: batchId, count: manifest.items.length, credential_id: a.credentialId, manifest_sha256: sha256Hex(bytes), not_after: manifest.not_after,
      transport: manifest.transport, signer: "secure-enclave",
    });
    return { approval_id: manifest.approval_id, manifest_sha256: sha256Hex(bytes), count: manifest.items.length, not_after: manifest.not_after, credential_id: a.credentialId, transport: manifest.transport };
  }).immediate();
}

// ---------- revocation ----------
export interface RevokeResult { approvals: number; drafts: number; approval_ids: string[]; draft_ids: string[]; at: string }
/** Revokes approvals and drops their still-`approved` drafts back to `review` (the executor already refuses revoked
 *  approvals; this keeps the app honest). Returns what was affected, so a stop can be undone. IMMEDIATE. */
export function revokeApprovals(db: Database, where: { batchId?: string; draftId?: string; credentialId?: string; exceptCredentialIds?: string[]; all?: boolean }, actor: string, why: string): RevokeResult {
  return db.transaction((): RevokeResult => {
    let rows = db.query<ApprovalRow & { credential_id: string }, []>("SELECT * FROM approvals WHERE revoked_at IS NULL").all();
    if (where.batchId) rows = rows.filter((a) => a.batch_id === where.batchId);
    if (where.credentialId) rows = rows.filter((a) => a.credential_id === where.credentialId);
    if (where.exceptCredentialIds) rows = rows.filter((a) => !where.exceptCredentialIds!.includes(a.credential_id));
    if (where.draftId) rows = rows.filter((a) => parseManifest(a)?.items.some((i) => i.draft_id === where.draftId));
    const t = nowIso();
    const draftIds: string[] = [];
    const batches = new Set<string>();
    for (const a of rows) {
      db.query("UPDATE approvals SET revoked_at = ? WHERE id = ?").run(t, a.id);
      batches.add(a.batch_id);
      for (const i of parseManifest(a)?.items ?? []) {
        if (db.query("UPDATE drafts SET status = 'review', updated_at = ? WHERE id = ? AND status = 'approved'").run(t, i.draft_id).changes) draftIds.push(i.draft_id);
      }
      audit(db, actor, "approval.revoke", a.id, { why });
    }
    for (const b of batches) {
      const open = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM drafts WHERE batch_id = ? AND status IN ('approved','sending')").get(b)?.n ?? 0;
      const cur = getBatch(db, b);
      if (cur && cur.status === "approved" && open === 0) setBatchStatus(db, b, "review", actor);
    }
    return { approvals: rows.length, drafts: draftIds.length, approval_ids: rows.map((a) => a.id), draft_ids: draftIds, at: t };
  }).immediate();
}

/** Undo of ONE stop event: clears `revoked_at` only on the approvals that stop revoked (still unexpired), puts their
 *  drafts back to `approved` if unchanged since, and restores the kill switch to what it was before the stop. */
export const UNDO_WINDOW_MS = 120_000;
export function undoStop(db: Database, stopId: number, actor: string): { restored_approvals: number; restored_drafts: number; kill_switch: boolean } {
  return db.transaction(() => {
    const row = db.query<{ id: number; at: string; details_json: string }, [number]>("SELECT id, at, details_json FROM audit_log WHERE id = ? AND action = 'stop'").get(stopId);
    if (!row) throw notFound("That stop wasn't found.");
    if (db.query("SELECT 1 FROM audit_log WHERE action = 'stop.undo' AND target = ?").get(String(stopId))) throw conflict("already_undone", "That stop was already undone.");
    if (Date.now() - Date.parse(row.at) > UNDO_WINDOW_MS) throw conflict("undo_expired", "Too late to undo that stop. Approve again instead.");
    const d = JSON.parse(row.details_json) as { approval_ids?: string[]; draft_ids?: string[]; revoked_at?: string; prev?: { kill_switch: boolean; kill_reason: string } };
    const revokedAt = d.revoked_at ?? "";
    const wanted = new Set(d.draft_ids ?? []);
    let approvals = 0, drafts = 0;
    const batches = new Set<string>();
    const t = nowIso();
    for (const id of d.approval_ids ?? []) {
      const a = db.query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE id = ?").get(id);
      if (!a || a.revoked_at !== revokedAt || a.not_after <= t) continue; // revoked by something else since, or expired
      db.query("UPDATE approvals SET revoked_at = NULL WHERE id = ? AND revoked_at = ?").run(id, revokedAt);
      approvals++; batches.add(a.batch_id);
      const m = parseManifest(a);
      const changed = new Set(m ? changedItems(db, m).map((c) => c.draft_id) : []);
      for (const it of m?.items ?? []) {
        if (!wanted.has(it.draft_id) || changed.has(it.draft_id)) continue;
        drafts += db.query("UPDATE drafts SET status = 'approved', updated_at = ? WHERE id = ? AND status = 'review'").run(t, it.draft_id).changes;
      }
    }
    for (const b of batches) {
      const cur = getBatch(db, b);
      const open = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM drafts WHERE batch_id = ? AND status = 'approved'").get(b)?.n ?? 0;
      if (cur && open > 0 && (cur.status === "review" || cur.status === "done")) setBatchStatus(db, b, "approved", actor);
    }
    const s = getSettings(db);
    const prev = d.prev ?? { kill_switch: false, kill_reason: "" };
    // Only undo the kill switch if it is still the one this stop set.
    if (s.kill_switch && s.kill_reason === "owner") {
      setSetting(db, "kill_switch", prev.kill_switch, actor);
      setSetting(db, "kill_reason", prev.kill_switch ? prev.kill_reason : "", actor);
    }
    audit(db, actor, "stop.undo", String(stopId), { restored_approvals: approvals, restored_drafts: drafts });
    return { restored_approvals: approvals, restored_drafts: drafts, kill_switch: getSettings(db).kill_switch };
  }).immediate();
}
