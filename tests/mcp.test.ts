// MCP server tested with an in-process MCP client against a real agent app served on a temp unix socket.
const HOME = (await import("./helpers")).tmpDir("outbox-home-");
process.env.OUTBOX_HOME = HOME; // paths.ts reads this at import time; nothing here uses the real state dir

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { createAgentApp } from "../src/agent-api/app";
import { createOutboxMcpServer } from "../src/mcp/server";
import { fakeDeps, memDb, seedContact, tmpDir } from "./helpers";

const EXPECTED_TOOLS = [
  "outbox_search_contacts", "outbox_get_contact", "outbox_create_draft", "outbox_create_batch", "outbox_ingest_file",
  "outbox_set_mapping", "outbox_batch_from_import", "outbox_update_draft", "outbox_list_batches", "outbox_get_batch",
  "outbox_submit_batch", "outbox_sync_contacts",
  "outbox_get_import", "outbox_add_items", "outbox_update_drafts", "outbox_cancel_batch",
  "outbox_propose_contacts", "outbox_contacts_from_import", "outbox_get_contact_changes",
  "outbox_list_groups", "outbox_get_group", "outbox_create_group", "outbox_add_to_group", "outbox_update_group", "outbox_batch_from_group",
];

let db: Database; let server: ReturnType<typeof Bun.serve>; let sock: string;
async function connect(socketPath = sock) {
  const mcp = createOutboxMcpServer({ socketPath, label: "mcp-test" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}
const textOf = (r: any): string => r.content.map((c: any) => c.text).join("\n");
const jsonOf = (r: any) => JSON.parse(textOf(r).slice(textOf(r).indexOf("{")));
const callTool = async (c: Client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args }) as Promise<any>;

beforeAll(() => {
  db = memDb();
  const { deps } = fakeDeps(db);
  const app = createAgentApp({ db: () => db, deps: async () => deps, origin: "https://outbox.test" });
  sock = join(tmpDir("outbox-sock-"), "agent.sock");
  server = Bun.serve({ unix: sock, fetch: app.fetch });
});
afterAll(() => { void server.stop(true); });

describe("tool surface", () => {
  test("exactly the 25 draft-only tools; none can send, approve or undo", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const t of tools) expect(t.name).not.toMatch(/send|approve|schedule|stop|setting/);
  });

  test("descriptions state the gate, the template syntax and the workflow", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    const d = Object.fromEntries(tools.map((t) => [t.name, t.description ?? ""]));
    for (const n of ["outbox_create_draft", "outbox_create_batch", "outbox_batch_from_import", "outbox_submit_batch"]) {
      expect(d[n]).toContain("only sent after the user approves them in the dashboard");
      expect(d[n]).toContain("You cannot send");
    }
    expect(d.outbox_create_batch).toContain("{{first_name|there}}");
    expect(d.outbox_batch_from_import).toContain("{{first_name|there}}");
    expect(d.outbox_create_batch).toMatch(/personalis/i);
    expect(d.outbox_create_draft).toMatch(/short, natural/);
    expect(d.outbox_ingest_file).toMatch(/ingest, then mapping, then batch/);
    expect(d.outbox_ingest_file).toContain("outbox_set_mapping");
    expect(d.outbox_ingest_file).toContain("outbox_batch_from_import");
    expect(d.outbox_set_mapping).toContain("exactly as listed");
    expect(d.outbox_search_contacts).toContain("Read-only");
    // read-only tools are annotated as such
    expect(tools.find((t) => t.name === "outbox_get_batch")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "outbox_create_draft")?.annotations?.readOnlyHint).toBe(false);
  });
});

describe("tools against the live socket", () => {
  test("search contacts, get contact", async () => {
    const id = seedContact(db, { name: "Sam Lee", phones: [{ e164: "+12025550009", label: "mobile" }] });
    const c = await connect();
    const s = await callTool(c, "outbox_search_contacts", { query: "sam", limit: 5 });
    expect(s.isError).toBeFalsy();
    expect(jsonOf(s).contacts[0].id).toBe(id);
    const g = await callTool(c, "outbox_get_contact", { id });
    expect(jsonOf(g).contact.preferred_handle).toBe("+12025550009");
    const bad = await callTool(c, "outbox_get_contact", { id: "nope" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("contact_not_found");
  });

  test("draft → update → get → list", async () => {
    const c = await connect();
    const d = await callTool(c, "outbox_create_draft", { to: "415-123-0001", body: "Hey! Coffee Friday?" });
    expect(d.isError).toBeFalsy();
    expect(textOf(d)).toMatch(/^Batch ".*" \(.*\): 1 draft, 0 warnings, waiting for the user to review and approve it\. Review link: https:\/\/outbox\.test\/#\/batch\//);
    const r = jsonOf(d);
    expect(r.batch.created_by).toBe("agent:mcp-test");
    expect(r.draft.handle).toBe("+14151230001");
    const u = await callTool(c, "outbox_update_draft", { draft_id: r.draft.id, body: "Hey! Coffee Friday at 10?" });
    expect(jsonOf(u).draft.body).toBe("Hey! Coffee Friday at 10?");
    const bad = await callTool(c, "outbox_create_draft", { to: "nonsense", body: "x" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("not a valid phone number");
    const g = await callTool(c, "outbox_get_batch", { id: r.batch.id });
    expect(jsonOf(g).drafts[0].version).toBe(2);
    const l = await callTool(c, "outbox_list_batches", { status: "review" });
    expect(jsonOf(l).batches.some((b: any) => b.id === r.batch.id)).toBe(true);
    // approval can't be smuggled through update
    db.query("UPDATE drafts SET status = 'approved' WHERE id = ?").run(r.draft.id);
    const refused = await callTool(c, "outbox_update_draft", { draft_id: r.draft.id, body: "changed after approval" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("draft_not_editable");
  });

  test("batch with template → submit", async () => {
    const c = await connect();
    const b = await callTool(c, "outbox_create_batch", { title: "Invites", template: "Hi {{first_name|there}}!", items: [{ to: "4151230005", recipient_name: "Joan Doe" }, { to: "4151230006", body: "Custom" }] });
    const r = jsonOf(b);
    expect(r.batch.status).toBe("drafting");
    expect(r.drafts.map((d: any) => d.body)).toEqual(["Hi Joan!", "Custom"]);
    const s = await callTool(c, "outbox_submit_batch", { id: r.batch.id });
    expect(jsonOf(s).batch.status).toBe("review");
  });

  test("ingest (text) → set_mapping → batch_from_import → submit", async () => {
    const c = await connect();
    const i = await callTool(c, "outbox_ingest_file", { text: "Name,Phone,City\nAnn,4151230011,Oslo\nBob,4151230012,Rome\n" });
    expect(i.isError).toBeFalsy();
    const imp = jsonOf(i);
    expect(imp.needs_confirmation).toBe(true);
    const m = await callTool(c, "outbox_set_mapping", { import_id: imp.import_id, fields: { phone: { column: "Phone" } }, vars: { city: "City" } });
    expect(jsonOf(m).needs_confirmation).toBe(false);
    const bad = await callTool(c, "outbox_set_mapping", { import_id: imp.import_id, fields: { phone: { column: "Telephone" } } });
    expect(bad.isError).toBe(true);
    const b = await callTool(c, "outbox_batch_from_import", { import_id: imp.import_id, title: "Hellos", template: "Hi {{first_name}}!", per_row_bodies: { "0": "Ann! Oslo trip?" } });
    const r = jsonOf(b);
    expect(r.drafts.map((d: any) => d.body)).toEqual(["Ann! Oslo trip?", "Hi Bob!"]);
    expect(jsonOf(await callTool(c, "outbox_submit_batch", { id: r.batch.id })).batch.status).toBe("review");
  });

  test("ingest by path reads the file in the MCP process and uploads it", async () => {
    const p = join(tmpDir("outbox-csv-"), "friends.csv");
    await Bun.write(p, "Name,Phone\nCy,4151230021\n");
    const c = await connect();
    const i = await callTool(c, "outbox_ingest_file", { path: p });
    expect(jsonOf(i).filename).toBe("friends.csv");
    expect((await callTool(c, "outbox_ingest_file", { path: join(HOME, "missing.csv") })).isError).toBe(true);
    expect((await callTool(c, "outbox_ingest_file", {})).isError).toBe(true);
  });

  test("sync contacts", async () => {
    const r = await callTool(await connect(), "outbox_sync_contacts");
    expect(jsonOf(r).status).toBe("requested");
  });
});

describe("daemon down", () => {
  test("a missing socket gives a clear error", async () => {
    const c = await connect(join(HOME, "nope.sock"));
    const r = await callTool(c, "outbox_list_batches");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("outboxd isn't running");
  });
  test("a stale socket file (nobody listening) gives the same error", async () => {
    const stale = join(tmpDir("outbox-stale-"), "agent.sock");
    const s = Bun.serve({ unix: stale, fetch: () => new Response("x") });
    void s.stop(true);
    const c = await connect(stale);
    const r = await callTool(c, "outbox_list_batches");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("outboxd isn't running");
  });
});

describe("real stdio launch (the command compose and `claude mcp add` use)", () => {
  test("bun run src/mcp/index.ts speaks MCP over stdio and reaches the socket", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath, args: ["run", join(import.meta.dir, "../src/mcp/index.ts")],
      env: { PATH: process.env.PATH ?? "", OUTBOX_HOME: HOME, OUTBOX_AGENT_SOCKET: sock, OUTBOX_CLIENT: "stdio-test" },
    });
    const client = new Client({ name: "stdio-test", version: "0" });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools).toHaveLength(25);
      const r: any = await client.callTool({ name: "outbox_create_draft", arguments: { to: "4151239999", body: "via stdio" } });
      expect(r.isError).toBeFalsy();
      expect(JSON.parse(r.content[0].text.slice(r.content[0].text.indexOf("{"))).batch.created_by).toBe("agent:stdio-test");
    } finally { await client.close(); }
  });
});
