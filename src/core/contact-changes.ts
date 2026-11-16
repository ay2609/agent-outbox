// Native contact management, TypeScript side. Validation, the create -> update "convert" rule,
// the import -> change-set transform, and the read views shared by the agent API and the user API.
//
// Nothing in here approves, applies or undoes anything: it only PROPOSES (inserts sets and changes as auto_queued or review).
// Approval, rejection and undo belong to the user's side of the server, never to anything that imports this file for proposing.
import type { Database } from "bun:sqlite";
import { newId, nowIso } from "../db";
import { normalizeEmail, normalizePhone } from "../ingest/normalize";
import type { ImportRowRecord } from "../ingest/types";
import { fullNameSkeleton, nameSkeleton } from "./name-skeleton";
import { audit, getContact, rowToContact } from "./store";
import type {
  Contact, ContactChange, ContactChangeKind, ContactChangePayload, ContactChangeSet, ContactChangeStatus, ContactCreatePayload,
  ContactSetSource, ContactSetStatus, ContactUndoPayload, ContactUpdatePayload, Email, Phone,
} from "./types";

export const MAX_NAME_CHARS = 100;
export const MAX_HANDLES = 5;
export const MAX_GROUPS = 5;
export const MAX_EMAIL_CHARS = 254;
/** Per propose call. */
export const MAX_CHANGES = 500;
/** Every created contact also goes into this group (outbox-exec adds it). */
export const OUTBOX_GROUP = "Outbox imports";

/** Names and group names refuse C0/C1 controls, U+2028/2029 and the bidi overrides/isolates (contract v4). Emoji are fine. */
const BAD_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;
/** Default-ignorable / invisible code points: a name made of or padded with these reads as an existing contact's (contract v4
 *  "impersonation" rule). U+200D (ZWJ) and U+FE0F (VS16) stay allowed: emoji sequences need them. */
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B\u200C\u200E\u200F\u2060-\u206F\u3164\uFE00-\uFE0E\uFEFF\uFFA0\u{E0000}-\u{E0FFF}]/u;

export class ContactValidationError extends Error {
  constructor(message: string) { super(message); this.name = "ContactValidationError"; }
}
const bad = (msg: string): never => { throw new ContactValidationError(msg); };

// ---------- field validators ----------
/** A trimmed string. The length limit counts UTF-16 units, the strictest of the possible counts (graphemes <= code points
 *  <= units), so what passes here passes the executor whichever way it counts. */
function textField(v: unknown, what: string, o: { trim?: boolean } = {}): string {
  if (typeof v !== "string") return bad(`${what} must be a string`);
  const s = o.trim === false ? v : v.trim();
  if (s.length > MAX_NAME_CHARS) return bad(`${what} is longer than ${MAX_NAME_CHARS} characters`);
  if (BAD_CHARS.test(s)) return bad(`${what} has a control or direction-override character, which isn't allowed`);
  // Checked on the raw text, after the control/bidi ban (U+2066-2069 are in both lists): trim() would quietly strip a leading
  // or trailing U+FEFF.
  if (INVISIBLE.test(v)) return bad(`${what} contains an invisible character, which isn't allowed`);
  return s;
}
function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) bad(`${what} has unknown field(s): ${extra.join(", ")}`);
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function phoneList(v: unknown, what: string, region: string): Phone[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return bad(`${what} must be a list`);
  if (v.length > MAX_HANDLES) bad(`${what} has more than ${MAX_HANDLES} entries`);
  const out: Phone[] = [];
  for (const it of v) {
    let raw: unknown, label: unknown;
    if (typeof it === "string") raw = it;
    else if (isObj(it)) { onlyKeys(it, ["e164", "label", "raw"], `a phone in ${what}`); raw = it.e164; label = it.label; }
    else return bad(`${what} entries must be text or {e164, label}`);
    if (typeof raw !== "string" || !raw.trim()) return bad(`${what} has an empty phone number`);
    const n = normalizePhone(raw, region);
    if (!n.valid || !n.e164) return bad(`"${raw}" isn't a valid phone number (use a number with its country code, like +14155550123)`);
    if (out.some((p) => p.e164 === n.e164)) return bad(`${n.e164} is listed twice in ${what}`);
    const l = label === undefined || label === null || label === "" ? "mobile" : textField(label, `a label in ${what}`);
    out.push({ e164: n.e164, label: l || "mobile" });
  }
  return out;
}
function emailList(v: unknown, what: string): Email[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return bad(`${what} must be a list`);
  if (v.length > MAX_HANDLES) bad(`${what} has more than ${MAX_HANDLES} entries`);
  const out: Email[] = [];
  for (const it of v) {
    let raw: unknown, label: unknown;
    if (typeof it === "string") raw = it;
    else if (isObj(it)) { onlyKeys(it, ["email", "label"], `an email in ${what}`); raw = it.email; label = it.label; }
    else return bad(`${what} entries must be text or {email, label}`);
    if (typeof raw !== "string" || !raw.trim()) return bad(`${what} has an empty email address`);
    const e = normalizeEmail(raw);
    if (!e) return bad(`"${raw}" isn't a valid email address`);
    if (raw.trim().length > MAX_EMAIL_CHARS || e.length > MAX_EMAIL_CHARS) return bad(`an email address in ${what} is longer than ${MAX_EMAIL_CHARS} characters`);
    if (out.some((x) => x.email === e)) return bad(`${e} is listed twice in ${what}`);
    const l = label === undefined || label === null || label === "" ? "home" : textField(label, `a label in ${what}`);
    out.push({ email: e, label: l || "home" });
  }
  return out;
}
function groupList(v: unknown, what: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return bad(`${what} must be a list`);
  const out: string[] = [];
  for (const g of v) {
    const s = textField(g, `a group in ${what}`);
    if (!s) return bad(`${what} has an empty group name`);
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > MAX_GROUPS) bad(`${what} has more than ${MAX_GROUPS} groups`);
  return out;
}
function nameFields(o: Record<string, unknown>, what: string): { given_name?: string; family_name?: string; nickname?: string; org?: string } {
  const out: { given_name?: string; family_name?: string; nickname?: string; org?: string } = {};
  for (const k of ["given_name", "family_name", "nickname", "org"] as const) {
    if (o[k] !== undefined && o[k] !== null) out[k] = textField(o[k], `${what} ${k}`);
  }
  return out;
}

// ---------- payload validators (the same rules the executor applies) ----------
/** kind = create. Strict: unknown keys are refused. Returns the canonical payload (the key order is fixed). */
export function validateCreate(raw: unknown, region = "US"): ContactCreatePayload {
  if (!isObj(raw)) return bad("a new contact must be an object");
  onlyKeys(raw, ["given_name", "family_name", "nickname", "org", "phones", "emails", "groups"], "a new contact");
  const n = nameFields(raw, "a new contact's");
  const given = n.given_name ?? "", family = n.family_name ?? "";
  if (!given && !family) bad("a new contact needs a first or last name");
  const phones = phoneList(raw.phones, "phones", region);
  const emails = emailList(raw.emails, "emails");
  if (phones.length + emails.length === 0) bad("a new contact needs at least one phone number or email");
  const groups = groupList(raw.groups, "groups");
  return {
    given_name: given, family_name: family,
    ...(n.nickname ? { nickname: n.nickname } : {}), ...(n.org ? { org: n.org } : {}),
    phones, emails, ...(groups.length ? { groups } : {}),
  };
}

/** kind = update. At least one change; `set` only takes the four name fields. `from_create` is accepted only when the
 *  caller says so (a stored payload that convert wrote), never from an agent's input. */
export function validateUpdate(raw: unknown, o: { region?: string; allowFromCreate?: boolean } = {}): ContactUpdatePayload {
  if (!isObj(raw)) return bad("an edit must be an object");
  onlyKeys(raw, ["set", "add_phones", "add_emails", "add_groups", ...(o.allowFromCreate ? ["from_create"] : [])], "an edit");
  let set: ReturnType<typeof nameFields> = {};
  if (raw.set !== undefined && raw.set !== null) {
    if (!isObj(raw.set)) bad("set must be an object");
    onlyKeys(raw.set as Record<string, unknown>, ["given_name", "family_name", "nickname", "org"], "set");
    set = nameFields(raw.set as Record<string, unknown>, "set");
  }
  const add_phones = phoneList(raw.add_phones, "add_phones", o.region ?? "US");
  const add_emails = emailList(raw.add_emails, "add_emails");
  const add_groups = groupList(raw.add_groups, "add_groups");
  if (raw.from_create !== undefined && raw.from_create !== true) bad("from_create can only be true");
  const out: ContactUpdatePayload = {};
  if (Object.keys(set).length) out.set = set;
  if (add_phones.length) out.add_phones = add_phones;
  if (add_emails.length) out.add_emails = add_emails;
  if (add_groups.length) out.add_groups = add_groups;
  if (!Object.keys(out).length) bad("an edit needs at least one change (set a name field, or add a phone, email or group)");
  if (raw.from_create === true) out.from_create = true;
  return out;
}

export function validateUndo(raw: unknown): ContactUndoPayload {
  if (!isObj(raw)) return bad("an undo must be an object");
  onlyKeys(raw, ["undo_of", "undo_kind", "before_vcard_sha256", "after_fingerprint"], "an undo");
  if (typeof raw.undo_of !== "string" || !raw.undo_of) bad("undo_of is required");
  if (raw.undo_kind !== "create" && raw.undo_kind !== "update") bad("undo_kind must be create or update");
  if (raw.before_vcard_sha256 !== null && !(typeof raw.before_vcard_sha256 === "string" && /^[0-9a-f]{64}$/.test(raw.before_vcard_sha256))) bad("before_vcard_sha256 must be a sha256 hex string or null");
  if (typeof raw.after_fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(raw.after_fingerprint)) bad("after_fingerprint must be 64 lowercase hex characters");
  return raw as unknown as ContactUndoPayload;
}

/** Validates a STORED payload_json by kind (re-checked just before a signature is accepted). Structural only: the bytes
 *  are what gets hashed, so they are never rewritten. */
export function checkStoredPayload(kind: ContactChangeKind, payloadJson: string): ContactChangePayload {
  let parsed: unknown;
  try { parsed = JSON.parse(payloadJson); } catch { return bad("the stored payload isn't valid JSON"); }
  if (kind === "create") return validateCreate(parsed);
  if (kind === "update") return validateUpdate(parsed, { allowFromCreate: true });
  return validateUndo(parsed);
}

// ---------- comparing with a cached card ----------
const lc = (s: string) => s.toLowerCase();
const sameFields = (a: { given_name?: string; family_name?: string; nickname?: string; org?: string }, c: Contact): string[] =>
  (["given_name", "family_name", "nickname", "org"] as const).filter((k) => a[k] !== undefined && a[k] !== c[k]);

/** Would this edit change the cached card at all? (A no-op edit is stored as rejected, not sent for approval.) */
export function isEffective(card: Contact, u: ContactUpdatePayload): boolean {
  if (u.set && sameFields(u.set, card).length) return true;
  const phones = new Set(card.phones.map((p) => p.e164));
  if ((u.add_phones ?? []).some((p) => !phones.has(p.e164))) return true;
  const emails = new Set(card.emails.map((e) => lc(e.email)));
  if ((u.add_emails ?? []).some((e) => !emails.has(lc(e.email)))) return true;
  const tags = new Set(card.tags.map(lc));
  return (u.add_groups ?? []).some((g) => !tags.has(lc(g)));
}

/** The convert rule (contract v4): a create whose handle is already on a card becomes an edit of that card.
 *  set = the create's non-empty name fields that differ; add_* = the create's handles the card lacks; add_groups = its groups. */
export function convertCreateToUpdate(card: Contact, c: ContactCreatePayload): ContactUpdatePayload {
  const set: Record<string, string> = {};
  for (const k of ["given_name", "family_name", "nickname", "org"] as const) {
    const v = c[k];
    if (v && v !== card[k]) set[k] = v;
  }
  const phones = new Set(card.phones.map((p) => p.e164));
  const emails = new Set(card.emails.map((e) => lc(e.email)));
  const add_phones = c.phones.filter((p) => !phones.has(p.e164));
  const add_emails = c.emails.filter((e) => !emails.has(lc(e.email)));
  const out: ContactUpdatePayload = {};
  if (Object.keys(set).length) out.set = set;
  if (add_phones.length) out.add_phones = add_phones;
  if (add_emails.length) out.add_emails = add_emails;
  if (c.groups?.length) out.add_groups = c.groups;
  out.from_create = true;
  return out;
}

// ---------- proposing ----------
export interface ProposedUpdate { contact: Contact; payload: ContactUpdatePayload }
export interface ProposedChangeResult { id: string; kind: ContactChangeKind; status: ContactChangeStatus; note: string; target_contact_id: string | null }
export interface ProposeResult {
  set_id: string;
  status: ContactSetStatus;
  counts: { auto_queued: number; review: number; rejected: number };
  changes: ProposedChangeResult[];
}

/** Distinct cached macOS contacts that own any of these handles. */
function cachedOwners(db: Database, handles: string[]): Contact[] {
  if (!handles.length) return [];
  const rows = db.query(`SELECT DISTINCT c.* FROM contacts c JOIN contact_handles h ON h.contact_id = c.id
                         WHERE c.macos_id IS NOT NULL AND h.handle IN (${handles.map(() => "?").join(",")})`).all(...handles);
  return rows.map(rowToContact);
}

interface Resolved {
  kind: "create" | "update"; target: Contact | null; payload: ContactChangePayload;
  status: ContactChangeStatus; requires_approval: boolean; note: string;
}

/** The cache's view of the address book, for the early (propose-time) look-alike checks on creates. Built once per proposal,
 *  and only when there is a create to check. The executor repeats both checks against the live address book. */
export interface CreateGuard {
  /** skeleton of "given family", of given alone, and of nickname, over every cached macOS contact. */
  full: Set<string>; given: Set<string>; nick: Set<string>;
  /** Lowercased names of every group any cached contact is in. */
  groups: Set<string>;
}
export function buildCreateGuard(db: Database): CreateGuard {
  const g: CreateGuard = { full: new Set(), given: new Set(), nick: new Set(), groups: new Set() };
  for (const r of db.query("SELECT given_name, family_name, nickname FROM contacts WHERE macos_id IS NOT NULL").all() as { given_name: string; family_name: string; nickname: string }[]) {
    const f = fullNameSkeleton(r.given_name, r.family_name);
    if (f) g.full.add(f);
    const gv = nameSkeleton(r.given_name);
    if (gv) g.given.add(gv);
    const n = nameSkeleton(r.nickname);
    if (n) g.nick.add(n);
  }
  try {
    for (const r of db.query("SELECT groups_json FROM contact_attrs").all() as { groups_json: string }[]) {
      let list: unknown = [];
      try { list = JSON.parse(r.groups_json); } catch { /* a bad row names no group */ }
      if (Array.isArray(list)) for (const x of list) if (typeof x === "string" && x.trim()) g.groups.add(lc(x.trim()));
    }
  } catch { /* contact_attrs not created yet: no export has carried groups */ }
  return g;
}

/** Why an otherwise-automatic create must wait for the user (empty when it can go ahead). */
export function createReviewReasons(c: ContactCreatePayload, guard: CreateGuard): string[] {
  const why: string[] = [];
  if (!c.given_name || !c.family_name) why.push("only one name; please check");
  const full = fullNameSkeleton(c.given_name, c.family_name);
  const nick = c.nickname ? nameSkeleton(c.nickname) : "";
  if ((full && guard.full.has(full)) || (nick && (guard.full.has(nick) || guard.given.has(nick) || guard.nick.has(nick)))) why.push("same name as an existing contact");
  if ((c.groups ?? []).some((g) => lc(g) !== lc(OUTBOX_GROUP) && guard.groups.has(lc(g)))) why.push("joins an existing group");
  return why;
}

/** A create either queues for automatic apply, waits for the user as a create (single name, look-alike name, existing group),
 *  converts to an edit that waits for the user, or is rejected. */
function resolveCreate(db: Database, c: ContactCreatePayload, guard: () => CreateGuard): Resolved {
  const handles = [...c.phones.map((p) => p.e164), ...c.emails.map((e) => lc(e.email))];
  const owners = cachedOwners(db, handles);
  if (owners.length === 0) {
    const why = createReviewReasons(c, guard());
    if (why.length) return { kind: "create", target: null, payload: c, status: "review", requires_approval: true, note: why.join("; ") };
    return { kind: "create", target: null, payload: c, status: "auto_queued", requires_approval: false, note: "" };
  }
  if (owners.length > 1) {
    return { kind: "create", target: null, payload: c, status: "rejected", requires_approval: true, note: `its numbers or emails match ${owners.length} different contacts, so it can't be added automatically` };
  }
  const card = owners[0]!;
  const u = convertCreateToUpdate(card, c);
  if (!isEffective(card, u)) return { kind: "update", target: card, payload: u, status: "rejected", requires_approval: true, note: "already in Contacts, nothing to change" };
  return { kind: "update", target: card, payload: u, status: "review", requires_approval: true, note: "already in Contacts" };
}

function resolveUpdate(u: ProposedUpdate): Resolved {
  if (!isEffective(u.contact, u.payload)) {
    return { kind: "update", target: u.contact, payload: u.payload, status: "rejected", requires_approval: true, note: "nothing to change: the card already has this" };
  }
  return { kind: "update", target: u.contact, payload: u.payload, status: "review", requires_approval: true, note: "" };
}

/** Inserts one set with its changes. Creates are queued for the executor (auto_queued) unless the cache already knows one of
 *  their handles (then they convert to an edit) or they look risky (one name only, a name that looks like an existing
 *  contact's, joining an existing group: they wait in review as creates); edits wait in review. One IMMEDIATE transaction, one audit row. Every payload is serialised exactly once. */
export function proposeContactChanges(db: Database, o: {
  title: string; created_by: string; source: ContactSetSource; creates: ContactCreatePayload[]; updates: ProposedUpdate[];
}): ProposeResult {
  return db.transaction((): ProposeResult => {
    const t = nowIso();
    let guard: CreateGuard | null = null;
    const getGuard = () => (guard ??= buildCreateGuard(db));
    const resolved: Resolved[] = [...o.creates.map((c) => resolveCreate(db, c, getGuard)), ...o.updates.map(resolveUpdate)];
    const count = (s: ContactChangeStatus) => resolved.filter((r) => r.status === s).length;
    // Agents can only create a set as drafting (nothing awaiting the user) or review, never as approved/applying/done.
    const status: ContactSetStatus = count("review") > 0 ? "review" : count("auto_queued") > 0 ? "drafting" : "cancelled";
    const setId = newId();
    db.query("INSERT INTO contact_change_sets(id, title, created_by, source, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(setId, o.title, o.created_by, o.source, status, t, t);
    const changes: ProposedChangeResult[] = [];
    resolved.forEach((r, position) => {
      const id = newId();
      db.query(`INSERT INTO contact_changes(id, set_id, position, kind, target_contact_id, target_macos_id, payload_json, requires_approval,
                  status, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, setId, position, r.kind, r.target?.id ?? null, r.target?.macos_id ?? null, JSON.stringify(r.payload),
          r.requires_approval ? 1 : 0, r.status, r.note, t);
      changes.push({ id, kind: r.kind, status: r.status, note: r.note, target_contact_id: r.target?.id ?? null });
    });
    const counts = { auto_queued: count("auto_queued"), review: count("review"), rejected: count("rejected") };
    audit(db, o.created_by, "contact_changes.propose", setId, { title: o.title, source: o.source, ...counts, creates: o.creates.length, updates: o.updates.length });
    return { set_id: setId, status, counts, changes };
  }).immediate();
}

/** Throws ContactValidationError listing every problem, so nothing is created when any item is bad. */
export function validateProposal(db: Database, input: { creates?: unknown[]; updates?: unknown[]; region?: string }): { creates: ContactCreatePayload[]; updates: ProposedUpdate[] } {
  const errors: string[] = [];
  const creates: ContactCreatePayload[] = [];
  const createIdx: number[] = []; // each valid create's index in the caller's list, for messages
  const updates: ProposedUpdate[] = [];
  (input.creates ?? []).forEach((raw, i) => {
    try { creates.push(validateCreate(raw, input.region)); createIdx.push(i); }
    catch (e) { if (e instanceof ContactValidationError) errors.push(`creates[${i}]: ${e.message}`); else throw e; }
  });
  // The same number or email in two creates would add the person twice.
  const seen = new Map<string, number>();
  creates.forEach((c, k) => {
    for (const h of [...c.phones.map((p) => p.e164), ...c.emails.map((e) => lc(e.email))]) {
      if (seen.has(h)) errors.push(`creates[${createIdx[k]}]: ${h} is also in creates[${seen.get(h)}]`);
      else seen.set(h, createIdx[k]!);
    }
  });
  const seenContacts = new Set<string>();
  (input.updates ?? []).forEach((raw, i) => {
    try {
      if (!isObj(raw)) return bad("an edit must be an object");
      const { contact_id, ...rest } = raw;
      if (typeof contact_id !== "string" || !contact_id) return bad("contact_id is required (an id from outbox_search_contacts)");
      const contact = getContact(db, contact_id);
      if (!contact) return bad(`contact ${contact_id} not found`);
      if (!contact.macos_id) return bad(`contact ${contact.display_name || contact_id} isn't in the Mac's Contacts (it has no macOS id), so it can't be edited`);
      if (seenContacts.has(contact.id)) return bad(`contact ${contact.display_name || contact_id} is edited twice in one proposal; combine the edits`);
      seenContacts.add(contact.id);
      updates.push({ contact, payload: validateUpdate(rest, { region: input.region }) });
    } catch (e) { if (e instanceof ContactValidationError) errors.push(`updates[${i}]: ${e.message}`); else throw e; }
  });
  if (errors.length) throw new ContactValidationError(errors.length === 1 ? errors[0]! : `${errors.length} problems: ${errors.slice(0, 5).join("; ")}${errors.length > 5 ? "; ..." : ""}`);
  if (creates.length + updates.length === 0) bad("nothing to propose: give creates and/or updates");
  if (creates.length + updates.length > MAX_CHANGES) bad(`at most ${MAX_CHANGES} changes per proposal (got ${creates.length + updates.length})`);
  return { creates, updates };
}

// ---------- import -> change set ----------
export interface ImportPlanOptions { prefix?: string; suffix?: string; include?: number[]; groups?: string[] }
export interface ImportPlan {
  creates: { payload: ContactCreatePayload; row_index: number }[];
  updates: (ProposedUpdate & { row_index: number })[];
  skipped: { row_index: number; reason: string }[];
}

/** Turns an import's rows into creates and edits. Matched rows become an edit of the CACHE contact (their given name is the
 *  cache's, not the spreadsheet's): given_name = prefix + given + suffix, skipped as "already done" when it already starts
 *  with the prefix and ends with the suffix. New rows become creates. Ambiguous, invalid and duplicate rows are skipped. */
export function planFromImport(db: Database, rows: ImportRowRecord[], o: ImportPlanOptions): ImportPlan {
  const prefix = o.prefix === undefined ? "" : textField(o.prefix, "first_name_prefix", { trim: false });
  const suffix = o.suffix === undefined ? "" : textField(o.suffix, "first_name_suffix", { trim: false });
  const groups = groupList(o.groups, "groups");
  const include = o.include ? new Set(o.include) : null;
  const plan: ImportPlan = { creates: [], updates: [], skipped: [] };
  const skip = (row_index: number, reason: string) => plan.skipped.push({ row_index, reason });
  for (const row of rows) {
    const i = row.row_index;
    if (include && !include.has(i)) continue;
    if (row.match === "invalid") { skip(i, "No usable phone number or email"); continue; }
    if (row.match === "duplicate") {
      const d = row.issues.find((x) => x.code === "duplicate_of_row" || x.code === "duplicate_person");
      skip(i, d?.row !== undefined ? (d.code === "duplicate_person" ? `Same person as row ${d.row}` : `Duplicate of row ${d.row}`) : "Duplicate row");
      continue;
    }
    if (row.match === "ambiguous") { skip(i, "Matches more than one contact; resolve it in the import first"); continue; }
    if (row.match === "matched") {
      const card = row.contact_id ? getContact(db, row.contact_id) : null;
      if (!card) { skip(i, "The matched contact isn't in the cache any more"); continue; }
      if (!card.macos_id) { skip(i, `${card.display_name || "That contact"} isn't in the Mac's Contacts, so it can't be edited`); continue; }
      const given = card.given_name;
      const set: Record<string, string> = {};
      if ((prefix || suffix) && given) {
        const next = prefix + given + suffix;
        if (!(given.startsWith(prefix) && given.endsWith(suffix))) set.given_name = next;
      }
      const have = new Set(card.tags.map(lc));
      const add_groups = groups.filter((g) => !have.has(lc(g)));
      if (!Object.keys(set).length && !add_groups.length) {
        skip(i, !given && (prefix || suffix) ? "The contact has no first name" : prefix || suffix || groups.length ? "Already done" : "No name change asked for");
        continue;
      }
      try {
        plan.updates.push({ row_index: i, contact: card, payload: validateUpdate({ ...(Object.keys(set).length ? { set } : {}), ...(add_groups.length ? { add_groups } : {}) }) });
      } catch (e) { if (e instanceof ContactValidationError) skip(i, e.message); else throw e; }
      continue;
    }
    // match === "new"
    const n = row.normalized;
    const phones = n.phones?.length ? n.phones : n.phone_e164 ? [n.phone_e164] : [];
    const emails = n.emails?.length ? n.emails : n.email ? [n.email] : [];
    // Same idempotence as matched rows: a sheet that already carries the prefix/suffix doesn't get it twice.
    const given = !n.given_name ? n.given_name
      : (n.given_name.startsWith(prefix) ? "" : prefix) + n.given_name + (n.given_name.endsWith(suffix) ? "" : suffix);
    try {
      plan.creates.push({
        row_index: i,
        payload: validateCreate({
          given_name: given, family_name: n.family_name, ...(n.org ? { org: n.org } : {}),
          phones: phones.slice(0, MAX_HANDLES), emails: emails.slice(0, MAX_HANDLES), ...(groups.length ? { groups } : {}),
        }),
      });
    } catch (e) { if (e instanceof ContactValidationError) skip(i, e.message); else throw e; }
  }
  return plan;
}

// ---------- reading ----------
export function rowToContactChange(r: any): ContactChange {
  let payload: ContactChangePayload = {} as ContactChangePayload;
  try { payload = JSON.parse(r.payload_json); } catch { /* shown as empty; approval re-validates and refuses */ }
  return {
    id: r.id, set_id: r.set_id, position: r.position, kind: r.kind, target_contact_id: r.target_contact_id, target_macos_id: r.target_macos_id,
    payload_json: r.payload_json, payload, requires_approval: !!r.requires_approval, status: r.status, note: r.note ?? "",
    transport: r.transport, before_vcard: r.before_vcard, after_fingerprint: r.after_fingerprint, result_macos_id: r.result_macos_id,
    error: r.error, created_at: r.created_at, applied_at: r.applied_at, undo_of: r.undo_of,
  };
}
export function getContactSet(db: Database, id: string): ContactChangeSet | null {
  return (db.query("SELECT * FROM contact_change_sets WHERE id = ?").get(id) as ContactChangeSet | null) ?? null;
}
export function getContactChanges(db: Database, setId: string): ContactChange[] {
  return db.query("SELECT * FROM contact_changes WHERE set_id = ? ORDER BY position, created_at").all(setId).map(rowToContactChange);
}
export function contactSetCounts(db: Database, setId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db.query("SELECT status, COUNT(*) AS n FROM contact_changes WHERE set_id = ? GROUP BY status").all(setId) as { status: string; n: number }[]) out[r.status] = r.n;
  return out;
}

/** What the target card looks like in the cache right now, for the "before" side of a diff. Display only. */
export interface ContactBefore {
  contact_id: string; display_name: string; given_name: string; family_name: string; nickname: string; org: string;
  phones: string[]; emails: string[]; groups: string[];
}
export function contactBefore(db: Database, ch: Pick<ContactChange, "target_contact_id" | "target_macos_id">): ContactBefore | null {
  let c: Contact | null = ch.target_contact_id ? getContact(db, ch.target_contact_id) : null;
  if (!c && ch.target_macos_id) {
    const r = db.query("SELECT * FROM contacts WHERE macos_id = ?").get(ch.target_macos_id);
    c = r ? rowToContact(r) : null;
  }
  if (!c) return null;
  return {
    contact_id: c.id, display_name: c.display_name, given_name: c.given_name, family_name: c.family_name, nickname: c.nickname, org: c.org,
    phones: c.phones.map((p) => p.e164), emails: c.emails.map((e) => e.email), groups: c.tags,
  };
}

/** One change as an API client sees it. The before-snapshot (`before_vcard`: a canonical JSON snapshot `{"v":1,...}` since 2026-11-10, a vCard in older rows) stays internal; the dashboard never parses it. `payload_json` only where asked (the user's
 *  confirm sheet hashes it). */
export function contactChangeView(db: Database, ch: ContactChange, o: { payloadJson?: boolean } = {}) {
  const { before_vcard, payload_json, ...rest } = ch;
  return { ...rest, ...(o.payloadJson ? { payload_json } : {}), has_snapshot: before_vcard !== null, before: ch.kind === "create" ? null : contactBefore(db, ch) };
}
export function contactSetView(db: Database, set: ContactChangeSet, o: { origin: string }) {
  const changes = getContactChanges(db, set.id).map((c) => contactChangeView(db, c));
  return {
    set, counts: contactSetCounts(db, set.id), changes,
    dashboard_url: `${o.origin.replace(/\/$/, "")}/#/contacts/changes/${set.id}`,
  };
}
