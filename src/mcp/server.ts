// MCP tools for the outbox. Draft-only: there is no send, approve or schedule tool, and the agent API behind
// these tools has no such routes. Each tool is a thin call to the agent socket.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createAgentClient, OutboxApiError, OutboxDownError, qs, type AgentClient, type Json } from "../agent-api/client";
import { FileProblemError, PathRefusedError, readUpload } from "../core/upload";

export interface McpOptions {
  client?: AgentClient;
  socketPath?: string;
  label?: string;
  source?: "mcp" | "compose";
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

const GATE = "Drafts are only sent after the user approves them in the dashboard (signed with a passkey and Touch ID). You cannot send or approve anything, and there is no tool for it.";
const STYLE = "Write the way a person texts: short, natural, specific to the recipient. Personalise each message (a real detail, not just the name); don't paste one generic blast. No placeholders left in the text, no emojis unless the user uses them, no links in a first message to someone who hasn't heard from the user, and don't invent facts about the recipient.";
const TEMPLATES = "Template syntax: {{first_name}} inserts a field; {{first_name|there}} uses the text after | when the field is empty. Standard fields: first_name, last_name, full_name, name, org, tags, plus one field per spreadsheet column (lowercased, spaces and punctuation turned into underscores, e.g. column \"Pickup Date\" is {{pickup_date}}); contacts also bring city and birthday when known. A template that uses a field the import doesn't have is refused (with the list of available fields) unless allow_unknown_vars is set.";

const CONTACTS_GATE = "New contacts are added to the user's Contacts automatically, after a live duplicate check (a person who is already in Contacts becomes an edit instead), except that a new contact with only a first or only a last name, a new contact whose name looks like one already in Contacts (same name, ignoring emoji, accents and look-alike letters), and a new contact that joins a Contacts group that already exists (other than \"Outbox imports\") wait for the user's Touch ID approval instead. Edits to existing contacts (changing a name, adding a number, email or group) wait for the user's Touch ID approval in the dashboard. The user can undo any change. You cannot approve, apply or undo anything, and there is no tool for it. Removing a number, deleting a contact and merging contacts are not possible.";
const NAME_RULES = "Names and group names are at most 100 characters, with no control or invisible characters (emoji are fine); emails are at most 254 characters. Give a new contact BOTH a first and a last name where you can: with only one, it waits for the user's approval. A new contact needs a first or last name and at least one valid phone number (with country code, e.g. +14155550123) or email, at most 5 phones, 5 emails and 5 groups; it is also put in the group \"Outbox imports\".";

const itemShape = z.object({
  to: z.string().optional().describe("Phone number (any format; US assumed if no country code) or email. Use this OR contact_id."),
  contact_id: z.string().optional().describe("Id from outbox_search_contacts. The contact's first mobile number (else first phone, else first email) is used."),
  body: z.string().optional().describe("The finished message text for this person. Omit only if the batch has a template to render."),
  vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Extra template fields for this recipient, e.g. {\"city\":\"Boston\"}."),
  recipient_name: z.string().optional().describe("Display name when the recipient isn't a known contact."),
  proposed_contact: z.object({
    given_name: z.string().optional(), family_name: z.string().optional(), org: z.string().optional(),
    phones: z.array(z.string()).optional().describe("Phone numbers"), emails: z.array(z.string()).optional(),
    note: z.string().optional(), tags: z.array(z.string()).optional(),
  }).optional().describe("For someone who isn't in the address book: the user can choose to create this contact when approving. It is never created without approval. The contact is created with exactly the number or address the message goes to (\"to\"); any other numbers in here are dropped, and a \"to\" that isn't one of them is refused."),
  service: z.enum(["iMessage", "SMS", "auto"]).optional().describe("Default auto (iMessage, falling back to SMS)."),
  notes: z.string().optional().describe("A note to the user about this draft (why this message, what to double check). Not sent."),
});

type Out = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): Out => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

function headline(r: Json): string {
  if (r.set_id && r.counts && r.dashboard_url) {
    return `Contact change set ${r.set_id}: ${r.counts.auto_queued ?? 0} automatic, ${r.counts.review ?? 0} waiting for the user's approval, ${r.counts.rejected ?? 0} not needed. Review link: ${r.dashboard_url}`;
  }
  if (r.batch && r.drafts) {
    const b = r.batch; const n = r.drafts.length; const w = (r.warnings ?? []).length;
    const state = b.status === "review" ? "waiting for the user to review and approve it" : `status ${b.status}`;
    return `Batch "${b.title}" (${b.id}): ${n} draft${n === 1 ? "" : "s"}, ${w} warning${w === 1 ? "" : "s"}, ${state}. Review link: ${r.dashboard_url}${r.lint_error ? `\nNOTE: ${r.lint_error}` : ""}`;
  }
  return "";
}

export function createOutboxMcpServer(o: McpOptions = {}): McpServer {
  const api = o.client ?? createAgentClient({
    client: o.label ?? process.env.OUTBOX_CLIENT ?? "claude",
    source: o.source ?? (process.env.OUTBOX_SOURCE === "compose" ? "compose" : "mcp"),
    ...(o.socketPath ? { socketPath: o.socketPath } : {}),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
  });
  const server = new McpServer({ name: "outbox", version: "0.1.0" }, {
    instructions: `iMessage outbox. ${GATE} Use these tools to prepare messages for the user to approve. ${STYLE}`,
  });

  const run = (fn: () => Promise<Json>) => async (): Promise<Out> => {
    try {
      const r = await fn();
      const h = headline(r);
      return text((h ? h + "\n\n" : "") + JSON.stringify(r, null, 2));
    } catch (e) {
      if (e instanceof OutboxDownError) return text(e.message, true);
      if (e instanceof OutboxApiError) return text(`${e.code}: ${e.message}${e.details ? "\n" + JSON.stringify(e.details) : ""}`, true);
      if (e instanceof PathRefusedError || e instanceof FileProblemError) return text(`${e.code}: ${e.message}`, true);
      return text(`unexpected error: ${(e as Error).message}`, true);
    }
  };
  const ro = { readOnlyHint: true, openWorldHint: false };
  const wr = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  server.registerTool("outbox_search_contacts", {
    description: `Search the user's contacts (copied from the Mac address book). "query" is plain text matched as a substring against name, nickname, organisation, tags (the user's Contacts GROUPS are tags, e.g. "College friends") and phone or email fragments; several words are ANDed ("sam lee" narrows). It cannot understand relationships or meaning: "friends" finds nobody unless a name, org or tag contains it. To message a group of people, use the exact group as "tag" (case-insensitive; comma-separated = any of) and set include_tags=true once to list every tag with its size. Other filters: has=phone|email|none (has a number, an address, or neither), source=macos|import|manual. Results are alphabetical, paged with limit (max 100) and offset; "total" is the full match count, so page until offset+limit reaches it before writing to "all" of a group. Each contact has an id, phones, emails, tags, preferred_handle (the number a message would go to), and city or birthday when the Contacts app has them (as vars). Use this to find recipients before drafting; don't guess phone numbers. Read-only.`,
    inputSchema: {
      query: z.string().optional().describe("Name, org, tag, phone digits or email fragment. Empty lists contacts alphabetically."),
      tag: z.string().optional().describe("Exact tag / Contacts group, e.g. \"College friends\". Comma-separated for any of several."),
      has: z.enum(["phone", "email", "none"]).optional().describe("Only contacts that have a phone number / an email / neither."),
      source: z.enum(["macos", "import", "manual"]).optional(),
      limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional(),
      include_tags: z.boolean().optional().describe("Also return every tag with its contact count."),
    },
    annotations: ro,
  }, async ({ query, tag, has, source, limit, offset, include_tags }) => run(() => api.get(`/v1/contacts${qs({ q: query, tag, has, source, limit, offset, facets: include_tags ? "tags" : undefined })}`))());

  server.registerTool("outbox_get_contact", {
    description: "Get one contact by id (from outbox_search_contacts): all phones, emails, tags and the preferred handle. Read-only.",
    inputSchema: { id: z.string() }, annotations: ro,
  }, async ({ id }) => run(() => api.get(`/v1/contacts/${encodeURIComponent(id)}`))());

  server.registerTool("outbox_create_draft", {
    description: `Draft ONE iMessage/SMS for the user to review. Give the recipient as "to" (phone or email) or "contact_id", and the finished message text in "body". It becomes a one-message batch in review. ${GATE} ${STYLE} Phone numbers are normalised and invalid ones are rejected. For several people use outbox_create_batch instead.`,
    inputSchema: {
      to: z.string().optional().describe("Phone number or email. Use this OR contact_id."),
      contact_id: z.string().optional().describe("Contact id from outbox_search_contacts."),
      body: z.string().describe("The exact message text."),
      service: z.enum(["iMessage", "SMS", "auto"]).optional(),
      notes: z.string().optional().describe("Private note for the user, not sent."),
      title: z.string().optional().describe("Batch title shown in the dashboard."),
    }, annotations: wr,
  }, async (a) => run(() => api.post("/v1/drafts", a))());

  server.registerTool("outbox_create_batch", {
    description: `Create a batch of drafts for several recipients, each with its own message. Prefer writing a personalised "body" for every item; or set a "template" and omit "body" on items to have it merged from each recipient's fields. ${TEMPLATES} ${STYLE} Items are validated all-or-nothing: if any recipient is invalid nothing is created and the error says which item. The batch starts as "drafting"; set submit=true (or call outbox_submit_batch) to put it in front of the user. ${GATE} For spreadsheets use outbox_ingest_file then outbox_batch_from_import instead.`,
    inputSchema: {
      title: z.string().describe("Short title, e.g. \"Dinner invites Nov 20\"."),
      template: z.string().optional().describe("Optional merge template, e.g. \"Hi {{first_name|there}}, ...\"."),
      instructions: z.string().optional().describe("What the user asked for, kept for context."),
      items: z.array(itemShape).max(500).optional(),
      submit: z.boolean().optional().describe("true = send to the user for review now."),
    }, annotations: wr,
  }, async (a) => run(() => api.post("/v1/batches", a))());

  server.registerTool("outbox_ingest_file", {
    description: `Step 1 of the spreadsheet workflow (ingest, then mapping, then batch). Reads a CSV, TSV, XLSX/XLS/ODS/Numbers sheet, vCard, JSON/JSONL file, or pasted table. Give "path" (absolute or ~/..., and only an ordinary data file under ~/code, ~/workspaces, ~/Downloads, ~/Desktop, ~/Documents or a temp folder: hidden folders, key and .env files are refused, so copy the file there or paste it), or "text" for pasted content, or "base64" plus "filename". The result has the import_id, the detected column mapping with confidence, needs_confirmation, counts of matched (already a contact) / new / ambiguous (same name, different number) / invalid / duplicate rows, and a preview. If needs_confirmation is true or a mapping looks wrong, fix it with outbox_set_mapping; then call outbox_batch_from_import. Rows with a phone with no country code that fail to parse are retried as international when they have 11+ digits and flagged; set "region" for non-US lists. Empty or row-less files are refused. Nothing is drafted or sent by ingesting.`,
    inputSchema: {
      path: z.string().optional().describe("Path to the file on this Mac. Only ordinary data files (csv, tsv, txt, xlsx, xls, ods, numbers, vcf, json, jsonl, md, up to 25 MB) under ~/code, ~/workspaces, ~/Downloads, ~/Desktop, ~/Documents or a temp folder; hidden folders, key and .env files are refused. Otherwise pass the contents as text."),
      text: z.string().optional().describe("Pasted CSV/TSV/markdown table/vCard/JSON content."),
      base64: z.string().optional(), filename: z.string().optional().describe("Required with base64; optional otherwise."),
      kind: z.string().optional().describe("Force a format: csv, tsv, xlsx, vcf, json, ..."),
      sheet: z.string().optional().describe("Sheet name for workbooks; default is the first sheet."),
      region: z.string().optional().describe("Default country for phone numbers without a country code, e.g. \"GB\". Default US."),
    }, annotations: wr,
  }, async (a) => run(async () => {
    const given = [a.path, a.text, a.base64].filter((x) => x !== undefined).length;
    if (given !== 1) throw new OutboxApiError(400, "validation_error", "give exactly one of path, text or base64");
    const body: Json = { ...(a.kind ? { kind: a.kind } : {}), ...(a.sheet ? { sheet: a.sheet } : {}), ...(a.region ? { region: a.region } : {}) };
    if (a.path !== undefined) { const u = readUpload(a.path); Object.assign(body, { base64: u.base64, filename: a.filename ?? u.filename }); }
    else if (a.text !== undefined) Object.assign(body, { text: a.text, ...(a.filename ? { filename: a.filename } : {}) });
    else Object.assign(body, { base64: a.base64, filename: a.filename ?? "upload.bin" });
    return api.post("/v1/imports", body);
  })());

  server.registerTool("outbox_set_mapping", {
    description: `Step 2 (when needed): tell the outbox which spreadsheet column is which. "fields" maps targets (display_name, given_name, family_name, phone, email, org, notes, tags) to column names exactly as listed in the ingest result's columns, e.g. {"phone":{"column":"Mobile"},"given_name":{"column":"First"}} (column names match case-insensitively). phone, email and tags can take an ordered "columns" list, e.g. {"phone":{"columns":["Mobile","Home Phone"]}}; each row then uses its best number (a mobile-labelled one first). Fields you don't mention keep their current mapping; set one to null to unmap it. "vars" exposes other columns as template fields: {"city":"City"} makes {{city}} available. Rows are re-normalised and re-matched, and the new counts come back. ${TEMPLATES}`,
    inputSchema: {
      import_id: z.string(),
      fields: z.record(z.string(), z.object({ column: z.string().optional(), columns: z.array(z.string()).optional() }).nullable()),
      vars: z.record(z.string(), z.string()).optional().describe("template field name -> column name (extra aliases for columns)"),
      confirmed: z.boolean().optional().describe("Default true."),
      region: z.string().optional().describe("Default country for phone numbers without a country code, e.g. \"GB\"."),
    }, annotations: wr,
  }, async ({ import_id, ...rest }) => run(() => api.put(`/v1/imports/${encodeURIComponent(import_id)}/mapping`, rest))());

  server.registerTool("outbox_get_import", {
    description: `Read an ingested import (from outbox_ingest_file): the summary (columns, mapping, counts, template_vars) plus its ROWS, paged. Each row has row_index, match (matched / new / ambiguous / invalid / duplicate), name, handle (where the message would go), tags, vars (every field a template or message can use for that person: first_name, columns like city, tags...), contact_id and issues (invalid number, no handle, duplicate person, which number was used...). Use it to write a message for EVERY row, not just the 10-row preview: page with limit (max 500) and offset until has_more is false, then pass the texts as per_row_bodies ({"<row_index>": "text"}) to outbox_batch_from_import. Skip rows whose match is invalid or duplicate (they get no draft). fields="full" adds each row's raw cells. Read-only.`,
    inputSchema: {
      import_id: z.string(),
      offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional().describe("Rows per page, default 50."),
      fields: z.enum(["slim", "full"]).optional().describe("slim (default) or full (adds raw and normalized row data)."),
    }, annotations: ro,
  }, async ({ import_id, offset, limit, fields }) => run(() => api.get(`/v1/imports/${encodeURIComponent(import_id)}${qs({ offset, limit, fields: fields === "full" ? "full" : undefined })}`))());

  server.registerTool("outbox_batch_from_import", {
    description: `Step 3: turn an import into a batch of drafts by merging "template" into every usable row (invalid and duplicate rows are skipped and reported; rows for unknown people carry a proposed new contact the user can approve; ambiguous rows are flagged and have no contact). ${TEMPLATES} ${STYLE} Refused (nothing created) when no draft would result, or when the template uses a field the import doesn't have. To write a different message for every row, first read all rows with outbox_get_import (paged; each row has its vars and issues), then pass "per_row_bodies" ({"<row_index>": "full text"}) here, or edit drafts afterwards with outbox_update_draft / outbox_update_drafts. Then call outbox_submit_batch (or pass submit=true) so the user can review. ${GATE}`,
    inputSchema: {
      import_id: z.string(), title: z.string(),
      template: z.string().describe("Merge template, e.g. \"Hey {{first_name|there}}, ...\"."),
      per_row_bodies: z.record(z.string(), z.string()).optional().describe("Row index (as in the import preview) -> finished text for that row."),
      include: z.array(z.number().int()).optional().describe("Only these row indexes."),
      create_new_contacts: z.boolean().optional().describe("Whether proposed new contacts are offered for creation (default true)."),
      submit: z.boolean().optional().describe("true = move straight to the user for review."),
      instructions: z.string().optional().describe("What the user asked for, kept on the batch for context (and used to flag a message that is just the template when personalisation was asked for)."),
      allow_unknown_vars: z.boolean().optional().describe("Create the batch even if the template uses fields the import doesn't have (they stay as {{field}} in the text, with a warning). Default false."),
    }, annotations: wr,
  }, async ({ import_id, ...rest }) => run(() => api.post(`/v1/imports/${encodeURIComponent(import_id)}/batch`, rest))());

  server.registerTool("outbox_update_draft", {
    description: `Change the text of one draft by id. Only works while the draft is not yet approved; a revision is kept and the lint warnings are recomputed. If the user already approved or the message is sending or sent, this is refused (ask the user to change it in the dashboard). ${STYLE}`,
    inputSchema: { draft_id: z.string(), body: z.string().describe("The new full message text.") }, annotations: wr,
  }, async ({ draft_id, body }) => run(() => api.patch(`/v1/drafts/${encodeURIComponent(draft_id)}`, { body }))());

  server.registerTool("outbox_update_drafts", {
    description: `Change the text of MANY drafts in one call: updates = [{draft_id, body}, ...] (up to 500). All or nothing: if any draft is approved, sent, cancelled or unknown, or any body is empty, nothing is changed and the error lists each problem. Lint warnings are recomputed once per batch. Use it to personalise a batch after outbox_get_batch. Drafts the user has already approved can't be edited by you. ${STYLE}`,
    inputSchema: { updates: z.array(z.object({ draft_id: z.string(), body: z.string().describe("The new full message text.") })).min(1).max(500) }, annotations: wr,
  }, async ({ updates }) => run(() => api.patch("/v1/drafts", { updates }))());

  server.registerTool("outbox_add_items", {
    description: `Add recipients to a batch that is still "drafting" (created with outbox_create_batch without submit). Same item format as outbox_create_batch, all-or-nothing: if any item is invalid none are added. Then call outbox_submit_batch. ${TEMPLATES} ${GATE}`,
    inputSchema: { id: z.string().describe("Batch id."), items: z.array(itemShape).min(1).max(500) }, annotations: wr,
  }, async ({ id, items }) => run(() => api.post(`/v1/batches/${encodeURIComponent(id)}/items`, { items }))());

  server.registerTool("outbox_cancel_batch", {
    description: `Cancel a batch YOU created, while it is still drafting or waiting for review: the batch becomes cancelled and its drafts rejected, so none can be sent. Use it to retract a mistake or a superseded batch. Refused if the batch is someone else's, or already approved or sent (then ask the user to stop it in the dashboard). This can only stop messages, never send them.`,
    inputSchema: { id: z.string().describe("Batch id.") }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ id }) => run(() => api.post(`/v1/batches/${encodeURIComponent(id)}/cancel`))());

  server.registerTool("outbox_list_batches", {
    description: "List recent batches (newest first) with status and draft counts. Statuses: drafting (yours to finish), review (waiting for the user), approved, sending, done, cancelled. Use it to check what is pending or to find a batch id. Read-only.",
    inputSchema: { status: z.enum(["drafting", "review", "approved", "sending", "done", "cancelled"]).optional(), limit: z.number().int().min(1).max(200).optional() },
    annotations: ro,
  }, async ({ status, limit }) => run(() => api.get(`/v1/batches${qs({ status, limit })}`))());

  server.registerTool("outbox_get_batch", {
    description: "Get a batch with all its drafts (recipient, handle, body, status, warnings) and, for each draft, its send results (sent, failed or unknown, with errors). Use this to review what you drafted, see lint warnings to fix, or report back on delivery. Read-only.",
    inputSchema: { id: z.string() }, annotations: ro,
  }, async ({ id }) => run(() => api.get(`/v1/batches/${encodeURIComponent(id)}`))());

  server.registerTool("outbox_submit_batch", {
    description: `Hand a drafting batch to the user: moves it from drafting to review so it appears in their dashboard inbox. Do this once the drafts are final and warnings are dealt with. This does NOT send anything. ${GATE} Tell the user the dashboard link from the result.`,
    inputSchema: { id: z.string() }, annotations: wr,
  }, async ({ id }) => run(() => api.post(`/v1/batches/${encodeURIComponent(id)}/submit`))());

  const phoneArg = z.union([z.string(), z.object({ e164: z.string(), label: z.string().optional() })]);
  const emailArg = z.union([z.string(), z.object({ email: z.string(), label: z.string().optional() })]);
  server.registerTool("outbox_propose_contacts", {
    description: `Add new contacts to the user's address book and/or propose edits to existing ones, in one change set. ${CONTACTS_GATE} ${NAME_RULES} "creates" are new people (given_name, family_name, optional nickname, org, groups, and phones/emails); "updates" edit an existing contact by contact_id (from outbox_search_contacts; it must be a contact from the Mac's Contacts): "set" replaces given_name, family_name, nickname or org ("" clears one), and add_phones, add_emails and add_groups add to the card. All or nothing: if any item is invalid, nothing is created and the error lists each problem. Max 500 changes. Returns the set id, per-change status and a review link; tell the user the link when edits are waiting.`,
    inputSchema: {
      title: z.string().describe("Short title for the user, e.g. \"Book club members\"."),
      creates: z.array(z.object({
        given_name: z.string().optional(), family_name: z.string().optional(), nickname: z.string().optional(), org: z.string().optional(),
        phones: z.array(phoneArg).optional().describe("Phone numbers; any format, US assumed without a country code."), emails: z.array(emailArg).optional(),
        groups: z.array(z.string()).optional().describe("Extra Contacts groups to put the person in."),
      })).optional(),
      updates: z.array(z.object({
        contact_id: z.string(),
        set: z.object({ given_name: z.string().optional(), family_name: z.string().optional(), nickname: z.string().optional(), org: z.string().optional() }).optional(),
        add_phones: z.array(phoneArg).optional(), add_emails: z.array(emailArg).optional(), add_groups: z.array(z.string()).optional(),
      })).optional(),
      region: z.string().optional().describe("Default country for phone numbers without a country code, e.g. \"GB\". Default US."),
    }, annotations: wr,
  }, async (a) => run(() => api.post("/v1/contact-changes", a))());

  server.registerTool("outbox_contacts_from_import", {
    description: `Turn an ingested import (outbox_ingest_file) into a contact change set. Rows for people already in Contacts become edits (waiting for the user's Touch ID approval); rows for new people become new contacts (added automatically after a live duplicate check, except a row with only one name, a look-alike of an existing name, or one joining an existing group, which waits for the user's approval). first_name_prefix / first_name_suffix are put around every first name (e.g. first_name_suffix "📚"); an existing contact whose first name already has them is skipped as already done. Ambiguous, invalid and duplicate rows are skipped and reported. "groups" adds everyone to those Contacts groups. ${CONTACTS_GATE} ${NAME_RULES}`,
    inputSchema: {
      import_id: z.string(), title: z.string().optional(),
      first_name_prefix: z.string().optional(), first_name_suffix: z.string().optional(),
      include: z.array(z.number().int()).optional().describe("Only these row indexes."),
      groups: z.array(z.string()).optional(),
    }, annotations: wr,
  }, async ({ import_id, ...rest }) => run(() => api.post(`/v1/imports/${encodeURIComponent(import_id)}/contact-changes`, rest))());

  server.registerTool("outbox_get_contact_changes", {
    description: "Check a contact change set: each change's status (auto_queued = waiting for the Mac to add it, review = waiting for the user's Touch ID: edits, single-name new contacts, look-alike names and joins of existing groups, with the reason in its note, approved, applied, failed, rejected, undone), its note (for example \"already in Contacts\"), the proposed payload and, for edits, the contact's current values. Give set_id for one set, or leave it out to list recent sets (optionally by status). Read-only.",
    inputSchema: { set_id: z.string().optional(), status: z.enum(["drafting", "review", "approved", "applying", "done", "cancelled"]).optional(), limit: z.number().int().min(1).max(200).optional() }, annotations: ro,
  }, async ({ set_id, status, limit }) => run(() => set_id ? api.get(`/v1/contact-changes/${encodeURIComponent(set_id)}`) : api.get(`/v1/contact-changes${qs({ status, limit })}`))());

  // ----- saved groups -----
  const GROUPS = "A group is a saved list of people kept by the outbox itself (not a Contacts-app group). A group argument is its id or its exact name, any capitalisation.";
  const memberArg = z.object({
    to: z.string().optional().describe("Phone or email. Use this and/or contact_id."),
    contact_id: z.string().optional().describe("Id from outbox_search_contacts."),
    name: z.string().optional().describe("Display name for someone who isn't a contact."),
    vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Template fields for this person, e.g. {\"city\":\"Boston\"}."),
  });
  const peopleShape = {
    members: z.array(memberArg).max(1000).optional().describe("People by phone/email and/or contact_id."),
    contact_ids: z.array(z.string()).max(1000).optional().describe("Contact ids from outbox_search_contacts."),
    from_import: z.object({ import_id: z.string(), rows: z.array(z.number().int()).optional().describe("Only these row indexes.") }).optional()
      .describe("Everyone in an ingested import (invalid and duplicate rows are skipped and reported)."),
  };

  server.registerTool("outbox_list_groups", {
    description: `List the user's saved groups (name, description, member count). Check here before creating one: "my book club" is probably a group already. ${GROUPS} Read-only.`,
    inputSchema: {}, annotations: ro,
  }, async () => run(() => api.get("/v1/groups"))());

  server.registerTool("outbox_get_group", {
    description: `Get a group and its members (handle, name, per-person fields, and the contact if there is one). ${GROUPS} Read-only.`,
    inputSchema: { group: z.string().describe("Group id or name.") }, annotations: ro,
  }, async ({ group }) => run(() => api.get(`/v1/groups/${encodeURIComponent(group)}`))());

  server.registerTool("outbox_create_group", {
    description: `Save people as a new named group so later sessions can use them. Add people with members, contact_ids and/or from_import (a spreadsheet you ingested). Refused with group_exists if the name is taken: use outbox_add_to_group then. People are deduped by number or address; bad entries are reported and the rest are added. ${GROUPS} It only saves a list: nothing is drafted or sent.`,
    inputSchema: { name: z.string().describe("Group name, at most 80 characters, e.g. \"Book club\"."), description: z.string().optional(), ...peopleShape }, annotations: wr,
  }, async (a) => run(() => api.post("/v1/groups", a))());

  server.registerTool("outbox_add_to_group", {
    description: `Add people to an existing group (same people options as outbox_create_group). People already in it are reported as "already" and left alone. ${GROUPS}`,
    inputSchema: { group: z.string().describe("Group id or name."), ...peopleShape }, annotations: wr,
  }, async ({ group, ...rest }) => run(() => api.post(`/v1/groups/${encodeURIComponent(group)}/members`, rest))());

  server.registerTool("outbox_update_group", {
    description: `Rename a group, change its description and/or remove people from it (by phone/email in remove_members, or remove_contact_ids). Everything you give is applied; a rename onto another group's name is refused. You cannot delete a group: the user does that in the dashboard. ${GROUPS}`,
    inputSchema: {
      group: z.string().describe("Group id or name."), name: z.string().optional().describe("New name."), description: z.string().optional(),
      remove_members: z.array(z.string()).optional().describe("Phones or emails to remove."), remove_contact_ids: z.array(z.string()).optional(),
    }, annotations: wr,
  }, async ({ group, name, description, remove_members, remove_contact_ids }) => run(async () => {
    const removing = !!(remove_members?.length || remove_contact_ids?.length);
    if (!removing && name === undefined && description === undefined) throw new OutboxApiError(400, "validation_error", "give name, description, remove_members and/or remove_contact_ids");
    let ref = encodeURIComponent(group);
    let out: Json = {};
    // Rename first: if that is refused (name taken) nothing has been removed yet. After it, the id is the stable reference.
    if (name !== undefined || description !== undefined) {
      out = await api.patch(`/v1/groups/${ref}`, { name, description });
      ref = encodeURIComponent(out.group.id);
    }
    if (removing) out = { ...out, ...(await api.post(`/v1/groups/${ref}/remove`, { handles: remove_members, contact_ids: remove_contact_ids })) };
    return out;
  })());

  server.registerTool("outbox_batch_from_group", {
    description: `Draft a message to everyone in a group (or only some, with "only"). Best: write a personalised text for each person and pass "bodies" ({"<phone or email>": "text"}, keys as in outbox_get_group); or give a "template" merged from each person's fields. ${TEMPLATES} ${STYLE} Up to 500 people per call. All or nothing: if anyone can't be drafted, nothing is created and the error says who. Submitted for the user's review by default (submit=false keeps it as a drafting batch). ${GATE}`,
    inputSchema: {
      group: z.string().describe("Group id or name."), title: z.string().describe("Short title, e.g. \"Book club, Nov 20\"."),
      bodies: z.record(z.string(), z.string()).optional().describe("Phone or email -> the finished message for that person. Wins over the template."),
      template: z.string().optional().describe("Merge template for people without a body."),
      only: z.array(z.string()).optional().describe("Only these members (phones or emails)."),
      instructions: z.string().optional().describe("What the user asked for, kept for context."),
      submit: z.boolean().optional().describe("Default true: move straight to the user for review."),
    }, annotations: wr,
  }, async ({ group, ...rest }) => run(() => api.post(`/v1/groups/${encodeURIComponent(group)}/batch`, rest))());

  server.registerTool("outbox_sync_contacts", {
    description: "Ask the outbox executor to re-export the Mac address book so new or changed contacts become searchable (takes up to about a minute). Use when a contact you expect isn't found. Read-only for the user's data.",
    inputSchema: {}, annotations: wr,
  }, async () => run(() => api.post("/v1/contacts/sync"))());

  return server;
}
