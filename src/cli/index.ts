#!/usr/bin/env bun
// `outbox`: the command-line client of the agent API. Draft-only, like the MCP server: no send, approve or schedule verbs.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createAgentClient, OutboxApiError, OutboxDownError, qs, type AgentClient, type Json } from "../agent-api/client";
import { FileProblemError, PathRefusedError, readUpload } from "../core/upload";

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
  readStdin: () => Promise<string>;
  client?: AgentClient;
}

const HELP = `outbox: draft iMessages for the user to approve. Nothing here sends; the user approves in the dashboard.

  outbox draft (--to <phone|email> | --contact <id>) (--body <text> | --body-file <file|->) [--service iMessage|SMS|auto] [--notes <text>] [--title <text>]
  outbox batch create --title <t> [--template <t>] [--instructions <t>] [--items <file|->] [--submit]
  outbox batch add <batch_id> --items <file|->
  outbox batch show <batch_id>
  outbox batch list [--status drafting|review|approved|sending|done|cancelled]
  outbox batch submit <batch_id>
  outbox batch cancel <batch_id>        (only your own drafting/review batches; its drafts become rejected)
  outbox edit <draft_id> (--body <text> | --body-file <file|->)
  outbox edit-many --file <updates.json|->   (JSON array of {draft_id, body}; all or nothing)
  outbox import <file|-> [--sheet <name>] [--kind <csv|tsv|xlsx|vcf|json>] [--filename <name>] [--region GB]   ("-" reads pasted text from stdin;
        files only from ~/code, ~/workspaces, ~/Downloads, ~/Desktop, ~/Documents or a temp folder)
  outbox import show <import_id> [--offset <n>] [--limit <n>] [--full]   (rows with their vars and issues, paged)
  outbox import batch <import_id> --template <t> --title <t> [--instructions <t>] [--bodies <json file>] [--include 0,1,2] [--no-new-contacts] [--allow-unknown-vars] [--submit]
  outbox mapping <import_id> [--set field=Column[,Column2...]]... [--var name=Column]... [--unset field]... [--region GB] [--file mapping.json]
  outbox contacts search [<query>] [--tag <group>] [--has phone|email|none] [--source macos|import|manual] [--limit <n>] [--offset <n>] [--tags]
  outbox contacts show <contact_id>
  outbox contacts propose --file <json|->     (new contacts are added automatically after a live duplicate check, unless they have one name only, look like an existing contact or join an existing group; those and all edits wait for the user's Touch ID; the user can undo any change)
  outbox contacts from-import <import_id> [--suffix <text>] [--prefix <text>] [--title <t>] [--include 0,1,2] [--group <name>]...
  outbox contacts changes [<set_id>] [--status drafting|review|approved|applying|done|cancelled]
  outbox sync-contacts
  outbox status

A contacts propose file is JSON: {"title": "...", "creates": [{"given_name","family_name","phones":[...],"emails":[...],"org"?,"nickname"?,"groups"?}], "updates": [{"contact_id","set"?:{"given_name"...},"add_phones"?,"add_emails"?,"add_groups"?}]}.

Add --json to any command for machine-readable output. Items files are a JSON array of {to|contact_id, body?, vars?, recipient_name?, proposed_contact?, service?}.
Merge templates: {{first_name}}, or {{first_name|there}} for a fallback.`;

class UsageError extends Error {}

const common = { json: { type: "boolean" as const }, socket: { type: "string" as const }, help: { type: "boolean" as const, short: "h" as const } };

function opts(argv: string[], extra: Record<string, { type: "boolean" | "string"; multiple?: boolean; short?: string }>): { values: Record<string, any>; positionals: string[] } {
  try {
    const r = parseArgs({ args: argv, options: { ...common, ...extra }, allowPositionals: true, strict: true });
    return { values: r.values as Record<string, any>, positionals: r.positionals };
  } catch (e) { throw new UsageError((e as Error).message); }
}

async function textArg(io: CliIo, inline: string | undefined, file: string | undefined, what: string): Promise<string> {
  if (inline !== undefined) return inline;
  if (file === undefined) throw new UsageError(`${what} is required`);
  return file === "-" ? await io.readStdin() : readFileSync(file, "utf8");
}

async function itemsArg(io: CliIo, file: string): Promise<any[]> {
  const raw = file === "-" ? await io.readStdin() : readFileSync(file, "utf8");
  let j: any;
  try { j = JSON.parse(raw); } catch (e) { throw new UsageError(`items file isn't valid JSON: ${(e as Error).message}`); }
  const items = Array.isArray(j) ? j : j?.items;
  if (!Array.isArray(items)) throw new UsageError("items must be a JSON array (or an object with an items array)");
  return items;
}

// ---------- human output ----------
function fmtBatch(r: Json): string {
  const b = r.batch; const lines: string[] = [];
  lines.push(`${b.title}  [${b.status}]  ${b.id}`);
  lines.push(`  by ${b.created_by}, ${r.drafts.length} draft(s)${r.drafts.length ? ": " + Object.entries(r.counts ?? {}).map(([k, v]) => `${v} ${k}`).join(", ") : ""}`);
  for (const d of r.drafts) {
    const w = (d.warnings ?? []).map((x: any) => x.code).join(",");
    const sends = (d.sends ?? []).map((s: any) => s.result ?? "pending").join(",");
    lines.push(`  - ${d.id}  ${d.recipient_name || "(no name)"} <${d.handle}>  [${d.status}]${w ? "  warnings: " + w : ""}${sends ? "  sends: " + sends : ""}`);
    lines.push(`      ${String(d.body).replace(/\n/g, "\n      ")}`);
  }
  lines.push(`  dashboard: ${r.dashboard_url}`);
  if (r.lint_error) lines.push(`  NOTE: ${r.lint_error}`);
  if (r.next_step) lines.push(`  next: ${r.next_step}`);
  if (r.message) lines.push(`  ${r.message}`);
  if (r.skipped?.length) lines.push(`  skipped ${r.skipped.length} row(s): ${r.skipped.slice(0, 5).map((s: any) => `#${s.row_index} ${s.reason}`).join("; ")}`);
  return lines.join("\n");
}
function fmtImport(r: Json): string {
  const c = r.counts ?? {};
  const lines = [`import ${r.import_id}: ${r.filename} (${r.kind}${r.sheet ? ", sheet " + r.sheet : ""})`];
  lines.push(`  rows: ${c.matched ?? 0} matched, ${c.new ?? 0} new, ${c.ambiguous ?? 0} ambiguous, ${c.invalid ?? 0} invalid, ${c.duplicate ?? 0} duplicate`);
  if (r.mapping?.fields) lines.push("  mapping: " + Object.entries(r.mapping.fields).map(([k, v]: any) => `${k}<-${v.column}(${Math.round((v.confidence ?? 0) * 100)}%)`).join(", "));
  if (r.mapping?.vars && Object.keys(r.mapping.vars).length) lines.push("  template fields: " + Object.keys(r.mapping.vars).map((k) => `{{${k}}}`).join(" "));
  if (r.needs_confirmation) lines.push("  NEEDS CONFIRMATION: check the mapping, then `outbox mapping " + r.import_id + " --set ...`");
  if (r.columns) lines.push("  columns: " + r.columns.join(", "));
  if (r.mapping?.region && r.mapping.region !== "US") lines.push(`  region: ${r.mapping.region}`);
  if (r.unlabeled_columns?.length) lines.push(`  columns with no header: ${r.unlabeled_columns.join(", ")}`);
  if (r.template_vars) lines.push("  template fields: " + r.template_vars.map((v: string) => `{{${v}}}`).join(" "));
  if (Array.isArray(r.rows)) {
    lines.push(`  rows ${r.offset + 1}-${r.offset + r.rows.length} of ${r.rows_total}${r.has_more ? `; next: --offset ${r.offset + r.rows.length}` : ""}`);
    for (const row of r.rows) lines.push(`   #${row.row_index} [${row.match}] ${row.name ?? ""} <${row.handle ?? "no handle"}>${row.issues?.length ? "  issues: " + row.issues.map((i: any) => i.code).join(",") : ""}`);
  }
  lines.push(`  dashboard: ${r.dashboard_url}`);
  return lines.join("\n");
}
function fmtContacts(r: Json): string {
  const lines: string[] = [];
  if (!r.contacts.length) lines.push("no contacts found");
  else {
    lines.push(...r.contacts.map((c: any) => `${c.id}  ${c.display_name || "(no name)"}${c.org ? " (" + c.org + ")" : ""}  ${c.preferred_handle ?? "no handle"}${c.tags?.length ? "  tags: " + c.tags.join(",") : ""}`));
    if (r.total !== undefined) lines.push(`-- ${r.offset + 1}-${r.offset + r.contacts.length} of ${r.total}${r.has_more ? `; next page: --offset ${r.offset + r.contacts.length}` : ""}`);
  }
  if (r.tags?.length) lines.push("tags: " + r.tags.map((t: any) => `${t.tag} (${t.count})`).join(", "));
  return lines.join("\n");
}

function fmtContactSet(r: Json): string {
  const lines: string[] = [];
  const set = r.set;
  if (set) {
    lines.push(`${set.title}  [${set.status}]  ${set.id}`);
    lines.push(`  by ${set.created_by} (${set.source}); ${Object.entries(r.counts ?? {}).map(([k, v]) => `${v} ${k}`).join(", ") || "no changes"}`);
    for (const c of r.changes ?? []) {
      const p = c.payload ?? {};
      const who = c.kind === "create" ? [p.given_name, p.family_name].filter(Boolean).join(" ") : c.before?.display_name ?? c.target_macos_id ?? "";
      const what = c.kind === "create" ? [...(p.phones ?? []).map((x: any) => x.e164), ...(p.emails ?? []).map((x: any) => x.email)].join(", ")
        : [p.set ? "set " + Object.entries(p.set).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ") : "", ...(p.add_phones ?? []).map((x: any) => "+" + x.e164), ...(p.add_emails ?? []).map((x: any) => "+" + x.email), ...(p.add_groups ?? []).map((g: string) => "+group " + g)].filter(Boolean).join("; ");
      lines.push(`  - ${c.id}  ${c.kind}  ${who}  [${c.status}]${c.note ? "  (" + c.note + ")" : ""}${c.error ? "  error: " + c.error : ""}`);
      if (what) lines.push(`      ${what}`);
    }
  } else if (r.set_id) {
    lines.push(`contact change set ${r.set_id} [${r.status}]: ${r.counts.auto_queued} automatic, ${r.counts.review} waiting for the user's approval, ${r.counts.rejected} not needed`);
    for (const c of r.changes ?? []) lines.push(`  - ${c.id}  ${c.kind}  [${c.status}]${c.note ? "  (" + c.note + ")" : ""}`);
    if (r.skipped?.length) lines.push(`  skipped ${r.skipped.length} row(s): ${r.skipped.slice(0, 5).map((s: any) => `#${s.row_index} ${s.reason}`).join("; ")}${r.skipped.length > 5 ? "; ..." : ""}`);
    if (r.message) lines.push(`  ${r.message}`);
  } else if (Array.isArray(r.sets)) {
    if (!r.sets.length) return "no contact change sets";
    for (const s of r.sets) lines.push(`${s.id}  [${s.status}]  ${Object.entries(s.counts ?? {}).map(([k, v]) => `${v} ${k}`).join(", ")}  ${s.title}  (${s.created_by})`);
  }
  if (r.dashboard_url) lines.push(`  dashboard: ${r.dashboard_url}`);
  return lines.join("\n");
}

type Fmt = (r: Json) => string;

export async function main(argv: string[], io: Partial<CliIo> = {}): Promise<number> {
  const out = io.out ?? ((s: string) => console.log(s));
  const errOut = io.err ?? ((s: string) => console.error(s));
  const full: CliIo = { out, err: errOut, readStdin: io.readStdin ?? (() => Bun.stdin.text()) };
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { out(HELP); return 0; }

  try {
    const wantJson = argv.includes("--json");
    const socketFlag = (() => { const i = argv.indexOf("--socket"); return i >= 0 ? argv[i + 1] : undefined; })();
    const api = io.client ?? createAgentClient({ client: process.env.OUTBOX_CLIENT ?? "cli", source: "cli", ...(socketFlag ? { socketPath: socketFlag } : {}) });
    const show = (r: Json, f: Fmt) => out(wantJson ? JSON.stringify(r, null, 2) : f(r));

    switch (cmd) {
      case "draft": {
        const { values } = opts(rest, { to: { type: "string" }, contact: { type: "string" }, body: { type: "string" }, "body-file": { type: "string" }, service: { type: "string" }, notes: { type: "string" }, title: { type: "string" } });
        const body = await textArg(full, values.body, values["body-file"], "--body or --body-file");
        show(await api.post("/v1/drafts", { to: values.to, contact_id: values.contact, body, service: values.service, notes: values.notes, title: values.title }), fmtBatch);
        return 0;
      }
      case "edit": {
        const { values, positionals } = opts(rest, { body: { type: "string" }, "body-file": { type: "string" } });
        const id = positionals[0]; if (!id) throw new UsageError("edit needs a draft id");
        const body = await textArg(full, values.body, values["body-file"], "--body or --body-file");
        show(await api.patch(`/v1/drafts/${encodeURIComponent(id)}`, { body }), (r) => `draft ${id} updated (v${r.draft.version}), ${r.warnings.length} warning(s)\n  ${r.draft.body}\n  dashboard: ${r.dashboard_url}`);
        return 0;
      }
      case "edit-many": {
        const { values } = opts(rest, { file: { type: "string" } });
        if (!values.file) throw new UsageError("edit-many needs --file <updates.json|->");
        const raw = values.file === "-" ? await full.readStdin() : readFileSync(values.file, "utf8");
        let j: any; try { j = JSON.parse(raw); } catch (e) { throw new UsageError(`updates file isn't valid JSON: ${(e as Error).message}`); }
        const updates = Array.isArray(j) ? j : j?.updates;
        if (!Array.isArray(updates)) throw new UsageError("updates must be a JSON array of {draft_id, body}");
        show(await api.patch("/v1/drafts", { updates }), (r) => `${r.updated} draft(s) updated, ${r.unchanged} unchanged\n` + (r.batches ?? []).map((b: any) => `  ${b.id}: ${b.warnings.length} warning(s)  ${b.dashboard_url}`).join("\n"));
        return 0;
      }
      case "batch": {
        const [sub, ...r2] = rest;
        if (sub === "create") {
          const { values } = opts(r2, { title: { type: "string" }, template: { type: "string" }, instructions: { type: "string" }, items: { type: "string" }, submit: { type: "boolean" } });
          if (!values.title) throw new UsageError("batch create needs --title");
          const items = values.items ? await itemsArg(full, values.items) : undefined;
          show(await api.post("/v1/batches", { title: values.title, template: values.template, instructions: values.instructions, items, submit: values.submit }), fmtBatch);
          return 0;
        }
        if (sub === "add") {
          const { values, positionals } = opts(r2, { items: { type: "string" } });
          const id = positionals[0]; if (!id || !values.items) throw new UsageError("batch add needs a batch id and --items");
          show(await api.post(`/v1/batches/${encodeURIComponent(id)}/items`, { items: await itemsArg(full, values.items) }), fmtBatch);
          return 0;
        }
        if (sub === "show") {
          const { positionals } = opts(r2, {});
          if (!positionals[0]) throw new UsageError("batch show needs a batch id");
          show(await api.get(`/v1/batches/${encodeURIComponent(positionals[0])}`), fmtBatch);
          return 0;
        }
        if (sub === "list") {
          const { values } = opts(r2, { status: { type: "string" }, limit: { type: "string" } });
          show(await api.get(`/v1/batches${qs({ status: values.status, limit: values.limit })}`), (r) => r.batches.length
            ? r.batches.map((b: any) => `${b.id}  [${b.status}]  ${b.draft_count} draft(s)  ${b.title}  (${b.created_by})`).join("\n") : "no batches");
          return 0;
        }
        if (sub === "submit") {
          const { positionals } = opts(r2, {});
          if (!positionals[0]) throw new UsageError("batch submit needs a batch id");
          show(await api.post(`/v1/batches/${encodeURIComponent(positionals[0])}/submit`), fmtBatch);
          return 0;
        }
        if (sub === "cancel") {
          const { positionals } = opts(r2, {});
          if (!positionals[0]) throw new UsageError("batch cancel needs a batch id");
          show(await api.post(`/v1/batches/${encodeURIComponent(positionals[0])}/cancel`), fmtBatch);
          return 0;
        }
        throw new UsageError("batch needs a subcommand: create, add, show, list, submit, cancel");
      }
      case "import": {
        const [sub, ...r2] = rest;
        if (sub === "show" && r2.length) {
          const { values, positionals } = opts(r2, { offset: { type: "string" }, limit: { type: "string" }, full: { type: "boolean" } });
          if (!positionals[0]) throw new UsageError("import show needs an import id");
          show(await api.get(`/v1/imports/${encodeURIComponent(positionals[0])}${qs({ offset: values.offset, limit: values.limit, fields: values.full ? "full" : undefined })}`), fmtImport);
          return 0;
        }
        if (sub === "batch" && r2.length) {
          const { values, positionals } = opts(r2, { template: { type: "string" }, title: { type: "string" }, instructions: { type: "string" }, bodies: { type: "string" }, include: { type: "string" }, "no-new-contacts": { type: "boolean" }, "allow-unknown-vars": { type: "boolean" }, submit: { type: "boolean" } });
          const id = positionals[0];
          if (!id || !values.template || !values.title) throw new UsageError("import batch needs an import id, --template and --title");
          const per_row_bodies = values.bodies ? JSON.parse(readFileSync(values.bodies, "utf8")) : undefined;
          const include = values.include ? (values.include as string).split(",").map((x: string) => Number(x.trim())).filter((n: number) => Number.isInteger(n)) : undefined;
          show(await api.post(`/v1/imports/${encodeURIComponent(id)}/batch`, {
            title: values.title, template: values.template, per_row_bodies, include, instructions: values.instructions,
            create_new_contacts: values["no-new-contacts"] ? false : undefined, submit: values.submit,
            allow_unknown_vars: values["allow-unknown-vars"] ? true : undefined,
          }), fmtBatch);
          return 0;
        }
        const { values, positionals } = opts(rest, { sheet: { type: "string" }, kind: { type: "string" }, filename: { type: "string" }, region: { type: "string" } });
        const src = positionals[0]; if (!src) throw new UsageError("import needs a file path (or - for stdin)");
        const body: Json = { sheet: values.sheet, kind: values.kind, region: values.region };
        if (src === "-") Object.assign(body, { text: await full.readStdin(), filename: values.filename });
        else { const u = readUpload(src); Object.assign(body, { base64: u.base64, filename: values.filename ?? u.filename }); }
        show(await api.post("/v1/imports", body), fmtImport);
        return 0;
      }
      case "mapping": {
        const { values, positionals } = opts(rest, { set: { type: "string", multiple: true }, var: { type: "string", multiple: true }, unset: { type: "string", multiple: true }, file: { type: "string" }, unconfirmed: { type: "boolean" }, region: { type: "string" } });
        const id = positionals[0]; if (!id) throw new UsageError("mapping needs an import id");
        let body: Json = values.file ? JSON.parse(readFileSync(values.file, "utf8")) : { fields: {} };
        body.fields ??= {};
        const pair = (s: string, flag: string): [string, string] => { const i = s.indexOf("="); if (i < 1) throw new UsageError(`${flag} wants name=Column`); return [s.slice(0, i), s.slice(i + 1)]; };
        // --set phone=Mobile,Home Phone  -> an ordered list of columns for phone, email or tags
        for (const s of values.set ?? []) {
          const [k, v] = pair(s, "--set");
          const cols = v.split(",").map((x) => x.trim()).filter(Boolean);
          body.fields[k] = cols.length > 1 && ["phone", "email", "tags"].includes(k) ? { column: cols[0], columns: cols } : { column: v };
        }
        if (values.region) body.region = values.region;
        for (const k of values.unset ?? []) body.fields[k] = null;
        if (values.var?.length) { body.vars = { ...(body.vars ?? {}) }; for (const s of values.var) { const [k, v] = pair(s, "--var"); body.vars[k] = v; } }
        if (values.unconfirmed) body.confirmed = false;
        show(await api.put(`/v1/imports/${encodeURIComponent(id)}/mapping`, body), fmtImport);
        return 0;
      }
      case "contacts": {
        const [sub, ...r2] = rest;
        if (sub === "search") {
          const { values, positionals } = opts(r2, { limit: { type: "string" }, offset: { type: "string" }, tag: { type: "string" }, has: { type: "string" }, source: { type: "string" }, tags: { type: "boolean" } });
          show(await api.get(`/v1/contacts${qs({ q: positionals.join(" "), limit: values.limit, offset: values.offset, tag: values.tag, has: values.has, source: values.source, facets: values.tags ? "tags" : undefined })}`), fmtContacts);
          return 0;
        }
        if (sub === "show") {
          const { positionals } = opts(r2, {});
          if (!positionals[0]) throw new UsageError("contacts show needs a contact id");
          show(await api.get(`/v1/contacts/${encodeURIComponent(positionals[0])}`), (r) => JSON.stringify(r.contact, null, 2));
          return 0;
        }
        if (sub === "propose") {
          const { values } = opts(r2, { file: { type: "string" } });
          if (!values.file) throw new UsageError("contacts propose needs --file <json|->");
          const raw = values.file === "-" ? await full.readStdin() : readFileSync(values.file, "utf8");
          let j: any; try { j = JSON.parse(raw); } catch (e) { throw new UsageError(`the file isn't valid JSON: ${(e as Error).message}`); }
          if (!j || typeof j !== "object" || Array.isArray(j)) throw new UsageError("the file must be a JSON object with title and creates and/or updates");
          show(await api.post("/v1/contact-changes", j), fmtContactSet);
          return 0;
        }
        if (sub === "from-import") {
          const { values, positionals } = opts(r2, { suffix: { type: "string" }, prefix: { type: "string" }, title: { type: "string" }, include: { type: "string" }, group: { type: "string", multiple: true } });
          if (!positionals[0]) throw new UsageError("contacts from-import needs an import id");
          const include = values.include ? (values.include as string).split(",").map((x: string) => Number(x.trim())).filter((n: number) => Number.isInteger(n)) : undefined;
          show(await api.post(`/v1/imports/${encodeURIComponent(positionals[0])}/contact-changes`, {
            title: values.title, first_name_prefix: values.prefix, first_name_suffix: values.suffix, include, groups: values.group?.length ? values.group : undefined,
          }), fmtContactSet);
          return 0;
        }
        if (sub === "changes") {
          const { values, positionals } = opts(r2, { status: { type: "string" }, limit: { type: "string" } });
          show(await api.get(positionals[0] ? `/v1/contact-changes/${encodeURIComponent(positionals[0])}` : `/v1/contact-changes${qs({ status: values.status, limit: values.limit })}`), fmtContactSet);
          return 0;
        }
        throw new UsageError("contacts needs a subcommand: search, show, propose, from-import, changes");
      }
      case "sync-contacts": {
        opts(rest, {});
        show(await api.post("/v1/contacts/sync"), (r) => `${r.message}${r.warning ? "\n  warning: " + r.warning : ""}`);
        return 0;
      }
      case "status": {
        opts(rest, {});
        show(await api.get("/v1/status"), (r) => [
          `outboxd: ok`,
          `executor: ${r.executor.alive ? "alive" : "NOT running"}${r.executor.transport ? ` (transport ${r.executor.transport}, pin file ${r.executor.pin_file_ok ? "ok" : "not usable"})` : ""}`,
          `kill switch: ${r.kill_switch ? "ON (sending stopped)" : "off"}`,
          `batches: ${Object.entries(r.batches).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}`,
          `contacts: ${r.contacts}`, `dashboard: ${r.dashboard_url}`,
        ].join("\n"));
        return 0;
      }
      default:
        errOut(`unknown command "${cmd}". There is deliberately no send or approve command.\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError) { errOut(`usage: ${e.message}\nRun "outbox help" for the commands.`); return 2; }
    if (e instanceof OutboxDownError) { errOut(e.message); return 3; }
    if (e instanceof PathRefusedError || e instanceof FileProblemError) { errOut(`error (${e.code}): ${e.message}`); return 1; }
    if (e instanceof OutboxApiError) {
      errOut(argv.includes("--json") ? JSON.stringify({ error: { code: e.code, message: e.message, details: e.details } }) : `error (${e.code}): ${e.message}`);
      return 1;
    }
    errOut(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
