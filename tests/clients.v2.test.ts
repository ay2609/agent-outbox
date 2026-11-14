// MCP tools and the CLI for the fix round: contacts filters, get_import, add_items, bulk update, cancel, region, path allowlist.
const HOME = (await import("./helpers")).tmpDir("outbox-v2c-home-");
process.env.OUTBOX_HOME = HOME;

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Database } from "bun:sqlite";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentApp } from "../src/agent-api/app";
import { createAgentClient } from "../src/agent-api/client";
import type { BDeps } from "../src/core/deps";
import { main } from "../src/cli";
import { createOutboxMcpServer } from "../src/mcp/server";
import { memDb, seedContact, tmpDir } from "./helpers";

let db: Database; let app: ReturnType<typeof createAgentApp>; let server: ReturnType<typeof Bun.serve>; let sock: string;

const GOOGLE = [
  "First Name,Last Name,Labels,Phone 1 - Label,Phone 1 - Value,Phone 2 - Label,Phone 2 - Value,City",
  "Jane,Smith,* myContacts ::: College Friends,Work,202-555-0143,Mobile,(301) 555-0123,Oslo",
  "Bob,Jones,* myContacts,Mobile,301-555-0188,,,Rome",
  "Cy,Dee,College Friends,Home,202-555-0100,,,Paris",
].join("\n");

beforeAll(async () => {
  db = memDb();
  const [norm, ing, from, lint, tpl] = await Promise.all([
    import("../src/ingest/normalize"), import("../src/ingest/ingest"), import("../src/personalize/from-import"),
    import("../src/personalize/lint"), import("../src/personalize/template"),
  ]);
  const importsDir = tmpDir("outbox-imports-");
  const deps: BDeps = {
    normalizeHandle: norm.normalizeHandle as any, normalizePhone: norm.normalizePhone as any,
    ingestFile: (d, a) => ing.ingestFile(d, { ...a, importsDir }), setMapping: ing.setMapping as any, getImport: ing.getImport as any,
    batchFromImport: from.batchFromImport as any, lintBatch: lint.lintBatch as any, renderTemplate: tpl.renderTemplate as any,
  };
  app = createAgentApp({ db: () => db, deps: async () => deps, origin: "https://outbox.test" });
  sock = join(tmpDir("outbox-sock-"), "agent.sock");
  server = Bun.serve({ unix: sock, fetch: app.fetch });
  seedContact(db, { name: "Ann Lee", phones: [{ e164: "+12025550001", label: "mobile" }], tags: ["College Friends"] });
  seedContact(db, { name: "Ben Roe", emails: ["ben@example.com"], tags: ["College Friends", "Climbing"] });
  seedContact(db, { name: "Dan Fox", tags: ["Climbing"] });
});
afterAll(() => { void server.stop(true); });

async function connect() {
  const mcp = createOutboxMcpServer({ socketPath: sock, label: "mcp-v2" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}
const textOf = (r: any): string => r.content.map((c: any) => c.text).join("\n");
const jsonOf = (r: any) => JSON.parse(textOf(r).slice(textOf(r).indexOf("{")));
const tool = async (c: Client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args }) as Promise<any>;

describe("MCP tool descriptions say what the tools can really do", () => {
  test("search_contacts: filters, paging, groups-as-tags, and the honest limits", async () => {
    const { tools } = await (await connect()).listTools();
    const d = Object.fromEntries(tools.map((t) => [t.name, t.description ?? ""]));
    const s = d.outbox_search_contacts!;
    for (const w of ["tag", "has=phone|email|none", "source=", "offset", "total", "include_tags", "GROUPS are tags"]) expect(s).toContain(w);
    expect(s).toMatch(/cannot understand relationships/);
    expect(s).toMatch(/substring/);
    const props = Object.keys((tools.find((t) => t.name === "outbox_search_contacts")!.inputSchema as any).properties);
    expect(props.sort()).toEqual(["has", "include_tags", "limit", "offset", "query", "source", "tag"]);
    expect(d.outbox_get_import).toMatch(/EVERY row/);
    expect(d.outbox_cancel_batch).toMatch(/can only stop messages/);
    expect(d.outbox_update_drafts).toMatch(/All or nothing/);
    expect(d.outbox_batch_from_import).toMatch(/Refused \(nothing created\)/);
    expect(d.outbox_ingest_file).toContain("~/Downloads");
    expect(d.outbox_ingest_file).toContain("hidden folders");
    expect(d.outbox_add_items).toContain("only sent after the user approves");
  });
});

describe("search_contacts tool", () => {
  test("tag, has, source, offset, include_tags", async () => {
    const c = await connect();
    const r = jsonOf(await tool(c, "outbox_search_contacts", { tag: "college friends", limit: 1, include_tags: true }));
    expect(r).toMatchObject({ total: 2, has_more: true, offset: 0 });
    expect(r.contacts.map((x: any) => x.display_name)).toEqual(["Ann Lee"]);
    expect(r.tags).toEqual([{ tag: "climbing", count: 2 }, { tag: "college friends", count: 2 }]);
    const p2 = jsonOf(await tool(c, "outbox_search_contacts", { tag: "college friends", limit: 1, offset: 1 }));
    expect(p2.contacts.map((x: any) => x.display_name)).toEqual(["Ben Roe"]);
    expect(jsonOf(await tool(c, "outbox_search_contacts", { has: "none" })).contacts.map((x: any) => x.display_name)).toEqual(["Dan Fox"]);
    expect(jsonOf(await tool(c, "outbox_search_contacts", { source: "macos", has: "email" })).total).toBe(1);
    expect((await tool(c, "outbox_search_contacts", {})).isError).toBeFalsy(); // query is optional now
  });
});

describe("import workflow tools", () => {
  test("ingest → get_import (paged, vars, issues) → batch_from_import with per-row bodies → add_items/update_drafts/cancel", async () => {
    const c = await connect();
    const i = jsonOf(await tool(c, "outbox_ingest_file", { text: GOOGLE }));
    expect(i.dashboard_url).toContain("/#/imports/");
    const page1 = jsonOf(await tool(c, "outbox_get_import", { import_id: i.import_id, limit: 2 }));
    expect(page1).toMatchObject({ rows_total: 3, has_more: true });
    expect(page1.rows[0]).toMatchObject({ name: "Jane Smith", handle: "+13015550123", match: "new" });
    expect(page1.rows[0].vars.city).toBe("Oslo");
    const page2 = jsonOf(await tool(c, "outbox_get_import", { import_id: i.import_id, limit: 2, offset: 2 }));
    expect(page2.rows.map((r: any) => r.row_index)).toEqual([2]);
    expect(page2.has_more).toBe(false);
    expect(jsonOf(await tool(c, "outbox_get_import", { import_id: i.import_id, limit: 1, fields: "full" })).rows[0].raw["First Name"]).toBe("Jane");
    expect((await tool(c, "outbox_get_import", { import_id: "nope" })).isError).toBe(true);

    // unknown fields: refused, with the list
    const unk = await tool(c, "outbox_batch_from_import", { import_id: i.import_id, title: "x", template: "Hi {{first_name}} {{nope}}" });
    expect(unk.isError).toBe(true);
    expect(textOf(unk)).toContain("unknown_template_vars");
    expect(textOf(unk)).toContain("Available fields:");

    const bodies = Object.fromEntries(page1.rows.concat(page2.rows).map((r: any) => [r.row_index, `Hey ${r.vars.first_name}, how is ${r.vars.city}?`]));
    const b = jsonOf(await tool(c, "outbox_batch_from_import", { import_id: i.import_id, title: "Per row", template: "unused", per_row_bodies: bodies, instructions: "friendly check-ins" }));
    expect(b.drafts.map((d: any) => d.body)).toEqual(["Hey Jane, how is Oslo?", "Hey Bob, how is Rome?", "Hey Cy, how is Paris?"]);
    expect(b.batch.instructions).toBe("friendly check-ins");

    // bulk update, all or nothing
    const ids = b.drafts.map((d: any) => d.id);
    const ok = jsonOf(await tool(c, "outbox_update_drafts", { updates: [{ draft_id: ids[0], body: "Jane! Oslo?" }, { draft_id: ids[1], body: "Bob! Rome?" }] }));
    expect(ok).toMatchObject({ updated: 2, unchanged: 0 });
    const bad = await tool(c, "outbox_update_drafts", { updates: [{ draft_id: ids[2], body: "changed" }, { draft_id: "nope", body: "x" }] });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("invalid_updates");
    const got = jsonOf(await tool(c, "outbox_get_batch", { id: b.batch.id }));
    expect(got.drafts.map((d: any) => d.body)).toEqual(["Jane! Oslo?", "Bob! Rome?", "Hey Cy, how is Paris?"]);

    // add_items needs a drafting batch (this one is)
    const more = jsonOf(await tool(c, "outbox_add_items", { id: b.batch.id, items: [{ to: "202-555-0177", body: "Hi Dee" }] }));
    expect(more.drafts).toHaveLength(4);
    // cancel
    const cx = jsonOf(await tool(c, "outbox_cancel_batch", { id: b.batch.id }));
    expect(cx).toMatchObject({ cancelled: true, drafts_rejected: 4 });
    const again = await tool(c, "outbox_cancel_batch", { id: b.batch.id });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toContain("not_cancellable");
    const late = await tool(c, "outbox_add_items", { id: b.batch.id, items: [{ to: "202-555-0178", body: "x" }] });
    expect(late.isError).toBe(true);
  });

  test("cancel refuses another session's batch and an approved one", async () => {
    const mine = await connect();
    const b = jsonOf(await tool(mine, "outbox_create_batch", { title: "mine", items: [{ to: "202-555-0141", body: "hi" }], submit: true }));
    const other = createOutboxMcpServer({ socketPath: sock, label: "someone-else" });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const theirs = new Client({ name: "t", version: "0" });
    await Promise.all([other.connect(x), theirs.connect(y)]);
    const denied = await tool(theirs, "outbox_cancel_batch", { id: b.batch.id });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("not_your_batch");
    db.query("UPDATE batches SET status = 'approved' WHERE id = ?").run(b.batch.id);
    const approved = await tool(mine, "outbox_cancel_batch", { id: b.batch.id });
    expect(approved.isError).toBe(true);
    expect(db.query("SELECT status FROM batches WHERE id = ?").get(b.batch.id)).toEqual({ status: "approved" });
  });

  test("0 drafts is refused; allow_unknown_vars overrides the field check", async () => {
    const c = await connect();
    const i = jsonOf(await tool(c, "outbox_ingest_file", { text: "Name,Phone\nBad One,nope\nGood One,202-555-0150\n" }));
    const empty = await tool(c, "outbox_batch_from_import", { import_id: i.import_id, title: "x", template: "Hi", include: [0] });
    expect(empty.isError).toBe(true);
    expect(textOf(empty)).toContain("no_drafts");
    const forced = jsonOf(await tool(c, "outbox_batch_from_import", { import_id: i.import_id, title: "x", template: "Hi {{missing}}", allow_unknown_vars: true }));
    expect(forced.drafts).toHaveLength(1);
    expect(forced.warnings.map((w: any) => w.code)).toContain("unresolved_var");
  });

  test("region on ingest; set_mapping with a phone columns list", async () => {
    const c = await connect();
    const i = jsonOf(await tool(c, "outbox_ingest_file", { text: "Name,Home,Cell\nZed Quill,07911 123456,07911 123457\n", region: "GB" }));
    expect(i.mapping.region).toBe("GB");
    expect(i.counts.new).toBe(1);
    const m = jsonOf(await tool(c, "outbox_set_mapping", { import_id: i.import_id, fields: { phone: { columns: ["cell", "home"] } } }));
    expect(m.mapping.fields.phone).toMatchObject({ column: "Cell", columns: ["Cell", "Home"] });
    expect(m.preview[0].normalized.handle).toBe("+447911123457");
  });

  test("ingest by path: ~/.ssh, a symlink out of the temp dir, and .env are refused in the MCP process, before any upload", async () => {
    const c = await connect();
    const ssh = await tool(c, "outbox_ingest_file", { path: "~/.ssh/id_ed25519" });
    expect(ssh.isError).toBe(true);
    expect(textOf(ssh)).toContain("path_not_allowed");
    const dir = tmpDir("outbox-evil-");
    symlinkSync("/etc/hosts", join(dir, "people.csv"));
    writeFileSync(join(dir, ".env"), "TOKEN=1\n");
    expect(textOf(await tool(c, "outbox_ingest_file", { path: join(dir, "people.csv") }))).toContain("path_not_allowed");
    expect(textOf(await tool(c, "outbox_ingest_file", { path: join(dir, ".env") }))).toContain("path_not_allowed");
    expect(db.query("SELECT COUNT(*) AS n FROM imports WHERE filename IN ('people.csv', '.env', 'id_ed25519')").get()).toEqual({ n: 0 });
  });
});

// ------------------------------------------------------------------------------------------------ CLI
async function cli(args: string[], stdin = "") {
  const out: string[] = []; const err: string[] = [];
  const client = createAgentClient({ client: "cli-v2", source: "cli", fetchImpl: (url, init) => Promise.resolve(app.fetch(new Request(url, init))) });
  const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s), readStdin: async () => stdin, client });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("CLI mirrors the new tools", () => {
  test("contacts search flags and paging footer", async () => {
    const r = await cli(["contacts", "search", "--tag", "college friends", "--limit", "1", "--tags"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Ann Lee");
    expect(r.out).toContain("-- 1-1 of 2; next page: --offset 1");
    expect(r.out).toContain("tags: climbing (2), college friends (2)");
    expect((await cli(["contacts", "search", "--has", "none", "--json"])).out).toContain("Dan Fox");
    expect((await cli(["contacts", "search", "--has", "fax"])).code).toBe(1);
  });

  test("import (with --region), import show (paged rows), import batch (--instructions, unknown vars), batch cancel, edit-many", async () => {
    const f = join(tmpDir("outbox-cli-"), "uk.csv");
    await Bun.write(f, "Name,Mobile\nZed Quill,07911 123456\nYan Brook,07911 123457\n");
    const i = await cli(["import", f, "--region", "GB", "--json"]);
    expect(i.code).toBe(0);
    const imp = JSON.parse(i.out);
    expect(imp.counts.new).toBe(2);
    const shown = await cli(["import", "show", imp.import_id, "--limit", "1", "--offset", "1"]);
    expect(shown.out).toContain("rows 2-2 of 2");
    expect(shown.out).toContain("#1 [new] Yan Brook <+447911123457>");
    expect(shown.out).toContain("region: GB");
    expect(shown.out).toContain("template fields: {{first_name}}");

    const unk = await cli(["import", "batch", imp.import_id, "--template", "Hi {{first_name}} {{nope}}", "--title", "t"]);
    expect(unk.code).toBe(1);
    expect(unk.err).toContain("unknown_template_vars");
    const b = await cli(["import", "batch", imp.import_id, "--template", "Hi {{first_name}} {{nope}}", "--title", "t", "--allow-unknown-vars", "--instructions", "keep it short", "--json"]);
    expect(b.code).toBe(0);
    const batch = JSON.parse(b.out);
    expect(batch.batch.instructions).toBe("keep it short");

    const upd = join(tmpDir("outbox-cli-"), "updates.json");
    await Bun.write(upd, JSON.stringify(batch.drafts.map((d: any, n: number) => ({ draft_id: d.id, body: `Hi again ${n}` }))));
    const em = await cli(["edit-many", "--file", upd]);
    expect(em.code).toBe(0);
    expect(em.out).toContain("2 draft(s) updated");
    const bad = await cli(["edit-many", "--file", "-"], JSON.stringify([{ draft_id: "nope", body: "x" }]));
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("invalid_updates");

    const cx = await cli(["batch", "cancel", batch.batch.id]);
    expect(cx.code).toBe(0);
    expect(cx.out).toContain("[cancelled]");
    expect((await cli(["batch", "cancel", batch.batch.id])).code).toBe(1);
    expect((await cli(["batch", "cancel"])).code).toBe(2);
  });

  test("mapping --set phone=A,B builds a columns list; --region", async () => {
    const i = JSON.parse((await cli(["import", "-", "--filename", "x.csv", "--json"], "Name,Home,Cell\nAnn Lee,202-555-0143,301-555-0123\n")).out);
    const m = JSON.parse((await cli(["mapping", i.import_id, "--set", "phone=cell,Home", "--region", "us", "--json"])).out);
    expect(m.mapping.fields.phone).toMatchObject({ column: "Cell", columns: ["Cell", "Home"] });
    expect(m.mapping.region).toBe("US");
  });

  test("import by path refuses ~/.ssh and a symlink out of the temp dir", async () => {
    const ssh = await cli(["import", "~/.ssh/id_ed25519"]);
    expect(ssh.code).toBe(1);
    expect(ssh.err).toContain("path_not_allowed");
    const dir = tmpDir("outbox-cli-evil-");
    symlinkSync("/etc/hosts", join(dir, "hosts.txt"));
    expect((await cli(["import", join(dir, "hosts.txt")])).err).toContain("path_not_allowed");
  });

  test("help lists the new verbs", async () => {
    const r = await cli(["help"]);
    for (const v of ["batch cancel", "edit-many", "--region", "--offset", "--allow-unknown-vars", "--instructions", "--has phone|email|none"]) expect(r.out).toContain(v);
  });
});
