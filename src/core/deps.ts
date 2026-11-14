// Late-bound access to library (ingest, personalisation, lint). Loaded with dynamic import() so this
// package still loads, and can be tested with injected fakes, before or without those modules.
import type { Database } from "bun:sqlite";

export interface HandleInfo { handle: string | null; kind: "phone" | "email" | null; valid: boolean; mobile: boolean | null }
export interface PhoneInfo { e164: string | null; valid: boolean; mobile: boolean | null; raw: string }

export interface BDeps {
  normalizeHandle(input: string): HandleInfo;
  normalizePhone(raw: string, region?: string): PhoneInfo;
  ingestFile(db: Database, args: { bytes: Uint8Array; filename: string; created_by: string; sheet?: string; kind?: string; region?: string }): any;
  setMapping(db: Database, importId: string, mapping: any, opts?: { region?: string }): any;
  /** `page` returns only that slice of rows (rows_total is the full count); every row carries `vars`. */
  getImport(db: Database, id: string, page?: { offset?: number; limit?: number }): any;
  batchFromImport(db: Database, importId: string, opts: {
    title: string; template: string; created_by: string; source: string;
    per_row_bodies?: Record<number, string>; create_new_contacts?: boolean; include?: number[]; instructions?: string | null;
  }): { batch_id: string; drafts: number; skipped: { row_index: number; reason: string }[]; lint_error?: string };
  lintBatch(db: Database, batchId: string): void;
  renderTemplate(template: string, vars: Record<string, string>): { body: string; unresolved: string[]; empty: string[] };
}

let cached: BDeps | null = null;

/** Imports modules at the paths fixed in docs/design/CONTRACTS.md. Throws a readable error if one is missing. */
export async function loadBDeps(): Promise<BDeps> {
  if (cached) return cached;
  try {
    const [norm, ing, from, lint, tpl] = await Promise.all([
      import("../ingest/normalize"), import("../ingest/ingest"), import("../personalize/from-import"),
      import("../personalize/lint"), import("../personalize/template"),
    ]);
    cached = {
      normalizeHandle: norm.normalizeHandle as any, normalizePhone: norm.normalizePhone as any,
      ingestFile: ing.ingestFile as any, setMapping: ing.setMapping as any, getImport: ing.getImport as any,
      batchFromImport: from.batchFromImport as any, lintBatch: lint.lintBatch as any,
      renderTemplate: tpl.renderTemplate as any,
    };
    return cached;
  } catch (e) {
    throw new Error(`ingest/personalise modules are not available: ${(e as Error).message}`);
  }
}
