// Saved groups: Agent Outbox's own named lists of people (not macOS Contacts groups). Pure DB functions, used by the agent
// API, the owner API and tests. A group only decides who a draft is addressed to; it never approves or sends anything.
//
// Identity: a member is its handle (E.164 or lowercased email) within the group. `contact_id` is a convenience link that
// goes null if contacts sync deletes the contact, so the stored handle and name must always be enough on their own.
import type { Database } from "bun:sqlite";
import { newId, nowIso } from "../db";
import { pickHandle } from "./contact-pick";
import { audit, findContactsByHandle, getContact } from "./store";
import type { HandleInfo } from "./deps";

export const MAX_NAME = 80;
export const MAX_DESCRIPTION = 500;
export const MAX_MEMBERS = 5000;
export const MAX_GROUPS = 500;
const MAX_VARS = 50;
const MAX_VAR_VALUE = 500;

/** The one normaliser everyone uses (deps.normalizeHandle in the agent API, loadB().normalizeHandle in the owner API). */
export interface GroupDeps { normalizeHandle(input: string): HandleInfo }

export class GroupError extends Error {
  constructor(public status: 400 | 404 | 409, public code: string, message: string, public details?: unknown) { super(message); }
}

export interface Group { id: string; name: string; description: string; created_by: string; created_at: string; updated_at: string }
export interface GroupSummary extends Group { members: number }
export interface GroupMember {
  handle: string; contact_id: string | null; name: string; vars: Record<string, string>; added_by: string; added_at: string;
  /** The linked contact as it is now, or null (never linked, or the contact was deleted by a contacts sync). */
  contact: { id: string; display_name: string; org: string; other_handles: string[] } | null;
}

/** What a caller may give for one member. At least one of `to` and `contact_id`. */
export interface MemberInput { to?: string; contact_id?: string; name?: string; vars?: Record<string, string | number | boolean> }
export interface Added { handle: string; name: string; contact_id: string | null }
export interface InvalidMember { index: number; input: string; reason: string }
export interface AddResult { added: Added[]; already: Added[]; invalid: InvalidMember[] }

// ---------- names ----------
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\ufeff]");
/** Collapses runs of spaces; 1 to 80 characters, no control or invisible characters. */
export function cleanName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) throw new GroupError(400, "validation_error", "a group needs a name");
  if ([...name].length > MAX_NAME) throw new GroupError(400, "validation_error", `a group name is at most ${MAX_NAME} characters`);
  if (CONTROL.test(name)) throw new GroupError(400, "validation_error", "a group name can't contain control or invisible characters");
  return name;
}
export const nameKey = (name: string): string => name.replace(/\s+/g, " ").trim().toLowerCase();
function cleanDescription(raw: string): string {
  const d = raw.trim();
  if ([...d].length > MAX_DESCRIPTION) throw new GroupError(400, "validation_error", `a description is at most ${MAX_DESCRIPTION} characters`);
  return d;
}

// ---------- groups ----------
const rowToGroup = (r: any): Group => ({
  id: r.id, name: r.name, description: r.description, created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at,
});
const memberCount = (db: Database, id: string): number =>
  (db.query("SELECT COUNT(*) AS n FROM contact_group_members WHERE group_id = ?").get(id) as { n: number }).n;
const summary = (db: Database, g: Group): GroupSummary => ({ ...g, members: memberCount(db, g.id) });

/** A group by id, or by exact name (case-insensitive, spaces collapsed). */
export function resolveGroup(db: Database, ref: string): Group | null {
  const byId = db.query("SELECT * FROM contact_groups WHERE id = ?").get(ref);
  if (byId) return rowToGroup(byId);
  const byName = db.query("SELECT * FROM contact_groups WHERE name_key = ?").get(nameKey(ref));
  return byName ? rowToGroup(byName) : null;
}
export function requireGroup(db: Database, ref: string): Group {
  const g = resolveGroup(db, ref);
  if (!g) throw new GroupError(404, "group_not_found", `no group "${ref}": use an id or the exact name (outbox_list_groups lists them)`);
  return g;
}

export function listGroups(db: Database): GroupSummary[] {
  return (db.query(`SELECT g.*, (SELECT COUNT(*) FROM contact_group_members m WHERE m.group_id = g.id) AS members
      FROM contact_groups g ORDER BY g.name COLLATE NOCASE, g.id`).all() as any[])
    .map((r) => ({ ...rowToGroup(r), members: r.members }));
}
export const groupSummary = (db: Database, ref: string): GroupSummary => summary(db, requireGroup(db, ref));

export function createGroup(db: Database, o: { name: string; description?: string; actor: string; createdBy?: string }): GroupSummary {
  const name = cleanName(o.name);
  const description = cleanDescription(o.description ?? "");
  return db.transaction(() => {
    const clash = db.query("SELECT id FROM contact_groups WHERE name_key = ?").get(nameKey(name)) as { id: string } | null;
    if (clash) throw new GroupError(409, "group_exists", `a group named "${name}" already exists; add to it instead`, { id: clash.id });
    if ((db.query("SELECT COUNT(*) AS n FROM contact_groups").get() as { n: number }).n >= MAX_GROUPS) {
      throw new GroupError(400, "group_limit", `at most ${MAX_GROUPS} groups`);
    }
    const id = newId(); const t = nowIso();
    db.query("INSERT INTO contact_groups(id, name, name_key, description, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, name, nameKey(name), description, o.createdBy ?? o.actor, t, t);
    audit(db, o.actor, "group.create", id, { name });
    return summary(db, rowToGroup(db.query("SELECT * FROM contact_groups WHERE id = ?").get(id)));
  }).immediate();
}

/** Rename and/or change the description. A rename onto another group's name is a 409. */
export function updateGroup(db: Database, ref: string, o: { name?: string; description?: string; actor: string }): GroupSummary {
  return db.transaction(() => {
    const g = requireGroup(db, ref);
    const t = nowIso();
    if (o.name !== undefined) {
      const name = cleanName(o.name);
      if (name !== g.name) {
        const clash = db.query("SELECT id FROM contact_groups WHERE name_key = ? AND id <> ?").get(nameKey(name), g.id) as { id: string } | null;
        if (clash) throw new GroupError(409, "group_exists", `a group named "${name}" already exists`, { id: clash.id });
        db.query("UPDATE contact_groups SET name = ?, name_key = ?, updated_at = ? WHERE id = ?").run(name, nameKey(name), t, g.id);
        audit(db, o.actor, "group.rename", g.id, { from: g.name, to: name });
      }
    }
    if (o.description !== undefined) {
      const d = cleanDescription(o.description);
      if (d !== g.description) db.query("UPDATE contact_groups SET description = ?, updated_at = ? WHERE id = ?").run(d, t, g.id);
    }
    return summary(db, rowToGroup(db.query("SELECT * FROM contact_groups WHERE id = ?").get(g.id)));
  }).immediate();
}

/** Owner only (no agent route calls this). Members go with the group (ON DELETE CASCADE). */
export function deleteGroup(db: Database, ref: string, actor: string): { id: string; name: string; members: number } {
  return db.transaction(() => {
    const g = requireGroup(db, ref);
    const members = memberCount(db, g.id);
    db.query("DELETE FROM contact_groups WHERE id = ?").run(g.id);
    audit(db, actor, "group.delete", g.id, { name: g.name, members });
    return { id: g.id, name: g.name, members };
  }).immediate();
}

// ---------- members ----------
const parseVars = (s: string): Record<string, string> => { try { const v = JSON.parse(s); return v && typeof v === "object" ? v : {}; } catch { return {}; } };

function cleanVars(v: MemberInput["vars"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v ?? {})) {
    if (Object.keys(out).length >= MAX_VARS) break;
    const key = k.trim();
    if (key) out[key] = String(val).slice(0, MAX_VAR_VALUE);
  }
  return out;
}

/** The members, each joined with the contact as it is now (current name, org, all its handles). */
export function listMembers(db: Database, groupId: string): GroupMember[] {
  const rows = db.query(`SELECT m.*, c.id AS c_id, c.display_name AS c_name, c.org AS c_org FROM contact_group_members m
      LEFT JOIN contacts c ON c.id = m.contact_id WHERE m.group_id = ? ORDER BY lower(COALESCE(NULLIF(c.display_name, ''), m.name, m.handle)), m.handle`).all(groupId) as any[];
  const handles = db.query("SELECT handle FROM contact_handles WHERE contact_id = ? ORDER BY handle");
  return rows.map((r) => ({
    handle: r.handle, contact_id: r.contact_id, name: r.name, vars: parseVars(r.vars_json), added_by: r.added_by, added_at: r.added_at,
    contact: r.c_id ? {
      id: r.c_id, display_name: r.c_name, org: r.c_org,
      other_handles: (handles.all(r.c_id) as { handle: string }[]).map((h) => h.handle).filter((h) => h !== r.handle),
    } : null,
  }));
}

export function getGroup(db: Database, ref: string): { group: GroupSummary; members: GroupMember[] } {
  const g = requireGroup(db, ref);
  return { group: summary(db, g), members: listMembers(db, g.id) };
}

interface Resolved { handle: string; contact_id: string | null; name: string; vars: Record<string, string> }

/** Turns one input into a handle plus the linked contact. `lenient` (import rows): a `to` the contact doesn't own is kept
 *  as a plain handle instead of being an error. Same rules as the agent API's resolveItem, with the same normaliser. */
function resolveMember(db: Database, deps: GroupDeps, input: MemberInput, lenient: boolean): Resolved {
  let contact = null as ReturnType<typeof getContact>;
  if (input.contact_id) {
    contact = getContact(db, input.contact_id);
    if (!contact) throw new Error(`contact ${input.contact_id} not found`);
  }
  let handle: string;
  if (input.to) {
    const h = deps.normalizeHandle(input.to);
    if (!h.valid || !h.handle) throw new Error(`"${input.to}" is not a valid phone number or email address`);
    handle = h.handle;
    if (contact) {
      const owns = db.query("SELECT 1 FROM contact_handles WHERE contact_id = ? AND handle = ?").get(contact.id, handle);
      if (!owns) {
        if (!lenient) throw new Error(`${input.to} is not a number or email of contact ${contact.display_name || contact.id}; leave out contact_id, or leave out to to use the contact's own number`);
        contact = null;
      }
    }
    if (!contact) {
      const found = findContactsByHandle(db, handle);
      if (found.length === 1) contact = found[0]!; // linked only when it isn't ambiguous
    }
  } else if (contact) {
    const p = pickHandle(contact);
    if (!p) throw new Error(`contact ${contact.display_name || contact.id} has no phone number or email`);
    handle = p.handle;
  } else {
    throw new Error("give to (a phone number or email) or contact_id");
  }
  return { handle, contact_id: contact?.id ?? null, name: input.name?.trim() || contact?.display_name || "", vars: cleanVars(input.vars) };
}

const label = (m: MemberInput): string => m.to ?? m.contact_id ?? "";

/** Adds people. Dedupes by handle (a person already in the group is reported under `already`, not changed). Bad inputs are
 *  reported under `invalid` and the rest are still added; only the 5000-member cap refuses the whole call. */
export function addMembers(db: Database, deps: GroupDeps, ref: string, inputs: MemberInput[], o: { actor: string; addedBy?: string; lenient?: boolean; source?: string }): AddResult & { group: GroupSummary } {
  return db.transaction(() => {
    const g = requireGroup(db, ref);
    const have = new Set((db.query("SELECT handle FROM contact_group_members WHERE group_id = ?").all(g.id) as { handle: string }[]).map((r) => r.handle));
    const res: AddResult = { added: [], already: [], invalid: [] };
    const fresh: Resolved[] = [];
    const seen = new Set<string>();
    inputs.forEach((input, index) => {
      let r: Resolved;
      try { r = resolveMember(db, deps, input, o.lenient ?? false); }
      catch (e) { res.invalid.push({ index, input: label(input), reason: (e as Error).message }); return; }
      const row = { handle: r.handle, name: r.name, contact_id: r.contact_id };
      if (have.has(r.handle) || seen.has(r.handle)) { res.already.push(row); return; }
      seen.add(r.handle); fresh.push(r); res.added.push(row);
    });
    if (have.size + fresh.length > MAX_MEMBERS) {
      throw new GroupError(400, "group_full", `a group holds at most ${MAX_MEMBERS} people (this one has ${have.size}, and you tried to add ${fresh.length}); nothing was added`);
    }
    const t = nowIso();
    const ins = db.query("INSERT INTO contact_group_members(group_id, handle, contact_id, name, vars_json, added_by, added_at) VALUES (?,?,?,?,?,?,?)");
    for (const r of fresh) ins.run(g.id, r.handle, r.contact_id, r.name, JSON.stringify(r.vars), o.addedBy ?? o.actor, t);
    if (fresh.length) {
      db.query("UPDATE contact_groups SET updated_at = ? WHERE id = ?").run(t, g.id);
      audit(db, o.actor, "group.add", g.id, { count: fresh.length, ...(o.source ? { source: o.source } : {}) });
    }
    return { ...res, group: summary(db, g) };
  }).immediate();
}

export const membersFromContactIds = (ids: string[]): MemberInput[] => ids.map((contact_id) => ({ contact_id }));

/** Member inputs from an ingested import (as returned by getImport, rows with `normalized`, `match`, `vars`). Rows that are
 *  invalid, duplicate, outside `rows`, or without a handle are reported in `invalid` instead of added. */
export function membersFromImport(imp: any, rows?: number[]): { members: MemberInput[]; invalid: InvalidMember[] } {
  const only = rows ? new Set(rows) : null;
  const members: MemberInput[] = []; const invalid: InvalidMember[] = [];
  for (const r of Array.isArray(imp?.rows) ? imp.rows : []) {
    if (only && !only.has(r.row_index)) continue;
    const n = r.normalized;
    const why = r.match === "invalid" || !n?.handle ? "no usable phone number or email" : r.match === "duplicate" ? "duplicate of another row" : null;
    if (why) { invalid.push({ index: r.row_index, input: `row ${r.row_index}`, reason: why }); continue; }
    members.push({
      to: n.handle, ...(r.match === "matched" && r.contact_id ? { contact_id: r.contact_id } : {}),
      name: n.display_name ?? "", vars: r.vars ?? {},
    });
  }
  return { members, invalid };
}

/** Removes by handle and/or contact id. Handles are normalised like everywhere else (a stored handle also matches as typed). */
export function removeMembers(db: Database, deps: GroupDeps, ref: string, o: { handles?: string[]; contact_ids?: string[]; actor: string }): { removed: string[]; not_found: string[]; group: GroupSummary } {
  return db.transaction(() => {
    const g = requireGroup(db, ref);
    const removed: string[] = []; const notFound: string[] = [];
    const del = db.query("DELETE FROM contact_group_members WHERE group_id = ? AND handle = ? RETURNING handle");
    for (const raw of o.handles ?? []) {
      const n = deps.normalizeHandle(raw);
      const hit = (n.valid && n.handle ? del.get(g.id, n.handle) : null) ?? del.get(g.id, raw.trim().toLowerCase());
      if (hit) removed.push((hit as { handle: string }).handle); else notFound.push(raw);
    }
    for (const cid of o.contact_ids ?? []) {
      const rows = db.query("DELETE FROM contact_group_members WHERE group_id = ? AND contact_id = ? RETURNING handle").all(g.id, cid) as { handle: string }[];
      if (rows.length) removed.push(...rows.map((r) => r.handle)); else notFound.push(cid);
    }
    if (removed.length) {
      db.query("UPDATE contact_groups SET updated_at = ? WHERE id = ?").run(nowIso(), g.id);
      audit(db, o.actor, "group.remove", g.id, { count: removed.length });
    }
    return { removed, not_found: notFound, group: summary(db, g) };
  }).immediate();
}

/** Items for the agent API's batch resolver (POST /v1/batches' items), one per member, optionally only some of them.
 *  The linked contact is passed along only while it still owns the handle (a sync may have changed its numbers).
 *  The name is the contact's current name when linked, else the one stored when the member was added. */
export function itemsForBatch(db: Database, deps: GroupDeps, ref: string, o: { only?: string[] } = {}): { group: Group; items: { to: string; contact_id?: string; recipient_name: string; vars: Record<string, string> }[] } {
  const g = requireGroup(db, ref);
  let members = listMembers(db, g.id);
  if (o.only) {
    const want = new Set<string>(); const unknown: string[] = [];
    const have = new Set(members.map((m) => m.handle));
    for (const raw of o.only) {
      const n = deps.normalizeHandle(raw);
      const h = n.valid && n.handle && have.has(n.handle) ? n.handle : have.has(raw.trim().toLowerCase()) ? raw.trim().toLowerCase() : null;
      if (h) want.add(h); else unknown.push(raw);
    }
    if (unknown.length) throw new GroupError(400, "not_in_group", `not in group "${g.name}": ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ", ..." : ""}`, { handles: unknown });
    members = members.filter((m) => want.has(m.handle));
  }
  const owns = db.query("SELECT 1 FROM contact_handles WHERE contact_id = ? AND handle = ?");
  return {
    group: g,
    items: members.map((m) => ({
      to: m.handle,
      ...(m.contact && owns.get(m.contact.id, m.handle) ? { contact_id: m.contact.id } : {}),
      recipient_name: m.contact?.display_name || m.name, vars: m.vars,
    })),
  };
}
