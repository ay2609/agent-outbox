// The agent API: draft-only. Nothing here can approve or send. See the
// forbidden-route test in tests/agent-api.forbidden.test.ts, which fails if a route or a SQL write to a gated table
// appears in src/agent-api/.
import type { Database } from "bun:sqlite";
import { Hono, type Context } from "hono";
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { getDb, newId, nowIso } from "../db";
import { pickHandle } from "../core/contact-pick";
import {
  ContactValidationError, MAX_CHANGES, contactSetCounts, contactSetView, getContactSet, planFromImport, proposeContactChanges,
  validateProposal, type ProposeResult,
} from "../core/contact-changes";
import { contactVars } from "../core/contacts-sync";
import {
  GroupError, addMembers, createGroup, getGroup, groupSummary, itemsForBatch, listGroups, membersFromContactIds, membersFromImport,
  removeMembers, updateGroup, type AddResult, type MemberInput,
} from "../core/groups";
import { loadBDeps, type BDeps } from "../core/deps";
import { FileProblemError, MAX_UPLOAD_BYTES, PathRefusedError, checkImportPath, expandHome } from "../core/upload";
import { availableVars, resolveColumn } from "../ingest/mapping";
import { listVars, varKey } from "../personalize/template";
import { ORIGIN } from "../core/paths";
import {
  addDraft, audit, createBatch, getBatch, getContact, getDrafts, getSettings, findContactsByHandle,
  rowToContact, setBatchStatus, updateDraftBody, type NewDraft,
} from "../core/store";
import type { BatchSource, BatchStatus, Contact, ContactSetSource, Draft, ProposedContact, Warning } from "../core/types";

export interface AgentAppOptions {
  db?: () => Database;
  deps?: () => Promise<BDeps>;
  origin?: string;
}

// ---------- errors ----------
export class ApiError extends Error {
  constructor(public status: 400 | 403 | 404 | 409 | 413 | 500 | 502, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

const BATCH_STATUSES = ["drafting", "review", "approved", "sending", "done", "cancelled"] as const;
const MAPPING_FIELDS = ["display_name", "given_name", "family_name", "phone", "email", "org", "notes", "tags"] as const;
// Draft statuses an agent may still edit. Never approved, sending, sent, failed or unknown.
const AGENT_EDITABLE = ["draft", "review", "skipped"];

// ---------- request schemas ----------
const serviceS = z.enum(["iMessage", "SMS", "auto"]);
const phoneS = z.union([
  z.string().min(1),
  z.object({ e164: z.string().min(1), label: z.string().optional(), raw: z.string().optional() }),
]);
const emailS = z.union([z.string().min(1), z.object({ email: z.string().min(1), label: z.string().optional() })]);
const proposedContactS = z.object({
  given_name: z.string().default(""), family_name: z.string().default(""), org: z.string().optional(),
  phones: z.array(phoneS).default([]), emails: z.array(emailS).default([]), note: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
const varsS = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
const itemS = z.object({
  to: z.string().min(1).optional(),
  contact_id: z.string().min(1).optional(),
  body: z.string().max(20000).optional(),
  vars: varsS.optional(),
  recipient_name: z.string().optional(),
  proposed_contact: proposedContactS.optional(),
  service: serviceS.optional(),
  notes: z.string().optional(),
});
type Item = z.infer<typeof itemS>;

const draftBodyS = z.object({
  to: z.string().min(1).optional(),
  contact_id: z.string().min(1).optional(),
  body: z.string().min(1).max(20000),
  service: serviceS.optional(),
  notes: z.string().optional(),
  title: z.string().min(1).max(200).optional(),
});
const batchBodyS = z.object({
  title: z.string().min(1).max(200),
  template: z.string().optional(),
  instructions: z.string().optional(),
  items: z.array(itemS).max(500).optional(),
  submit: z.boolean().optional(),
});
const itemsBodyS = z.object({ items: z.array(itemS).min(1).max(500) });
const patchDraftS = z.object({ body: z.string().min(1).max(20000) });
const bulkUpdateS = z.object({ updates: z.array(z.object({ draft_id: z.string().min(1), body: z.string().min(1).max(20000) })).min(1).max(500) });
const regionS = z.string().regex(/^[A-Za-z]{2}$/, "region is a two-letter country code such as US or GB");
const importBodyS = z.object({
  path: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  base64: z.string().min(1).optional(),
  filename: z.string().min(1).optional(),
  sheet: z.string().optional(),
  kind: z.string().optional(),
  region: regionS.optional(),
}).refine((v) => [v.path, v.text, v.base64].filter((x) => x !== undefined).length === 1, {
  message: "give exactly one of path, text or base64",
}).refine((v) => v.base64 === undefined || v.filename !== undefined, { message: "base64 needs a filename" });
const mappingBodyS = z.object({
  fields: z.partialRecord(z.enum(MAPPING_FIELDS), z.object({
    column: z.string().min(1).optional(), columns: z.array(z.string().min(1)).optional(), confidence: z.number().min(0).max(1).optional(),
  }).refine((v) => v.column !== undefined || (v.columns?.length ?? 0) > 0, { message: "give column (or columns)" }).nullable()),
  vars: z.record(z.string(), z.string()).optional(),
  confirmed: z.boolean().optional(),
  region: regionS.optional(),
});
const importBatchS = z.object({
  title: z.string().min(1).max(200),
  template: z.string().min(1),
  per_row_bodies: z.record(z.string(), z.string()).optional(),
  create_new_contacts: z.boolean().optional(),
  include: z.array(z.number().int().min(0)).optional(),
  submit: z.boolean().optional(),
  instructions: z.string().optional(),
  allow_unknown_vars: z.boolean().optional(),
});

// Saved groups (v5). Members: a phone or email and/or a contact id; people can also come from contacts or an import.
const MAX_MEMBERS_PER_CALL = 1000;
const memberS = z.object({
  to: z.string().min(1).optional(), contact_id: z.string().min(1).optional(), name: z.string().max(200).optional(), vars: varsS.optional(),
}).strict();
const memberSources = {
  members: z.array(memberS).max(MAX_MEMBERS_PER_CALL).optional(),
  contact_ids: z.array(z.string().min(1)).max(MAX_MEMBERS_PER_CALL).optional(),
  from_import: z.object({ import_id: z.string().min(1), rows: z.array(z.number().int().min(0)).optional() }).strict().optional(),
};
const groupCreateS = z.object({ name: z.string().min(1), description: z.string().optional(), ...memberSources }).strict();
const groupMembersS = z.object({ ...memberSources }).strict();
const groupRemoveS = z.object({ handles: z.array(z.string().min(1)).max(MAX_MEMBERS_PER_CALL).optional(), contact_ids: z.array(z.string().min(1)).max(MAX_MEMBERS_PER_CALL).optional() }).strict();
const groupPatchS = z.object({ name: z.string().min(1).optional(), description: z.string().optional() }).strict();
const groupBatchS = z.object({
  title: z.string().min(1).max(200),
  template: z.string().optional(),
  bodies: z.record(z.string(), z.string().max(20000)).optional(),
  only: z.array(z.string().min(1)).optional(),
  instructions: z.string().optional(),
  submit: z.boolean().optional(),
}).strict();

// Contact changes (v4). The items themselves are validated by src/core/contact-changes.ts, which refuses unknown keys.
const CONTACT_SET_STATUSES = ["drafting", "review", "approved", "applying", "done", "cancelled"] as const;
const contactChangesS = z.object({
  title: z.string().min(1).max(200),
  creates: z.array(z.unknown()).max(MAX_CHANGES).optional(),
  updates: z.array(z.unknown()).max(MAX_CHANGES).optional(),
  region: regionS.optional(),
}).strict();
const importContactChangesS = z.object({
  title: z.string().min(1).max(200).optional(),
  first_name_prefix: z.string().max(100).optional(),
  first_name_suffix: z.string().max(100).optional(),
  include: z.array(z.number().int().min(0)).optional(),
  groups: z.array(z.string()).max(5).optional(),
}).strict();

// ---------- helpers ----------
const sanitizeLabel = (s: string | undefined): string => (s ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "unknown";

interface Who { label: string; actor: string; source: BatchSource; revisionActor: "agent" }
function who(c: Context): Who {
  const label = sanitizeLabel(c.req.header("x-outbox-client"));
  const s = c.req.header("x-outbox-source");
  const source: BatchSource = s === "cli" ? s : "mcp";
  return { label, actor: `agent:${label}`, source, revisionActor: "agent" };
}

async function parseJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new ApiError(400, "invalid_json", "request body must be JSON"); }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    const first = issues[0];
    throw new ApiError(400, "validation_error", `invalid request: ${first ? `${first.path || "body"}: ${first.message}` : "bad input"}`, issues);
  }
  return r.data;
}

function splitFirst(name: string): string { return name.trim().split(/\s+/)[0] ?? ""; }

interface ItemError { index: number; message: string }

export function createAgentApp(opts: AgentAppOptions = {}): Hono {
  const getDatabase = opts.db ?? getDb;
  const getDeps = opts.deps ?? loadBDeps;
  const origin = (opts.origin ?? ORIGIN).replace(/\/$/, "");
  const app = new Hono();

  const dashboardUrl = (batchId: string) => `${origin}/#/batch/${batchId}`;
  const importUrl = (importId: string) => `${origin}/#/imports/${importId}`;

  /** Lint runs after the data is committed. If it throws, the batch still exists, so report it instead of failing the
   *  request (a 500 would make the agent retry and create the batch twice). */
  function safeLint(deps: BDeps, db: Database, batchId: string): string | undefined {
    try { deps.lintBatch(db, batchId); return undefined; }
    catch (e) {
      console.error("[agent-api] lint failed for batch", batchId, (e as Error).message);
      return `Lint failed (${(e as Error).message}); warnings for this batch may be missing or out of date. The batch itself was saved.`;
    }
  }
  const withLint = <T extends object>(view: T, lintError: string | undefined): T & { lint_error?: string } => (lintError ? { ...view, lint_error: lintError } : view);

  // ----- batch view -----
  function batchView(db: Database, id: string, withSends = false) {
    const batch = getBatch(db, id);
    if (!batch) throw new ApiError(404, "batch_not_found", `batch ${id} not found`);
    const drafts = getDrafts(db, id);
    const warnings = drafts.flatMap((d) => d.warnings.map((w) => ({
      draft_id: d.id, recipient: d.recipient_name || d.handle, code: w.code, message: w.message,
    })));
    const counts: Record<string, number> = {};
    for (const d of drafts) counts[d.status] = (counts[d.status] ?? 0) + 1;
    let outDrafts: (Draft & { sends?: unknown[] })[] = drafts;
    if (withSends) {
      const sends = db.query("SELECT draft_id, attempt, transport, service_used, started_at, finished_at, result, error FROM sends WHERE draft_id IN (SELECT id FROM drafts WHERE batch_id = ?) ORDER BY started_at")
        .all(id) as any[];
      outDrafts = drafts.map((d) => ({ ...d, sends: sends.filter((s) => s.draft_id === d.id) }));
    }
    return { batch, drafts: outDrafts, counts, warnings, dashboard_url: dashboardUrl(id) };
  }

  // ----- item resolution -----
  async function resolveItems(db: Database, deps: BDeps, items: Item[], template: string | null, w: Who): Promise<NewDraft[]> {
    const out: NewDraft[] = [];
    const errors: ItemError[] = [];
    items.forEach((item, index) => {
      try { out.push(resolveItem(db, deps, item, template, w)); }
      catch (e) {
        if (e instanceof ApiError) errors.push({ index, message: e.message }); else throw e;
      }
    });
    if (errors.length) {
      const msg = errors.slice(0, 5).map((e) => `item ${e.index}: ${e.message}`).join("; ");
      throw new ApiError(400, "invalid_items", `${errors.length} item(s) rejected, nothing was created. ${msg}${errors.length > 5 ? "; ..." : ""}`, errors);
    }
    return out;
  }

  /** Normalises every handle the agent gave. Narrowing to the draft's single handle happens in `singleHandle`. */
  function normalizeProposed(deps: BDeps, p: z.infer<typeof proposedContactS>): ProposedContact {
    const phones = p.phones.map((ph) => {
      const raw = typeof ph === "string" ? ph : ph.e164;
      const h = deps.normalizeHandle(raw);
      if (!h.valid || h.kind !== "phone" || !h.handle) throw new ApiError(400, "invalid_handle", `proposed_contact phone "${raw}" is not a valid phone number`);
      return { e164: h.handle, label: typeof ph === "string" ? "mobile" : (ph.label ?? "mobile"), ...(typeof ph === "string" ? {} : ph.raw ? { raw: ph.raw } : {}) };
    });
    const emails = p.emails.map((em) => {
      const raw = typeof em === "string" ? em : em.email;
      const h = deps.normalizeHandle(raw);
      if (!h.valid || h.kind !== "email" || !h.handle) throw new ApiError(400, "invalid_handle", `proposed_contact email "${raw}" is not valid`);
      return { email: h.handle, label: typeof em === "string" ? "home" : (em.label ?? "home") };
    });
    return { given_name: p.given_name, family_name: p.family_name, ...(p.org ? { org: p.org } : {}), phones, emails, ...(p.note ? { note: p.note } : {}), ...(p.tags?.length ? { tags: p.tags } : {}) };
  }

  /** Contract v2 §4: a proposed contact has exactly one handle, equal to the draft's. Extra handles are dropped; a
   *  `to` that none of the proposal's handles match is refused. */
  function singleHandle(p: ProposedContact, handle: string): ProposedContact {
    const listed = [...p.phones.map((x) => x.e164), ...p.emails.map((x) => x.email)];
    if (listed.length && !listed.includes(handle)) {
      throw new ApiError(400, "handle_proposed_mismatch", `to "${handle}" is not one of proposed_contact's numbers or addresses (${listed.join(", ")}); a new contact may only be created with the number or address the message goes to`);
    }
    const isEmail = handle.includes("@");
    const phone = p.phones.find((x) => x.e164 === handle);
    const email = p.emails.find((x) => x.email === handle);
    return {
      ...p,
      phones: isEmail ? [] : [phone ?? { e164: handle, label: "mobile" }],
      emails: isEmail ? [email ?? { email: handle, label: "home" }] : [],
    };
  }

  function resolveItem(db: Database, deps: BDeps, item: Item, template: string | null, w: Who): NewDraft {
    let contact: Contact | null = null;
    if (item.contact_id) {
      contact = getContact(db, item.contact_id);
      if (!contact) throw new ApiError(404, "contact_not_found", `contact ${item.contact_id} not found`);
    }
    let proposed = item.proposed_contact ? normalizeProposed(deps, item.proposed_contact) : null;

    let handle: string | null = null;
    if (item.to) {
      const h = deps.normalizeHandle(item.to);
      if (!h.valid || !h.handle) throw new ApiError(400, "invalid_handle", `"${item.to}" is not a valid phone number or email address`);
      handle = h.handle;
      if (contact) {
        const owns = db.query("SELECT 1 FROM contact_handles WHERE contact_id = ? AND handle = ?").get(contact.id, handle);
        if (!owns) throw new ApiError(400, "handle_contact_mismatch", `${item.to} is not a number or email of contact ${contact.display_name || contact.id}; leave out contact_id, or leave out to to use the contact's own number`);
      } else {
        const found = findContactsByHandle(db, handle);
        if (found.length === 1) contact = found[0]!;
      }
    } else if (contact) {
      const p = pickHandle(contact);
      if (!p) throw new ApiError(400, "no_handle", `contact ${contact.display_name || contact.id} has no phone number or email`);
      handle = p.handle;
    } else if (proposed) {
      const p = pickHandle({ phones: proposed.phones, emails: proposed.emails });
      if (!p) throw new ApiError(400, "no_handle", "proposed_contact has no phone number or email");
      handle = p.handle;
    } else {
      throw new ApiError(400, "missing_recipient", "give to (a phone number or email) or contact_id");
    }
    if (proposed && !contact) proposed = singleHandle(proposed, handle);

    const name = item.recipient_name?.trim()
      || contact?.display_name || [proposed?.given_name, proposed?.family_name].filter(Boolean).join(" ") || "";
    const vars: Record<string, string> = {};
    if (contact) { Object.assign(vars, contactVars(db, contact.id)); if (contact.tags.length) vars.tags = contact.tags.join(", "); }
    for (const [k, v] of Object.entries(item.vars ?? {})) vars[k] = String(v);

    let body = item.body?.trim();
    if (!body) {
      if (!template) throw new ApiError(400, "missing_body", "no body and no batch template to build one from");
      const given = contact?.given_name || proposed?.given_name || splitFirst(name);
      const std: Record<string, string> = {
        first_name: given, last_name: contact?.family_name ?? proposed?.family_name ?? "", full_name: name,
        name: given || name, org: contact?.org ?? proposed?.org ?? "",
      };
      body = deps.renderTemplate(template, { ...std, ...vars }).body.trim();
      if (!body) throw new ApiError(400, "missing_body", "the template rendered to an empty message");
    }

    return {
      handle, body, service: item.service ?? "auto", recipient_name: name, contact_id: contact?.id ?? null,
      proposed_contact: contact ? null : proposed, create_contact: !contact && !!proposed, vars,
      notes: item.notes ?? "", actor: w.revisionActor,
    };
  }

  function insertDrafts(db: Database, batchId: string, drafts: NewDraft[]) {
    for (const d of drafts) addDraft(db, batchId, d);
  }

  // ----- routes -----
  app.get("/v1/health", (c) => c.json({ ok: true, service: "outboxd-agent-api", time: nowIso() }));

  app.get("/v1/status", (c) => {
    const db = getDatabase();
    const hb = db.query("SELECT * FROM exec_status WHERE id = 1").get() as any;
    const age = hb ? Math.round((Date.now() - Date.parse(hb.heartbeat_at)) / 1000) : null;
    const byStatus = Object.fromEntries((db.query("SELECT status, COUNT(*) AS n FROM batches GROUP BY status").all() as any[]).map((r) => [r.status, r.n]));
    const s = getSettings(db);
    return c.json({
      ok: true,
      executor: hb ? { alive: age !== null && age < 120, heartbeat_age_s: age, transport: hb.transport, pin_file_ok: !!hb.pin_file_ok, last_error: hb.last_error } : { alive: false },
      transport: s.transport, kill_switch: s.kill_switch,
      batches: byStatus,
      contacts: (db.query("SELECT COUNT(*) AS n FROM contacts").get() as any).n,
      dashboard_url: `${origin}/`,
    });
  });

  // Drafts and batches
  app.post("/v1/drafts", async (c) => {
    const w = who(c);
    const input = await parseJson(c, draftBodyS);
    const db = getDatabase(); const deps = await getDeps();
    const [draft] = await resolveItems(db, deps, [{ to: input.to, contact_id: input.contact_id, body: input.body, service: input.service, notes: input.notes }], null, w);
    const batchId = db.transaction(() => {
      const title = input.title ?? `Message to ${draft!.recipient_name || draft!.handle}`;
      const id = createBatch(db, { title, created_by: w.actor, source: w.source, status: "review" });
      insertDrafts(db, id, [draft!]);
      return id;
    }).immediate();
    const lintError = safeLint(deps, db, batchId);
    const view = batchView(db, batchId);
    return c.json(withLint({ ...view, draft: view.drafts[0] }, lintError), 201);
  });

  /** Resolves the items (all or nothing), creates the batch and lints it. Shared by POST /v1/batches and the group batch. */
  async function makeBatch(w: Who, db: Database, deps: BDeps, input: { title: string; template?: string; instructions?: string; items?: Item[]; submit?: boolean }) {
    const drafts = await resolveItems(db, deps, input.items ?? [], input.template ?? null, w);
    if (input.submit && drafts.length === 0) throw new ApiError(400, "empty_batch", "can't submit a batch with no items");
    const batchId = db.transaction(() => {
      const id = createBatch(db, {
        title: input.title, created_by: w.actor, source: w.source, template: input.template ?? null,
        instructions: input.instructions ?? null, status: input.submit ? "review" : "drafting",
      });
      insertDrafts(db, id, drafts);
      return id;
    }).immediate();
    const lintError = drafts.length ? safeLint(deps, db, batchId) : undefined;
    const view = batchView(db, batchId);
    return { ...withLint(view, lintError), next_step: view.batch.status === "drafting" ? "Add items with POST /v1/batches/:id/items if needed, then submit with POST /v1/batches/:id/submit so the user can review it." : "Submitted. The user reviews and approves it in the dashboard." };
  }

  app.post("/v1/batches", async (c) => {
    const w = who(c);
    const input = await parseJson(c, batchBodyS);
    const db = getDatabase(); const deps = await getDeps();
    return c.json(await makeBatch(w, db, deps, input), 201);
  });

  app.post("/v1/batches/:id/items", async (c) => {
    const w = who(c);
    const id = c.req.param("id");
    const input = await parseJson(c, itemsBodyS);
    const db = getDatabase(); const deps = await getDeps();
    const batch = getBatch(db, id);
    if (!batch) throw new ApiError(404, "batch_not_found", `batch ${id} not found`);
    if (batch.status !== "drafting") throw new ApiError(409, "batch_not_drafting", `batch is ${batch.status}; items can only be added while it is drafting`);
    const drafts = await resolveItems(db, deps, input.items, batch.template, w);
    db.transaction(() => {
      const again = getBatch(db, id);
      if (!again || again.status !== "drafting") throw new ApiError(409, "batch_not_drafting", `batch is ${again?.status ?? "gone"}; items can only be added while it is drafting`);
      insertDrafts(db, id, drafts);
      db.query("UPDATE batches SET updated_at = ? WHERE id = ?").run(nowIso(), id);
    }).immediate();
    const lintError = safeLint(deps, db, id);
    return c.json(withLint(batchView(db, id), lintError), 201);
  });

  app.post("/v1/batches/:id/submit", async (c) => {
    const w = who(c);
    const id = c.req.param("id");
    const db = getDatabase(); const deps = await getDeps();
    const batch = getBatch(db, id);
    if (!batch) throw new ApiError(404, "batch_not_found", `batch ${id} not found`);
    let lintError: string | undefined;
    if (batch.status === "drafting") {
      if (getDrafts(db, id).length === 0) throw new ApiError(400, "empty_batch", "can't submit a batch with no drafts");
      lintError = safeLint(deps, db, id);
      db.transaction(() => {
        if (getBatch(db, id)?.status === "drafting") setBatchStatus(db, id, "review", w.actor);
      }).immediate();
    } else if (batch.status !== "review") {
      throw new ApiError(409, "not_submittable", `batch is ${batch.status}; only a drafting batch can be submitted`);
    }
    return c.json({ ...withLint(batchView(db, id), lintError), message: "Waiting for the user to review and approve it in the dashboard." });
  });

  app.get("/v1/batches", (c) => {
    const db = getDatabase();
    const status = c.req.query("status");
    if (status && !(BATCH_STATUSES as readonly string[]).includes(status)) throw new ApiError(400, "validation_error", `status must be one of ${BATCH_STATUSES.join(", ")}`);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const rows = db.query(`SELECT b.*, (SELECT COUNT(*) FROM drafts d WHERE d.batch_id = b.id) AS draft_count
      FROM batches b ${status ? "WHERE b.status = ?" : ""} ORDER BY b.created_at DESC LIMIT ?`)
      .all(...(status ? [status, limit] : [limit])) as any[];
    return c.json({ batches: rows.map((r) => ({ ...r, dashboard_url: dashboardUrl(r.id) })) });
  });

  app.get("/v1/batches/:id", (c) => c.json(batchView(getDatabase(), c.req.param("id"), true)));

  /** One edit, checked and applied inside the caller's transaction. Throws ApiError when the draft can't be edited. */
  function applyBodyEdit(db: Database, id: string, rawBody: string): { batch_id: string; changed: boolean } {
    const cur = db.query("SELECT id, batch_id, status, body FROM drafts WHERE id = ?").get(id) as any;
    if (!cur) throw new ApiError(404, "draft_not_found", `draft ${id} not found`);
    if (!AGENT_EDITABLE.includes(cur.status)) throw new ApiError(409, "draft_not_editable", `draft is ${cur.status}; the agent can only edit drafts that are not yet approved. Ask the user to edit it in the dashboard.`);
    const batch = getBatch(db, cur.batch_id);
    if (batch?.status === "cancelled") throw new ApiError(409, "batch_cancelled", "the batch was cancelled");
    const body = rawBody.trim();
    if (!body) throw new ApiError(400, "validation_error", "body can't be empty");
    if (body === cur.body) return { batch_id: cur.batch_id, changed: false };
    try { updateDraftBody(db, id, body, "agent"); }
    catch (e) { throw new ApiError(409, "draft_not_editable", (e as Error).message); }
    return { batch_id: cur.batch_id, changed: true };
  }

  app.patch("/v1/drafts/:id", async (c) => {
    const id = c.req.param("id");
    const input = await parseJson(c, patchDraftS);
    const db = getDatabase(); const deps = await getDeps();
    const r = db.transaction(() => applyBodyEdit(db, id, input.body)).immediate();
    const lintError = r.changed ? safeLint(deps, db, r.batch_id) : undefined;
    const view = batchView(db, r.batch_id);
    return c.json(withLint({ draft: view.drafts.find((d) => d.id === id), warnings: view.warnings.filter((x) => x.draft_id === id), batch_id: r.batch_id, dashboard_url: view.dashboard_url }, lintError));
  });

  // Bulk body edits, all or nothing: every update is checked first and nothing changes if any one is refused.
  app.patch("/v1/drafts", async (c) => {
    const input = await parseJson(c, bulkUpdateS);
    const db = getDatabase(); const deps = await getDeps();
    const ids = input.updates.map((u) => u.draft_id);
    const dupes = ids.filter((x, i) => ids.indexOf(x) !== i);
    if (dupes.length) throw new ApiError(400, "validation_error", `draft_id listed more than once: ${[...new Set(dupes)].join(", ")}`);
    class Rollback extends Error { constructor(public errors: ItemError[]) { super("rollback"); } }
    let result: { batches: Set<string>; changed: number };
    try {
      result = db.transaction(() => {
        const errors: ItemError[] = [];
        const batches = new Set<string>(); let changed = 0;
        input.updates.forEach((u, index) => {
          try { const r = applyBodyEdit(db, u.draft_id, u.body); batches.add(r.batch_id); if (r.changed) changed++; }
          catch (e) { if (e instanceof ApiError) errors.push({ index, message: `${u.draft_id}: ${e.message}` }); else throw e; }
        });
        if (errors.length) throw new Rollback(errors); // undoes the edits that did succeed
        return { batches, changed };
      }).immediate();
    } catch (e) {
      if (e instanceof Rollback) {
        const msg = e.errors.slice(0, 5).map((x) => `update ${x.index} (${x.message})`).join("; ");
        throw new ApiError(400, "invalid_updates", `${e.errors.length} update(s) refused, nothing was changed. ${msg}${e.errors.length > 5 ? "; ..." : ""}`, e.errors);
      }
      throw e;
    }
    const lintErrors = [...result.batches].map((b) => safeLint(deps, db, b)).filter((x): x is string => !!x);
    return c.json({
      updated: result.changed, unchanged: input.updates.length - result.changed,
      batches: [...result.batches].map((b) => { const v = batchView(db, b); return { id: b, dashboard_url: v.dashboard_url, warnings: v.warnings }; }),
      ...(lintErrors.length ? { lint_error: lintErrors[0] } : {}),
    });
  });

  // Cancel: the one status change an agent may make besides drafting -> review, because it can only STOP messages. Only
  // for a drafting or review batch this same client created; its unsent drafts become rejected.
  app.post("/v1/batches/:id/cancel", async (c) => {
    const w = who(c);
    const id = c.req.param("id");
    const db = getDatabase();
    const rejected = db.transaction(() => {
      const batch = getBatch(db, id);
      if (!batch) throw new ApiError(404, "batch_not_found", `batch ${id} not found`);
      if (batch.created_by !== w.actor) throw new ApiError(403, "not_your_batch", `this batch was created by ${batch.created_by}; a session can only cancel its own batches. The user can cancel any batch in the dashboard.`);
      if (batch.status !== "drafting" && batch.status !== "review") throw new ApiError(409, "not_cancellable", `batch is ${batch.status}; only a drafting or review batch can be cancelled here. Ask the user to stop it in the dashboard.`);
      const open = db.query("SELECT COUNT(*) AS n FROM drafts WHERE batch_id = ? AND status NOT IN ('draft','review','skipped','rejected')").get(id) as { n: number };
      if (open.n > 0) throw new ApiError(409, "not_cancellable", `${open.n} draft(s) in this batch are already approved or sent; ask the user to stop it in the dashboard.`);
      const r = db.query("UPDATE drafts SET status = 'rejected', updated_at = ? WHERE batch_id = ? AND status IN ('draft','review','skipped')").run(nowIso(), id);
      setBatchStatus(db, id, "cancelled", w.actor);
      return r.changes;
    }).immediate();
    return c.json({ ...batchView(db, id), cancelled: true, drafts_rejected: rejected, message: "Batch cancelled; none of its messages will be sent." });
  });

  // Contacts
  const slimContact = (db: Database, c: Contact) => {
    const { notes: _notes, ...rest } = c;
    const vars = contactVars(db, c.id);
    return { ...rest, preferred_handle: pickHandle(c)?.handle ?? null, ...(Object.keys(vars).length ? { vars } : {}) };
  };
  const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);
  const HAS = ["phone", "email", "none"] as const;
  const SOURCES = ["macos", "import", "manual"] as const;

  app.get("/v1/contacts", (c) => {
    const db = getDatabase();
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20) || 20, 1), 100);
    const offset = Math.max(Math.floor(Number(c.req.query("offset") ?? 0) || 0), 0);
    const tagQ = (c.req.query("tag") ?? "").trim();
    const has = c.req.query("has");
    const source = c.req.query("source");
    if (has && !(HAS as readonly string[]).includes(has)) throw new ApiError(400, "validation_error", `has must be one of ${HAS.join(", ")}`);
    if (source && !(SOURCES as readonly string[]).includes(source)) throw new ApiError(400, "validation_error", `source must be one of ${SOURCES.join(", ")}`);
    const where: string[] = []; const args: (string | number)[] = [];
    for (const term of q.split(/\s+/).filter(Boolean)) {
      const t = likeEscape(term);
      const digits = term.replace(/\D/g, "");
      let clause = `(lower(c.display_name || ' ' || c.given_name || ' ' || c.family_name || ' ' || c.nickname || ' ' || c.org || ' ' || c.tags_json) LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM contact_handles h WHERE h.contact_id = c.id AND h.handle LIKE ? ESCAPE '\\')`;
      args.push(`%${t}%`, `%${t}%`);
      if (digits.length >= 3) {
        clause += ` OR EXISTS (SELECT 1 FROM contact_handles h WHERE h.contact_id = c.id AND h.handle LIKE ? ESCAPE '\\')`;
        args.push(`%${digits}%`);
      }
      where.push(clause + ")");
    }
    // tag= is an exact (case-insensitive) match on a tag, e.g. a Contacts group; several, comma-separated, mean "any of".
    const tags = tagQ.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (tags.length) {
      where.push(`EXISTS (SELECT 1 FROM json_each(c.tags_json) j WHERE lower(j.value) IN (${tags.map(() => "?").join(",")}))`);
      args.push(...tags);
    }
    if (has === "phone") where.push("json_array_length(c.phones_json) > 0");
    else if (has === "email") where.push("json_array_length(c.emails_json) > 0");
    else if (has === "none") where.push("json_array_length(c.phones_json) = 0 AND json_array_length(c.emails_json) = 0");
    if (source) { where.push("c.source = ?"); args.push(source); }
    const cond = where.length ? "WHERE " + where.join(" AND ") : "";
    const total = (db.query(`SELECT COUNT(*) AS n FROM contacts c ${cond}`).get(...args) as { n: number }).n;
    const rows = db.query(`SELECT c.* FROM contacts c ${cond} ORDER BY c.display_name COLLATE NOCASE, c.id LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const contacts = rows.map((r) => slimContact(db, rowToContact(r)));
    const facets = c.req.query("facets") === "tags"
      ? { tags: (db.query("SELECT lower(j.value) AS tag, COUNT(*) AS count FROM contacts c, json_each(c.tags_json) j WHERE lower(j.value) <> 'removed' GROUP BY lower(j.value) ORDER BY count DESC, tag LIMIT 200").all() as { tag: string; count: number }[]) }
      : {};
    return c.json({ contacts, total, offset, limit, has_more: offset + contacts.length < total, query: q, ...facets });
  });

  // Registered before /v1/contacts/:id only for readability; different methods, so no clash.
  app.post("/v1/contacts/sync", (c) => {
    const w = who(c);
    const db = getDatabase();
    const recent = db.query("SELECT id, created_at FROM exec_requests WHERE kind = 'contacts_export' AND done_at IS NULL ORDER BY created_at DESC LIMIT 1").get() as any;
    let id: string; let reused = false;
    if (recent && Date.now() - Date.parse(recent.created_at) < 30_000) { id = recent.id; reused = true; }
    else {
      id = newId();
      db.query("INSERT INTO exec_requests(id, kind, created_at) VALUES (?, 'contacts_export', ?)").run(id, nowIso());
      audit(db, w.actor, "contacts.sync_requested", id);
    }
    const hb = db.query("SELECT heartbeat_at FROM exec_status WHERE id = 1").get() as any;
    const alive = hb && Date.now() - Date.parse(hb.heartbeat_at) < 120_000;
    return c.json({
      request_id: id, status: "requested", reused,
      message: "The executor will export the address book; contacts update within about a minute.",
      ...(alive ? {} : { warning: "The executor (outbox-exec) has no recent heartbeat, so this may wait until it is running." }),
    }, 202);
  });

  app.get("/v1/contacts/:id", (c) => {
    const db = getDatabase();
    const contact = getContact(db, c.req.param("id"));
    if (!contact) throw new ApiError(404, "contact_not_found", `contact ${c.req.param("id")} not found`);
    return c.json({ contact: slimContact(db, contact) });
  });

  // Imports
  app.post("/v1/imports", async (c) => {
    const w = who(c);
    const input = await parseJson(c, importBodyS);
    const db = getDatabase(); const deps = await getDeps();
    let bytes: Uint8Array; let filename: string;
    if (input.path !== undefined) {
      // outboxd runs as the user and an agent may be sandboxed away from files it could otherwise not read: only
      // ordinary data files in the user's working folders are allowed (see checkImportPath).
      const wanted = expandHome(input.path);
      if (!isAbsolute(wanted)) throw new ApiError(400, "validation_error", "path must be absolute (or start with ~/)");
      let p: string;
      try { p = checkImportPath(wanted); }
      catch (e) {
        if (e instanceof PathRefusedError) throw new ApiError(403, "path_not_allowed", e.message);
        if (e instanceof FileProblemError) throw new ApiError(e.code === "file_not_found" ? 404 : e.code === "too_large" ? 413 : 400, e.code === "not_a_file" ? "validation_error" : e.code, e.message);
        throw e;
      }
      try { bytes = new Uint8Array(await Bun.file(p).arrayBuffer()); }
      catch (e) { throw new ApiError(400, "unreadable", `can't read ${p}: ${(e as Error).message}. Pass the contents as text or base64 instead.`); }
      filename = input.filename ?? basename(p);
    } else if (input.base64 !== undefined) {
      bytes = new Uint8Array(Buffer.from(input.base64, "base64"));
      if (bytes.length > MAX_UPLOAD_BYTES) throw new ApiError(413, "too_large", "file is over 25 MB");
      filename = input.filename!;
    } else {
      if (input.text!.trim() === "") throw new ApiError(400, "empty_file", "the pasted text is empty");
      bytes = new TextEncoder().encode(input.text!);
      const ext = input.kind && /^(csv|tsv|json|jsonl|vcf)$/.test(input.kind) ? input.kind : "txt";
      filename = input.filename ?? `pasted.${ext}`;
    }
    if (bytes.length === 0) throw new ApiError(400, "empty_file", "the file is empty");
    let summary: any;
    try {
      summary = deps.ingestFile(db, {
        bytes, filename, created_by: w.actor, ...(input.sheet ? { sheet: input.sheet } : {}), ...(input.kind ? { kind: input.kind } : {}),
        ...(input.region ? { region: input.region.toUpperCase() } : {}),
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "empty_file" || code === "no_rows") throw new ApiError(400, code, (e as Error).message);
      throw new ApiError(400, "ingest_failed", `couldn't read that file: ${(e as Error).message}`);
    }
    return c.json({ ...summary, dashboard_url: importUrl(summary.import_id) }, 201);
  });

  async function loadImport(db: Database, deps: BDeps, id: string): Promise<any> {
    let imp: any;
    try { imp = deps.getImport(db, id); }
    catch (e) { if (/not found/i.test((e as Error).message)) imp = null; else throw e; }
    if (!imp) throw new ApiError(404, "import_not_found", `import ${id} not found`);
    return imp;
  }

  // The import with a page of its rows. Each row carries `vars` (everything a template or a per-row body can use),
  // `issues`, `match` and the handle, so an agent can write a body for EVERY row, page by page.
  app.get("/v1/imports/:id", async (c) => {
    const db = getDatabase(); const deps = await getDeps();
    const id = c.req.param("id");
    const imp = await loadImport(db, deps, id);
    const rows: any[] | undefined = Array.isArray(imp.rows) ? imp.rows : undefined;
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 500);
    const offset = Math.max(Math.floor(Number(c.req.query("offset") ?? 0) || 0), 0);
    const full = c.req.query("fields") === "full";
    const { rows: _r, rows_total: _t, ...summary } = imp;
    const page = rows?.slice(offset, offset + limit).map((r) => {
      const { raw, normalized, ...rest } = r;
      const base = { ...rest, ...(normalized ? { name: normalized.display_name, handle: normalized.handle, tags: normalized.tags } : {}) };
      return full ? { ...base, raw, normalized } : base;
    });
    const columns: string[] | null = Array.isArray(imp.columns) ? imp.columns : null;
    return c.json({
      ...summary,
      ...(columns ? { template_vars: availableVars(columns, imp.mapping ?? { vars: {} }) } : {}),
      ...(page ? { rows: page, rows_total: rows!.length, offset, limit, has_more: offset + page.length < rows!.length } : {}),
      dashboard_url: importUrl(id),
    });
  });

  app.put("/v1/imports/:id/mapping", async (c) => {
    const id = c.req.param("id");
    const input = await parseJson(c, mappingBodyS);
    const db = getDatabase(); const deps = await getDeps();
    const imp = await loadImport(db, deps, id);
    const existing = imp.mapping ?? { fields: {}, vars: {} };
    const columns: string[] | null = Array.isArray(imp.columns) ? imp.columns : null;
    // Column names match case-insensitively; the exact header is what gets stored.
    const canon = (name: string): string => {
      if (!columns) return name;
      const hit = resolveColumn(name, columns);
      if (!hit) throw new ApiError(400, "unknown_column", `column "${name}" is not in this file. Columns: ${columns.join(", ")}`);
      return hit;
    };
    const fields: Record<string, { column: string; confidence: number; columns?: string[] }> = { ...(existing.fields ?? {}) };
    for (const [k, v] of Object.entries(input.fields)) {
      if (v === null || v === undefined) { delete fields[k]; continue; }
      const list = (v.columns ?? []).map(canon);
      const column = v.column !== undefined ? canon(v.column) : list[0]!;
      fields[k] = { column, confidence: v.confidence ?? 1, ...(list.length ? { columns: [column, ...list.filter((x) => x !== column)] } : {}) };
    }
    const vars: Record<string, string> = {};
    for (const [slugName, col] of Object.entries(input.vars ?? existing.vars ?? {})) vars[slugName] = canon(col as string);
    let summary: any;
    try {
      summary = deps.setMapping(db, id, { fields, vars, confirmed: input.confirmed ?? true, ...(input.region ? { region: input.region.toUpperCase() } : {}) }, input.region ? { region: input.region.toUpperCase() } : undefined);
    } catch (e) { throw new ApiError(400, "invalid_mapping", (e as Error).message); }
    return c.json({ ...summary, dashboard_url: importUrl(id) });
  });

  app.post("/v1/imports/:id/batch", async (c) => {
    const w = who(c);
    const id = c.req.param("id");
    const input = await parseJson(c, importBatchS);
    const db = getDatabase(); const deps = await getDeps();
    const imp = await loadImport(db, deps, id);
    let per_row_bodies: Record<number, string> | undefined;
    if (input.per_row_bodies) {
      per_row_bodies = {};
      for (const [k, v] of Object.entries(input.per_row_bodies)) {
        const n = Number(k);
        if (!Number.isInteger(n) || n < 0) throw new ApiError(400, "validation_error", `per_row_bodies key "${k}" is not a row index`);
        per_row_bodies[n] = v;
      }
    }
    // Unknown template fields are reported up front, with what IS available, instead of leaving "{{foo}}" in every draft.
    if (!input.allow_unknown_vars && Array.isArray(imp.columns)) {
      const available = availableVars(imp.columns, imp.mapping ?? { vars: {} });
      const have = new Set(available.map(varKey));
      const unknown = listVars(input.template).filter((v) => !have.has(v));
      const rows: any[] = Array.isArray(imp.rows) ? imp.rows : [];
      const target = rows.filter((r) => (!input.include || input.include.includes(r.row_index)) && r.match !== "invalid" && r.match !== "duplicate");
      const allOverridden = !!per_row_bodies && target.length > 0 && target.every((r) => per_row_bodies![r.row_index] !== undefined);
      if (unknown.length && !allOverridden) {
        throw new ApiError(400, "unknown_template_vars",
          `The template uses field(s) this import doesn't have: ${unknown.map((v) => `{{${v}}}`).join(", ")}. Available fields: ${available.join(", ")}. Fix the template (or the column mapping), or pass allow_unknown_vars=true to leave them as they are.`,
          { unknown, available });
      }
    }
    let r: ReturnType<BDeps["batchFromImport"]>;
    try {
      r = deps.batchFromImport(db, id, {
        title: input.title, template: input.template, created_by: w.actor, source: w.source,
        ...(per_row_bodies ? { per_row_bodies } : {}),
        ...(input.create_new_contacts !== undefined ? { create_new_contacts: input.create_new_contacts } : {}),
        ...(input.include ? { include: input.include } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      });
    } catch (e) {
      if ((e as { code?: string }).code === "no_drafts") throw new ApiError(400, "no_drafts", (e as Error).message, { skipped: (e as { skipped?: unknown }).skipped });
      throw e;
    }
    if (r.drafts === 0) {
      // A batch library that returns an empty batch instead of refusing: don't leave it behind.
      db.transaction(() => setBatchStatus(db, r.batch_id, "cancelled", w.actor)).immediate();
      throw new ApiError(400, "no_drafts", `No drafts would be created from this import (${r.skipped.length} row(s) skipped). Check the mapping and the include list.`, { skipped: r.skipped });
    }
    let lintError: string | undefined = r.lint_error ? `Lint failed (${r.lint_error}); warnings for this batch may be missing.` : undefined;
    const batch = getBatch(db, r.batch_id);
    if (input.submit && batch?.status === "drafting") {
      lintError = safeLint(deps, db, r.batch_id) ?? lintError;
      db.transaction(() => { if (getBatch(db, r.batch_id)?.status === "drafting") setBatchStatus(db, r.batch_id, "review", w.actor); }).immediate();
    }
    return c.json({ ...withLint(batchView(db, r.batch_id), lintError), skipped: r.skipped, drafts_created: r.drafts }, 201);
  });

  // ----- contact changes (v4) -----
  // Draft-only like everything here: creates are queued for the executor (after its live duplicate check), edits wait in
  // review for the user's Touch ID. No route here approves, applies or undoes anything.
  const contactSetUrl = (setId: string) => `${origin}/#/contacts/changes/${setId}`;
  const contactSource = (w: Who): ContactSetSource => (w.source === "cli" ? "cli" : "mcp");
  function proposeView(r: ProposeResult, extra: object = {}) {
    const lines = [
      r.counts.auto_queued ? `${r.counts.auto_queued} new contact(s) will be added automatically (after a live duplicate check)` : "",
      r.counts.review ? `${r.counts.review} change(s) wait for the user's Touch ID approval (edits, and new contacts with one name only, a look-alike name or an existing group; see each note)` : "",
      r.counts.rejected ? `${r.counts.rejected} change(s) need nothing and were not queued` : "",
    ].filter(Boolean);
    return { set_id: r.set_id, status: r.status, dashboard_url: contactSetUrl(r.set_id), counts: r.counts, changes: r.changes.map((c) => ({ id: c.id, kind: c.kind, status: c.status, note: c.note })), message: lines.join("; ") + ". The user can undo any change.", ...extra };
  }

  app.post("/v1/contact-changes", async (c) => {
    const w = who(c);
    const input = await parseJson(c, contactChangesS);
    const db = getDatabase();
    let r: ProposeResult;
    try {
      const v = validateProposal(db, input);
      r = proposeContactChanges(db, { title: input.title, created_by: w.actor, source: contactSource(w), creates: v.creates, updates: v.updates });
    } catch (e) {
      if (e instanceof ContactValidationError) throw new ApiError(400, "invalid_contact_changes", `nothing was created: ${e.message}`);
      throw e;
    }
    return c.json(proposeView(r), 201);
  });

  app.post("/v1/imports/:id/contact-changes", async (c) => {
    const w = who(c);
    const id = c.req.param("id");
    const input = await parseJson(c, importContactChangesS);
    const db = getDatabase(); const deps = await getDeps();
    const imp = await loadImport(db, deps, id);
    const rows: any[] = Array.isArray(imp.rows) ? imp.rows.filter((r: any) => r?.normalized && r.match) : [];
    let r: ProposeResult; let skipped: { row_index: number; reason: string }[];
    try {
      const plan = planFromImport(db, rows, { prefix: input.first_name_prefix, suffix: input.first_name_suffix, include: input.include, groups: input.groups });
      skipped = plan.skipped;
      const total = plan.creates.length + plan.updates.length;
      if (total === 0) throw new ApiError(400, "no_changes", `No contact changes would come out of this import (${skipped.length} row(s) skipped). Check the include list, the prefix/suffix and the mapping.`, { skipped });
      if (total > MAX_CHANGES) throw new ApiError(400, "too_many_changes", `This would make ${total} changes; at most ${MAX_CHANGES} per set. Pass "include" with a range of row indexes and call again.`);
      r = proposeContactChanges(db, {
        title: input.title ?? `Contacts from ${imp.filename ?? "import"}`, created_by: w.actor, source: "import",
        creates: plan.creates.map((x) => x.payload), updates: plan.updates.map(({ contact, payload }) => ({ contact, payload })),
      });
    } catch (e) {
      if (e instanceof ContactValidationError) throw new ApiError(400, "invalid_contact_changes", e.message);
      throw e;
    }
    db.transaction(() => audit(db, w.actor, "contact_changes.from_import", r.set_id, { import_id: id, skipped: skipped.length })).immediate();
    return c.json(proposeView(r, { skipped, import_id: id }), 201);
  });

  app.get("/v1/contact-changes", (c) => {
    const db = getDatabase();
    const status = c.req.query("status");
    if (status && !(CONTACT_SET_STATUSES as readonly string[]).includes(status)) throw new ApiError(400, "validation_error", `status must be one of ${CONTACT_SET_STATUSES.join(", ")}`);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const rows = db.query(`SELECT * FROM contact_change_sets ${status ? "WHERE status = ?" : ""} ORDER BY created_at DESC LIMIT ?`).all(...(status ? [status, limit] : [limit])) as any[];
    return c.json({ sets: rows.map((s) => ({ ...s, counts: contactSetCounts(db, s.id), dashboard_url: contactSetUrl(s.id) })) });
  });

  app.get("/v1/contact-changes/:id", (c) => {
    const db = getDatabase();
    const set = getContactSet(db, c.req.param("id"));
    if (!set) throw new ApiError(404, "contact_set_not_found", `contact change set ${c.req.param("id")} not found`);
    return c.json(contactSetView(db, set, { origin }));
  });

  // ----- saved groups (v5) -----
  // Draft-only like everything here. Agents may create groups, change them and address a batch to one; deleting a group is
  // the owner's (dashboard). A group only chooses recipients: the batch it makes is an ordinary one the user must approve.
  type GroupSummary = ReturnType<typeof groupSummary>;
  const groupUrl = (id: string) => `${origin}/#/contacts/groups/${id}`;
  const groupBody = (g: GroupSummary) => ({ ...g, dashboard_url: groupUrl(g.id) });
  const groupActor = (w: Who) => (w.source === "cli" ? "cli" : w.actor);
  const asApi = (e: unknown): never => {
    if (e instanceof GroupError) throw new ApiError(e.status, e.code, e.message, e.details);
    throw e;
  };

  interface MemberSources { members?: MemberInput[]; contact_ids?: string[]; from_import?: { import_id: string; rows?: number[] } }
  /** The member inputs from whichever of members / contact_ids / from_import was given (an import is read first, so a bad
   *  import id fails before anything is written). */
  async function gatherMembers(db: Database, deps: BDeps, input: MemberSources) {
    const inputs: MemberInput[] = [...(input.members ?? []), ...membersFromContactIds(input.contact_ids ?? [])];
    let skipped: ReturnType<typeof membersFromImport>["invalid"] = [];
    if (input.from_import) {
      const fi = membersFromImport(await loadImport(db, deps, input.from_import.import_id), input.from_import.rows);
      inputs.push(...fi.members); skipped = fi.invalid;
    }
    return { inputs, skipped };
  }
  function addGathered(db: Database, deps: BDeps, w: Who, ref: string, g: { inputs: MemberInput[]; skipped: AddResult["invalid"] }, importId?: string) {
    try {
      const r = addMembers(db, deps, ref, g.inputs, { actor: w.actor, addedBy: groupActor(w), lenient: !!importId, ...(importId ? { source: `import ${importId}` } : {}) });
      return { added: r.added, already: r.already, invalid: [...r.invalid, ...g.skipped], group: groupBody(r.group) };
    } catch (e) { return asApi(e); }
  }

  app.get("/v1/groups", (c) => c.json({
    groups: listGroups(getDatabase()).map((g) => ({ id: g.id, name: g.name, description: g.description, members: g.members, updated_at: g.updated_at })),
  }));

  app.post("/v1/groups", async (c) => {
    const w = who(c);
    const input = await parseJson(c, groupCreateS);
    const db = getDatabase(); const deps = await getDeps();
    const gathered = await gatherMembers(db, deps, input);
    let made: GroupSummary;
    try { made = createGroup(db, { name: input.name, description: input.description, actor: w.actor, createdBy: groupActor(w) }); } catch (e) { return asApi(e); }
    return c.json(addGathered(db, deps, w, made.id, gathered, input.from_import?.import_id), 201);
  });

  app.get("/v1/groups/:ref", (c) => {
    try {
      const r = getGroup(getDatabase(), c.req.param("ref"));
      return c.json({ group: groupBody(r.group), members: r.members });
    } catch (e) { return asApi(e); }
  });

  app.post("/v1/groups/:ref/members", async (c) => {
    const w = who(c);
    const input = await parseJson(c, groupMembersS);
    const db = getDatabase(); const deps = await getDeps();
    return c.json(addGathered(db, deps, w, c.req.param("ref"), await gatherMembers(db, deps, input), input.from_import?.import_id));
  });

  app.post("/v1/groups/:ref/remove", async (c) => {
    const w = who(c);
    const input = await parseJson(c, groupRemoveS);
    if (!input.handles?.length && !input.contact_ids?.length) throw new ApiError(400, "validation_error", "give handles and/or contact_ids to remove");
    const db = getDatabase(); const deps = await getDeps();
    try {
      const r = removeMembers(db, deps, c.req.param("ref"), { ...input, actor: w.actor });
      return c.json({ removed: r.removed, not_found: r.not_found, group: groupBody(r.group) });
    } catch (e) { return asApi(e); }
  });

  app.patch("/v1/groups/:ref", async (c) => {
    const w = who(c);
    const input = await parseJson(c, groupPatchS);
    if (input.name === undefined && input.description === undefined) throw new ApiError(400, "validation_error", "give name and/or description");
    try { return c.json({ group: groupBody(updateGroup(getDatabase(), c.req.param("ref"), { ...input, actor: w.actor })) }); } catch (e) { return asApi(e); }
  });

  // A batch addressed to the group's members, built by the same resolver as POST /v1/batches: `to`, `contact_id`, the name
  // and `vars` come from the member; `bodies` (keyed by handle) wins over the template. Personalised bodies are the better path.
  app.post("/v1/groups/:ref/batch", async (c) => {
    const w = who(c);
    const input = await parseJson(c, groupBatchS);
    const db = getDatabase(); const deps = await getDeps();
    let made: ReturnType<typeof itemsForBatch>;
    try { made = itemsForBatch(db, deps, c.req.param("ref"), { only: input.only }); } catch (e) { return asApi(e); }
    const name = made.group.name;
    if (!made.items.length) throw new ApiError(400, "empty_group", `group "${name}" has no people${input.only ? " in that selection" : ""}`);
    if (made.items.length > 500) throw new ApiError(400, "too_many_members", `${made.items.length} people is more than one batch holds (500). Pass "only" with up to 500 handles per call.`);
    const have = new Set(made.items.map((i) => i.to));
    const bodies = new Map<string, string>();
    for (const [raw, body] of Object.entries(input.bodies ?? {})) {
      const n = deps.normalizeHandle(raw);
      const h = n.valid && n.handle && have.has(n.handle) ? n.handle : have.has(raw.trim().toLowerCase()) ? raw.trim().toLowerCase() : null;
      if (!h) throw new ApiError(400, "not_in_group", `bodies has "${raw}", who is not in group "${name}"${input.only ? " (or not in only)" : ""}`);
      bodies.set(h, body);
    }
    if (!input.template && !made.items.every((i) => bodies.has(i.to))) {
      const missing = made.items.filter((i) => !bodies.has(i.to)).map((i) => i.recipient_name || i.to);
      throw new ApiError(400, "missing_body", `give a template, or a body for every person; missing: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}`);
    }
    const items: Item[] = made.items.map((i) => ({ ...i, ...(bodies.has(i.to) ? { body: bodies.get(i.to) } : {}) }));
    const r = await makeBatch(w, db, deps, { title: input.title, template: input.template, instructions: input.instructions, items, submit: input.submit ?? true });
    return c.json({ ...r, group: { id: made.group.id, name } }, 201);
  });

  // ----- errors -----
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }, err.status);
    console.error("[agent-api] unhandled", err);
    return c.json({ error: { code: "internal_error", message: (err as Error).message || "internal error" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: `no route ${c.req.method} ${new URL(c.req.url).pathname}. The agent API only drafts; it has no approve or send routes.` } }, 404));

  return app;
}
