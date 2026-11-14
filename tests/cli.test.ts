import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { createAgentApp } from "../src/agent-api/app";
import { createAgentClient } from "../src/agent-api/client";
import { main } from "../src/cli";
import { fakeDeps, memDb, seedContact, tmpDir } from "./helpers";

let db: Database;
let app: ReturnType<typeof createAgentApp>;

beforeEach(() => {
  db = memDb();
  const { deps } = fakeDeps(db);
  app = createAgentApp({ db: () => db, deps: async () => deps, origin: "https://outbox.test" });
});

async function run(args: string[], stdin = "") {
  const out: string[] = []; const err: string[] = [];
  const client = createAgentClient({ client: "cli-test", source: "cli", fetchImpl: (url, init) => Promise.resolve(app.fetch(new Request(url, init))) });
  const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s), readStdin: async () => stdin, client });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("outbox CLI", () => {
  test("draft --json returns the API response and attributes the cli source", async () => {
    const r = await run(["draft", "--to", "415 123 0001", "--body", "hi there", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.draft.handle).toBe("+14151230001");
    expect(j.batch.source).toBe("cli");
    expect(j.batch.created_by).toBe("agent:cli-test");
  });

  test("draft human output, body from stdin, contact lookup", async () => {
    const id = seedContact(db, { name: "Sam Lee", phones: [{ e164: "+12025550009", label: "mobile" }] });
    const r = await run(["draft", "--contact", id, "--body-file", "-"], "from stdin\n");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Sam Lee <+12025550009>");
    expect(r.out).toContain("from stdin");
    expect(r.out).toContain("dashboard: https://outbox.test/#/batch/");
  });

  test("batch create from an items file, show, list, submit", async () => {
    const f = join(tmpDir(), "items.json");
    await Bun.write(f, JSON.stringify([{ to: "4151230001", body: "a" }, { to: "4151230002", body: "b" }]));
    const c = await run(["batch", "create", "--title", "Two", "--items", f, "--json"]);
    expect(c.code).toBe(0);
    const id = JSON.parse(c.out).batch.id;
    expect((await run(["batch", "show", id])).out).toContain("[drafting]");
    expect((await run(["batch", "list", "--status", "drafting"])).out).toContain("2 draft(s)  Two");
    const s = await run(["batch", "submit", id]);
    expect(s.code).toBe(0);
    expect(s.out).toContain("[review]");
    expect((await run(["batch", "list", "--status", "drafting"])).out).toBe("no batches");
  });

  test("items from stdin as { items: [...] } with a template", async () => {
    const r = await run(["batch", "create", "--title", "T", "--template", "Hi {{first_name|there}}", "--items", "-", "--submit", "--json"], JSON.stringify({ items: [{ to: "4151230001", recipient_name: "Joan Doe" }] }));
    expect(JSON.parse(r.out).drafts[0].body).toBe("Hi Joan");
  });

  test("edit a draft", async () => {
    const d = JSON.parse((await run(["draft", "--to", "4151230001", "--body", "one", "--json"])).out);
    const e = await run(["edit", d.draft.id, "--body", "two"]);
    expect(e.code).toBe(0);
    expect(e.out).toContain("updated (v2)");
  });

  test("import (file and stdin), mapping flags, import batch", async () => {
    const f = join(tmpDir(), "p.csv");
    await Bun.write(f, "Name,Phone,City\nAnn,4151230001,Oslo\n");
    const i = await run(["import", f, "--json"]);
    expect(i.code).toBe(0);
    const id = JSON.parse(i.out).import_id;
    const m = await run(["mapping", id, "--set", "phone=Phone", "--var", "city=City"]);
    expect(m.code).toBe(0);
    expect(m.out).toContain("phone<-Phone");
    expect(m.out).toContain("{{city}}");
    expect((await run(["mapping", id, "--set", "bogus"])).code).toBe(2);
    expect((await run(["import", "show", id])).out).toContain(`import ${id}`);
    const b = await run(["import", "batch", id, "--template", "Hi {{first_name}}", "--title", "X", "--submit"]);
    expect(b.code).toBe(0);
    expect(b.out).toContain("Hi Ann");
    const p = await run(["import", "-", "--kind", "csv", "--json"], "N,P\nBo,4151230009\n");
    expect(JSON.parse(p.out).filename).toBe("pasted.csv");
  });

  test("contacts search/show, sync-contacts, status", async () => {
    const id = seedContact(db, { name: "Sam Lee", phones: [{ e164: "+12025550009", label: "mobile" }], tags: ["fam"] });
    expect((await run(["contacts", "search", "sam", "lee"])).out).toContain(`${id}  Sam Lee`);
    expect((await run(["contacts", "search", "zzzz"])).out).toBe("no contacts found");
    expect(JSON.parse((await run(["contacts", "show", id])).out).display_name).toBe("Sam Lee");
    expect((await run(["sync-contacts"])).out).toContain("executor will export");
    const s = await run(["status"]);
    expect(s.out).toContain("executor: NOT running");
    expect(s.out).toContain("kill switch: off");
  });

  test("errors: API errors exit 1, usage errors exit 2, unknown (and send) commands exit 2", async () => {
    const bad = await run(["draft", "--to", "banana", "--body", "x"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("invalid_items");
    expect(JSON.parse((await run(["draft", "--to", "banana", "--body", "x", "--json"])).err).error.code).toBe("invalid_items");
    expect((await run(["draft", "--to", "4151230001"])).code).toBe(2);
    expect((await run(["batch"])).code).toBe(2);
    const s = await run(["send", "abc"]);
    expect(s.code).toBe(2);
    expect(s.err).toContain("no send or approve command");
    expect((await run(["approve", "abc"])).code).toBe(2);
    expect((await run(["draft", "--nope"])).code).toBe(2);
  });

  test("help lists commands and says nothing sends", async () => {
    const r = await run(["help"]);
    expect(r.out).toContain("Nothing here sends");
    expect(r.out).toContain("{{first_name|there}}");
  });

  test("daemon down exits 3 with a clear message", async () => {
    const out: string[] = []; const err: string[] = [];
    const client = createAgentClient({ client: "cli-test", source: "cli", socketPath: join(tmpDir(), "none.sock") });
    const code = await main(["status"], { out: (s) => out.push(s), err: (s) => err.push(s), client });
    expect(code).toBe(3);
    expect(err.join()).toContain("outboxd isn't running");
  });
});
