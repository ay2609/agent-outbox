import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const IMPORT_EXTENSIONS = ["csv", "tsv", "txt", "xlsx", "xls", "ods", "numbers", "vcf", "json", "jsonl", "md"];
const ROOT_DIRS = ["code", "workspaces", "Downloads", "Desktop", "Documents"];

/** A path an agent asked outboxd (or the MCP/CLI process) to read, refused by the allowlist. */
export class PathRefusedError extends Error {
  code = "path_not_allowed";
  constructor(message: string) { super(message); this.name = "PathRefusedError"; }
}
export class FileProblemError extends Error {
  constructor(public code: "file_not_found" | "not_a_file" | "too_large", message: string) { super(message); this.name = "FileProblemError"; }
}

export interface PathPolicy {
  /** Home directory (tests pass a fake one). */
  home?: string;
  /** Replaces the default allowed roots (home subfolders plus the system temp dirs). */
  roots?: string[];
  maxBytes?: number;
}

export function expandHome(p: string, home = homedir()): string {
  return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

export function allowedRoots(policy: PathPolicy = {}): string[] {
  if (policy.roots) return policy.roots.map((r) => real(r) ?? r);
  const home = policy.home ?? homedir();
  const cands = [...ROOT_DIRS.map((d) => join(home, d)), tmpdir(), process.env.TMPDIR ?? "", "/tmp", "/private/tmp"].filter(Boolean);
  return [...new Set(cands.map((c) => real(c)).filter((x): x is string => !!x))];
}

/** Dot-segments, key and secret files: refused wherever they are. Applied to the path as given AND after symlinks. */
function checkNames(p: string, shown: string): void {
  const segs = p.split(sep).filter((s) => s && s !== "." && s !== "..");
  const hidden = segs.find((s) => s.startsWith("."));
  if (hidden) throw new PathRefusedError(`${shown}: paths with hidden folders or files (".${hidden.slice(1)}") are never read. Copy the file somewhere ordinary, e.g. ~/Downloads, or pass its contents as text.`);
  const name = basename(p).toLowerCase();
  if (name.startsWith(".env") || name.endsWith(".pem") || name.includes("key")) throw new PathRefusedError(`${shown}: files named like keys, certificates or env files are never read.`);
}

/** The allowlist for files an agent wants ingested. Returns the real (symlink-resolved) path of an ordinary data file:
 *  - only under ~/code, ~/workspaces, ~/Downloads, ~/Desktop, ~/Documents or a system temp dir (after realpath, so a
 *    symlink out of those folders is refused);
 *  - no path segment starting with ".", no .env*, *.pem or *key* file names;
 *  - extensions csv, tsv, txt, xlsx, xls, ods, numbers, vcf, json, jsonl, md; at most 25 MB. */
export function checkImportPath(input: string, policy: PathPolicy = {}): string {
  const home = policy.home ?? homedir();
  const given = resolve(process.cwd(), expandHome(input, home));
  checkNames(given, input);
  const p = real(given);
  if (!p) throw new FileProblemError("file_not_found", `no such file: ${given}`);
  checkNames(p, input);
  const roots = allowedRoots(policy);
  if (!roots.some((r) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep))) {
    throw new PathRefusedError(`${input}: only files under ~/code, ~/workspaces, ~/Downloads, ~/Desktop, ~/Documents or a temp folder can be imported by path. Move or copy the file there, or pass its contents as text.`);
  }
  const st = statSync(p);
  if (!st.isFile()) throw new FileProblemError("not_a_file", `${p} is not a regular file`);
  const ext = extname(p).slice(1).toLowerCase();
  if (!IMPORT_EXTENSIONS.includes(ext)) throw new PathRefusedError(`${input}: .${ext || "(none)"} files can't be imported by path (allowed: ${IMPORT_EXTENSIONS.join(", ")}).`);
  if (st.size > (policy.maxBytes ?? MAX_UPLOAD_BYTES)) throw new FileProblemError("too_large", `${p} is over 25 MB`);
  return p;
}

/** Reads a local file in the caller's process (it may have access outboxd lacks) and returns it ready to upload.
 *  Subject to the same path allowlist as the agent API's `path` option. */
export function readUpload(path: string, policy: PathPolicy = {}): { base64: string; filename: string } {
  const p = checkImportPath(path, policy);
  return { base64: readFileSync(p).toString("base64"), filename: basename(p) };
}
