// Ingest: store the raw upload, parse, map, normalise, dedupe, match against known contacts.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId, nowIso } from "../db";
import { paths } from "../core/paths";
import { audit, findContactsByHandle, sha256Hex } from "../core/store";
import type { Contact, MatchStatus } from "../core/types";
import { columnSlugs, completeMapping, guessMapping, mappingNeedsConfirmation, normalizeRegion, unmappedVars } from "./mapping";
export { availableVars, STANDARD_VARS } from "./mapping";
import { cleanText, isShoutedName, nameKey, splitName } from "./normalize";
import { parseFile } from "./parse";
import { scanEmails, scanPhones, splitTags } from "./rows";
import type { ImportIssue, ImportRowRecord, ImportSummary, IssueCandidate, Mapping, NormalizedRow } from "./types";

export class NotFoundError extends Error {
  status = 404;
  constructor(what: string) { super(what); this.name = "NotFoundError"; }
}

/** A file that can't become an import. `code` is `empty_file` or `no_rows`. */
export class IngestError extends Error {
  status = 400;
  constructor(public code: "empty_file" | "no_rows", message: string) { super(message); this.name = "IngestError"; }
}

const EXT_FOR_KIND: Record<string, string> = { csv: "csv", tsv: "tsv", xlsx: "xlsx", xls: "xls", ods: "ods", numbers: "numbers", vcf: "vcf", json: "json", jsonl: "jsonl", text: "txt" };

// ---------------------------------------------------------------- normalisation
const colsOf = (f: Mapping["fields"][keyof Mapping["fields"]]): string[] => (f ? (f.columns?.length ? f.columns : [f.column]) : []);
const REGION_HINT = "If it's an international number, add a country code like +44 or set region";

export function normalizeRow(raw: Record<string, string>, mapping: Mapping, region?: string): { row: NormalizedRow; issues: ImportIssue[] } {
  const rg = region ?? mapping.region ?? "US";
  const f = mapping.fields;
  const get = (k: keyof Mapping["fields"]) => (f[k] ? cleanText(raw[f[k]!.column]) : "");
  const issues: ImportIssue[] = [];

  let given = get("given_name");
  let family = get("family_name");
  let display = get("display_name");
  const originalDisplay = display;
  if (!given && !family && display) {
    const s = splitName(display);
    given = s.given_name; family = s.family_name;
  } else if (given && !family && !f.family_name && /\s/.test(given) && !(display && nameKey(given) === nameKey(display))) {
    const s = splitName(given); // a "First Name" column that holds a full name
    given = s.given_name; family = s.family_name;
  }
  const joined = [given, family].filter(Boolean).join(" ");
  // Keep the name as written, unless it is "Last, First" or in shouting / all-lowercase case, which the split repairs.
  display = originalDisplay && !originalDisplay.includes(",") && !isShoutedName(originalDisplay) ? originalDisplay : joined || originalDisplay;

  // ---- every phone and email in the row, best first
  const phoneScan = scanPhones(raw, colsOf(f.phone), rg);
  const emailScan = scanEmails(raw, colsOf(f.email));
  const bestPhone = phoneScan.entries[0] ?? null;
  const bestEmail = emailScan.entries[0] ?? null;
  if (!bestPhone && phoneScan.invalid.length) {
    const bad = phoneScan.invalid[0]!;
    issues.push({ code: "invalid_phone", message: bad.note === "excel_scientific_notation"
      ? `Phone "${bad.raw}" looks like Excel turned it into scientific notation and lost digits; re-export the column as text`
      : `"${bad.raw}" isn't a valid phone number. ${REGION_HINT}.` });
  }
  if (bestPhone?.assumedCountry) {
    issues.push({ code: "phone_note", message: `"${bestPhone.raw}" has no country code and was read as ${bestPhone.e164}; check it, or set region` });
  } else if (phoneScan.entries.length > 1 && bestPhone) {
    issues.push({ code: "phone_note", message: `${phoneScan.entries.length} phone numbers in this row (${phoneScan.entries.map((e) => `${e.e164}${e.label ? ` ${e.label}` : ""}`).join(", ")}); using ${bestPhone.e164}${bestPhone.label ? ` (${bestPhone.label})` : ""}` });
  }
  if (!bestEmail && emailScan.invalid.length) issues.push({ code: "invalid_email", message: `"${emailScan.invalid[0]!.raw}" isn't a valid email address` });

  let handle: string | null = null;
  let kind: NormalizedRow["handle_kind"] = null;
  let mobile: boolean | null = null;
  if (bestPhone) { handle = bestPhone.e164; kind = "phone"; mobile = bestPhone.mobile; }
  else if (bestEmail) { handle = bestEmail.email; kind = "email"; }
  if (!handle) issues.push({ code: "no_handle", message: "No usable phone number or email" });
  if (kind === "phone" && mobile === false) issues.push({ code: "non_mobile", message: "This number is a landline or toll-free line, so a text may not reach it" });
  if (!display) issues.push({ code: "missing_name", message: "No name for this row" });

  const vars: Record<string, string> = {};
  for (const [s, col] of Object.entries(mapping.vars)) vars[s] = cleanText(raw[col]);

  const tags: string[] = [];
  for (const col of colsOf(f.tags)) for (const t of splitTags(raw[col] ?? "")) if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);

  return {
    row: {
      given_name: given, family_name: family, display_name: display,
      phone_e164: bestPhone?.e164 ?? null, email: bestEmail?.email ?? null, org: get("org"), notes: get("notes"), tags,
      handle, handle_kind: kind, mobile,
      phones: phoneScan.entries.map((e) => e.e164), emails: emailScan.entries.map((e) => e.email), vars,
    },
    issues,
  };
}

// ---------------------------------------------------------------- matching
function contactName(c: Contact): string {
  if (c.given_name || c.family_name) return nameKey(`${c.given_name} ${c.family_name}`);
  const s = splitName(c.display_name);
  return nameKey(`${s.given_name} ${s.family_name}`);
}
const candidate = (c: Contact): IssueCandidate => ({
  contact_id: c.id, display_name: c.display_name || [c.given_name, c.family_name].join(" ").trim(),
  phones: c.phones.map((p) => p.e164), emails: c.emails.map((e) => e.email),
});

function loadNameIndex(db: Database): Map<string, Contact[]> {
  const idx = new Map<string, Contact[]>();
  const rows = db.query("SELECT * FROM contacts").all() as any[];
  for (const r of rows) {
    const c: Contact = {
      id: r.id, source: r.source, macos_id: r.macos_id, display_name: r.display_name, given_name: r.given_name, family_name: r.family_name,
      nickname: r.nickname, org: r.org, phones: safeJson(r.phones_json), emails: safeJson(r.emails_json), tags: safeJson(r.tags_json),
      notes: r.notes, updated_at: r.updated_at, synced_at: r.synced_at,
    };
    const k = contactName(c);
    if (!k.includes(" ")) continue; // a bare first name is too common to match on
    (idx.get(k) ?? idx.set(k, []).get(k)!).push(c);
  }
  return idx;
}
function safeJson<T>(s: string): T { try { return JSON.parse(s) as T; } catch { return [] as unknown as T; } }

interface Computed { row_index: number; raw: Record<string, string>; normalized: NormalizedRow; contact_id: string | null; match: MatchStatus; issues: ImportIssue[] }

/** Normalises every row, dedupes (same handle, or the same person under two numbers) and matches against known contacts.
 *  A row is matched against ALL of its phones and emails, not just the one it will be messaged on. */
export function computeRows(db: Database, rawRows: Record<string, string>[], mapping: Mapping): Computed[] {
  const nameIdx = loadNameIndex(db);
  const firstSeen = new Map<string, number>();
  const personSeen = new Map<string, number>();            // `${name}|${contact_id}` -> first row
  const nameHandles = new Map<string, Map<string, number>>(); // name -> handle -> first row
  const ownHandles = (contactId: string): Set<string> =>
    new Set((db.query("SELECT handle FROM contact_handles WHERE contact_id = ?").all(contactId) as { handle: string }[]).map((r) => r.handle));
  const out: Computed[] = [];
  rawRows.forEach((raw, i) => {
    const { row, issues } = normalizeRow(raw, mapping);
    const rec: Computed = { row_index: i, raw, normalized: row, contact_id: null, match: "new", issues };
    out.push(rec);
    if (!row.handle) { rec.match = "invalid"; return; }
    const prev = firstSeen.get(row.handle);
    if (prev !== undefined) {
      rec.match = "duplicate";
      rec.issues.push({ code: "duplicate_of_row", row: prev, message: `Same recipient as row ${prev}` });
      return;
    }

    const allHandles = [...new Set([row.handle, ...(row.phones ?? []), ...(row.emails ?? [])])];
    const hitById = new Map<string, Contact>();
    for (const h of allHandles) for (const c of findContactsByHandle(db, h)) hitById.set(c.id, c);
    const hits = [...hitById.values()];
    const key = nameKey(row.display_name || `${row.given_name} ${row.family_name}`);

    if (hits.length === 1) {
      const contact = hits[0]!;
      rec.match = "matched"; rec.contact_id = contact.id;
      const personKey = `${key}|${contact.id}`;
      const dupOf = key ? personSeen.get(personKey) : undefined;
      if (dupOf !== undefined) {
        rec.match = "duplicate"; rec.contact_id = null;
        rec.issues.push({ code: "duplicate_person", row: dupOf, message: `Same person as row ${dupOf} (${row.display_name}, already matched to the same contact)` });
        return;
      }
      if (key) personSeen.set(personKey, i);
      // Message a number the contact already owns: if the best number isn't one of theirs, use the one that matched.
      const own = ownHandles(contact.id);
      if (!own.has(row.handle)) {
        const alt = [...(row.phones ?? []), ...(row.emails ?? [])].find((h) => own.has(h));
        if (alt) {
          rec.issues.push({ code: "phone_note", message: `${row.handle} isn't saved for ${contact.display_name || "this contact"}; using ${alt}, which is in your contacts` });
          row.handle = alt;
          row.handle_kind = alt.includes("@") ? "email" : "phone";
          if (row.handle_kind === "phone") row.phone_e164 = alt; else row.email = alt;
          row.mobile = null;
        }
      }
    } else if (hits.length > 1) {
      rec.match = "ambiguous";
      rec.issues.push({ code: "ambiguous_handle", message: `${hits.length} contacts share ${row.handle}`, candidates: hits.map(candidate) });
    } else if (row.given_name && row.family_name) {
      const same = nameIdx.get(nameKey(`${row.given_name} ${row.family_name}`)) ?? [];
      if (same.length) {
        rec.match = "ambiguous";
        rec.issues.push({ code: "ambiguous_name", message: `A contact named ${row.display_name} already exists with a different number or email`, candidates: same.map(candidate) });
      }
    }

    // The same person listed again under another number (same name, and a number or email in common).
    if (key) {
      const seenHandles = nameHandles.get(key);
      const shared = seenHandles ? allHandles.find((h) => seenHandles.has(h)) : undefined;
      if (shared !== undefined) {
        const dupOf = seenHandles!.get(shared)!;
        rec.match = "duplicate"; rec.contact_id = null;
        rec.issues.push({ code: "duplicate_person", row: dupOf, message: `Same person as row ${dupOf} (${row.display_name}; shares ${shared})` });
        return;
      }
      const m = seenHandles ?? new Map<string, number>();
      for (const h of allHandles) if (!m.has(h)) m.set(h, i);
      nameHandles.set(key, m);
    }
    firstSeen.set(row.handle, i);
  });
  return out;
}

function writeRows(db: Database, importId: string, rows: Computed[]): void {
  const q = db.query(`INSERT INTO import_rows(import_id,row_index,raw_json,normalized_json,contact_id,match,issues_json) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(import_id,row_index) DO UPDATE SET raw_json=excluded.raw_json, normalized_json=excluded.normalized_json,
    contact_id=excluded.contact_id, match=excluded.match, issues_json=excluded.issues_json`);
  for (const r of rows) q.run(importId, r.row_index, JSON.stringify(r.raw), JSON.stringify(r.normalized), r.contact_id, r.match, JSON.stringify(r.issues));
}

// ---------------------------------------------------------------- summaries
interface Meta { sheets: string[]; warnings: string[]; unlabeled?: string[] }
const j = <T>(s: string | null | undefined, fb: T): T => { try { return s ? (JSON.parse(s) as T) : fb; } catch { return fb; } };

function rowRecord(r: any): ImportRowRecord {
  return { row_index: r.row_index, raw: j(r.raw_json, {}), normalized: j(r.normalized_json, {} as NormalizedRow), contact_id: r.contact_id, match: r.match, issues: j(r.issues_json, []) };
}

/** Standard template variables plus every column slug. Standard names win over a column with the same slug. */
export function rowVars(row: ImportRowRecord, columns: string[]): Record<string, string> {
  const slugs = columnSlugs(columns);
  const vars: Record<string, string> = {};
  for (const c of columns) vars[slugs[c]!] = (row.raw[c] ?? "").trim();
  for (const [k, v] of Object.entries(row.normalized.vars ?? {})) vars[k] = v;
  const n = row.normalized;
  const first = n.given_name || "";
  vars.first_name = first;
  vars.last_name = n.family_name || "";
  vars.full_name = n.display_name || "";
  vars.name = first || n.display_name || "";
  vars.org = n.org || "";
  vars.tags = (n.tags ?? []).join(", ");
  return vars;
}

function summarize(db: Database, importId: string): ImportSummary {
  const imp = db.query("SELECT * FROM imports WHERE id = ?").get(importId) as any;
  if (!imp) throw new NotFoundError(`import ${importId} not found`);
  const stored = j<Mapping & { _meta?: Meta }>(imp.mapping_json, { fields: {}, vars: {}, confirmed: false });
  const { _meta, ...mapping } = stored;
  const counts: Record<MatchStatus, number> = { matched: 0, new: 0, ambiguous: 0, invalid: 0, duplicate: 0 };
  for (const r of db.query("SELECT match, COUNT(*) AS n FROM import_rows WHERE import_id = ? GROUP BY match").all(importId) as any[]) counts[r.match as MatchStatus] = r.n;
  const preview = (db.query("SELECT * FROM import_rows WHERE import_id = ? ORDER BY row_index LIMIT 10").all(importId) as any[]).map(rowRecord);
  const unlabeled = _meta?.unlabeled ?? [];
  return {
    import_id: importId, filename: imp.filename, kind: imp.kind, sheet: imp.sheet, sheets: _meta?.sheets ?? [],
    columns: j(imp.columns_json, []),
    mapping: { fields: mapping.fields ?? {}, vars: mapping.vars ?? {}, confirmed: !!mapping.confirmed, region: mapping.region ?? "US" },
    needs_confirmation: mappingNeedsConfirmation(mapping, unlabeled), counts, preview, warnings: _meta?.warnings ?? [],
    ...(unlabeled.length ? { unlabeled_columns: unlabeled } : {}),
  };
}

// ---------------------------------------------------------------- public API
export interface IngestOptions {
  bytes: Uint8Array; filename: string; created_by: string; sheet?: string; kind?: string;
  /** Default country for numbers without a country code: ISO alpha-2, default "US". Stored in mapping_json. */
  region?: string;
  /** Override for the raw-file store (tests). Defaults to paths.imports. */
  importsDir?: string;
}

export function ingestFile(db: Database, o: IngestOptions): ImportSummary {
  const region = normalizeRegion(o.region);
  if (o.bytes.length === 0) throw new IngestError("empty_file", `${o.filename} is empty (0 bytes)`);
  const table = parseFile(o.bytes, o.filename, { sheet: o.sheet, kind: o.kind });
  if (table.rows.length === 0) {
    if (table.warnings.some((w) => /input is empty/i.test(w))) throw new IngestError("empty_file", `${o.filename} has no content`);
    throw new IngestError("no_rows", `No data rows found in ${o.filename}${table.sheet ? ` (sheet "${table.sheet}")` : ""}. ${table.warnings.join(" ")}`.trim());
  }
  const sha = sha256Hex(o.bytes);
  const dir = o.importsDir ?? paths.imports;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stored = join(dir, `${sha}.${EXT_FOR_KIND[table.kind] ?? "bin"}`);
  try {
    writeFileSync(stored, o.bytes, { flag: "wx", mode: 0o400 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // identical upload already stored; keep the original bytes
  }
  if (!existsSync(stored)) throw new Error("Couldn't store the upload");

  const mapping: Mapping = { ...guessMapping(table), ...(region ? { region } : {}) };
  const id = newId();
  const meta: Meta = { sheets: table.sheets, warnings: table.warnings, ...(table.unlabeled?.length ? { unlabeled: table.unlabeled } : {}) };
  db.transaction(() => {
    db.query(`INSERT INTO imports(id,filename,sha256,kind,stored_path,sheet,mapping_json,columns_json,row_count,created_by,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, o.filename, sha, table.kind, stored, table.sheet, JSON.stringify({ ...mapping, _meta: meta }), JSON.stringify(table.columns), table.rows.length, o.created_by, nowIso());
    writeRows(db, id, computeRows(db, table.rows, mapping));
    audit(db, o.created_by, "import.create", id, { filename: o.filename, kind: table.kind, rows: table.rows.length, sha256: sha, ...(region ? { region } : {}) });
  }).immediate();
  return summarize(db, id);
}

export function setMapping(db: Database, import_id: string, mapping: Partial<Mapping> & { fields?: Record<string, any> }, opts: { region?: string } = {}): ImportSummary {
  const imp = db.query("SELECT * FROM imports WHERE id = ?").get(import_id) as any;
  if (!imp) throw new NotFoundError(`import ${import_id} not found`);
  const columns = j<string[]>(imp.columns_json, []);
  const old = j<Partial<Mapping> & { _meta?: Meta }>(imp.mapping_json, {});
  // The region stays as it was unless this call sets one.
  const next = completeMapping({ ...mapping, region: opts.region ?? mapping.region ?? old.region }, columns);
  const rawRows = (db.query("SELECT raw_json FROM import_rows WHERE import_id = ? ORDER BY row_index").all(import_id) as any[]).map((r) => j<Record<string, string>>(r.raw_json, {}));
  db.transaction(() => {
    db.query("UPDATE imports SET mapping_json = ? WHERE id = ?").run(JSON.stringify({ ...next, _meta: old._meta }), import_id);
    writeRows(db, import_id, computeRows(db, rawRows, next));
    audit(db, "system", "import.mapping", import_id, {
      fields: Object.fromEntries(Object.entries(next.fields).map(([k, v]) => [k, v!.columns?.length ? v!.columns : v!.column])), ...(next.region ? { region: next.region } : {}),
    });
  }).immediate();
  return summarize(db, import_id);
}

export interface GetImportOptions { offset?: number; limit?: number }

/** The import with its rows. Every row carries `vars`: what a template (or a per-row body) can use for it. With
 *  `limit` only that page of rows is returned (rows_total always holds the full count). */
export function getImport(db: Database, id: string, page: GetImportOptions = {}): ImportSummary & { rows: ImportRowRecord[]; rows_total: number } {
  const s = summarize(db, id);
  const total = (db.query("SELECT COUNT(*) AS n FROM import_rows WHERE import_id = ?").get(id) as { n: number }).n;
  const paged = page.limit !== undefined || page.offset !== undefined;
  const sql = `SELECT * FROM import_rows WHERE import_id = ? ORDER BY row_index${paged ? " LIMIT ? OFFSET ?" : ""}`;
  const args: (string | number)[] = paged ? [id, page.limit ?? -1, page.offset ?? 0] : [id];
  const rows = (db.query(sql).all(...args) as any[]).map(rowRecord).map((r) => ({ ...r, vars: rowVars(r, s.columns) }));
  return { ...s, rows, rows_total: total };
}

export { unmappedVars };
