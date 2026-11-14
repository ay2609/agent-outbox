// Per-row phone and email scanning. A mapped phone field is an ordered LIST of columns (plus per-row label columns such
// as Google's "Phone 1 - Label"), so each row has to choose its own best number. Pure functions, no I/O.
import { cleanText, normalizeEmail, normalizePhoneLoose } from "./normalize";

/** Splits a multi-valued cell: Google's " ::: ", newlines, semicolons and pipes. */
const CELL_SPLIT = /\s*:::\s*|\r?\n|;|\|/;
const MOBILE_RE = /\b(mobile|cell|cellular|cellphone|iphone|mob)\b/i;
const FIXED_RE = /\b(home|work|office|business|main|company|landline|school|assistant)\b/i;
const SKIP_RE = /\b(fax|pager)\b/i;

export type LabelKind = "mobile" | "none" | "fixed" | "skip";

/** Reads a label such as "Mobile", "_$!<iPhone>!$_" (Apple), "* Work" (Google) or a header like "Home Phone". */
export function classifyLabel(label: string): LabelKind {
  const t = cleanText(label).replace(/_\$!<(.*?)>!\$_/g, "$1").replace(/[_-]+/g, " ");
  if (!t) return "none";
  if (SKIP_RE.test(t)) return "skip";
  if (MOBILE_RE.test(t)) return "mobile";
  if (FIXED_RE.test(t)) return "fixed";
  return "none";
}

/** Finds the label/type column that belongs to a value column: "Phone 1 - Value" -> "Phone 1 - Label",
 *  "phones.0.number" -> "phones.0.type", "phone_2" -> "phone_2_label". */
export function labelColumnFor(col: string, columns: string[]): string | null {
  const byLower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  const cands: string[] = [];
  const m = /^(.*?)([\s._-]+)(value|number|phone|tel|address|email|e-mail)$/i.exec(col);
  if (m && m[1]!.trim()) for (const kind of ["label", "type"]) for (const sep of [m[2]!, " - ", " ", "_", "."]) cands.push(m[1] + sep + kind);
  for (const kind of ["label", "type"]) for (const sep of ["_", " ", " - ", "."]) cands.push(col + sep + kind);
  for (const c of cands) {
    const hit = byLower.get(c.toLowerCase());
    if (hit && hit !== col) return hit;
  }
  return null;
}

const rankOf = (kind: LabelKind, mobile: boolean | null): number => (kind === "mobile" ? 0 : kind === "none" ? 2 : 4) + (mobile === false ? 1 : 0);

export interface PhoneEntry {
  e164: string; mobile: boolean | null; label: string; column: string; raw: string;
  /** Lower is better: mobile-labelled, then unlabelled, then home / work / main; a landline ranks after a mobile at each level. */
  rank: number; order: number;
  /** The digits had no "+" and were read as `+digits` (11 or more digits). */
  assumedCountry: boolean;
}
export interface BadValue { column: string; raw: string; note?: string }

export function scanPhones(raw: Record<string, string>, phoneColumns: string[], region: string): { entries: PhoneEntry[]; invalid: BadValue[] } {
  const allColumns = Object.keys(raw);
  const best = new Map<string, PhoneEntry>();
  const invalid: BadValue[] = [];
  let order = 0;
  for (const col of phoneColumns) {
    const cell = cleanText(raw[col]);
    if (!cell) continue;
    const labelCol = labelColumnFor(col, allColumns);
    const labels = labelCol ? cleanText(raw[labelCol]).split(/\s*:::\s*/) : [];
    const headerLabel = classifyLabel(col) === "none" ? "" : col;
    const parts = cell.split(CELL_SPLIT).map((x) => x.trim()).filter(Boolean);
    parts.forEach((part, i) => {
      const label = (labels.length > 1 ? labels[i] : labels[0]) ?? "";
      const text = cleanText(label) || headerLabel;
      const kind = classifyLabel(text);
      if (kind === "skip") return;
      const r = normalizePhoneLoose(part, region);
      if (!r.valid || !r.e164) { invalid.push({ column: col, raw: part, ...(r.note ? { note: r.note } : {}) }); return; }
      const e: PhoneEntry = {
        e164: r.e164, mobile: r.mobile, label: kind === "mobile" ? "mobile" : text,
        column: col, raw: part, rank: rankOf(kind, r.mobile), order: order++, assumedCountry: r.note === "assumed_country_code",
      };
      const prev = best.get(e.e164);
      if (!prev || e.rank < prev.rank) best.set(e.e164, { ...e, order: prev?.order ?? e.order });
    });
  }
  const entries = [...best.values()].sort((a, b) => a.rank - b.rank || a.order - b.order);
  return { entries, invalid };
}

export interface EmailEntry { email: string; label: string; column: string; rank: number; order: number }

export function scanEmails(raw: Record<string, string>, emailColumns: string[]): { entries: EmailEntry[]; invalid: BadValue[] } {
  const allColumns = Object.keys(raw);
  const best = new Map<string, EmailEntry>();
  const invalid: BadValue[] = [];
  let order = 0;
  for (const col of emailColumns) {
    const cell = cleanText(raw[col]);
    if (!cell) continue;
    const labelCol = labelColumnFor(col, allColumns);
    const labels = labelCol ? cleanText(raw[labelCol]).split(/\s*:::\s*/) : [];
    const split = (cell.match(/@/g)?.length ?? 0) > 1 ? /\s*:::\s*|\r?\n|;|,|\|/ : CELL_SPLIT;
    const parts = cell.split(split).map((x) => x.trim()).filter(Boolean);
    parts.forEach((part, i) => {
      const label = cleanText(labels.length === 1 ? labels[0] : labels[i]) || (/\b(work|office|business|company)\b/i.test(col) ? "work" : "");
      const addr = normalizeEmail(part);
      if (!addr) { invalid.push({ column: col, raw: part }); return; }
      const e: EmailEntry = { email: addr, label, column: col, rank: /\b(work|office|business|company)\b/i.test(label) ? 1 : 0, order: order++ };
      const prev = best.get(addr);
      if (!prev || e.rank < prev.rank) best.set(addr, { ...e, order: prev?.order ?? e.order });
    });
  }
  return { entries: [...best.values()].sort((a, b) => a.rank - b.rank || a.order - b.order), invalid };
}

/** Tags from a Google "Labels" / Outlook "Categories" / vCard CATEGORIES / plain tags cell. Google's "* myContacts"
 *  system label is dropped and its "* " prefix stripped from the others. */
export function splitTags(cell: string): string[] {
  const out: string[] = [];
  for (const t of cleanText(cell).split(/\s*:::\s*|[,;|\n]/)) {
    const v = t.trim().replace(/^\*\s*/, "").trim();
    if (!v || /^mycontacts$/i.test(v)) continue;
    if (!out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}
