import { beforeEach, describe, expect, test } from "bun:test";
import { createAgentApp } from "../src/agent-api/app";
import { call, fakeDeps, memDb, seedContact, type FakeState } from "./helpers";
import type { Database } from "bun:sqlite";

let db: Database; let app: ReturnType<typeof createAgentApp>; let st: FakeState;
const ORIGIN = "https://outbox.test";
beforeEach(() => {
  db = memDb();
  const f = fakeDeps(db); st = f.state;
  app = createAgentApp({ db: () => db, deps: async () => f.deps, origin: ORIGIN });
});
const H = { "X-Outbox-Client": "unit test!" };

describe("single drafts", () => {
  test("normalises `to`, creates a one-draft batch in review, lints, returns dashboard_url", async () => {
    const r = await call(app, "POST", "/v1/drafts", { to: "(555) 123-4567".replace("555", "415"), body: "Hey, free Friday?" }, H);
    expect(r.status).toBe(201);
    expect(r.json.batch.status).toBe("review");
    expect(r.json.batch.created_by).toBe("agent:unittest");
    expect(r.json.batch.source).toBe("mcp");
    expect(r.json.draft.handle).toBe("+14151234567");
    expect(r.json.draft.status).toBe("review");
    expect(r.json.dashboard_url).toBe(`${ORIGIN}/#/batch/${r.json.batch.id}`);
    expect(st.lintCalls).toEqual([r.json.batch.id]);
    const rev = db.query("SELECT actor, version FROM draft_revisions").all() as any[];
    expect(rev).toEqual([{ actor: "agent", version: 1 }]);
  });

  test("rejects invalid handles with a clear JSON error and creates nothing", async () => {
    const r = await call(app, "POST", "/v1/drafts", { to: "banana", body: "hi" });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("invalid_items");
    expect(r.json.error.message).toContain("banana");
    expect(db.query("SELECT COUNT(*) AS n FROM batches").get()).toEqual({ n: 0 });
  });

  test("needs a recipient and a body", async () => {
    expect((await call(app, "POST", "/v1/drafts", { body: "hi" })).json.error.message).toContain("to (a phone number or email) or contact_id");
    const r = await call(app, "POST", "/v1/drafts", { to: "4151234567" });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("validation_error");
    expect((await call(app, "POST", "/v1/drafts", { to: "4151234567", body: "x", service: "WhatsApp" })).status).toBe(400);
  });

  test("malformed JSON is a clean 400", async () => {
    const res = await app.fetch(new Request("http://outbox/v1/drafts", { method: "POST", body: "{nope" }));
    expect(res.status).toBe(400);
    expect((await res.json() as any).error.code).toBe("invalid_json");
  });

  test("contact_id: first mobile phone, else first phone, else first email", async () => {
    const both = seedContact(db, { name: "Mia Mobile", phones: [{ e164: "+12025550001", label: "home" }, { e164: "+12025550002", label: "_$!<Mobile>!$_" }], emails: ["mia@x.com"] });
    const homeOnly = seedContact(db, { name: "Hal Home", phones: [{ e164: "+12025550003", label: "home" }, { e164: "+12025550004", label: "work" }] });
    const mailOnly = seedContact(db, { name: "Eve Mail", emails: ["Eve@Example.com"] });
    const none = seedContact(db, { name: "Nobody" });
    const to = async (id: string) => (await call(app, "POST", "/v1/drafts", { contact_id: id, body: "yo" }));
    const a = await to(both); expect(a.json.draft.handle).toBe("+12025550002"); expect(a.json.draft.recipient_name).toBe("Mia Mobile"); expect(a.json.draft.contact_id).toBe(both);
    expect((await to(homeOnly)).json.draft.handle).toBe("+12025550003");
    expect((await to(mailOnly)).json.draft.handle).toBe("eve@example.com");
    const n = await to(none); expect(n.status).toBe(400); expect(n.json.error.message).toContain("no phone number or email");
    const missing = await to("missing-id"); expect(missing.status).toBe(400); expect(missing.json.error.message).toContain("contact missing-id not found");
  });

  test("`to` that matches exactly one contact attaches it; a mismatching contact_id is refused", async () => {
    const id = seedContact(db, { name: "Sam Lee", phones: [{ e164: "+12025550009", label: "mobile" }] });
    const r = await call(app, "POST", "/v1/drafts", { to: "202-555-0009", body: "hi" });
    expect(r.json.draft.contact_id).toBe(id);
    expect(r.json.draft.recipient_name).toBe("Sam Lee");
    const bad = await call(app, "POST", "/v1/drafts", { to: "202-555-0100", contact_id: id, body: "hi" });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toContain("is not a number or email of contact Sam Lee");
  });

  test("warnings from lint come back flattened", async () => {
    const r = await call(app, "POST", "/v1/drafts", { to: "4151234567", body: "Hi {{first_name}}" });
    expect(r.json.warnings).toEqual([expect.objectContaining({ code: "unresolved_var", draft_id: r.json.draft.id })]);
  });
});

describe("batches", () => {
  test("create with items starts drafting; submit moves to review; relints", async () => {
    const r = await call(app, "POST", "/v1/batches", { title: "Dinner", items: [{ to: "4151230001", body: "a" }, { to: "ann@x.com", body: "b", service: "iMessage", notes: "close friend" }] });
    expect(r.status).toBe(201);
    expect(r.json.batch.status).toBe("drafting");
    expect(r.json.drafts.map((d: any) => d.handle)).toEqual(["+14151230001", "ann@x.com"]);
    expect(r.json.next_step).toContain("submit");
    const id = r.json.batch.id;
    const s = await call(app, "POST", `/v1/batches/${id}/submit`);
    expect(s.status).toBe(200);
    expect(s.json.batch.status).toBe("review");
    expect(s.json.dashboard_url).toBe(`${ORIGIN}/#/batch/${id}`);
    // idempotent while in review, refused once past it
    expect((await call(app, "POST", `/v1/batches/${id}/submit`)).status).toBe(200);
    db.query("UPDATE batches SET status = 'approved' WHERE id = ?").run(id);
    const late = await call(app, "POST", `/v1/batches/${id}/submit`);
    expect(late.status).toBe(409);
    expect(late.json.error.code).toBe("not_submittable");
  });

  test("submit:true goes straight to review; empty batches can't be submitted", async () => {
    expect((await call(app, "POST", "/v1/batches", { title: "x", items: [{ to: "4151230001", body: "a" }], submit: true })).json.batch.status).toBe("review");
    expect((await call(app, "POST", "/v1/batches", { title: "x", submit: true })).status).toBe(400);
    const empty = await call(app, "POST", "/v1/batches", { title: "x" });
    expect((await call(app, "POST", `/v1/batches/${empty.json.batch.id}/submit`)).json.error.code).toBe("empty_batch");
  });

  test("items are all-or-nothing and errors name the item", async () => {
    const r = await call(app, "POST", "/v1/batches", { title: "x", items: [{ to: "4151230001", body: "ok" }, { to: "nope", body: "bad" }, { body: "no recipient" }] });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("invalid_items");
    expect(r.json.error.details.map((e: any) => e.index)).toEqual([1, 2]);
    expect(db.query("SELECT COUNT(*) AS n FROM batches").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM drafts").get()).toEqual({ n: 0 });
  });

  test("template rendering for items without a body, with standard and custom vars", async () => {
    const id = seedContact(db, { name: "Sam Lee", given: "Sam", family: "Lee", org: "Acme", phones: [{ e164: "+12025550009", label: "mobile" }] });
    const r = await call(app, "POST", "/v1/batches", {
      title: "T", template: "Hi {{first_name|there}} from {{org}}, see you in {{city}}!",
      items: [{ contact_id: id, vars: { city: "Boston" } }, { to: "4151230001", recipient_name: "Joe Roe", vars: { city: 7 } }, { to: "4151230002", body: "custom text" }],
    });
    expect(r.status).toBe(201);
    expect(r.json.drafts[0].body).toBe("Hi Sam from Acme, see you in Boston!");
    expect(r.json.drafts[1].body).toBe("Hi Joe from , see you in 7!");
    expect(r.json.drafts[2].body).toBe("custom text");
    expect(r.json.drafts[0].vars).toEqual({ city: "Boston" });
    // no body and no template is an error
    const bad = await call(app, "POST", "/v1/batches", { title: "x", items: [{ to: "4151230001" }] });
    expect(bad.json.error.message).toContain("no body and no batch template");
  });

  test("proposed_contact is normalised and offered for creation; known contacts ignore it", async () => {
    const r = await call(app, "POST", "/v1/batches", { title: "x", items: [{ body: "hi", proposed_contact: { given_name: "New", family_name: "Person", phones: ["415 123 0003"], emails: ["N@X.com"] } }] });
    expect(r.status).toBe(201);
    const d = r.json.drafts[0];
    expect(d.handle).toBe("+14151230003");
    expect(d.recipient_name).toBe("New Person");
    expect(d.create_contact).toBe(true);
    expect(d.proposed_contact.phones[0].e164).toBe("+14151230003");
    expect(d.proposed_contact.emails).toEqual([]); // contract v2 §4: exactly the draft's handle, extra handles are dropped
    const bad = await call(app, "POST", "/v1/batches", { title: "x", items: [{ to: "4151230001", body: "hi", proposed_contact: { phones: ["zzz"] } }] });
    expect(bad.status).toBe(400);
  });

  test("add items only while drafting", async () => {
    const b = await call(app, "POST", "/v1/batches", { title: "x" });
    const id = b.json.batch.id;
    const a = await call(app, "POST", `/v1/batches/${id}/items`, { items: [{ to: "4151230001", body: "a" }] });
    expect(a.status).toBe(201); expect(a.json.drafts).toHaveLength(1);
    await call(app, "POST", `/v1/batches/${id}/submit`);
    const late = await call(app, "POST", `/v1/batches/${id}/items`, { items: [{ to: "4151230001", body: "a" }] });
    expect(late.status).toBe(409); expect(late.json.error.code).toBe("batch_not_drafting");
    expect((await call(app, "POST", "/v1/batches/nope/items", { items: [{ to: "4151230001", body: "a" }] })).status).toBe(404);
  });

  test("list filters by status; get includes drafts and send results", async () => {
    const a = await call(app, "POST", "/v1/batches", { title: "A", items: [{ to: "4151230001", body: "a" }], submit: true });
    await call(app, "POST", "/v1/batches", { title: "B" });
    expect((await call(app, "GET", "/v1/batches")).json.batches).toHaveLength(2);
    const rev = await call(app, "GET", "/v1/batches?status=review");
    expect(rev.json.batches.map((b: any) => b.title)).toEqual(["A"]);
    expect(rev.json.batches[0].draft_count).toBe(1);
    expect((await call(app, "GET", "/v1/batches?status=bogus")).status).toBe(400);
    // simulate an executor result
    const d = a.json.drafts[0];
    db.query("INSERT INTO approvals(id,batch_id,manifest,manifest_sha256,credential_id,authenticator_data_b64,client_data_json_b64,signature_b64,not_after,created_at) VALUES ('ap',?,'{}','x','c','a','b','s','2099','2026')").run(a.json.batch.id);
    db.query("INSERT INTO sends(id,draft_id,approval_id,attempt,transport,started_at,finished_at,result) VALUES ('s1',?,'ap',1,'dry','t','t','sent')").run(d.id);
    const got = await call(app, "GET", `/v1/batches/${a.json.batch.id}`);
    expect(got.json.drafts[0].sends).toEqual([expect.objectContaining({ result: "sent", transport: "dry" })]);
    expect((await call(app, "GET", "/v1/batches/nope")).json.error.code).toBe("batch_not_found");
  });
});

describe("PATCH /v1/drafts/:id", () => {
  test("edits a body, keeps a revision, relints; same body is a no-op", async () => {
    const r = await call(app, "POST", "/v1/drafts", { to: "4151230001", body: "first" });
    const id = r.json.draft.id;
    const p = await call(app, "PATCH", `/v1/drafts/${id}`, { body: "second {{x}}" });
    expect(p.status).toBe(200);
    expect(p.json.draft.body).toBe("second {{x}}");
    expect(p.json.draft.version).toBe(2);
    expect(p.json.warnings[0].code).toBe("unresolved_var");
    expect((db.query("SELECT COUNT(*) AS n FROM draft_revisions WHERE draft_id = ?").get(id) as any).n).toBe(2);
    const same = await call(app, "PATCH", `/v1/drafts/${id}`, { body: "second {{x}}" });
    expect(same.json.draft.version).toBe(2);
  });

  test("refused once approved, sending, sent, failed or unknown; and on a cancelled batch", async () => {
    const r = await call(app, "POST", "/v1/drafts", { to: "4151230001", body: "first" });
    const id = r.json.draft.id;
    for (const s of ["approved", "sending", "sent", "failed", "unknown", "rejected"]) {
      db.query("UPDATE drafts SET status = ? WHERE id = ?").run(s, id);
      const p = await call(app, "PATCH", `/v1/drafts/${id}`, { body: "sneaky" });
      expect(p.status).toBe(409);
      expect(p.json.error.code).toBe("draft_not_editable");
    }
    expect((db.query("SELECT body FROM drafts WHERE id = ?").get(id) as any).body).toBe("first");
    db.query("UPDATE drafts SET status = 'review' WHERE id = ?").run(id);
    expect((await call(app, "PATCH", `/v1/drafts/${id}`, { body: "   " })).status).toBe(400);
    db.query("UPDATE batches SET status = 'cancelled'").run();
    expect((await call(app, "PATCH", `/v1/drafts/${id}`, { body: "x" })).json.error.code).toBe("batch_cancelled");
    expect((await call(app, "PATCH", "/v1/drafts/none", { body: "x" })).status).toBe(404);
  });
});

describe("contacts", () => {
  test("search by name, org, tag, phone digits, email; ANDed terms; notes stripped; LIKE chars escaped", async () => {
    seedContact(db, { name: "Sam Lee", org: "Acme Robotics", tags: ["climbing"], phones: [{ e164: "+12025550009", label: "mobile" }], emails: ["sam@lee.io"] });
    seedContact(db, { name: "Samantha Fox", phones: [{ e164: "+13035550123", label: "home" }] });
    seedContact(db, { name: "100% Joe" });
    const q = async (s: string) => (await call(app, "GET", `/v1/contacts?q=${encodeURIComponent(s)}`)).json.contacts.map((c: any) => c.display_name);
    expect(await q("sam")).toEqual(["Sam Lee", "Samantha Fox"]);
    expect(await q("sam lee")).toEqual(["Sam Lee"]);
    expect(await q("robotics")).toEqual(["Sam Lee"]);
    expect(await q("climbing")).toEqual(["Sam Lee"]);
    expect(await q("(303) 555-0123")).toEqual(["Samantha Fox"]);
    expect(await q("lee.io")).toEqual(["Sam Lee"]);
    expect(await q("100%")).toEqual(["100% Joe"]);
    expect(await q("%")).toEqual(["100% Joe"]);
    expect(await q("")).toHaveLength(3);
    const first = (await call(app, "GET", "/v1/contacts?q=sam&limit=1")).json.contacts;
    expect(first).toHaveLength(1);
    expect(first[0].notes).toBeUndefined();
    expect(first[0].preferred_handle).toBe("+12025550009");
  });

  test("get one; 404", async () => {
    const id = seedContact(db, { name: "Sam Lee", phones: [{ e164: "+12025550009", label: "mobile" }] });
    expect((await call(app, "GET", `/v1/contacts/${id}`)).json.contact.display_name).toBe("Sam Lee");
    expect((await call(app, "GET", "/v1/contacts/zzz")).status).toBe(404);
  });

  test("sync inserts an exec_requests row, reuses a fresh pending one, warns without an executor", async () => {
    const a = await call(app, "POST", "/v1/contacts/sync");
    expect(a.status).toBe(202);
    expect(a.json.warning).toContain("no recent heartbeat");
    const b = await call(app, "POST", "/v1/contacts/sync");
    expect(b.json.request_id).toBe(a.json.request_id); expect(b.json.reused).toBe(true);
    expect(db.query("SELECT kind, done_at FROM exec_requests").all()).toEqual([{ kind: "contacts_export", done_at: null }]);
    db.query("INSERT INTO exec_status(id, heartbeat_at, version, transport, pin_file_ok) VALUES (1, ?, '1', 'dry', 0)").run(new Date().toISOString());
    db.query("UPDATE exec_requests SET done_at = 'x'").run();
    const c = await call(app, "POST", "/v1/contacts/sync");
    expect(c.json.warning).toBeUndefined();
    const s = await call(app, "GET", "/v1/status");
    expect(s.json.executor.alive).toBe(true);
    expect(s.json.kill_switch).toBe(false);
  });
});

describe("imports", () => {
  test("ingest from text and base64, path; mapping merges; batch from import", async () => {
    const t = await call(app, "POST", "/v1/imports", { text: "Name,Phone,City\nAnn,4151230001,Oslo\nBob,4151230002,Rome\n", kind: "csv" }, H);
    expect(t.status).toBe(201);
    expect(t.json.import_id).toBeTruthy();
    expect(t.json.dashboard_url).toContain("/#/imports/");
    expect(st.ingested[0].filename).toBe("pasted.csv");
    expect(st.ingested[0].created_by).toBe("agent:unittest");
    const id = t.json.import_id;

    const g = await call(app, "GET", `/v1/imports/${id}?limit=1`);
    expect(g.json.rows).toHaveLength(1); expect(g.json.rows_total).toBe(2);
    expect((await call(app, "GET", "/v1/imports/none")).status).toBe(404);

    // mapping: fields merge with existing, unknown column rejected, null unmaps, vars set, confirmed defaults true
    const bad = await call(app, "PUT", `/v1/imports/${id}/mapping`, { fields: { phone: { column: "Nope" } } });
    expect(bad.status).toBe(400); expect(bad.json.error.message).toContain("Columns: Name, Phone, City");
    expect((await call(app, "PUT", `/v1/imports/${id}/mapping`, { fields: { height: { column: "City" } } })).status).toBe(400);
    const m = await call(app, "PUT", `/v1/imports/${id}/mapping`, { fields: { org: { column: "City" } }, vars: { city: "City" } });
    expect(m.status).toBe(200);
    const sent = st.mappings.at(-1);
    expect(sent.fields.given_name.column).toBe("Name");
    expect(sent.fields.org).toEqual({ column: "City", confidence: 1 });
    expect(sent.vars).toEqual({ city: "City" });
    expect(sent.confirmed).toBe(true);
    await call(app, "PUT", `/v1/imports/${id}/mapping`, { fields: { org: null } });
    expect(st.mappings.at(-1).fields.org).toBeUndefined();
    expect(st.mappings.at(-1).vars).toEqual({ city: "City" });

    const b = await call(app, "POST", `/v1/imports/${id}/batch`, { title: "Invites", template: "Hi {{first_name|there}}!", per_row_bodies: { "1": "Bob, long time!" } }, H);
    expect(b.status).toBe(201);
    expect(b.json.drafts_created).toBe(2);
    expect(b.json.drafts.map((d: any) => d.body)).toEqual(["Hi Ann!", "Bob, long time!"]);
    expect(b.json.batch.status).toBe("drafting");
    expect(b.json.batch.created_by).toBe("agent:unittest");
    expect(b.json.dashboard_url).toContain("/#/batch/");
    const b2 = await call(app, "POST", `/v1/imports/${id}/batch`, { title: "Invites", template: "Hi {{first_name}}", submit: true });
    expect(b2.json.batch.status).toBe("review");
    expect((await call(app, "POST", `/v1/imports/${id}/batch`, { title: "x", template: "y", per_row_bodies: { a: "b" } })).status).toBe(400);
    expect((await call(app, "POST", "/v1/imports/none/batch", { title: "x", template: "y" })).status).toBe(404);
  });

  test("ingest input validation, base64 and file path", async () => {
    expect((await call(app, "POST", "/v1/imports", {})).status).toBe(400);
    expect((await call(app, "POST", "/v1/imports", { text: "a", path: "/x" })).status).toBe(400);
    expect((await call(app, "POST", "/v1/imports", { base64: "YQ==" })).json.error.message).toContain("filename");
    const b = await call(app, "POST", "/v1/imports", { base64: Buffer.from("N,P\nA,4151230001\n").toString("base64"), filename: "x.csv" });
    expect(b.status).toBe(201);
    expect((await call(app, "POST", "/v1/imports", { path: "relative.csv" })).status).toBe(400);
    expect((await call(app, "POST", "/v1/imports", { path: "/definitely/not/here.csv" })).status).toBe(404);
    const dir = (await import("./helpers")).tmpDir();
    const p = `${dir}/people.csv`;
    await Bun.write(p, "N,P\nA,4151230001\n");
    const f = await call(app, "POST", "/v1/imports", { path: p });
    expect(f.status).toBe(201);
    expect(f.json.filename).toBe("people.csv");
    expect((await call(app, "POST", "/v1/imports", { path: dir })).status).toBe(400);
  });
});

describe("misc", () => {
  test("unknown routes are JSON 404s that say there is no send", async () => {
    const r = await call(app, "POST", "/v1/batches/x/send");
    expect(r.status).toBe(404);
    expect(r.json.error.message).toContain("no approve or send routes");
  });
  test("client label is sanitised; source header is limited to mcp|cli", async () => {
    const r = await call(app, "POST", "/v1/drafts", { to: "4151230001", body: "x" }, { "X-Outbox-Client": "ev/il;label", "X-Outbox-Source": "dashboard" });
    expect(r.json.batch.created_by).toBe("agent:evillabel");
    expect(r.json.batch.source).toBe("mcp");
    const c = await call(app, "POST", "/v1/drafts", { to: "4151230001", body: "x" }, { "X-Outbox-Source": "compose" });
    expect(c.json.batch.source).toBe("mcp");
    expect(c.json.batch.created_by).toBe("agent:unknown");
    expect((db.query("SELECT actor FROM draft_revisions ORDER BY rowid DESC LIMIT 1").get() as any).actor).toBe("agent");
    const l = await call(app, "POST", "/v1/drafts", { to: "4151230001", body: "x" }, { "X-Outbox-Source": "cli" });
    expect(l.json.batch.source).toBe("cli");
  });
  test("health", async () => { expect((await call(app, "GET", "/v1/health")).json.ok).toBe(true); });
});
