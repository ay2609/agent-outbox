// Turns an import into a batch of template-rendered drafts.
import type { Database } from "bun:sqlite";
import { createBatch, addDraft } from "../core/store";
import type { BatchSource, ProposedContact } from "../core/types";
import { getImport, rowVars } from "../ingest/ingest";
import type { NormalizedRow } from "../ingest/types";
import { lintBatch } from "./lint";
import { renderTemplate } from "./template";

export interface BatchFromImportOptions {
  title: string;
  template: string;
  created_by: string;
  source: BatchSource;
  per_row_bodies?: Record<number, string>;
  create_new_contacts?: boolean; // default true
  include?: number[]; // row indexes
  instructions?: string | null; // extra: stored on the batch; drives the identical_to_template lint
}

/** Standard variables plus every import column slug. Standard names win over a column with the same slug. */
export const varsForRow = rowVars;

/** Builds the single-handle proposed contact for a new person (contract v2 §4): the handle is the draft's handle and
 *  nothing else, so approving can't plant a second number or address under a name. */
export function proposedFor(n: NormalizedRow, handle: string, kind: "phone" | "email", note: string): ProposedContact {
  return {
    given_name: n.given_name, family_name: n.family_name,
    ...(n.org ? { org: n.org } : {}),
    phones: kind === "phone" ? [{ e164: handle, label: n.mobile === false ? "phone" : "mobile" }] : [],
    emails: kind === "email" ? [{ email: handle, label: "other" }] : [],
    note,
    ...(n.tags?.length ? { tags: n.tags } : {}),
  };
}

/** Raised (and the whole batch rolled back) when an import would produce no drafts. */
export class NoDraftsError extends Error {
  code = "no_drafts";
  status = 400;
  constructor(message: string, public skipped: { row_index: number; reason: string }[]) { super(message); this.name = "NoDraftsError"; }
}

export function batchFromImport(db: Database, import_id: string, o: BatchFromImportOptions): { batch_id: string; drafts: number; skipped: { row_index: number; reason: string }[]; lint_error?: string } {
  const imp = getImport(db, import_id);
  const include = o.include ? new Set(o.include) : null;
  const createNew = o.create_new_contacts ?? true;
  const skipped: { row_index: number; reason: string }[] = [];
  let drafts = 0;
  let batchId = "";
  db.transaction(() => {
    batchId = createBatch(db, { title: o.title, created_by: o.created_by, source: o.source, import_id, template: o.template, instructions: o.instructions ?? null, status: "drafting" });
    for (const row of imp.rows) {
      if (include && !include.has(row.row_index)) continue;
      if (row.match === "invalid") { skipped.push({ row_index: row.row_index, reason: "No usable phone number or email" }); continue; }
      if (row.match === "duplicate") {
        const dup = row.issues.find((i) => i.code === "duplicate_of_row" || i.code === "duplicate_person");
        skipped.push({ row_index: row.row_index, reason: dup?.row !== undefined ? (dup.code === "duplicate_person" ? `Same person as row ${dup.row}` : `Duplicate of row ${dup.row}`) : "Duplicate recipient" });
        continue;
      }
      const n = row.normalized;
      if (!n.handle || !n.handle_kind) { skipped.push({ row_index: row.row_index, reason: "No usable phone number or email" }); continue; }
      const vars = rowVars(row, imp.columns);
      const override = o.per_row_bodies?.[row.row_index];
      const body = override !== undefined ? override : renderTemplate(o.template, vars).body;

      const proposed = row.match === "new" ? proposedFor(n, n.handle, n.handle_kind, `Imported from ${imp.filename}`) : null;
      const candidates = row.match === "ambiguous" ? row.issues.flatMap((i) => i.candidates ?? []) : [];
      addDraft(db, batchId, {
        handle: n.handle, body, recipient_name: n.display_name, contact_id: row.match === "matched" ? row.contact_id : null,
        proposed_contact: proposed, create_contact: proposed ? createNew : false, vars,
        notes: candidates.length ? `Possible existing contacts: ${candidates.map((c) => `${c.display_name} (${[...c.phones, ...c.emails].join(", ")})`).join("; ")}` : "",
        import_id, import_row: row.row_index, actor: "template",
      });
      drafts++;
    }
    if (drafts === 0) {
      const why = skipped.length ? ` Skipped ${skipped.length} row(s): ${skipped.slice(0, 3).map((x) => `#${x.row_index} ${x.reason}`).join("; ")}${skipped.length > 3 ? "; ..." : ""}.` : "";
      throw new NoDraftsError(`No drafts would be created from this import.${why} Check the mapping (phone or email column) and the include list.`, skipped);
    }
  }).immediate();
  // Lint after the commit: a lint failure must not turn a created batch into an error (the caller would retry and duplicate it).
  let lint_error: string | undefined;
  try { lintBatch(db, batchId); } catch (e) { lint_error = (e as Error).message; }
  return { batch_id: batchId, drafts, skipped, ...(lint_error ? { lint_error } : {}) };
}
