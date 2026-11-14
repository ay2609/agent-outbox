// Merge-field templates: {{var}}, {{var|fallback}}, \{{ for a literal.
export interface RenderResult { body: string; unresolved: string[]; empty: string[] }

/** Canonical form of a variable name: case-insensitive, whitespace and hyphens read as underscores. */
export const varKey = (s: string): string => s.trim().toLowerCase().replace(/[\s-]+/g, "_");

// Either an escaped opener, or a complete {{name}} / {{name|fallback}} token.
const TOKEN = /\\\{\{|\{\{\s*([^{}|]*?)\s*(?:(\|)([^{}]*))?\}\}/g;

/** Case-insensitive lookup in a vars bag. Returns undefined when the variable isn't there at all. */
export function lookupVar(vars: Record<string, unknown>, name: string): string | undefined {
  const want = varKey(name);
  for (const [k, v] of Object.entries(vars)) if (varKey(k) === want) return v == null ? "" : String(v);
  return undefined;
}

export function renderTemplate(template: string, vars: Record<string, unknown>): RenderResult {
  const idx = new Map<string, string>();
  for (const [k, v] of Object.entries(vars)) idx.set(varKey(k), v == null ? "" : String(v));
  const unresolved = new Set<string>();
  const empty = new Set<string>();
  const body = template.replace(TOKEN, (m, name: string | undefined, bar: string | undefined, fallback: string | undefined) => {
    if (m === "\\{{") return "{{";
    const key = varKey(name ?? "");
    if (!key) return m;
    const has = idx.has(key);
    const val = (idx.get(key) ?? "").trim();
    if (has && val !== "") return val;
    if (bar !== undefined) return (fallback ?? "").trim();
    if (!has) { unresolved.add(key); return m; }
    empty.add(key);
    return "";
  });
  return { body, unresolved: [...unresolved], empty: [...empty] };
}

/** Distinct variable names used by the template (canonical form), in order of first use. Escaped openers are ignored. */
export function listVars(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(TOKEN)) {
    if (m[0] === "\\{{") continue;
    const key = varKey(m[1] ?? "");
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/** Variables that have a `|fallback` somewhere in the template. */
export function varsWithFallback(template: string): Set<string> {
  const s = new Set<string>();
  for (const m of template.matchAll(TOKEN)) if (m[0] !== "\\{{" && m[2] === "|") s.add(varKey(m[1] ?? ""));
  return s;
}
