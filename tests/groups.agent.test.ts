// Saved groups through the agent API, the CLI and the MCP tools. Draft-only: a group batch is an ordinary review batch.
const HOME = (await import("./helpers")).tmpDir("outbox-home-");
process.env.OUTBOX_HOME = HOME;

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { createAgentApp } from "../src/agent-api/app";
import { createAgentClient } from "../src/agent-api/client";
import { main } from "../src/cli";
import { createOutboxMcpServer } from "../src/mcp/server";
import { call, fakeDeps, memDb, seedContact, tmpDir } from "./helpers";

let db: Database;
let app: ReturnType<typeof createAgentApp>;
let state: ReturnType<typeof fakeDeps>["state"];
beforeEach(() => {
  db = memDb();
  const f = fakeDeps(db); state = f.state;
  app = createAgentApp({ db: () => db, deps: async () => f.deps });
});
const H: Record<string, string> = { "X-Outbox-Client": "g-test" };
const api = (method: string, path: string, body?: unknown, headers = H) => call(app, method, path, body, headers);
const people = [{ to: "4151230001", name: "Ann" }, { to: "4151230002", name: "Bo", vars: { city: "Oslo" } }, { to: "cy@x.com", name: "Cy" }];

describe("agent API: groups", () => {
  test("create → 201 with the group, who was added, and an Agent Outbox link; list; get by id and by name", async () => {
    const sam = seedContact(db, { name: "Sam Lee", phones: [{ e164: "+12025550009", label: "mobile" }] });
    const r = await api("POST", "/v1/groups", { name: "Book club", description: "Thursdays", members: [...people, { to: "nope" }], contact_ids: [sam] });
    expect(r.status).toBe(201);
    expect(r.json.group).toMatchObject({ name: "Book club", description: "Thursdays", members: 4, created_by: "agent:g-test" });
    expect(r.json.group.dashboard_url).toBe(`agent-outbox://groups/${r.json.group.id}`);
    expect(r.json.added).toHaveLength(4);
    expect(r.json.invalid).toEqual([{ index: 3, input: "nope", reason: expect.stringContaining("not a valid") }]);

    const list = await api("GET", "/v1/groups");
    expect(list.json.groups).toEqual([{ id: r.json.group.id, name: "Book club", description: "Thursdays", members: 4, updated_at: expect.any(String) }]);

    for (const ref of [r.json.group.id, "book CLUB", encodeURIComponent("Book club")]) {
      const g = await api("GET", `/v1/groups/${ref}`);
      expect(g.status).toBe(200);
      expect(g.json.group.id).toBe(r.json.group.id);
      expect(g.json.members.map((m: any) => m.handle).sort()).toEqual(["+12025550009", "+14151230001", "+14151230002", "cy@x.com"]);
    }
    const g = await api("GET", `/v1/groups/${r.json.group.id}`);
    const sm = g.json.members.find((m: any) => m.handle === "+12025550009");
    expect(sm).toMatchObject({ contact_id: sam, name: "Sam Lee", contact: { display_name: "Sam Lee" } });
    expect(g.json.members.find((m: any) => m.handle === "+14151230002")).toMatchObject({ vars: { city: "Oslo" }, contact: null });
  });

  test("a taken name is 409 group_exists with the id; an unknown group is 404; bad bodies are 400", async () => {
    const a = await api("POST", "/v1/groups", { name: "Book club" });
    const dup = await api("POST", "/v1/groups", { name: "book  CLUB", members: people });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toMatchObject({ code: "group_exists", details: { id: a.json.group.id } });
    expect((await api("GET", "/v1/groups")).json.groups).toHaveLength(1);
    expect((await api("GET", "/v1/groups/nope")).json.error.code).toBe("group_not_found");
    expect((await api("POST", "/v1/groups/nope/members", { members: people })).status).toBe(404);
    expect((await api("POST", "/v1/groups", { name: "x", status: "approved" })).status).toBe(400);
    expect((await api("POST", "/v1/groups", { name: "" })).status).toBe(400);
    expect((await api("POST", "/v1/groups", { name: "y", members: [{ to: "4151230001", sneaky: 1 }] })).status).toBe(400);
  });

  test("a bad import id creates no group", async () => {
    const r = await api("POST", "/v1/groups", { name: "From file", from_import: { import_id: "missing" } });
    expect(r.status).toBe(404);
    expect(db.query("SELECT COUNT(*) AS n FROM contact_groups").get()).toEqual({ n: 0 });
  });

  test("from an import: people with their row vars; invalid and duplicate rows reported", async () => {
    const imp = await api("POST", "/v1/imports", { text: "Name,Phone\nAnn,4151230001\nBo,4151230002\nCy,bad\n", kind: "csv" });
    const id = imp.json.import_id;
    // the fake library keeps rows only as raw cells; give them the normalised shape the real one adds
    const rows = state.imports.get(id).rows;
    rows[0].normalized = { handle: "+14151230001", display_name: "Ann" }; rows[0].match = "new"; rows[0].vars = { first_name: "Ann" };
    rows[1].normalized = { handle: "+14151230002", display_name: "Bo" }; rows[1].match = "new";
    rows[2].normalized = { handle: null, display_name: "Cy" }; rows[2].match = "invalid";
    const r = await api("POST", "/v1/groups", { name: "From file", from_import: { import_id: id } });
    expect(r.status).toBe(201);
    expect(r.json.added.map((x: any) => x.name)).toEqual(["Ann", "Bo"]);
    expect(r.json.invalid).toEqual([{ index: 2, input: "row 2", reason: "no usable phone number or email" }]);
    const only = await api("POST", "/v1/groups/From file/members".replace(" ", "%20"), { from_import: { import_id: id, rows: [1] } });
    expect(only.json).toMatchObject({ added: [], already: [{ handle: "+14151230002" }] });
  });

  test("add members: new ones added, the rest reported", async () => {
    const g = (await api("POST", "/v1/groups", { name: "Book club", members: people.slice(0, 1) })).json.group;
    const r = await api("POST", `/v1/groups/${g.id}/members`, { members: [people[0], people[1], { to: "bad" }] });
    expect(r.status).toBe(200);
    expect(r.json.added.map((x: any) => x.handle)).toEqual(["+14151230002"]);
    expect(r.json.already.map((x: any) => x.handle)).toEqual(["+14151230001"]);
    expect(r.json.invalid).toHaveLength(1);
    expect(r.json.group.members).toBe(2);
  });

  test("remove by handle or contact id; needs at least one", async () => {
    const sam = seedContact(db, { name: "Sam", phones: [{ e164: "+12025550009", label: "mobile" }] });
    const g = (await api("POST", "/v1/groups", { name: "G", members: people, contact_ids: [sam] })).json.group;
    const r = await api("POST", `/v1/groups/${g.id}/remove`, { handles: ["415-123-0001", "zzz"], contact_ids: [sam] });
    expect(r.json.removed.sort()).toEqual(["+12025550009", "+14151230001"]);
    expect(r.json.not_found).toEqual(["zzz"]);
    expect(r.json.group.members).toBe(2);
    expect((await api("POST", `/v1/groups/${g.id}/remove`, {})).status).toBe(400);
  });

  test("patch: rename (409 on a clash), description", async () => {
    const a = (await api("POST", "/v1/groups", { name: "Book club" })).json.group;
    await api("POST", "/v1/groups", { name: "Climbing" });
    const ok = await api("PATCH", "/v1/groups/book club".replace(" ", "%20"), { name: "Readers", description: "d" });
    expect(ok.json.group).toMatchObject({ id: a.id, name: "Readers", description: "d" });
    const clash = await api("PATCH", `/v1/groups/${a.id}`, { name: "climbing" });
    expect(clash.status).toBe(409);
    expect((await api("PATCH", `/v1/groups/${a.id}`, {})).status).toBe(400);
  });

  test("batch: personalised bodies by handle, a template, or both; goes to review like POST /v1/batches", async () => {
    const sam = seedContact(db, { name: "Sam Lee", phones: [{ e164: "+12025550009", label: "mobile" }] });
    const g = (await api("POST", "/v1/groups", { name: "Book club", members: people, contact_ids: [sam] })).json.group;
    const r = await api("POST", `/v1/groups/Book%20club/batch`, {
      title: "Nov 20", template: "Hi {{first_name|there}} from {{city|nowhere}}", bodies: { "(415) 123-0001": "Ann, a special note" }, instructions: "invite",
    });
    expect(r.status).toBe(201);
    expect(r.json.group).toEqual({ id: g.id, name: "Book club" });
    expect(r.json.batch).toMatchObject({ title: "Nov 20", status: "review", created_by: "agent:g-test", source: "mcp", template: "Hi {{first_name|there}} from {{city|nowhere}}" });
    expect(r.json.dashboard_url).toContain("agent-outbox://batch/");
    const bodies = Object.fromEntries(r.json.drafts.map((d: any) => [d.handle, d.body]));
    expect(bodies["+14151230001"]).toBe("Ann, a special note");
    expect(bodies["+14151230002"]).toBe("Hi Bo from Oslo");
    expect(bodies["cy@x.com"]).toBe("Hi Cy from nowhere");
    const samDraft = r.json.drafts.find((d: any) => d.handle === "+12025550009");
    expect(samDraft).toMatchObject({ contact_id: sam, recipient_name: "Sam Lee" });
    expect(r.json.drafts).toHaveLength(4);
    expect(state.lintCalls).toHaveLength(1);
    expect(db.query("SELECT COUNT(*) AS n FROM drafts WHERE status NOT IN ('review')").get()).toEqual({ n: 0 });
  });

  test("batch: only some members, submit=false keeps it drafting, and the checks", async () => {
    await api("POST", "/v1/groups", { name: "G", members: people });
    const some = await api("POST", "/v1/groups/G/batch", { title: "t", template: "hi", only: ["4151230002"], submit: false });
    expect(some.json.batch.status).toBe("drafting");
    expect(some.json.drafts.map((d: any) => d.handle)).toEqual(["+14151230002"]);
    // no template and not every body: refused, nothing created
    const before = (db.query("SELECT COUNT(*) AS n FROM batches").get() as any).n;
    const miss = await api("POST", "/v1/groups/G/batch", { title: "t", bodies: { "4151230001": "x" } });
    expect(miss.status).toBe(400); expect(miss.json.error.code).toBe("missing_body");
    expect(miss.json.error.message).toContain("Bo");
    expect((await api("POST", "/v1/groups/G/batch", { title: "t", template: "hi", only: ["4159999999"] })).json.error.code).toBe("not_in_group");
    expect((await api("POST", "/v1/groups/G/batch", { title: "t", bodies: { "4159999999": "x" }, template: "hi" })).json.error.code).toBe("not_in_group");
    expect((await api("POST", "/v1/groups/G/batch", { title: "t" })).status).toBe(400);
    expect((await api("POST", "/v1/groups/nope/batch", { title: "t", template: "hi" })).status).toBe(404);
    await api("POST", "/v1/groups", { name: "Empty" });
    expect((await api("POST", "/v1/groups/Empty/batch", { title: "t", template: "hi" })).json.error.code).toBe("empty_group");
    expect((db.query("SELECT COUNT(*) AS n FROM batches").get() as any).n).toBe(before);
  });

  test("batch: over 500 people needs `only`", async () => {
    const g = (await api("POST", "/v1/groups", { name: "Big" })).json.group;
    const ins = db.query("INSERT INTO contact_group_members(group_id, handle, name, added_by, added_at) VALUES (?,?,?,?,?)");
    db.transaction(() => { for (let i = 0; i < 501; i++) ins.run(g.id, `+1${2000000000 + i}`, `P${i}`, "x", "t"); })();
    const r = await api("POST", "/v1/groups/Big/batch", { title: "t", template: "hi" });
    expect(r.json.error.code).toBe("too_many_members");
    const ok = await api("POST", "/v1/groups/Big/batch", { title: "t", template: "hi", only: Array.from({ length: 500 }, (_, i) => `+1${2000000000 + i}`) });
    expect(ok.status).toBe(201);
    expect(ok.json.drafts).toHaveLength(500);
  });

  test("a member whose contact was deleted still gets a draft, from the stored handle and name", async () => {
    const ann = seedContact(db, { name: "Ann Lee", phones: [{ e164: "+14155550101", label: "mobile" }] });
    await api("POST", "/v1/groups", { name: "G", contact_ids: [ann] });
    db.query("DELETE FROM contact_handles WHERE contact_id = ?").run(ann);
    db.query("DELETE FROM contacts WHERE id = ?").run(ann);
    const r = await api("POST", "/v1/groups/G/batch", { title: "t", template: "Hi {{full_name}}" });
    expect(r.json.drafts[0]).toMatchObject({ handle: "+14155550101", recipient_name: "Ann Lee", body: "Hi Ann Lee", contact_id: null });
  });

  test("a CLI call records the cli source on the group", async () => {
    const r = await api("POST", "/v1/groups", { name: "G" }, { ...H, "X-Outbox-Source": "cli" });
    expect(r.json.group.created_by).toBe("cli");
  });

  test("nothing about groups approves, sends or deletes: no gated table changes, no delete route", async () => {
    const g = (await api("POST", "/v1/groups", { name: "G", members: people })).json.group;
    await api("POST", `/v1/groups/${g.id}/batch`, { title: "t", template: "hi" });
    expect((await api("DELETE", `/v1/groups/${g.id}`)).status).toBe(404);
    for (const p of [`/v1/groups/${g.id}/approve`, `/v1/groups/${g.id}/send`]) expect((await api("POST", p, {})).status).toBe(404);
    expect(db.query("SELECT COUNT(*) AS n FROM drafts WHERE status IN ('approved','sending','sent')").get()).toEqual({ n: 0 });
    for (const t of ["approvals", "sends", "passkeys", "sessions"]) expect(db.query(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    expect((db.query("SELECT COUNT(*) AS n FROM contact_groups").get() as any).n).toBe(1);
  });
});

describe("CLI: outbox groups", () => {
  async function run(args: string[], stdin = "") {
    const out: string[] = []; const err: string[] = [];
    const client = createAgentClient({ client: "cli-test", source: "cli", fetchImpl: (url, init) => Promise.resolve(app.fetch(new Request(url, init))) });
    const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s), readStdin: async () => stdin, client });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  test("create (members from stdin), list, show, add, remove, rename", async () => {
    const c = await run(["groups", "create", "Book", "club", "--description", "Thursdays", "--members", "-"], JSON.stringify(people.slice(0, 2)));
    expect(c.code).toBe(0);
    expect(c.out).toContain("Book club");
    expect(c.out).toContain("added 2, already in the group 0, not added 0");
    expect((await run(["groups", "list"])).out).toMatch(/Book club {2}\(2 people\) {2}Thursdays/);
    const show = await run(["groups", "show", "book club"]);
    expect(show.out).toContain("Ann <+14151230001>");
    expect(show.out).toContain("(not in contacts)");
    const add = await run(["groups", "add", "Book club", "--members", "-"], JSON.stringify([people[1], people[2], { to: "bad" }]));
    expect(add.out).toContain("added 1, already in the group 1, not added 1");
    expect(add.out).toContain("not added: bad");
    const rm = await run(["groups", "remove", "Book club", "--handles", "4151230001,cy@x.com"]);
    expect(rm.out).toContain("removed 2");
    const rn = await run(["groups", "rename", "Book club", "Readers", "--json"]);
    expect(JSON.parse(rn.out).group.name).toBe("Readers");
    expect((await run(["groups", "list", "--json"])).out).toContain("Readers");
  });

  test("create from a contact list and add by --contacts", async () => {
    const a = seedContact(db, { name: "Ann", phones: [{ e164: "+14155550101", label: "mobile" }] });
    const b = seedContact(db, { name: "Bea", phones: [{ e164: "+14155550102", label: "mobile" }] });
    const r = await run(["groups", "create", "Two", "--contacts", `${a}`]);
    expect(r.out).toContain("added 1");
    expect((await run(["groups", "add", "Two", "--contacts", `${a},${b}`])).out).toContain("added 1, already in the group 1");
  });

  test("batch from bodies on stdin or a template, and the usage errors", async () => {
    await run(["groups", "create", "G", "--members", "-"], JSON.stringify(people));
    const t = await run(["groups", "batch", "G", "--title", "T", "--template", "Hi {{first_name|there}}", "--only", "4151230001"]);
    expect(t.code).toBe(0);
    expect(t.out).toContain("[review]");
    expect(t.out).toContain("+14151230001");
    const b = await run(["groups", "batch", "G", "--title", "T2", "--bodies", "-", "--no-submit", "--json"], JSON.stringify({ "4151230001": "a", "4151230002": "b", "cy@x.com": "c" }));
    expect(JSON.parse(b.out).batch.status).toBe("drafting");
    expect((await run(["groups", "batch", "G", "--title", "x"])).code).toBe(2);
    expect((await run(["groups", "show"])).code).toBe(2);
    expect((await run(["groups", "remove", "G"])).code).toBe(2);
    expect((await run(["groups", "add", "G"])).code).toBe(2);
    expect((await run(["groups", "frob"])).code).toBe(2);
    expect((await run(["groups", "delete", "G"])).code).toBe(2); // no delete verb
    const missing = await run(["groups", "show", "nope"]);
    expect(missing.code).toBe(1); expect(missing.err).toContain("group_not_found");
  });
});

describe("MCP: group tools", () => {
  let server: ReturnType<typeof Bun.serve>; let sock: string; let mdb: Database;
  beforeAll(() => {
    mdb = memDb();
    const { deps } = fakeDeps(mdb);
    const a = createAgentApp({ db: () => mdb, deps: async () => deps });
    sock = join(tmpDir("outbox-sock-"), "agent.sock");
    server = Bun.serve({ unix: sock, fetch: a.fetch });
  });
  afterAll(() => { void server.stop(true); });
  async function connect() {
    const mcp = createOutboxMcpServer({ socketPath: sock, label: "mcp-test" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([mcp.connect(a), client.connect(b)]);
    return client;
  }
  const textOf = (r: any): string => r.content.map((c: any) => c.text).join("\n");
  const jsonOf = (r: any) => JSON.parse(textOf(r).slice(textOf(r).indexOf("{")));
  const tool = async (c: Client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args }) as Promise<any>;

  test("the six tools exist with short descriptions; none can delete, approve or send", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    const names = ["outbox_list_groups", "outbox_get_group", "outbox_create_group", "outbox_add_to_group", "outbox_update_group", "outbox_batch_from_group"];
    for (const n of names) {
      const t = tools.find((x) => x.name === n)!;
      expect(t).toBeDefined();
      expect(t.description!.length).toBeGreaterThan(40);
    }
    expect(tools.some((t) => /delete_group|remove_group/.test(t.name))).toBe(false);
    for (const n of ["outbox_list_groups", "outbox_get_group"]) expect(tools.find((t) => t.name === n)!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "outbox_batch_from_group")!.description).toContain("personalised");
  });

  test("create, add, get, update (rename + remove), batch, list, by name", async () => {
    const c = await connect();
    expect(jsonOf(await tool(c, "outbox_list_groups")).groups).toEqual([]);
    const made = jsonOf(await tool(c, "outbox_create_group", { name: "Climbing", description: "Tuesday crew", members: [{ to: "4151230001", name: "Ann" }] }));
    expect(made.group.members).toBe(1);
    const dup = await tool(c, "outbox_create_group", { name: "climbing" });
    expect(dup.isError).toBe(true); expect(textOf(dup)).toContain("group_exists");
    const add = jsonOf(await tool(c, "outbox_add_to_group", { group: "climbing", members: [{ to: "4151230002", name: "Bo" }, { to: "4151230003", name: "Cy" }] }));
    expect(add.added).toHaveLength(2);
    const got = jsonOf(await tool(c, "outbox_get_group", { group: "CLIMBING" }));
    expect(got.members.map((m: any) => m.name).sort()).toEqual(["Ann", "Bo", "Cy"]);
    const upd = jsonOf(await tool(c, "outbox_update_group", { group: "Climbing", name: "Crew", remove_members: ["4151230003"] }));
    expect(upd.group).toMatchObject({ name: "Crew", members: 2 });
    expect(upd.removed).toEqual(["+14151230003"]);
    // giving the group's own name again is not a clash with itself
    expect(jsonOf(await tool(c, "outbox_update_group", { group: "Crew", name: "Crew", remove_members: ["4151230001"] })).group.members).toBe(1);
    expect((await tool(c, "outbox_update_group", { group: "Crew" })).isError).toBe(true);
    const batch = await tool(c, "outbox_batch_from_group", { group: "crew", title: "Climb", bodies: { "4151230002": "Bo, climbing at 6?" } });
    expect(textOf(batch)).toContain('Batch "Climb"');
    expect(jsonOf(batch).drafts.map((d: any) => d.body)).toEqual(["Bo, climbing at 6?"]);
    expect(jsonOf(await tool(c, "outbox_list_groups")).groups[0]).toMatchObject({ name: "Crew", members: 1 });
    expect((await tool(c, "outbox_get_group", { group: "nope" })).isError).toBe(true);
  });

  test("a rename onto another group's name is refused and removes nobody", async () => {
    const c = await connect();
    await tool(c, "outbox_create_group", { name: "One", members: [{ to: "4151230011" }, { to: "4151230012" }] });
    await tool(c, "outbox_create_group", { name: "Two" });
    const r = await tool(c, "outbox_update_group", { group: "One", name: "two", remove_members: ["4151230011"] });
    expect(r.isError).toBe(true);
    expect(jsonOf(await tool(c, "outbox_get_group", { group: "One" })).group.members).toBe(2);
  });
});
