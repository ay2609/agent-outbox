// Shared test fixtures. Fakes stand in for the ingest library so these tests don't depend on it.
import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, nowIso, openDb } from "../src/db";
import type { BDeps, HandleInfo } from "../src/core/deps";
import { addDraft, createBatch, getDrafts } from "../src/core/store";

export const tmpDir = (prefix = "outbox-test-"): string => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));

export function fakeHandle(input: string): HandleInfo {
  const s = input.trim();
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s)) return { handle: s.toLowerCase(), kind: "email", valid: true, mobile: null };
  const digits = s.replace(/[^\d]/g, "");
  if (s.startsWith("+") && digits.length >= 8 && digits.length <= 15) return { handle: "+" + digits, kind: "phone", valid: true, mobile: true };
  if (digits.length === 10) return { handle: "+1" + digits, kind: "phone", valid: true, mobile: true };
  if (digits.length === 11 && digits.startsWith("1")) return { handle: "+" + digits, kind: "phone", valid: true, mobile: true };
  return { handle: null, kind: null, valid: false, mobile: null };
}

export interface FakeState {
  lintCalls: string[];
  imports: Map<string, any>;
  mappings: any[];
  ingested: any[];
}

/** Fake ingest library. lintBatch flags bodies over 1000 chars and any leftover {{ }} so warnings flow through responses. */
export function fakeDeps(db: Database): { deps: BDeps; state: FakeState } {
  const state: FakeState = { lintCalls: [], imports: new Map(), mappings: [], ingested: [] };
  const deps: BDeps = {
    normalizeHandle: fakeHandle,
    normalizePhone: (raw) => {
      const h = fakeHandle(raw);
      return { e164: h.kind === "phone" ? h.handle : null, valid: h.kind === "phone", mobile: h.mobile, raw };
    },
    renderTemplate: (template, vars) => {
      const unresolved: string[] = []; const empty: string[] = [];
      const body = template.replace(/\{\{\s*([a-z0-9_]+)\s*(?:\|([^}]*))?\}\}/gi, (_m, k: string, fb?: string) => {
        const v = vars[k];
        if (v === undefined) { unresolved.push(k); return fb ?? ""; }
        if (v === "") { empty.push(k); return fb ?? ""; }
        return v;
      });
      return { body, unresolved, empty };
    },
    lintBatch: (d, batchId) => {
      state.lintCalls.push(batchId);
      for (const dr of getDrafts(d, batchId)) {
        const w: any[] = [];
        if (dr.body.length > 1000) w.push({ code: "too_long", message: "over 1000 characters" });
        if (/\{\{/.test(dr.body)) w.push({ code: "unresolved_var", message: "unresolved field" });
        d.query("UPDATE drafts SET warnings_json = ? WHERE id = ?").run(JSON.stringify(w), dr.id);
      }
    },
    ingestFile: (_d, args) => {
      const text = new TextDecoder().decode(args.bytes);
      const lines = text.split(/\r?\n/).filter(Boolean);
      const columns = (lines[0] ?? "").split(",");
      const rows = lines.slice(1).map((l, i) => {
        const cells = l.split(",");
        return { row_index: i, raw: Object.fromEntries(columns.map((c, k) => [c, cells[k] ?? ""])) };
      });
      const id = newId();
      const summary = {
        import_id: id, filename: args.filename, kind: "csv", sheet: null, sheets: [], columns,
        mapping: { fields: { given_name: { column: columns[0], confidence: 0.9 }, phone: { column: columns[1], confidence: 0.9 } }, vars: {}, confirmed: false },
        needs_confirmation: true, counts: { matched: 0, new: rows.length, ambiguous: 0, invalid: 0, duplicate: 0 }, preview: rows.slice(0, 10),
        rows, created_by: args.created_by,
      };
      state.imports.set(id, summary);
      state.ingested.push(args);
      return { ...summary, rows: undefined };
    },
    getImport: (_d, id) => state.imports.get(id) ?? null,
    setMapping: (_d, id, mapping) => {
      const cur = state.imports.get(id);
      state.mappings.push(mapping);
      cur.mapping = mapping; cur.needs_confirmation = !mapping.confirmed;
      return { ...cur, rows: undefined };
    },
    batchFromImport: (d, id, o) => {
      const imp = state.imports.get(id);
      const batch = createBatch(d, { title: o.title, created_by: o.created_by, source: o.source as any, import_id: null, template: o.template, status: "drafting" });
      let n = 0;
      for (const r of imp.rows) {
        const fields = imp.mapping.fields;
        const name = r.raw[fields.given_name.column];
        const phone = fakeHandle(r.raw[fields.phone.column]);
        if (!phone.handle) continue;
        const body = o.per_row_bodies?.[r.row_index] ?? o.template.replace(/\{\{first_name[^}]*\}\}/, name);
        addDraft(d, batch, { handle: phone.handle, body, recipient_name: name, import_row: r.row_index, actor: "template" });
        n++;
      }
      return { batch_id: batch, drafts: n, skipped: [] };
    },
  };
  return { deps, state };
}

export function seedContact(db: Database, c: {
  name: string; given?: string; family?: string; org?: string; phones?: { e164: string; label: string }[]; emails?: string[];
  tags?: string[]; macos_id?: string | null; source?: "macos" | "import" | "manual";
}): string {
  const id = newId();
  const phones = c.phones ?? []; const emails = (c.emails ?? []).map((email) => ({ email, label: "home" }));
  db.query(`INSERT INTO contacts(id, source, macos_id, display_name, given_name, family_name, nickname, org, phones_json, emails_json, tags_json, notes, updated_at, synced_at)
            VALUES (?,?,?,?,?,?,'',?,?,?,?,'',?,?)`)
    .run(id, c.source ?? "macos", c.macos_id === undefined ? newId() : c.macos_id, c.name, c.given ?? c.name.split(" ")[0] ?? "", c.family ?? c.name.split(" ")[1] ?? "",
      c.org ?? "", JSON.stringify(phones), JSON.stringify(emails), JSON.stringify(c.tags ?? []), nowIso(), nowIso());
  for (const p of phones) db.query("INSERT OR IGNORE INTO contact_handles(handle, contact_id) VALUES (?,?)").run(p.e164, id);
  for (const e of emails) db.query("INSERT OR IGNORE INTO contact_handles(handle, contact_id) VALUES (?,?)").run(e.email, id);
  return id;
}

export function memDb(): Database { return openDb(":memory:"); }

export async function call(app: { fetch: (r: Request) => Response | Promise<Response> }, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.fetch(new Request(`http://outbox${path}`, {
    method, headers: { "Content-Type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
  const text = await res.text();
  let json: any; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: res.status, json };
}
