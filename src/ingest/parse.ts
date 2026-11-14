// File and text parsing into a uniform ParsedTable. No database access.
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { headerScore } from "./mapping";
import { cleanText, normalizeEmail, normalizePhone, splitName } from "./normalize";
import { classifyLabel } from "./rows";
import { FIELD_NAMES, type ParsedTable } from "./types";
export type { ParsedTable } from "./types";

// ---------------------------------------------------------------- encoding
export interface Decoded { text: string; encoding: string; warnings: string[] }

function swapBytes(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length - (b.length % 2));
  for (let i = 0; i + 1 < b.length; i += 2) { out[i] = b[i + 1]!; out[i + 1] = b[i]!; }
  return out;
}

/** UTF-8 BOM, UTF-16 BOMs (and BOM-less UTF-16 by NUL density), strict UTF-8, then windows-1252. */
export function decodeBytes(bytes: Uint8Array): Decoded {
  const warnings: string[] = [];
  const n = bytes.length;
  if (n >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8", warnings };
  }
  if (n >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le", warnings };
  }
  if (n >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16le").decode(swapBytes(bytes.subarray(2))), encoding: "utf-16be", warnings };
  }
  if (n >= 4) {
    let even = 0, odd = 0;
    const lim = Math.min(n, 4096);
    for (let i = 0; i < lim; i++) if (bytes[i] === 0) (i % 2 === 0 ? even++ : odd++);
    if (odd > lim * 0.25 && even < lim * 0.05) return { text: new TextDecoder("utf-16le").decode(bytes), encoding: "utf-16le", warnings: ["Detected UTF-16LE without a BOM"] };
    if (even > lim * 0.25 && odd < lim * 0.05) return { text: new TextDecoder("utf-16le").decode(swapBytes(bytes)), encoding: "utf-16be", warnings: ["Detected UTF-16BE without a BOM"] };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8", warnings };
  } catch {
    warnings.push("Not valid UTF-8; decoded as windows-1252");
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252", warnings };
  }
}

// ---------------------------------------------------------------- shared table building
const cell = (v: unknown): string => cleanText(v);

export function dedupeHeaders(headers: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  headers.forEach((h0, i) => {
    let h = cell(h0) || `Column ${i + 1}`;
    const base = h;
    let n = 1;
    while (seen.has(h.toLowerCase())) { n++; h = `${base} (${n})`; }
    seen.add(h.toLowerCase());
    out.push(h);
  });
  return out;
}

const isValueLike = (s: string): boolean =>
  /^[\d\s.,/:\-+()#$%]+$/.test(s) || normalizeEmail(s) !== null || normalizePhone(s).valid;

/** Picks the header row among the first rows: the first row that's nearly as wide as the widest and whose cells read as labels. */
export function detectHeaderRow(rows: string[][]): number {
  const look = rows.slice(0, 30);
  const fill = look.map((r) => r.filter((c) => c !== "").length);
  const maxFill = Math.max(0, ...fill);
  if (maxFill === 0) return -1;
  const need = Math.min(maxFill, Math.max(2, Math.ceil(0.6 * maxFill)));
  for (let i = 0; i < look.length; i++) {
    if (fill[i]! < need) continue;
    const cells = look[i]!.filter((c) => c !== "");
    if (cells.some((c) => normalizeEmail(c) !== null || normalizePhone(c).valid)) return -1; // a real phone or email means this is data
    const labels = cells.filter((c) => !isValueLike(c)).length;
    if (labels / cells.length >= 0.6) {
      // A pure-text table (no phones, emails or numbers below) only has a header if the cells are recognisable column names.
      const below = look.slice(i + 1).some((r) => r.some((c) => c !== "" && isValueLike(c)));
      if (!below && !cells.some((c) => FIELD_NAMES.some((f) => headerScore(f, c) > 0))) return -1;
      return i;
    }
    // A wide row of values means the data starts here: there is no header above it.
    return -1;
  }
  return -1;
}

interface BuildOpts {
  kind: string; sheets?: string[]; sheet?: string | null; warnings?: string[]; explicitHeader?: boolean;
}

/** Matrix of cells -> ParsedTable (header detection, blank rows, duplicate/blank headers). */
export function matrixToTable(matrix: string[][], o: BuildOpts): ParsedTable {
  const warnings = [...(o.warnings ?? [])];
  const rows0 = matrix.map((r) => r.map(cell)).filter((r) => r.some((c) => c !== ""));
  const base = { kind: o.kind, sheets: o.sheets ?? [], sheet: o.sheet ?? null };
  if (!rows0.length) return { ...base, columns: [], rows: [], warnings: [...warnings, "No data rows found"] };

  let hi = o.explicitHeader ? 0 : detectHeaderRow(rows0);
  let headerCells: string[];
  let dataRows: string[][];
  const width = Math.max(...rows0.map((r) => r.length));
  if (hi < 0) {
    warnings.push("No header row detected; columns are named Column 1, Column 2, ...");
    headerCells = Array.from({ length: width }, () => "");
    dataRows = rows0;
  } else {
    if (hi > 0) warnings.push(`Skipped ${hi} row(s) above the header`);
    headerCells = rows0[hi]!;
    dataRows = rows0.slice(hi + 1);
  }
  // Drop trailing columns with a blank header and no data.
  let w = Math.max(width, headerCells.length);
  const colHasData = (c: number) => dataRows.some((r) => (r[c] ?? "") !== "");
  while (w > 0 && (headerCells[w - 1] ?? "") === "" && !colHasData(w - 1) && hi >= 0) w--;
  if (hi < 0) w = width;
  const columns = dedupeHeaders(Array.from({ length: w }, (_, i) => headerCells[i] ?? ""));
  // A column with data but no header: the owner should look at it (a merged header may have been lost).
  const unlabeled = hi >= 0 ? columns.filter((_, c) => (headerCells[c] ?? "") === "" && colHasData(c)) : [];
  if (unlabeled.length) warnings.push(`No header over ${unlabeled.join(", ")}; named automatically, check the column mapping`);
  const rows: Record<string, string>[] = [];
  let extra = false;
  for (const r of dataRows) {
    if (r.length > w && r.slice(w).some((c) => c !== "")) extra = true;
    const rec: Record<string, string> = {};
    for (let c = 0; c < w; c++) rec[columns[c]!] = r[c] ?? "";
    rows.push(rec);
  }
  if (extra) warnings.push("Some rows have more cells than the header; the extra cells were ignored");
  return { ...base, columns, rows, warnings, ...(unlabeled.length ? { unlabeled } : {}) };
}

/** Records (JSON, vCard) -> ParsedTable, columns in first-seen order. */
export function recordsToTable(records: Record<string, string>[], o: BuildOpts & { columns?: string[] }): ParsedTable {
  const cols: string[] = [...(o.columns ?? [])];
  const seen = new Set(cols);
  for (const r of records) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  const columns = dedupeHeaders(cols);
  const map = new Map(cols.map((c, i) => [c, columns[i]!]));
  const rows = records
    .map((r) => {
      const rec: Record<string, string> = Object.fromEntries(columns.map((c) => [c, ""]));
      for (const [k, v] of Object.entries(r)) rec[map.get(k)!] = cell(v);
      return rec;
    })
    .filter((r) => Object.values(r).some((v) => v !== ""));
  return { kind: o.kind, sheets: o.sheets ?? [], sheet: o.sheet ?? null, columns, rows, warnings: o.warnings ?? [] };
}

// ---------------------------------------------------------------- delimited text
const DELIMS = [",", ";", "\t", "|"] as const;

function papaRows(text: string, delimiter: string, preview = 0): { rows: string[][]; errors: number } {
  const res = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: false, ...(preview ? { preview } : {}) });
  return { rows: res.data as string[][], errors: res.errors.filter((e) => e.type === "Quotes").length };
}

interface Sniff { delimiter: string; score: number; modal: number; atModal: number; total: number }

/** Scores each delimiter by how consistently it splits the first rows into the same (>= 2) number of fields. */
export function sniffDelimiter(text: string, preferred?: string): Sniff {
  const order = preferred ? [preferred, ...DELIMS.filter((d) => d !== preferred)] : ["\t", ";", "|", ","];
  let best: Sniff = { delimiter: preferred ?? ",", score: 0, modal: 1, atModal: 0, total: 0 };
  for (const d of order) {
    const { rows } = papaRows(text, d, 120);
    const widths = rows.filter((r) => r.some((c) => c.trim() !== "")).map((r) => r.length);
    if (!widths.length) continue;
    const freq = new Map<number, number>();
    for (const w of widths) freq.set(w, (freq.get(w) ?? 0) + 1);
    let modal = 1, atModal = 0;
    for (const [w, c] of freq) if (w >= 2 && (c > atModal || (c === atModal && w > modal))) { modal = w; atModal = c; }
    if (modal < 2 || atModal < Math.ceil(widths.length * 0.5)) continue;
    const score = atModal * (modal - 1);
    if (score > best.score) best = { delimiter: d, score, modal, atModal, total: widths.length };
  }
  return best;
}

function delimitedToTable(text: string, kind: string | null, preferred?: string, extraWarnings: string[] = []): ParsedTable {
  text = text.replace(/^sep=.\r?\n/i, "");
  const sn = sniffDelimiter(text, preferred);
  const { rows, errors } = papaRows(text, sn.score > 0 ? sn.delimiter : "\u0001");
  const warnings = [...extraWarnings];
  if (errors) warnings.push("Some quoted fields were malformed");
  const k = kind ?? (sn.delimiter === "\t" ? "tsv" : "csv");
  if (sn.score === 0) warnings.push("Couldn't find a delimiter; treated as a single column");
  return matrixToTable(rows, { kind: k, warnings });
}

// ---------------------------------------------------------------- spreadsheets
const SHEET_KINDS = new Set(["xlsx", "xls", "ods", "numbers"]);

function sheetCellText(c: XLSX.CellObject | undefined): string {
  if (!c) return "";
  switch (c.t) {
    case "n": {
      const z = typeof c.z === "string" ? c.z : "General";
      const v = c.v as number;
      if (Number.isInteger(v) && Math.abs(v) < 1e15 && (/^general$/i.test(z) || /e/i.test(z) || /^0+$/.test(z) || /^#+$/.test(z))) return String(v);
      return c.w ?? String(v);
    }
    case "b": return c.v ? "TRUE" : "FALSE";
    case "e": case "z": return "";
    case "d": return c.w ?? (c.v instanceof Date ? c.v.toISOString().slice(0, 10) : String(c.v));
    default: return String(c.w ?? c.v ?? "");
  }
}

function sheetToMatrix(ws: XLSX.WorkSheet): string[][] {
  const ref = ws["!ref"];
  if (!ref) return [];
  const r = XLSX.utils.decode_range(ref);
  const out: string[][] = [];
  for (let R = r.s.r; R <= r.e.r; R++) {
    const row: string[] = [];
    for (let C = r.s.c; C <= r.e.c; C++) row.push(sheetCellText(ws[XLSX.utils.encode_cell({ r: R, c: C })]));
    out.push(row);
  }
  return mergeHeaderRows(out, ws["!merges"] ?? [], r.s.r, r.s.c);
}

/** Two-level headers: a group row above the real header ("Name" merged over "First" and "Last") is folded into the lower
 *  row as "Name First" / "Name Last". A merge spanning the whole sheet is a title, not a group, and is left alone.
 *  A cell merged down over both header rows keeps its single label. */
export function mergeHeaderRows(matrix: string[][], merges: XLSX.Range[], rowOffset = 0, colOffset = 0): string[][] {
  const width = Math.max(0, ...matrix.map((r) => r.length));
  const horizontal = merges
    .filter((m) => m.e.c > m.s.c && m.s.r === m.e.r)
    .map((m) => ({ r: m.s.r - rowOffset, c0: m.s.c - colOffset, c1: m.e.c - colOffset }))
    .filter((m) => m.r >= 0 && m.r < 30 && m.r < matrix.length && !(m.c0 <= 0 && m.c1 >= width - 1));
  if (!horizontal.length) return matrix;
  const groupRows = [...new Set(horizontal.map((m) => m.r))].sort((a, b) => a - b);
  const out = matrix.map((r) => [...r]);
  for (const g of groupRows) {
    // The child row is the next row with content; it must read as labels, and data must follow it.
    let c = g + 1;
    while (c < out.length && out[c]!.every((x) => x === "")) c++;
    if (c >= out.length - 1) continue;
    const child = out[c]!;
    const childCells = child.filter((x) => x !== "");
    if (childCells.length < 2 || childCells.some((x) => isValueLike(x))) continue;
    const parent: string[] = Array.from({ length: width }, (_, i) => out[g]![i] ?? "");
    for (const m of horizontal.filter((x) => x.r === g)) for (let i = m.c0; i <= m.c1; i++) parent[i] = out[g]![m.c0] ?? "";
    const merged = Array.from({ length: width }, (_, i) => {
      const p = parent[i] ?? "", k = child[i] ?? "";
      if (p && k && p.toLowerCase() !== k.toLowerCase()) return `${p} ${k}`;
      return k || p;
    });
    out[c] = merged;
    out[g] = Array.from({ length: width }, () => "");
  }
  return out;
}

function parseSpreadsheet(bytes: Uint8Array, kind: string, opts: { sheet?: string }): ParsedTable {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(bytes, { type: "array", cellDates: false, cellNF: true, cellText: true });
  } catch (e) {
    throw new Error(`Couldn't read the spreadsheet: ${(e as Error).message}`);
  }
  const sheets = wb.SheetNames;
  if (!sheets.length) throw new Error("The workbook has no sheets");
  const warnings: string[] = [];
  let name: string | undefined;
  if (opts.sheet != null && opts.sheet !== "") {
    name = sheets.find((s) => s === opts.sheet) ?? sheets.find((s) => s.toLowerCase() === String(opts.sheet).toLowerCase());
    if (!name && /^\d+$/.test(opts.sheet)) name = sheets[Number(opts.sheet)];
    if (!name) throw new Error(`Sheet "${opts.sheet}" not found. Available: ${sheets.join(", ")}`);
  } else {
    name = sheets.find((s) => sheetToMatrix(wb.Sheets[s]!).some((r) => r.some((c) => c !== ""))) ?? sheets[0]!;
    if (name !== sheets[0]) warnings.push(`First sheet is empty; using "${name}"`);
  }
  if (sheets.length > 1) warnings.push(`Workbook has ${sheets.length} sheets; using "${name}"`);
  return matrixToTable(sheetToMatrix(wb.Sheets[name]!), { kind, sheets, sheet: name, warnings });
}

// ---------------------------------------------------------------- vCard
function unescapeV(s: string): string {
  return s.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}
function splitUnescaped(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && i + 1 < s.length) { cur += ch + s[i + 1]; i++; }
    else if (ch === sep) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function decodeQP(v: string, charset: string): string {
  const bytes: number[] = [];
  const s = v.replace(/=\r?\n/g, "");
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else for (const b of new TextEncoder().encode(s[i]!)) bytes.push(b);
  }
  const arr = Uint8Array.from(bytes);
  try { return new TextDecoder(/utf-?8/i.test(charset) || !charset ? "utf-8" : charset.toLowerCase().replace(/^iso-8859-1$/, "windows-1252"), { fatal: true }).decode(arr); }
  catch { return new TextDecoder("windows-1252").decode(arr); }
}

function unfoldVcard(text: string): string[] {
  const raw = text.split(/\r\n|\n|\r/);
  const out: string[] = [];
  const isQP = (l: string) => /^[^:]*;\s*(?:ENCODING=)?QUOTED-PRINTABLE/i.test(l);
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]!;
    const last = out.length - 1;
    if (last >= 0 && isQP(out[last]!) && out[last]!.endsWith("=")) { out[last] = out[last]!.slice(0, -1) + line; continue; }
    if (last >= 0 && /^[ \t]/.test(line)) { out[last] += line.slice(1); continue; }
    out.push(line);
  }
  return out;
}

interface Prop { name: string; group: string; params: Map<string, string[]>; value: string; qp: boolean }

function parseProp(line: string): Prop | null {
  let inQ = false, colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') inQ = !inQ;
    else if (ch === ":" && !inQ) { colon = i; break; }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  let value = line.slice(colon + 1);
  const segs: string[] = [];
  let cur = "";
  inQ = false;
  for (const ch of head) {
    if (ch === '"') { inQ = !inQ; cur += ch; }
    else if (ch === ";" && !inQ) { segs.push(cur); cur = ""; }
    else cur += ch;
  }
  segs.push(cur);
  const name = segs[0]!.replace(/^.*\./, "").toUpperCase();
  const group = /^(.*)\.[^.]*$/.exec(segs[0]!)?.[1]?.toLowerCase() ?? "";
  const params = new Map<string, string[]>();
  const add = (k: string, v: string) => { const key = k.toUpperCase(); params.set(key, [...(params.get(key) ?? []), ...v.replace(/"/g, "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)]); };
  for (const seg of segs.slice(1)) {
    const eq = seg.indexOf("=");
    if (eq < 0) add("TYPE", seg); else add(seg.slice(0, eq), seg.slice(eq + 1));
  }
  const qp = (params.get("ENCODING") ?? []).includes("quoted-printable") || (params.get("TYPE") ?? []).includes("quoted-printable");
  if (qp) value = decodeQP(value, (params.get("CHARSET") ?? [""])[0] ?? "");
  return { name, group, params, value, qp };
}

const typesOf = (p: Prop) => p.params.get("TYPE") ?? [];

export function parseVcard(text: string): ParsedTable {
  const lines = unfoldVcard(text);
  const cards: Prop[][] = [];
  let cur: Prop[] | null = null;
  for (const l of lines) {
    if (/^BEGIN:VCARD\s*$/i.test(l)) { cur = []; continue; }
    if (/^END:VCARD\s*$/i.test(l)) { if (cur) cards.push(cur); cur = null; continue; }
    if (!cur || !l.trim()) continue;
    const p = parseProp(l);
    if (p) cur.push(p);
  }
  if (cur && cur.length) cards.push(cur); // truncated final card
  let maxPhones = 1, maxEmails = 1;
  const recs: Record<string, string>[] = [];
  const warnings: string[] = [];
  for (const props of cards) {
    const r: Record<string, string> = {};
    const val = (p: Prop) => (p.qp ? p.value : unescapeV(p.value)).trim();
    const n = props.find((p) => p.name === "N");
    const fn = props.find((p) => p.name === "FN");
    if (n) {
      const [family = "", given = ""] = splitUnescaped(n.value, ";").map((x) => (n.qp ? x : unescapeV(x)).trim());
      r.given_name = given; r.family_name = family;
    }
    if (fn) r.full_name = val(fn);
    if (!r.given_name && !r.family_name && r.full_name) {
      const s = splitName(r.full_name);
      r.given_name = s.given_name; r.family_name = s.family_name;
    }
    const nick = props.find((p) => p.name === "NICKNAME"); if (nick) r.nickname = val(nick);
    // Apple writes custom labels as a sibling property in the same itemN group: item1.TEL + item1.X-ABLabel:_$!<Mobile>!$_
    const abLabel = new Map<string, string>();
    for (const p of props) if (p.name === "X-ABLABEL" && p.group) abLabel.set(p.group, val(p).replace(/_\$!<(.*?)>!\$_/g, "$1"));
    const labelText = (p: Prop) => [p.group ? abLabel.get(p.group) ?? "" : "", ...typesOf(p)].join(" ");
    const phones = props.filter((p) => p.name === "TEL" && classifyLabel(labelText(p)) !== "skip");
    // mobile / cell / iPhone first, then unlabelled or preferred, then home / work / main
    const rank = (p: Prop) => { const k = classifyLabel(labelText(p)); return k === "mobile" ? 0 : k === "fixed" ? 2 : 1; };
    phones.sort((a, b) => rank(a) - rank(b)); // stable
    phones.forEach((p, i) => { r[i === 0 ? "phone" : `phone_${i + 1}`] = val(p).replace(/^tel:/i, ""); });
    maxPhones = Math.max(maxPhones, phones.length);
    const emails = props.filter((p) => p.name === "EMAIL");
    emails.sort((a, b) => Number(typesOf(b).includes("pref")) - Number(typesOf(a).includes("pref")));
    emails.forEach((p, i) => { r[i === 0 ? "email" : `email_${i + 1}`] = val(p).replace(/^mailto:/i, ""); });
    maxEmails = Math.max(maxEmails, emails.length);
    const org = props.find((p) => p.name === "ORG");
    if (org) r.org = unescapeV(splitUnescaped(org.value, ";")[0] ?? "").trim();
    const title = props.find((p) => p.name === "TITLE"); if (title) r.title = val(title);
    const note = props.find((p) => p.name === "NOTE"); if (note) r.notes = val(note);
    const cats = props.filter((p) => p.name === "CATEGORIES").flatMap((p) => splitUnescaped(p.value, ",").map((x) => (p.qp ? x : unescapeV(x)).trim())).filter(Boolean);
    if (cats.length) r.tags = cats.join(", ");
    const adr = props.find((p) => p.name === "ADR");
    if (adr) { const city = (splitUnescaped(adr.value, ";")[3] ?? "").trim(); if (city) r.city = unescapeV(city); }
    // A company card with no personal name: the organisation is the display name (and stays whole).
    if (!r.given_name && !r.family_name && !r.full_name && r.org) { r.full_name = r.org; r.given_name = r.org; }
    recs.push(r);
  }
  const columns = [
    "given_name", "family_name", "full_name", "nickname",
    ...Array.from({ length: maxPhones }, (_, i) => (i === 0 ? "phone" : `phone_${i + 1}`)),
    ...Array.from({ length: maxEmails }, (_, i) => (i === 0 ? "email" : `email_${i + 1}`)),
    "org", "title", "notes", "tags", "city",
  ];
  const t = recordsToTable(recs, { kind: "vcf", columns, warnings });
  // Drop columns that no card used.
  const used = t.columns.filter((c) => t.rows.some((r) => r[c] !== ""));
  t.columns = used;
  t.rows = t.rows.map((r) => Object.fromEntries(used.map((c) => [c, r[c]!])));
  if (!cards.length) t.warnings.push("No vCards found");
  return t;
}

// ---------------------------------------------------------------- JSON / JSONL
function flatten(v: unknown, prefix: string, out: Record<string, string>): void {
  if (v === null || v === undefined) { if (prefix) out[prefix] = ""; return; }
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== "object")) { out[prefix] = v.map((x) => (x == null ? "" : String(x))).join("; "); return; }
    v.forEach((x, i) => flatten(x, `${prefix}.${i}`, out));
    return;
  }
  if (typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  out[prefix] = String(v);
}

function jsonRecords(data: unknown): { records: Record<string, string>[]; warnings: string[] } | null {
  const warnings: string[] = [];
  let arr: unknown[] | null = null;
  if (Array.isArray(data)) arr = data;
  else if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const k of ["contacts", "data", "rows", "items", "records", "people", "results", "recipients"]) {
      if (Array.isArray(o[k])) { arr = o[k] as unknown[]; warnings.push(`Using the "${k}" array`); break; }
    }
    if (!arr) {
      const firstArr = Object.entries(o).find(([, v]) => Array.isArray(v) && (v as unknown[]).some((x) => x && typeof x === "object"));
      if (firstArr) { arr = firstArr[1] as unknown[]; warnings.push(`Using the "${firstArr[0]}" array`); }
      else arr = [o];
    }
  }
  if (!arr) return null;
  if (arr.length && arr.every((r) => Array.isArray(r))) {
    // array of arrays: first row is the header
    const [h, ...body] = arr as unknown[][];
    const heads = dedupeHeaders((h ?? []).map((x) => String(x ?? "")));
    return { records: body.map((r) => Object.fromEntries(heads.map((k, i) => [k, r[i] == null ? "" : String(r[i])]))), warnings };
  }
  const records: Record<string, string>[] = [];
  for (const item of arr) {
    if (item && typeof item === "object" && !Array.isArray(item)) { const o: Record<string, string> = {}; flatten(item, "", o); records.push(o); }
    else if (item != null && typeof item !== "object") records.push({ value: String(item) });
  }
  return { records, warnings };
}

export function parseJson(text: string): ParsedTable {
  const t = text.trim();
  let recs: { records: Record<string, string>[]; warnings: string[] } | null = null;
  let kind = "json";
  try {
    recs = jsonRecords(JSON.parse(t));
  } catch {
    // JSONL: one object per line
    const records: Record<string, string>[] = [];
    const warnings: string[] = [];
    let bad = 0;
    for (const line of t.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line);
        if (v && typeof v === "object" && !Array.isArray(v)) { const o: Record<string, string> = {}; flatten(v, "", o); records.push(o); } else bad++;
      } catch { bad++; }
    }
    if (!records.length) throw new Error("Not valid JSON or JSON Lines");
    if (bad) warnings.push(`Skipped ${bad} line(s) that weren't JSON objects`);
    recs = { records, warnings };
    kind = "jsonl";
  }
  if (!recs) throw new Error("JSON must be an array of objects or an object containing one");
  const table = recordsToTable(recs.records, { kind, warnings: recs.warnings });
  if (!table.rows.length) table.warnings.push("No records found");
  return table;
}

// ---------------------------------------------------------------- markdown tables and "Name - phone" lines
const MD_SEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function mdCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) =>
    cleanText(c.replace(/\\\|/g, "|").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|__|`/g, "")));
}

export function parseMarkdownTable(text: string): ParsedTable | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i]!.includes("|") && MD_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const matrix: string[][] = [mdCells(lines[i]!)];
      for (let j = i + 2; j < lines.length && lines[j]!.includes("|") && lines[j]!.trim() !== ""; j++) matrix.push(mdCells(lines[j]!));
      return matrixToTable(matrix, { kind: "text", explicitHeader: true });
    }
  }
  return null;
}

const PHONE_TOKEN = /(?<![\w@.])(\+?\(?\d[\d\s().\-]{5,}\d)(?:\s*(?:ext\.?|x)\s*\d{1,6})?(?![\w@])/g;
const EMAIL_TOKEN = /[^\s<>"',;()]+@[^\s<>"',;()]+\.[A-Za-z]{2,}/;

/** "Jane Doe - 301-555-0123", "jane@x.com Jane", "Jane Doe <jane@x.com>", bare numbers... Returns null when the lines don't look like that. */
export function parseContactLines(text: string): ParsedTable | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const recs: { name: string; phone: string; email: string }[] = [];
  let hits = 0;
  for (const line of lines) {
    let rest = line.replace(/^(?:\d+[.)]|[-*•])\s+(?=\S)/, ""); // list bullets "1. " "- " "* "
    let email = "", phone = "";
    const em = EMAIL_TOKEN.exec(rest);
    if (em) { email = em[0]; rest = rest.replace(em[0], " "); }
    const cands = [...rest.matchAll(PHONE_TOKEN)].filter((m) => m[1]!.replace(/\D/g, "").length >= 7);
    const pick = cands.find((m) => normalizePhone(m[0]).valid) ?? cands[0];
    if (pick) { phone = pick[0].trim(); rest = rest.replace(pick[0], " "); }
    const name = rest.replace(/[<>()"“”]/g, " ").replace(/^[\s\-–—:=|,;]+|[\s\-–—:=|,;]+$/g, "").replace(/\s+[-–—:=|]\s*$/g, "").replace(/\s+/g, " ").trim();
    if (email || phone) hits++;
    recs.push({ name, phone, email });
  }
  if (hits < Math.max(1, Math.ceil(lines.length * 0.6))) return null;
  const cols = ["Name", "Phone", "Email"].filter((c) => recs.some((r) => (c === "Name" ? r.name : c === "Phone" ? r.phone : r.email) !== ""));
  const rows = recs.map((r) => Object.fromEntries(cols.map((c) => [c, c === "Name" ? r.name : c === "Phone" ? r.phone : r.email]))) as Record<string, string>[];
  return { kind: "text", sheets: [], sheet: null, columns: cols, rows, warnings: ["Read as free-form lines (name plus number or email)"] };
}

// ---------------------------------------------------------------- entry points
const hasContactCells = (t: ParsedTable): boolean => {
  if (!t.rows.length) return false;
  let hit = 0;
  for (const r of t.rows) if (Object.values(r).some((v) => v && (normalizePhone(v).valid || normalizeEmail(v)))) hit++;
  return hit >= Math.ceil(t.rows.length * 0.5);
};

function parseTextBody(text: string, kindHint: string | null, preferred?: string, extra: string[] = []): ParsedTable {
  text = text.replace(/^﻿/, "");
  const trimmed = text.trim();
  if (!trimmed) return { kind: kindHint ?? "text", sheets: [], sheet: null, columns: [], rows: [], warnings: [...extra, "The input is empty"] };
  const addExtra = (t: ParsedTable) => { t.warnings.unshift(...extra); return t; };
  if (kindHint === "vcf" || /^BEGIN:VCARD/im.test(trimmed)) return addExtra(parseVcard(text));
  if (kindHint === "json" || kindHint === "jsonl" || /^[[{]/.test(trimmed)) {
    try { return addExtra(parseJson(trimmed)); } catch (e) { if (kindHint === "json" || kindHint === "jsonl") throw e; }
  }
  if (kindHint !== "csv" && kindHint !== "tsv") {
    const md = parseMarkdownTable(text);
    if (md && md.rows.length) return addExtra(md);
  }
  const forced = kindHint === "tsv" ? "\t" : preferred;
  const sn = sniffDelimiter(text, forced);
  const strong = sn.score > 0;
  if (kindHint === "csv" || kindHint === "tsv") return delimitedToTable(text, kindHint, forced, extra);
  const lines = parseContactLines(text);
  if (strong) {
    const d = delimitedToTable(text, null, forced, extra);
    if (!lines || hasContactCells(d)) return d;
    return addExtra(lines);
  }
  if (lines) return addExtra(lines);
  return delimitedToTable(text, null, forced, extra);
}

/** Pasted CSV / TSV / markdown table / vCard / JSON / simple "Name - phone" lines. `hint` may be a filename or kind. */
export function parseText(text: string, hint?: string): ParsedTable {
  const h = (hint ?? "").toLowerCase();
  const ext = /\.([a-z0-9]+)$/.exec(h)?.[1] ?? h;
  const kind = ({ csv: "csv", tsv: "tsv", tab: "tsv", vcf: "vcf", vcard: "vcf", json: "json", jsonl: "jsonl", ndjson: "jsonl" } as Record<string, string>)[ext] ?? null;
  return parseTextBody(text, kind);
}

function extKind(filename: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(filename.trim())?.[1]?.toLowerCase();
  if (!ext) return null;
  const m: Record<string, string> = {
    csv: "csv", tsv: "tsv", tab: "tsv", txt: "text", text: "text", md: "text", xlsx: "xlsx", xlsm: "xlsx", xlsb: "xlsx", xls: "xls",
    ods: "ods", fods: "ods", numbers: "numbers", vcf: "vcf", vcard: "vcf", json: "json", jsonl: "jsonl", ndjson: "jsonl",
  };
  return m[ext] ?? null;
}

/** Parses an uploaded file. The extension (or opts.kind) decides first; unknown types are sniffed from the bytes. */
export function parseFile(bytes: Uint8Array, filename: string, opts: { sheet?: string; kind?: string } = {}): ParsedTable {
  let kind = opts.kind ? opts.kind.toLowerCase().replace(/^\./, "") : extKind(filename);
  if (kind === "xlsm" || kind === "xlsb") kind = "xlsx";
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const isCfb = bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  const isPdf = bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  if (isPdf) throw new Error("PDF files aren't supported; export the data as CSV or XLSX");
  if (!kind || kind === "text" || kind === "txt") {
    if (isZip) kind = "xlsx"; else if (isCfb) kind = "xls";
  }
  if (kind && SHEET_KINDS.has(kind)) return parseSpreadsheet(bytes, kind, { sheet: opts.sheet });
  const dec = decodeBytes(bytes);
  const extra = dec.warnings;
  if (kind === "csv" || kind === "tsv") return parseTextBody(dec.text, kind, kind === "tsv" ? "\t" : undefined, extra);
  if (kind === "vcf" || kind === "json" || kind === "jsonl") return parseTextBody(dec.text, kind, undefined, extra);
  return parseTextBody(dec.text, null, undefined, extra);
}
