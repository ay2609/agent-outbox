// Late-bound access to the ingest / personalisation / lint modules at their fixed paths.
// Loaded with dynamic import() so the approval core loads and tests without them.
import type { Database } from "bun:sqlite";
import { ApiError } from "./errors";

export interface BLib {
  normalizeHandle(input: string): { handle: string | null; kind: "phone" | "email" | null; valid: boolean; mobile: boolean | null };
  ingestFile(db: Database, a: { bytes: Uint8Array; filename: string; created_by: string; sheet?: string; kind?: string; importsDir?: string; region?: string }): any;
  setMapping(db: Database, importId: string, mapping: any, opts?: { region?: string }): any;
  getImport(db: Database, id: string): any;
  batchFromImport(db: Database, importId: string, o: {
    title: string; template: string; created_by: string; source: string; per_row_bodies?: Record<number, string>;
    create_new_contacts?: boolean; include?: number[];
  }): { batch_id: string; drafts: number; skipped: { row_index: number; reason: string }[] };
  lintBatch(db: Database, batchId: string): void;
  renderTemplate(template: string, vars: Record<string, string>): { body: string; unresolved: string[]; empty: string[] };
  varsForRow(row: any, columns: string[]): Record<string, string>;
}
let b: BLib | null = null;
export async function loadB(): Promise<BLib> {
  if (b) return b;
  try {
    const [norm, ing, from, lint, tpl] = await Promise.all([
      import("../ingest/normalize"), import("../ingest/ingest"), import("../personalize/from-import"),
      import("../personalize/lint"), import("../personalize/template"),
    ]);
    b = { normalizeHandle: norm.normalizeHandle, ingestFile: ing.ingestFile, setMapping: ing.setMapping, getImport: ing.getImport,
      batchFromImport: from.batchFromImport, varsForRow: from.varsForRow, lintBatch: lint.lintBatch, renderTemplate: tpl.renderTemplate } as unknown as BLib;
    return b;
  } catch (e) {
    throw new ApiError(503, "unavailable", `Imports aren't available: ${(e as Error).message}`);
  }
}
/** Re-lint after an owner edit. Lint is advisory, so a missing or failing linter never blocks an edit.
 *  The linter keys `ambiguous_contact` on the import row, which never changes; once the owner has picked an existing
 *  contact or chosen "create a new one", the question is answered, so that warning is dropped again here. */
export async function tryLint(db: Database, batchId: string): Promise<void> {
  try { (await loadB()).lintBatch(db, batchId); } catch { /* advisory */ }
  dropResolvedAmbiguity(db, batchId);
}
export function dropResolvedAmbiguity(db: Database, batchId: string): void {
  const rows = db.query<{ id: string; warnings_json: string }, [string]>(
    "SELECT id, warnings_json FROM drafts WHERE batch_id = ? AND warnings_json LIKE '%ambiguous_contact%' AND (contact_id IS NOT NULL OR (create_contact = 1 AND proposed_contact_json IS NOT NULL))").all(batchId);
  for (const r of rows) {
    try {
      const ws = (JSON.parse(r.warnings_json) as { code: string }[]).filter((w) => w.code !== "ambiguous_contact");
      db.query("UPDATE drafts SET warnings_json = ? WHERE id = ?").run(JSON.stringify(ws), r.id);
    } catch { /* leave it */ }
  }
}
