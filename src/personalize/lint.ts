// Lint warnings for drafts. lintDraft is pure; lintBatch gathers the context from the DB and writes warnings_json.
import type { Database } from "bun:sqlite";
import { getBatch, getDrafts } from "../core/store";
import { GROUP_CONTACT_CHANGED_VAR, type Draft, type DraftStatus, type MatchStatus, type Warning } from "../core/types";
import { normalizeHandle } from "../ingest/normalize";
import type { ImportIssue } from "../ingest/types";
import { renderTemplate, varsWithFallback, listVars, lookupVar } from "./template";

export const TOO_LONG = 1000;
export const RECENT_DAYS = 7;

export interface LintContext {
  template?: string | null;
  instructions?: string | null;
  /** Non-skipped drafts in this batch per `dupKey(handle, body)`: the same text to the same handle. Different texts to one handle are a chain, not a duplicate. */
  duplicateCounts?: Map<string, number>;
  /** Handles with a draft in draft/review/approved in some other (live) batch. */
  pendingElsewhere?: Set<string>;
  /** Handle -> ISO time of the latest send with result 'sent' within RECENT_DAYS. */
  recentlySent?: Map<string, string>;
  /** Handles that have ever had a send (sent or unknown). Used for link_in_first_message. */
  priorSends?: Set<string>;
  /** `${import_id}#${row}` -> match and issues of the import row behind a draft. */
  importRows?: Map<string, { match: MatchStatus; issues: ImportIssue[] }>;
}

const PERSONALISE = /personali[sz]|customi[sz]|tailor|individuali[sz]|per[- ]?recipient|each (?:person|recipient|contact)|unique(?:ly)?\b/i;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+|(?<![@\w.-])(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|ly|me|app|dev|edu|gov|us|ai|xyz|info|biz|link|page|site|shop|store|tv|gl)\b(?:\/[^\s<>"']*)?/i;
const MERGE_TOKEN = /\{\{\s*([^{}|]*?)\s*(?:\|[^{}]*)?\}\}/g;

/** Key of "this exact text to this exact handle" (body compared after trim). */
export const dupKey = (handle: string, body: string): string => `${handle}\u0000${(body ?? "").trim()}`;

const w = (code: Warning["code"], message: string): Warning => ({ code, message });

export function lintDraft(draft: Draft, ctx: LintContext = {}): Warning[] {
  const out: Warning[] = [];
  const body = draft.body ?? "";

  if (body.trim() === "") out.push(w("empty_body", "The message is empty"));

  const unresolved = [...new Set([...body.matchAll(MERGE_TOKEN)].map((m) => (m[1] ?? "").trim()).filter(Boolean))];
  if (unresolved.length) out.push(w("unresolved_var", `Unfilled merge field${unresolved.length > 1 ? "s" : ""}: ${unresolved.map((v) => `{{${v}}}`).join(", ")}`));

  if (ctx.template) {
    // Only meaningful while the body is still exactly what the template produces for this recipient.
    const rendered = renderTemplate(ctx.template, draft.vars ?? {});
    if (rendered.body === body && rendered.empty.length) {
      out.push(w("empty_var", `No value for ${rendered.empty.map((v) => `{{${v}}}`).join(", ")} for this recipient`));
    } else if (rendered.body !== body) {
      // Edited body: still catch variables that came out blank in the original render and have no fallback.
      const fb = varsWithFallback(ctx.template);
      const blank = listVars(ctx.template).filter((v) => !fb.has(v) && (lookupVar(draft.vars ?? {}, v) ?? "x").trim() === "" && body.includes(`{{${v}}}`));
      if (blank.length) out.push(w("empty_var", `No value for ${blank.map((v) => `{{${v}}}`).join(", ")} for this recipient`));
    }
  }

  // Only an exact repeat (same handle, same text) is an accidental duplicate; consecutive different texts to one person are a chain.
  const n = body.trim() ? ctx.duplicateCounts?.get(dupKey(draft.handle, body)) ?? 0 : 0;
  if (n > 1) out.push(w("duplicate_recipient", `The same text goes to this person ${n} times`));

  if (ctx.pendingElsewhere?.has(draft.handle)) out.push(w("pending_elsewhere", "Another batch already has an unsent message to this recipient"));

  const recent = ctx.recentlySent?.get(draft.handle);
  if (recent) out.push(w("recently_messaged", `Messaged from the outbox on ${recent.slice(0, 10)} (within ${RECENT_DAYS} days)`));

  const h = normalizeHandle(draft.handle);
  if (!h.valid) out.push(w("invalid_handle", `"${draft.handle}" isn't a valid phone number or email`));
  else if (h.kind === "phone" && h.mobile === false) out.push(w("non_mobile", "This number looks like a landline or toll-free line"));

  if (body.length > TOO_LONG) out.push(w("too_long", `${body.length} characters; over ${TOO_LONG} may be split or look like spam`));

  if (ctx.template && body === ctx.template && ctx.instructions && PERSONALISE.test(ctx.instructions)) {
    out.push(w("identical_to_template", "The message is identical to the template, but the batch asks for personalisation"));
  }

  const row = draft.import_id != null && draft.import_row != null ? ctx.importRows?.get(`${draft.import_id}#${draft.import_row}`) : undefined;
  if (row?.match === "ambiguous") {
    const names = row.issues.flatMap((i) => i.candidates ?? []).map((c) => c.display_name).filter(Boolean);
    out.push(w("ambiguous_contact", `May match an existing contact${names.length ? `: ${[...new Set(names)].join(", ")}` : ""}; pick one or create a new contact`));
  }
  if (!draft.contact_id && draft.proposed_contact && row?.match !== "ambiguous") out.push(w("new_contact", "Not in your contacts yet"));

  // A saved group's member whose contact no longer has this number: the name on the draft may not be who owns it now.
  const changed = draft.vars?.[GROUP_CONTACT_CHANGED_VAR];
  if (changed) out.push(w("group_contact_changed", changed));

  if (!ctx.priorSends?.has(draft.handle) && URL_RE.test(body)) {
    out.push(w("link_in_first_message", "A link in a first message to someone new is likely to be filtered as spam"));
  }
  return out;
}

const LINTABLE: DraftStatus[] = ["draft", "review", "approved", "skipped", "failed"];
const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

/** Recomputes warnings for every editable draft in the batch and stores them in warnings_json. */
export function lintBatch(db: Database, batch_id: string, opts: { now?: Date } = {}): void {
  const batch = getBatch(db, batch_id);
  if (!batch) throw new Error(`batch ${batch_id} not found`);
  const drafts = getDrafts(db, batch_id);
  if (!drafts.length) return;
  const handles = [...new Set(drafts.map((d) => d.handle))];
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - RECENT_DAYS * 86_400_000).toISOString();

  const duplicateCounts = new Map<string, number>();
  for (const d of drafts) {
    if (d.status === "skipped" || d.status === "rejected") continue;
    const k = dupKey(d.handle, d.body);
    duplicateCounts.set(k, (duplicateCounts.get(k) ?? 0) + 1);
  }

  const pendingElsewhere = new Set(
    (db.query(`SELECT DISTINCT d.handle FROM drafts d JOIN batches b ON b.id = d.batch_id
               WHERE d.batch_id != ? AND d.status IN ('draft','review','approved') AND b.status != 'cancelled' AND d.handle IN (${marks(handles.length)})`)
      .all(batch_id, ...handles) as { handle: string }[]).map((r) => r.handle));

  const recentlySent = new Map<string, string>();
  for (const r of db.query(`SELECT d.handle AS handle, MAX(COALESCE(s.finished_at, s.started_at)) AS at FROM sends s JOIN drafts d ON d.id = s.draft_id
        WHERE s.result = 'sent' AND COALESCE(s.finished_at, s.started_at) >= ? AND d.handle IN (${marks(handles.length)}) GROUP BY d.handle`)
    .all(cutoff, ...handles) as { handle: string; at: string }[]) recentlySent.set(r.handle, r.at);

  const priorSends = new Set(
    (db.query(`SELECT DISTINCT d.handle FROM sends s JOIN drafts d ON d.id = s.draft_id
               WHERE s.result IN ('sent','unknown') AND d.handle IN (${marks(handles.length)})`).all(...handles) as { handle: string }[]).map((r) => r.handle));

  const importRows = new Map<string, { match: MatchStatus; issues: ImportIssue[] }>();
  const importIds = [...new Set(drafts.map((d) => d.import_id).filter((x): x is string => !!x))];
  for (const id of importIds) {
    for (const r of db.query("SELECT row_index, match, issues_json FROM import_rows WHERE import_id = ?").all(id) as any[]) {
      let issues: ImportIssue[] = [];
      try { issues = JSON.parse(r.issues_json); } catch { /* keep empty */ }
      importRows.set(`${id}#${r.row_index}`, { match: r.match, issues });
    }
  }

  const ctx: LintContext = { template: batch.template, instructions: batch.instructions, duplicateCounts, pendingElsewhere, recentlySent, priorSends, importRows };
  const upd = db.query("UPDATE drafts SET warnings_json = ? WHERE id = ?");
  db.transaction(() => {
    for (const d of drafts) if (LINTABLE.includes(d.status)) upd.run(JSON.stringify(lintDraft(d, ctx)), d.id);
  }).immediate();
}

/** Re-lints every batch still being drafted or reviewed (run once at server start, so a rule change reaches stored warnings).
 *  Returns how many batches were linted; a batch that fails to lint is skipped, not fatal. */
export function relintOpenBatches(db: Database): number {
  const ids = (db.query("SELECT id FROM batches WHERE status IN ('drafting','review')").all() as { id: string }[]).map((r) => r.id);
  let n = 0;
  for (const id of ids) {
    try { lintBatch(db, id); n++; } catch { /* advisory */ }
  }
  return n;
}
