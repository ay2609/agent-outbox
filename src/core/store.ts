// Shared persistence helpers used by every track. Raw SQL against src/db/schema.sql.
// Rule: nothing in TypeScript can send. Approval state changes happen only in src/owner-api.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { newId, nowIso } from "../db";
import type {
  Batch, BatchSource, BatchStatus, Contact, Draft, DraftStatus, ProposedContact, RevisionActor, Service, SettingKey, Settings, Warning,
} from "./types";
import { parsePacing } from "./pacing";

export const sha256Hex = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

const j = <T>(s: string | null | undefined, fallback: T): T => {
  if (s == null || s === "") return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

// ---------- row mappers ----------
export function rowToDraft(r: any): Draft {
  return {
    id: r.id, batch_id: r.batch_id, position: r.position, contact_id: r.contact_id,
    proposed_contact: j<ProposedContact | null>(r.proposed_contact_json, null),
    create_contact: !!r.create_contact, recipient_name: r.recipient_name, handle: r.handle,
    service: r.service, body: r.body, version: r.version, status: r.status, confirmed: !!r.confirmed,
    warnings: j<Warning[]>(r.warnings_json, []), vars: j<Record<string, string>>(r.vars_json, {}),
    notes: r.notes, import_id: r.import_id, import_row: r.import_row, scheduled_for: r.scheduled_for,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}
export function rowToContact(r: any): Contact {
  return {
    id: r.id, source: r.source, macos_id: r.macos_id, display_name: r.display_name, given_name: r.given_name,
    family_name: r.family_name, nickname: r.nickname, org: r.org, phones: j(r.phones_json, []),
    emails: j(r.emails_json, []), tags: j(r.tags_json, []), notes: r.notes, updated_at: r.updated_at,
    synced_at: r.synced_at,
  };
}
export const rowToBatch = (r: any): Batch => ({ ...r });

// ---------- audit ----------
export function audit(db: Database, actor: string, action: string, target: string | null, details: unknown = {}): void {
  db.query("INSERT INTO audit_log(at, actor, action, target, details_json) VALUES (?,?,?,?,?)")
    .run(nowIso(), actor, action, target, JSON.stringify(details));
}

// ---------- settings ----------
export function getSettings(db: Database): Settings {
  const rows = db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings").all();
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    transport: m.transport === "live" ? "live" : "dry",
    // A missing kill_switch row counts as ON (fail closed), matching outbox-exec.
    kill_switch: m.kill_switch !== "0",
    kill_reason: (m.kill_reason === "owner" || m.kill_reason === "breaker") ? m.kill_reason : "",
    breaker_on_failure: m.breaker_on_failure !== "0",
    contacts_transport: m.contacts_transport === "live" ? "live" : "dry",
    pacing: parsePacing(m),
  };
}
export function setSetting(db: Database, key: SettingKey, value: string | number | boolean, actor: string): void {
  const v = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  db.query("INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, v);
  audit(db, actor, "setting.set", key, { value: v });
}

// ---------- contacts ----------
export function findContactsByHandle(db: Database, handle: string): Contact[] {
  return db.query("SELECT c.* FROM contacts c JOIN contact_handles h ON h.contact_id = c.id WHERE h.handle = ?")
    .all(handle).map(rowToContact);
}
export function getContact(db: Database, id: string): Contact | null {
  const r = db.query("SELECT * FROM contacts WHERE id = ?").get(id);
  return r ? rowToContact(r) : null;
}

// ---------- batches & drafts ----------
export function createBatch(db: Database, b: {
  title: string; created_by: string; source: BatchSource; import_id?: string | null;
  template?: string | null; instructions?: string | null; status?: BatchStatus;
}): string {
  const id = newId(); const t = nowIso();
  db.query(`INSERT INTO batches(id,title,created_by,source,import_id,template,instructions,status,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, b.title, b.created_by, b.source, b.import_id ?? null, b.template ?? null, b.instructions ?? null,
      b.status ?? "drafting", t, t);
  audit(db, b.created_by, "batch.create", id, { title: b.title, source: b.source });
  return id;
}

export interface NewDraft {
  handle: string; body: string; service?: Service; recipient_name?: string; contact_id?: string | null;
  proposed_contact?: ProposedContact | null; create_contact?: boolean; warnings?: Warning[];
  vars?: Record<string, string>; notes?: string; import_id?: string | null; import_row?: number | null;
  scheduled_for?: string | null; actor: RevisionActor;
}
export function addDraft(db: Database, batchId: string, d: NewDraft): string {
  const id = newId(); const t = nowIso();
  const pos = (db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM drafts WHERE batch_id = ?").get(batchId)?.n ?? 0);
  db.query(`INSERT INTO drafts(id,batch_id,position,contact_id,proposed_contact_json,create_contact,recipient_name,handle,
             service,body,version,status,warnings_json,vars_json,notes,import_id,import_row,scheduled_for,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,1,'review',?,?,?,?,?,?,?,?)`)
    .run(id, batchId, pos, d.contact_id ?? null, d.proposed_contact ? JSON.stringify(d.proposed_contact) : null,
      d.create_contact ? 1 : 0, d.recipient_name ?? "", d.handle, d.service ?? "auto", d.body,
      JSON.stringify(d.warnings ?? []), JSON.stringify(d.vars ?? {}), d.notes ?? "", d.import_id ?? null,
      d.import_row ?? null, d.scheduled_for ?? null, t, t);
  db.query("INSERT INTO draft_revisions(draft_id, version, body, actor, at) VALUES (?,1,?,?,?)").run(id, d.body, d.actor, t);
  return id;
}

/** Edits a body. Allowed only before sending starts. Editing an approved draft drops it back to 'review':
 *  its body hash no longer matches the signed manifest, so outbox-exec would refuse it anyway. */
export function updateDraftBody(db: Database, draftId: string, body: string, actor: RevisionActor, warnings?: Warning[]): Draft {
  const cur = db.query("SELECT * FROM drafts WHERE id = ?").get(draftId);
  if (!cur) throw new Error(`draft ${draftId} not found`);
  const d = rowToDraft(cur);
  const editable: DraftStatus[] = ["draft", "review", "approved", "skipped", "failed"];
  if (!editable.includes(d.status)) throw new Error(`draft ${draftId} is ${d.status}; it can't be edited`);
  if (actor === "agent" && d.status === "approved") throw new Error(`draft ${draftId} is approved; only the user can change it now`);
  const v = d.version + 1; const t = nowIso();
  const status: DraftStatus = d.status === "approved" ? "review" : d.status;
  db.query("UPDATE drafts SET body = ?, version = ?, status = ?, warnings_json = COALESCE(?, warnings_json), updated_at = ? WHERE id = ?")
    .run(body, v, status, warnings ? JSON.stringify(warnings) : null, t, draftId);
  db.query("INSERT INTO draft_revisions(draft_id, version, body, actor, at) VALUES (?,?,?,?,?)").run(draftId, v, body, actor, t);
  return rowToDraft(db.query("SELECT * FROM drafts WHERE id = ?").get(draftId));
}

export function getBatch(db: Database, id: string): Batch | null {
  const r = db.query("SELECT * FROM batches WHERE id = ?").get(id);
  return r ? rowToBatch(r) : null;
}
export function getDrafts(db: Database, batchId: string): Draft[] {
  return db.query("SELECT * FROM drafts WHERE batch_id = ? ORDER BY position").all(batchId).map(rowToDraft);
}
export function setBatchStatus(db: Database, id: string, status: BatchStatus, actor: string): void {
  db.query("UPDATE batches SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
  audit(db, actor, "batch.status", id, { status });
}
