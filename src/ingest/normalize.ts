// Phone, email and name normalisation. Pure functions, no I/O.
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";

export interface PhoneResult {
  e164: string | null;
  valid: boolean;
  /** true for mobile and fixed-line-or-mobile numbers, false for landline/toll-free/VoIP etc., null when libphonenumber can't tell. */
  mobile: boolean | null;
  raw: string;
  /** Why a value was rejected or adjusted (e.g. "excel_scientific_notation"). */
  note?: string;
}

const INVISIBLE = /[ ​-‍⁠﻿‪-‮]/g;

/** Trims ordinary and invisible whitespace. */
export function cleanText(s: unknown): string {
  return String(s ?? "").replace(INVISIBLE, " ").trim();
}

const SCI = /^[+-]?(\d+)(?:\.(\d+))?[eE]\+?(\d+)$/;
const EXT = /\s*(?:ext\.?|extension|x|#)\s*(\d{1,6})\s*$/i;

function expandScientific(s: string): { digits: string; lossy: boolean } | null {
  const m = SCI.exec(s);
  if (!m) return null;
  const int = m[1]!, frac = m[2] ?? "", exp = Number(m[3]);
  if (frac.length > exp) return null; // a real decimal, not a mangled integer
  const pad = exp - frac.length;
  return { digits: int + frac + "0".repeat(pad), lossy: pad > 0 };
}

function typeToMobile(t: string | undefined): boolean | null {
  if (!t) return null;
  return t === "MOBILE" || t === "FIXED_LINE_OR_MOBILE";
}

function parseOne(s: string, region: string): { e164: string; mobile: boolean | null } | null {
  let t = s.replace(EXT, "");
  if (/[a-z]/i.test(t)) return null;
  t = t.trim();
  if (/^00\d/.test(t)) t = "+" + t.slice(2);
  else if (region === "US" && /^011\d/.test(t)) t = "+" + t.slice(3);
  const p = parsePhoneNumberFromString(t, region as CountryCode);
  if (!p || !p.isValid()) return null;
  return { e164: p.number, mobile: typeToMobile(p.getType()) };
}

export function normalizePhone(raw: string, region: string = "US"): PhoneResult {
  const rawStr = String(raw ?? "");
  const bad = (note?: string): PhoneResult => ({ e164: null, valid: false, mobile: null, raw: rawStr, ...(note ? { note } : {}) });
  let s = cleanText(rawStr).normalize("NFKC");
  s = s.replace(/^['‘’`"]+/, "").replace(/['‘’`"]+$/, "").trim();
  s = s.replace(/^(?:tel|sms|callto|facetime|whatsapp)\s*:\s*(?:\/\/)?/i, "");
  s = s.replace(/^[A-Za-z][A-Za-z ]{0,14}:\s*/, ""); // "Mobile: ..." label prefixes
  s = s.replace(/%20/g, " ").replace(/%2B/gi, "+");
  if (!s) return bad();

  const sci = expandScientific(s);
  if (sci) {
    if (sci.lossy) return bad("excel_scientific_notation");
    s = sci.digits;
  }
  s = s.replace(/^(\d+)\.0+$/, "$1"); // "13015550123.0"

  const parts = s.split(/\s*(?:;|\/|\n|\||\bor\b|&|\band\b)\s*/i).map((x) => x.trim()).filter(Boolean);
  let first: { e164: string; mobile: boolean | null } | null = null;
  for (const part of parts) {
    const r = parseOne(part, region);
    if (r) { first = r; break; }
  }
  if (!first) return bad();
  return { e164: first.e164, valid: true, mobile: first.mobile, raw: rawStr, ...(parts.length > 1 ? { note: "multiple_numbers_first_used" } : {}) };
}

const PART_SPLIT = /\s*(?:;|\/|\n|\||\bor\b|&|\band\b)\s*/i;

/** Like normalizePhone, but a number that fails to parse in `region` and has 11 to 15 digits is retried as `+digits`
 *  (a number typed without its "+", e.g. "447911123456"). A rescued number carries note "assumed_country_code". */
export function normalizePhoneLoose(raw: string, region: string = "US"): PhoneResult {
  const r = normalizePhone(raw, region);
  if (r.valid || r.note === "excel_scientific_notation") return r;
  const s0 = cleanText(String(raw ?? "")).normalize("NFKC").replace(/^(?:tel|sms|callto|facetime|whatsapp)\s*:\s*(?:\/\/)?/i, "").replace(/^[A-Za-z][A-Za-z ]{0,14}:\s*/, "");
  for (const part of s0.split(PART_SPLIT).map((x) => x.trim()).filter(Boolean)) {
    const t = part.replace(EXT, "");
    if (/[a-z]/i.test(t) || t.trim().startsWith("+")) continue;
    const digits = t.replace(/\D/g, "");
    if (digits.length < 11 || digits.length > 15) continue;
    const q = parseOne("+" + digits, region);
    if (q) return { e164: q.e164, valid: true, mobile: q.mobile, raw: String(raw ?? ""), note: "assumed_country_code" };
  }
  return r;
}

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

/** Lowercased, trimmed address, or null when it isn't one. Accepts "mailto:", "Name <a@b.co>" and trailing punctuation. */
export function normalizeEmail(raw: string): string | null {
  let s = cleanText(raw);
  if (!s) return null;
  s = s.replace(/^mailto:/i, "");
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(s);
  if (angle) s = angle[1]!;
  s = s.replace(/^[<"'(]+|[>"'),;.]+$/g, "").toLowerCase();
  return EMAIL_RE.test(s) ? s : null;
}

export interface HandleResult {
  handle: string | null;
  kind: "phone" | "email" | null;
  valid: boolean;
  mobile: boolean | null;
}

export function normalizeHandle(input: string, region: string = "US"): HandleResult {
  const s = cleanText(input);
  if (!s) return { handle: null, kind: null, valid: false, mobile: null };
  if (s.includes("@")) {
    const e = normalizeEmail(s);
    return { handle: e, kind: "email", valid: e !== null, mobile: null };
  }
  const p = normalizePhone(s, region);
  return { handle: p.e164, kind: "phone", valid: p.valid, mobile: p.mobile };
}

// ---------- names ----------
const TITLES = new Set(["dr", "mr", "mrs", "ms", "miss", "mx", "prof", "professor", "sir", "dame", "rev", "fr", "pastor", "capt", "captain", "sgt", "hon"]);
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "phd", "md", "esq", "dds", "dvm", "cpa", "mba", "rn", "jd", "np", "msc", "bsc"]);
const PARTICLES = new Set(["van", "von", "de", "der", "den", "da", "di", "del", "della", "du", "la", "le", "bin", "ibn", "al", "el", "st", "ten", "ter", "dos", "das", "do"]);

const tokKey = (t: string) => t.toLowerCase().replace(/[.,]/g, "");
const isTitle = (t: string) => TITLES.has(tokKey(t));
const isSuffix = (t: string) => SUFFIXES.has(tokKey(t));
const isInitial = (t: string) => /^[A-Za-z]\.?$/.test(t);

function titleCaseWord(w: string): string {
  return w.replace(/(^|[-'’])(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase()).replace(/\B\p{L}+/gu, (x) => x.toLowerCase());
}

/** True when the text is all one case (all caps or all lower), which is the only input whose case is "repaired". */
export function isShoutedName(s: string): boolean {
  return /\p{L}/u.test(s) && (s === s.toUpperCase() || s === s.toLowerCase());
}

/** Splits a full name. "Last, First", titles, suffixes, middle initials and single names are handled.
 *  Every given word goes into given_name ("Mary Jane Smith" -> "Mary Jane" + "Smith"), a multi-part surname stays whole
 *  ("Ana de la Cruz" -> "de la Cruz"), single-letter initials and quoted nicknames are dropped. Mixed-case input is left
 *  exactly as written; all-lower or all-caps input is title-cased, except all-caps tokens of 3 letters or fewer ("AJ"). */
export function splitName(full: string): { given_name: string; family_name: string } {
  let s = cleanText(full).replace(/\s+/g, " ");
  const withoutNick = s.replace(/["“”][^"“”]*["“”]/g, " ").replace(/\s+/g, " ").trim();
  s = (withoutNick || s).replace(/["“”]/g, "");
  if (!s) return { given_name: "", family_name: "" };
  const shout = isShoutedName(s);
  const allCaps = shout && s === s.toUpperCase();
  const fix = (w: string) => {
    if (!shout || !/\p{L}/u.test(w)) return w;
    if (allCaps && w.length <= 3 && !PARTICLES.has(tokKey(w))) return w;
    return PARTICLES.has(tokKey(w)) && w === w.toLowerCase() ? w.toLowerCase() : titleCaseWord(w);
  };
  const clean = (tokens: string[]) => tokens.filter((t) => t && !isTitle(t) && !isSuffix(t));
  const givenWords = (tokens: string[]) => {
    const words = tokens.filter((t) => !isInitial(t));
    return words.length ? words : tokens.slice(0, 1);
  };

  const commaParts = s.split(",").map((p) => p.trim()).filter(Boolean);
  let given: string[] = [];
  let family: string[] = [];
  const restAllSuffix = (parts: string[]) => parts.every((p) => p.split(" ").every((t) => isSuffix(t) || isTitle(t)));

  if (commaParts.length >= 2 && !restAllSuffix(commaParts.slice(1))) {
    // "Last, First [Middle]" (optionally "Last, Jr., First")
    family = clean(commaParts[0]!.split(" "));
    given = givenWords(clean(commaParts.slice(1).flatMap((p) => p.split(" "))));
  } else {
    const toks = clean(s.replace(/,/g, " ").split(" "));
    if (toks.length === 1) { given = [toks[0]!]; }
    else if (toks.length >= 2) {
      let i = toks.length - 1;
      family = [toks[i]!];
      while (i - 1 > 0 && PARTICLES.has(tokKey(toks[i - 1]!))) { i--; family.unshift(toks[i]!); }
      given = givenWords(toks.slice(0, i));
    }
  }
  return { given_name: given.map(fix).join(" "), family_name: family.map(fix).join(" ") };
}

/** Header text to a merge-variable slug: "First Name" -> "first_name", "E-mail 1 - Value" -> "e_mail_1_value". */
export function slug(header: string): string {
  const s = String(header ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s || "col";
}

/** Accent-, case- and whitespace-insensitive key for comparing names. */
export function nameKey(s: string): string {
  return String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
