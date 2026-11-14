// Column mapping: header synonyms combined with value sniffing into a confidence per target field.
import { getCountries } from "libphonenumber-js/max";
import { cleanText, normalizeEmail, normalizePhone, slug } from "./normalize";
import { FIELD_NAMES, type FieldMapping, type FieldName, type Mapping, type ParsedTable } from "./types";
export type { Mapping } from "./types";

type Syn = { strong: string[]; weak: string[] };
const SYNONYMS: Record<FieldName, Syn> = {
  given_name: { strong: ["first", "first_name", "firstname", "fname", "f_name", "given", "given_name", "givenname", "forename", "first_names", "name_first", "given_names"], weak: [] },
  family_name: { strong: ["last", "last_name", "lastname", "lname", "l_name", "surname", "family", "family_name", "familyname", "name_last", "last_names", "family_names"], weak: [] },
  display_name: { strong: ["full_name", "fullname", "name", "display_name", "displayname", "contact_name", "recipient_name", "customer_name", "student_name", "guest_name", "full_names", "names"], weak: ["contact", "person", "recipient", "customer", "student", "who"] },
  phone: { strong: ["phone", "phone_number", "phonenumber", "mobile", "mobile_phone", "mobile_number", "mobile_no", "cell", "cell_phone", "cell_number", "cellphone", "tel", "telephone", "whatsapp", "phone_1", "mobile_1", "cell_1", "phone_value", "phone_1_value", "primary_phone", "contact_number", "phone_no", "tel_no", "sms", "text_number", "phones"], weak: ["number", "contact_no"] },
  email: { strong: ["email", "e_mail", "email_address", "e_mail_address", "mail", "email_1", "e_mail_1", "email_1_value", "e_mail_1_value", "primary_email", "email_value", "e_mail_value", "email_addr", "emails"], weak: [] },
  org: { strong: ["company", "org", "organization", "organisation", "employer", "company_name", "organization_name", "organisation_name", "business", "firm", "workplace", "org_name", "university", "institution"], weak: ["school", "account"] },
  notes: { strong: ["notes", "note", "comments", "comment", "memo", "remarks"], weak: ["description", "details"] },
  tags: { strong: ["tags", "tag", "groups", "group", "labels", "categories", "category", "segment", "lists"], weak: ["label", "list"] },
};

const BAD_PHONE = new Set(["type", "label", "ext", "extension", "country", "code", "carrier", "status", "consent", "opt", "optin", "valid", "verified", "id", "count", "date", "sent", "time"]);
const BAD_EMAIL = new Set(["type", "label", "status", "opt", "optin", "valid", "verified", "sent", "bounce", "bounced", "date", "count", "domain", "time", "subscribed"]);
const BAD_ORG = new Set(["title", "type", "size", "id", "domain", "url", "website", "phone", "email", "address", "tel", "role", "position"]);
const NOT_A_NAME = new Set(["user", "username", "file", "nick", "nickname", "middle", "company", "org", "organization", "organisation", "school", "phonetic", "business", "account", "product", "project", "team", "city", "street", "last", "first", "family", "given", "sur", "list", "group", "event", "campaign",
  "manager", "assistant", "spouse", "children", "child", "referred", "referral", "referrer", "partner", "parent", "emergency", "boss", "supervisor"]);
/** Header words that mean the cell belongs to somebody else ("Spouse Phone", "Emergency Contact Email"): never a recipient. */
const OTHER_PERSON = new Set(["emergency", "spouse", "partner", "parent", "parents", "mother", "father", "mom", "dad", "guardian", "assistant", "manager", "referrer", "referred", "referral", "boss", "supervisor", "child", "children", "kid", "kids", "sibling", "brother", "sister", "wife", "husband", "nok"]);
const MOBILE_WORDS = ["mobile", "cell", "cellphone", "iphone", "mob"];
const FIXED_WORDS = ["home", "work", "office", "business", "main", "company", "landline", "fax", "pager", "school", "other"];

/** Header-only score in [0, 1]: 0.95 exact synonym, 0.8 weak synonym, 0.85 token match, 0.7 generic "...name". */
export function headerScore(field: FieldName, header: string): number {
  const s = slug(header);
  const tokens = s.split("_");
  const syn = SYNONYMS[field];
  let score = 0;
  if (syn.strong.includes(s)) score = 0.95;
  else if (syn.weak.includes(s)) score = 0.8;
  else if (field === "phone" && tokens.some((t) => ["phone", "phones", "mobile", "cell", "cellphone", "whatsapp", "tel", "telephone", "sms"].includes(t)) && !tokens.some((t) => BAD_PHONE.has(t))) score = 0.85;
  else if (field === "email" && (tokens.includes("email") || tokens.includes("mail")) && !tokens.some((t) => BAD_EMAIL.has(t))) score = 0.85;
  else if (field === "org" && tokens.some((t) => ["company", "organization", "organisation", "employer"].includes(t)) && !tokens.some((t) => BAD_ORG.has(t))) score = 0.85;
  else if (field === "display_name" && tokens.includes("name") && !tokens.some((t) => NOT_A_NAME.has(t))) score = 0.7;
  else if (field === "notes" && tokens.some((t) => ["notes", "comments"].includes(t))) score = 0.8;
  else if (field === "tags" && (tokens.some((t) => ["tags", "groups"].includes(t)) || (tokens.includes("group") && tokens.includes("membership")))) score = 0.8;
  return score;
}

const NAMEY = /^\p{L}[\p{L}.'’-]*(?:\s+\p{L}[\p{L}.'’-]*){0,3}$/u;

export interface ColumnStats { column: string; n: number; phone: number; email: number; fullName: number; /** non-empty cells over the whole table */ filled: number }

export function columnStats(table: Pick<ParsedTable, "rows">, column: string, sample = 200): ColumnStats {
  const vals: string[] = [];
  let filled = 0;
  for (const r of table.rows) {
    const v = cleanText(r[column]);
    if (v) { filled++; if (vals.length < sample) vals.push(v); }
  }
  const n = vals.length;
  if (!n) return { column, n: 0, phone: 0, email: 0, fullName: 0, filled: 0 };
  let phone = 0, email = 0, fullName = 0;
  for (const v of vals) {
    const parts = v.split(/\s*:::\s*/);
    if (parts.some((x) => normalizeEmail(x))) { email++; continue; }
    if (parts.some((x) => normalizePhone(x).valid)) { phone++; continue; }
    if (NAMEY.test(v) && v.includes(" ")) fullName++;
  }
  return { column, n, phone: phone / n, email: email / n, fullName: fullName / n, filled };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const combine = (h: number, v: number): number => (h > 0 ? (v >= 0.3 ? 1 - (1 - h) * (1 - v) : h * 0.7) : 0);

/** Unique merge-variable slug per column. */
export function columnSlugs(columns: string[]): Record<string, string> {
  const used = new Set<string>();
  const out: Record<string, string> = {};
  for (const c of columns) {
    const base = slug(c);
    let s = base, i = 1;
    while (used.has(s)) { i++; s = `${base}_${i}`; }
    used.add(s);
    out[c] = s;
  }
  return out;
}

/** Slug -> column for every column that isn't the primary column of a mapped field. (Extra phone or email columns stay
 *  available as template fields, e.g. {{home_phone}}.) */
export function unmappedVars(columns: string[], fields: Mapping["fields"]): Record<string, string> {
  const used = new Set(Object.values(fields).map((f) => f!.column));
  const slugs = columnSlugs(columns);
  const out: Record<string, string> = {};
  for (const c of columns) if (!used.has(c)) out[slugs[c]!] = c;
  return out;
}

const headerTokens = (c: string): string[] => slug(c).split("_");
const mobileClass = (c: string): number => {
  const t = headerTokens(c);
  if (t.some((x) => MOBILE_WORDS.includes(x))) return 0;
  if (t.some((x) => FIXED_WORDS.includes(x))) return 2;
  return 1;
};
/** Fill factor: columns at least half full count fully, sparser ones are discounted. */
const fillFactor = (cov: number): number => (cov >= 0.5 ? 1 : 0.4 + cov);

/** Orders and scores the candidate columns of a multi-column field (phone, email). */
function pickList(table: Pick<ParsedTable, "columns" | "rows">, stats: Map<string, ColumnStats>, field: "phone" | "email", skip: (c: string) => boolean): FieldMapping | null {
  const rowsN = Math.max(1, table.rows.length);
  const cands: { c: string; type: number; rank: number; cls: number; idx: number }[] = [];
  table.columns.forEach((c, idx) => {
    if (skip(c) || headerTokens(c).some((t) => OTHER_PERSON.has(t) || t === "fax" || t === "pager")) return;
    const st = stats.get(c)!;
    const v = field === "phone" ? st.phone : st.email;
    const h = headerScore(field, c);
    const sniff = field === "phone" ? 0.85 : 0.95;
    const base = h > 0 ? combine(h, v) : v >= 0.5 ? sniff * v : 0;
    if (base < 0.5) return;
    const cls = field === "phone" ? mobileClass(c) : (headerTokens(c).some((t) => ["work", "office", "business", "company"].includes(t)) ? 2 : 1);
    const bonus = field === "phone" && cls === 0 ? 0.02 : 0;
    const type = Math.min(1, base + bonus);
    cands.push({ c, type, rank: type * fillFactor(st.filled / rowsN), cls, idx });
  });
  if (!cands.length) return null;
  cands.sort((a, b) => a.cls - b.cls || b.rank - a.rank || a.idx - b.idx);
  const cols = cands.map((x) => x.c);
  const union = table.rows.filter((r) => cols.some((c) => cleanText(r[c]) !== "")).length / rowsN;
  const conf = round2(Math.min(1, cands[0]!.type * fillFactor(union)));
  return { column: cols[0]!, confidence: conf, ...(cols.length > 1 ? { columns: cols } : {}) };
}

export function guessMapping(table: Pick<ParsedTable, "columns" | "rows">): Mapping {
  const stats = new Map(table.columns.map((c) => [c, columnStats(table, c)]));
  const taken = new Set<string>();
  const fields: Mapping["fields"] = {};
  const pick = (field: FieldName, score: (c: string) => number) => {
    let best: { c: string; s: number } | null = null;
    for (const c of table.columns) {
      if (taken.has(c)) continue;
      const s = score(c);
      if (s >= 0.5 && (!best || s > best.s + 1e-9)) best = { c, s };
    }
    if (best) { taken.add(best.c); fields[field] = { column: best.c, confidence: round2(Math.min(1, best.s)) }; }
  };

  // Phone and email each map to an ordered LIST of columns (mobile / cell / iPhone first); each row later picks its own best.
  for (const field of ["phone", "email"] as const) {
    const list = pickList(table, stats, field, (c) => taken.has(c));
    if (list) {
      fields[field] = list;
      for (const c of list.columns ?? [list.column]) taken.add(c);
    }
  }
  // A column that is mostly phones/emails is never a name, even under a "name"-ish header.
  const isContactCol = (c: string) => stats.get(c)!.phone >= 0.5 || stats.get(c)!.email >= 0.5;
  for (const f of ["given_name", "family_name", "display_name", "org", "notes", "tags"] as FieldName[]) {
    pick(f, (c) => (isContactCol(c) ? 0 : headerScore(f, c)));
  }
  if (!fields.display_name && !fields.given_name && !fields.family_name) {
    // Headerless or unfamiliar headers: the leftmost column that mostly holds two-word names.
    pick("display_name", (c) => {
      const s = stats.get(c)!;
      return s.n >= 1 && s.fullName >= 0.6 ? 0.6 : 0;
    });
  }
  return { fields, vars: unmappedVars(table.columns, fields), confirmed: false };
}

/** True when the owner must confirm the mapping before it's trusted. */
export function mappingNeedsConfirmation(m: Mapping, unlabeled: string[] = []): boolean {
  if (m.confirmed) return false;
  if (unlabeled.length) return true; // a data column with no header may be a lost merged header: look before trusting it
  const f = m.fields;
  const conf = (k: FieldName) => f[k]?.confidence ?? 0;
  const contactOk = conf("phone") >= 0.8 || conf("email") >= 0.8;
  const nameOk = conf("display_name") >= 0.8 || conf("given_name") >= 0.8 || conf("family_name") >= 0.8;
  const lowMapped = (["phone", "email", "display_name", "given_name", "family_name"] as FieldName[]).some((k) => f[k] && f[k]!.confidence < 0.8);
  return !(contactOk && nameOk) || lowMapped;
}

/** Resolves a column name case-insensitively (and ignoring surrounding spaces) to the exact header. */
export function resolveColumn(name: string, columns: string[]): string | null {
  if (columns.includes(name)) return name;
  const want = String(name).trim().toLowerCase();
  const hits = columns.filter((c) => c.trim().toLowerCase() === want);
  return hits.length >= 1 ? hits[0]! : null;
}

const LIST_FIELDS: FieldName[] = ["phone", "email", "tags"];

/** Validates a caller-supplied mapping against the columns and fills in `vars`/`confirmed`. Column names match
 *  case-insensitively; phone, email and tags may carry an ordered `columns` list next to the primary `column`. */
export function completeMapping(input: Partial<Mapping> & { fields?: Record<string, Partial<FieldMapping> | null | undefined> }, columns: string[]): Mapping {
  const fields: Mapping["fields"] = {};
  const need = (name: string): string => {
    const c = resolveColumn(name, columns);
    if (!c) throw new Error(`Column "${name}" isn't in this import (columns: ${columns.join(", ")})`);
    return c;
  };
  for (const [k, v] of Object.entries(input.fields ?? {})) {
    if (!(FIELD_NAMES as string[]).includes(k)) throw new Error(`Unknown mapping field "${k}"`);
    if (!v) continue;
    const list = (v.columns ?? []).map(need);
    if (v.columns?.length && !LIST_FIELDS.includes(k as FieldName)) throw new Error(`"columns" is only supported for phone, email and tags, not ${k}`);
    const primary = v.column !== undefined && v.column !== "" ? need(v.column) : list[0];
    if (!primary) throw new Error(`Mapping field "${k}" needs a column`);
    const ordered = [primary, ...list.filter((c) => c !== primary)];
    fields[k as FieldName] = {
      column: primary, confidence: typeof v.confidence === "number" ? v.confidence : 1,
      ...(ordered.length > 1 ? { columns: ordered } : {}),
    };
  }
  const cols = Object.values(fields).flatMap((f) => f!.columns ?? [f!.column]);
  if (new Set(cols).size !== cols.length) throw new Error("A column can only be mapped to one field");
  // Every non-primary column is a template field under its slug; caller-supplied aliases ({"when": "Pickup Date"}) are added on top.
  const vars: Record<string, string> = unmappedVars(columns, fields);
  const primaries = new Set(Object.values(fields).map((f) => f!.column));
  for (const [slugName, col] of Object.entries(input.vars ?? {})) {
    const c = need(col);
    if (!primaries.has(c)) vars[slugName] = c;
  }
  const region = input.region !== undefined ? normalizeRegion(input.region) : undefined;
  return { fields, vars, confirmed: input.confirmed ?? true, ...(region ? { region } : {}) };
}

/** "gb" -> "GB". Throws on anything that isn't a known ISO 3166 alpha-2 country code. */
export function normalizeRegion(r: string | undefined | null): string | undefined {
  const t = String(r ?? "").trim().toUpperCase();
  if (!t) return undefined;
  if (!/^[A-Z]{2}$/.test(t) || !(getCountries() as string[]).includes(t)) throw new Error(`region must be a two-letter country code such as US, GB or DE (got "${r}")`);
  return t;
}

/** The template variable names every row of an import offers: the standard fields, every column slug, and mapped vars. */
export const STANDARD_VARS = ["first_name", "last_name", "full_name", "name", "org", "tags"];
export function availableVars(columns: string[], mapping: Pick<Mapping, "vars">): string[] {
  return [...new Set([...STANDARD_VARS, ...Object.values(columnSlugs(columns)), ...Object.keys(mapping.vars ?? {})])];
}
