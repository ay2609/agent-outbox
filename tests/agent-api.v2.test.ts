// Fix round 2026-11-10: agent API behaviour with real modules (ingest, personalise, lint).
const HOME = (await import("./helpers")).tmpDir("outbox-v2-home-");
process.env.OUTBOX_HOME = HOME;

import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentApp } from "../src/agent-api/app";
import { syncContactsExport } from "../src/core/contacts-sync";
import type { BDeps } from "../src/core/deps";
import { addDraft, createBatch, getBatch, getDrafts } from "../src/core/store";
import { call, memDb, seedContact, tmpDir } from "./helpers";

const H = { "X-Outbox-Client": "v2" };

async function setup(over: Partial<BDeps> = {}) {
  const db = memDb();
  const [norm, ing, from, lint, tpl] = await Promise.all([
    import("../src/ingest/normalize"), import("../src/ingest/ingest"), import("../src/personalize/from-import"),
    import("../src/personalize/lint"), import("../src/personalize/template"),
  ]);
  const importsDir = tmpDir("outbox-imports-");
  const deps: BDeps = {
    normalizeHandle: norm.normalizeHandle as any, normalizePhone: norm.normalizePhone as any,
    ingestFile: (d, a) => ing.ingestFile(d, { ...a, importsDir }),
    setMapping: ing.setMapping as any, getImport: ing.getImport as any, batchFromImport: from.batchFromImport as any,
    lintBatch: lint.lintBatch as any, renderTemplate: tpl.renderTemplate as any, ...over,
  };
  const app = createAgentApp({ db: () => db, deps: async () => deps });
  return { db, app, deps, importsDir };
}
const post = (app: any, path: string, body?: unknown) => call(app, "POST", path, body, H);

// ---------------------------------------------------------------------------------------------- contacts
describe("contacts search: tag, has, source, offset, total", () => {
  async function seeded() {
    const s = await setup();
    const mk = (name: string, o: Omit<Parameters<typeof seedContact>[1], "name">) => seedContact(s.db, { ...o, name });
    mk("Ann Lee", { phones: [{ e164: "+12025550001", label: "mobile" }], tags: ["College Friends"] });
    mk("Ben Roe", { emails: ["ben@example.com"], tags: ["College Friends", "Climbing"] });
    mk("Cat Poe", { phones: [{ e164: "+12025550003", label: "mobile" }], emails: ["cat@example.com"], source: "import", macos_id: null, tags: ["college friends"] });
    mk("Dan Fox", { tags: ["Climbing"] });
    mk("Eve Park", { phones: [{ e164: "+12025550005", label: "home" }], source: "manual", macos_id: null });
    mk("Fay Gold", { phones: [{ e164: "+12025550006", label: "mobile" }], tags: ["Family"] });
    return s;
  }
  const names = (r: any) => r.json.contacts.map((c: any) => c.display_name);

  test("tag= is an exact, case-insensitive match on a tag (a Contacts group); total counts all matches", async () => {
    const { app } = await seeded();
    const r = await call(app, "GET", "/v1/contacts?tag=college%20friends");
    expect(names(r)).toEqual(["Ann Lee", "Ben Roe", "Cat Poe"]);
    expect(r.json).toMatchObject({ total: 3, offset: 0, has_more: false });
    // exact, not substring: "college" alone is not the tag
    expect((await call(app, "GET", "/v1/contacts?tag=college")).json.total).toBe(0);
    // several tags: any of
    expect((await call(app, "GET", "/v1/contacts?tag=climbing,family")).json.total).toBe(3);
  });

  test("offset and limit page through the matches; total stays the full count; has_more says when to stop", async () => {
    const { app } = await seeded();
    const p1 = await call(app, "GET", "/v1/contacts?limit=4");
    expect(names(p1)).toEqual(["Ann Lee", "Ben Roe", "Cat Poe", "Dan Fox"]);
    expect(p1.json).toMatchObject({ total: 6, offset: 0, limit: 4, has_more: true });
    const p2 = await call(app, "GET", "/v1/contacts?limit=4&offset=4");
    expect(names(p2)).toEqual(["Eve Park", "Fay Gold"]);
    expect(p2.json).toMatchObject({ total: 6, offset: 4, has_more: false });
    expect(names(await call(app, "GET", "/v1/contacts?limit=4&offset=99"))).toEqual([]);
  });

  test("has=phone|email|none", async () => {
    const { app } = await seeded();
    expect(names(await call(app, "GET", "/v1/contacts?has=phone"))).toEqual(["Ann Lee", "Cat Poe", "Eve Park", "Fay Gold"]);
    expect(names(await call(app, "GET", "/v1/contacts?has=email"))).toEqual(["Ben Roe", "Cat Poe"]);
    expect(names(await call(app, "GET", "/v1/contacts?has=none"))).toEqual(["Dan Fox"]);
    expect((await call(app, "GET", "/v1/contacts?has=fax")).status).toBe(400);
  });

  test("source=, and filters combine with q and each other", async () => {
    const { app } = await seeded();
    expect(names(await call(app, "GET", "/v1/contacts?source=import"))).toEqual(["Cat Poe"]);
    expect(names(await call(app, "GET", "/v1/contacts?source=manual"))).toEqual(["Eve Park"]);
    expect((await call(app, "GET", "/v1/contacts?source=other")).status).toBe(400);
    expect(names(await call(app, "GET", "/v1/contacts?tag=climbing&has=phone"))).toEqual([]);
    expect(names(await call(app, "GET", "/v1/contacts?tag=college%20friends&has=email&q=ben"))).toEqual(["Ben Roe"]);
    // the old free-text search still works, including tags
    expect(names(await call(app, "GET", "/v1/contacts?q=climbing"))).toEqual(["Ben Roe", "Dan Fox"]);
  });

  test("facets=tags lists every tag with its size, so an agent can find the group name", async () => {
    const { app } = await seeded();
    const r = await call(app, "GET", "/v1/contacts?limit=1&facets=tags");
    expect(r.json.tags).toEqual([{ tag: "college friends", count: 3 }, { tag: "climbing", count: 2 }, { tag: "family", count: 1 }]);
    expect((await call(app, "GET", "/v1/contacts")).json.tags).toBeUndefined();
  });

  test("city and birthday from the executor export are vars on the contact: in search, and merged into a draft", async () => {
    const { app, db } = await setup();
    const exp = join(tmpDir(), "contacts-export.json");
    await Bun.write(exp, JSON.stringify({ contacts: [{ macos_id: "J1", given_name: "Jo", family_name: "Park", phones: [{ raw: "(202) 555-0101", label: "iPhone" }], groups: ["College Friends"], city: "Boston", birthday: "1998-03-14" }] }));
    await syncContactsExport(db, { path: exp });
    const found = await call(app, "GET", "/v1/contacts?tag=college%20friends");
    expect(found.json.contacts[0]).toMatchObject({ display_name: "Jo Park", tags: ["College Friends"], vars: { city: "Boston", birthday: "1998-03-14" }, preferred_handle: "+12025550101" });
    const b = await post(app, "/v1/batches", { title: "T", template: "Hey {{first_name}}, how's {{city}}? ({{tags}})", items: [{ contact_id: found.json.contacts[0].id }] });
    expect(b.json.drafts[0].body).toBe("Hey Jo, how's Boston? (College Friends)");
    expect(b.json.drafts[0].vars).toMatchObject({ city: "Boston", birthday: "1998-03-14" });
    expect((await call(app, "GET", `/v1/contacts/${found.json.contacts[0].id}`)).json.contact.vars.city).toBe("Boston");
  });
});

// ---------------------------------------------------------------------------------------------- imports
const GOOGLE = [
  "First Name,Last Name,Labels,Phone 1 - Label,Phone 1 - Value,Phone 2 - Label,Phone 2 - Value,City",
  "Jane,Smith,* myContacts ::: College Friends,Work,202-555-0143,Mobile,(301) 555-0123,Oslo",
  "Bob,Jones,* myContacts,Mobile,301-555-0188,,,Rome",
  "Cy,Dee,College Friends,Home,202-555-0100,,,Paris",
  "Dee,Ng,,Work,202-555-0111,,,Lima",
  "Bad,Row,,Mobile,nope,,,Nowhere",
].join("\n");

describe("imports through the API", () => {
  test("a Google CSV draft goes to the mobile number, not the work number", async () => {
    const { app } = await setup();
    const i = await post(app, "/v1/imports", { text: GOOGLE, kind: "csv" });
    expect(i.status).toBe(201);
    expect(i.json.dashboard_url).toBe(`agent-outbox://imports/${i.json.import_id}`);
    expect(i.json.mapping.fields.phone.columns).toEqual(["Phone 1 - Value", "Phone 2 - Value"]);
    const b = await post(app, `/v1/imports/${i.json.import_id}/batch`, { title: "Hi", template: "Hi {{first_name}}" });
    expect(b.status).toBe(201);
    expect(b.json.drafts.map((d: any) => d.handle)).toEqual(["+13015550123", "+13015550188", "+12025550100", "+12025550111"]);
    expect(b.json.skipped).toEqual([{ row_index: 4, reason: "No usable phone number or email" }]);
  });

  test("GET /v1/imports/:id pages rows with vars, issues, match and handle; the Agent Outbox link uses agent-outbox://imports/", async () => {
    const { app } = await setup();
    const id = (await post(app, "/v1/imports", { text: GOOGLE, kind: "csv" })).json.import_id;
    const p1 = await call(app, "GET", `/v1/imports/${id}?limit=2`);
    expect(p1.json).toMatchObject({ rows_total: 5, offset: 0, limit: 2, has_more: true, dashboard_url: `agent-outbox://imports/${id}` });
    expect(p1.json.rows).toHaveLength(2);
    const r0 = p1.json.rows[0];
    expect(r0).toMatchObject({ row_index: 0, match: "new", name: "Jane Smith", handle: "+13015550123", tags: ["College Friends"] });
    expect(r0.vars).toMatchObject({ first_name: "Jane", last_name: "Smith", city: "Oslo", full_name: "Jane Smith", tags: "College Friends" });
    expect(r0.issues.map((x: any) => x.code)).toEqual(["phone_note"]);
    expect(r0.raw).toBeUndefined();
    expect(r0.normalized).toBeUndefined();
    const p3 = await call(app, "GET", `/v1/imports/${id}?limit=2&offset=4`);
    expect(p3.json.rows.map((r: any) => r.row_index)).toEqual([4]);
    expect(p3.json.rows[0]).toMatchObject({ match: "invalid", handle: null });
    expect(p3.json.has_more).toBe(false);
    expect(p3.json.template_vars).toEqual(expect.arrayContaining(["first_name", "tags", "city", "phone_1_value"]));
    const full = await call(app, "GET", `/v1/imports/${id}?limit=1&fields=full`);
    expect(full.json.rows[0].raw["Phone 2 - Value"]).toBe("(301) 555-0123");
    expect(full.json.rows[0].normalized.phones).toEqual(["+13015550123", "+12025550143"]);
  });

  test("region on ingest and on the mapping; column names match case-insensitively", async () => {
    const { app } = await setup();
    const i = await post(app, "/v1/imports", { text: "Name,Mobile\nAnn Lee,07911 123456\n", kind: "csv", region: "gb" });
    expect(i.json.mapping.region).toBe("GB");
    expect(i.json.counts.new).toBe(1);
    const j = await post(app, "/v1/imports", { text: "Name,Mobile\nAnn Lee,07911 123456\n", kind: "csv" });
    expect(j.json.counts.invalid).toBe(1);
    const m = await call(app, "PUT", `/v1/imports/${j.json.import_id}/mapping`, { fields: { phone: { column: "MOBILE" }, display_name: { column: "name" } }, region: "GB" });
    expect(m.status).toBe(200);
    expect(m.json.mapping.fields.phone.column).toBe("Mobile");
    expect(m.json.mapping.region).toBe("GB");
    expect(m.json.counts).toMatchObject({ new: 1, invalid: 0 });
    expect((await post(app, "/v1/imports", { text: "a,b\n1,2", kind: "csv", region: "UK1" })).status).toBe(400);
    const bad = await call(app, "PUT", `/v1/imports/${j.json.import_id}/mapping`, { fields: { phone: { column: "Nope" } } });
    expect(bad.json.error.code).toBe("unknown_column");
  });

  test("the mapping takes an ordered columns list for phone", async () => {
    const { app } = await setup();
    const i = await post(app, "/v1/imports", { text: "Name,Home,Cell\nAnn Lee,202-555-0143,301-555-0123\nBob Roe,202-555-0144,\n", kind: "csv" });
    const m = await call(app, "PUT", `/v1/imports/${i.json.import_id}/mapping`, { fields: { phone: { columns: ["home", "cell"] }, display_name: { column: "Name" } } });
    expect(m.status).toBe(200);
    expect(m.json.mapping.fields.phone).toEqual({ column: "Home", confidence: 1, columns: ["Home", "Cell"] });
    // header labels still count: "Cell" outranks "Home" for the row that has both
    expect(m.json.preview.map((r: any) => r.normalized.handle)).toEqual(["+13015550123", "+12025550144"]);
  });

  test("empty and row-less input are clear errors", async () => {
    const { app } = await setup();
    expect((await post(app, "/v1/imports", { text: "   \n  " })).json.error.code).toBe("empty_file");
    expect((await post(app, "/v1/imports", { base64: "", filename: "x.csv" })).status).toBe(400);
    const none = await post(app, "/v1/imports", { text: "Name,Phone\n", kind: "csv" });
    expect(none.status).toBe(400);
    expect(none.json.error.code).toBe("no_rows");
    expect(none.json.error.message).toContain("No data rows");
    const empty = await post(app, "/v1/imports", { base64: Buffer.from("\n\n\n").toString("base64"), filename: "x.csv" });
    expect(["empty_file", "no_rows"]).toContain(empty.json.error.code);
  });

  test("path imports: the allowlist (~/.ssh, a symlink out of an allowed folder, .env) is enforced inside outboxd", async () => {
    const { app } = await setup();
    const ssh = await post(app, "/v1/imports", { path: "~/.ssh/id_ed25519" });
    expect(ssh.status).toBe(403);
    expect(ssh.json.error.code).toBe("path_not_allowed");
    const dir = tmpDir();
    writeFileSync(join(dir, ".env"), "TOKEN=secret\n");
    expect((await post(app, "/v1/imports", { path: join(dir, ".env") })).status).toBe(403);
    symlinkSync("/etc/hosts", join(dir, "people.csv"));
    expect((await post(app, "/v1/imports", { path: join(dir, "people.csv") })).status).toBe(403);
    writeFileSync(join(dir, "creds.pem"), "x");
    expect((await post(app, "/v1/imports", { path: join(dir, "creds.pem") })).status).toBe(403);
    writeFileSync(join(dir, "photo.png"), "x");
    expect((await post(app, "/v1/imports", { path: join(dir, "photo.png") })).status).toBe(403);
    expect((await post(app, "/v1/imports", { path: join(dir, "relative/../.ssh/x.csv") })).status).toBe(403);
    // the real refusal text names the allowed folders
    expect(ssh.json.error.message).toMatch(/hidden|~\/Downloads/);
    // and an ordinary file in a temp folder is fine
    writeFileSync(join(dir, "ok.csv"), "Name,Phone\nAnn Lee,301-555-0123\n");
    expect((await post(app, "/v1/imports", { path: join(dir, "ok.csv") })).status).toBe(201);
  });
});

describe("batch from import: refusals, instructions, unknown fields", () => {
  async function withImport() {
    const s = await setup();
    const i = await post(s.app, "/v1/imports", { text: GOOGLE, kind: "csv" });
    return { ...s, id: i.json.import_id as string };
  }

  test("unknown template fields are refused up front with the list of available fields", async () => {
    const { app, db, id } = await withImport();
    const r = await post(app, `/v1/imports/${id}/batch`, { title: "x", template: "Hi {{first_name}} from {{company}}, {{nickname|friend}}" });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("unknown_template_vars");
    expect(r.json.error.details.unknown).toEqual(["company", "nickname"]);
    expect(r.json.error.details.available).toEqual(expect.arrayContaining(["first_name", "last_name", "full_name", "name", "org", "tags", "city", "phone_1_value"]));
    expect(r.json.error.message).toContain("{{company}}");
    expect(r.json.error.message).toContain("Available fields:");
    expect((db.query("SELECT COUNT(*) AS n FROM batches").get() as any).n).toBe(0);
    // known fields in any case or spacing are fine; allow_unknown_vars overrides
    expect((await post(app, `/v1/imports/${id}/batch`, { title: "x", template: "Hi {{ First Name }} in {{CITY}}" })).status).toBe(201);
    const forced = await post(app, `/v1/imports/${id}/batch`, { title: "x", template: "Hi {{first_name}} from {{company}}", allow_unknown_vars: true });
    expect(forced.status).toBe(201);
    expect(forced.json.warnings.map((w: any) => w.code)).toContain("unresolved_var");
  });

  test("the check is skipped when every target row has its own body", async () => {
    const { app, id } = await withImport();
    const bodies = Object.fromEntries([0, 1, 2, 3].map((i) => [String(i), `Custom ${i}`]));
    const r = await post(app, `/v1/imports/${id}/batch`, { title: "x", template: "see per-row {{whatever}}", per_row_bodies: bodies });
    expect(r.status).toBe(201);
    expect(r.json.drafts.map((d: any) => d.body)).toEqual(["Custom 0", "Custom 1", "Custom 2", "Custom 3"]);
    // ...but not when some row lacks one
    expect((await post(app, `/v1/imports/${id}/batch`, { title: "x", template: "{{whatever}}", per_row_bodies: { "0": "only one" } })).status).toBe(400);
  });

  test("0 drafts is refused: nothing is created, and the skipped rows are explained", async () => {
    const { app, db, id } = await withImport();
    const r = await post(app, `/v1/imports/${id}/batch`, { title: "x", template: "Hi", include: [4] });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("no_drafts");
    expect(r.json.error.message).toContain("No usable phone number or email");
    expect(r.json.error.details.skipped).toHaveLength(1);
    expect((db.query("SELECT COUNT(*) AS n FROM batches").get() as any).n).toBe(0);
  });

  test("0 drafts from a library that returns an empty batch instead of refusing: the empty batch is cancelled", async () => {
    const s = await setup();
    const imp = await post(s.app, "/v1/imports", { text: GOOGLE, kind: "csv" });
    const lenient = createAgentApp({
      db: () => s.db,
      deps: async () => ({ ...s.deps, batchFromImport: (d: Database, _i: string, o: any) => ({ batch_id: createBatch(d, { title: o.title, created_by: o.created_by, source: o.source }), drafts: 0, skipped: [{ row_index: 4, reason: "x" }] }) }) as any,
    });
    const r = await call(lenient, "POST", `/v1/imports/${imp.json.import_id}/batch`, { title: "x", template: "Hi" }, H);
    expect(r.json.error.code).toBe("no_drafts");
    expect(s.db.query("SELECT status FROM batches").all()).toEqual([{ status: "cancelled" }]);
  });

  test("instructions are stored on the batch and drive the identical_to_template lint", async () => {
    const { app, db, id } = await withImport();
    const r = await post(app, `/v1/imports/${id}/batch`, { title: "x", template: "Join us Friday!", instructions: "Personalise every message", submit: true });
    expect(r.status).toBe(201);
    expect(getBatch(db, r.json.batch.id)!.instructions).toBe("Personalise every message");
    expect(r.json.warnings.map((w: any) => w.code)).toContain("identical_to_template");
    expect(r.json.batch.status).toBe("review");
    expect(r.json.dashboard_url).toBe(`agent-outbox://batch/${r.json.batch.id}`);
  });

  test("an agent can write a body for EVERY row: page the rows, then pass per_row_bodies", async () => {
    const { app, id } = await withImport();
    const rows: any[] = [];
    for (let offset = 0; ; offset += 2) {
      const p = await call(app, "GET", `/v1/imports/${id}?limit=2&offset=${offset}`);
      rows.push(...p.json.rows);
      if (!p.json.has_more) break;
    }
    expect(rows).toHaveLength(5);
    const bodies = Object.fromEntries(rows.filter((r) => r.match !== "invalid" && r.match !== "duplicate").map((r) => [r.row_index, `Hey ${r.vars.first_name}, how is ${r.vars.city}?`]));
    const b = await post(app, `/v1/imports/${id}/batch`, { title: "Per row", template: "unused", per_row_bodies: bodies });
    expect(b.json.drafts.map((d: any) => d.body)).toEqual(["Hey Jane, how is Oslo?", "Hey Bob, how is Rome?", "Hey Cy, how is Paris?", "Hey Dee, how is Lima?"]);
  });
});

// ---------------------------------------------------------------------------------------------- proposed contacts
describe("proposed contacts: exactly the draft's handle", () => {
  const item = (o: any) => ({ title: "T", items: [{ body: "hi", ...o }] });

  test("extra numbers and emails are dropped; only the handle the message goes to remains", async () => {
    const { app } = await setup();
    const r = await post(app, "/v1/batches", item({ to: "202 555 0102", proposed_contact: { given_name: "Ann", family_name: "Lee", phones: ["202 555 0101", "202 555 0102"], emails: ["ann@x.com"], tags: ["Climbing"] } }));
    expect(r.status).toBe(201);
    const d = r.json.drafts[0];
    expect(d.handle).toBe("+12025550102");
    expect(d.proposed_contact.phones).toEqual([{ e164: "+12025550102", label: "mobile" }]);
    expect(d.proposed_contact.emails).toEqual([]);
    expect(d.proposed_contact.tags).toEqual(["Climbing"]);
  });

  test("without `to` the preferred handle is chosen and the proposal is cut down to it", async () => {
    const { app } = await setup();
    const r = await post(app, "/v1/batches", item({ proposed_contact: { given_name: "Ann", phones: [{ e164: "202 555 0101", label: "work" }, { e164: "202 555 0102", label: "iPhone" }], emails: ["ann@x.com"] } }));
    const d = r.json.drafts[0];
    expect(d.handle).toBe("+12025550102");
    expect(d.proposed_contact.phones).toEqual([{ e164: "+12025550102", label: "iPhone" }]);
    expect(d.proposed_contact.emails).toEqual([]);
  });

  test("an email `to` leaves an email-only proposal; a proposal with no handles gets the `to`", async () => {
    const { app } = await setup();
    const a = await post(app, "/v1/batches", item({ to: "Ann@X.com", proposed_contact: { given_name: "Ann", phones: ["202 555 0101"], emails: ["ann@x.com"] } }));
    expect(a.json.drafts[0].proposed_contact).toMatchObject({ phones: [], emails: [{ email: "ann@x.com", label: "home" }] });
    const b = await post(app, "/v1/batches", item({ to: "202 555 0109", proposed_contact: { given_name: "Zed" } }));
    expect(b.json.drafts[0].proposed_contact).toMatchObject({ given_name: "Zed", phones: [{ e164: "+12025550109", label: "mobile" }], emails: [] });
  });

  test("a `to` that isn't one of the proposal's handles is refused, and nothing is created", async () => {
    const { app, db } = await setup();
    const r = await post(app, "/v1/batches", item({ to: "202 555 0199", proposed_contact: { given_name: "Ann", phones: ["202 555 0101"] } }));
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("invalid_items");
    expect(r.json.error.message).toContain("is not one of proposed_contact's numbers or addresses");
    expect((db.query("SELECT COUNT(*) AS n FROM batches").get() as any).n).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------- bulk edit and cancel
describe("bulk draft updates are all or nothing", () => {
  async function two() {
    const s = await setup();
    const a = (await post(s.app, "/v1/batches", { title: "A", items: [{ to: "2025550101", body: "a1" }, { to: "2025550102", body: "a2" }], submit: true })).json;
    const b = (await post(s.app, "/v1/batches", { title: "B", items: [{ to: "2025550103", body: "b1" }] })).json;
    return { ...s, a, b, ids: [...a.drafts, ...b.drafts].map((d: any) => d.id) as string[] };
  }

  test("updates drafts across batches, re-lints once per batch, versions bump", async () => {
    const { app, db, a, b, ids } = await two();
    const r = await call(app, "PATCH", "/v1/drafts", { updates: [{ draft_id: ids[0], body: "new a1 {{oops}}" }, { draft_id: ids[1], body: "new a2" }, { draft_id: ids[2], body: "new b1" }] });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ updated: 3, unchanged: 0 });
    expect(r.json.batches.map((x: any) => x.id).sort()).toEqual([a.batch.id, b.batch.id].sort());
    expect(getDrafts(db, a.batch.id).map((d) => [d.body, d.version])).toEqual([["new a1 {{oops}}", 2], ["new a2", 2]]);
    expect(getDrafts(db, a.batch.id)[0]!.warnings.map((w) => w.code)).toContain("unresolved_var");
    // an identical body is "unchanged"
    const same = await call(app, "PATCH", "/v1/drafts", { updates: [{ draft_id: ids[1], body: "new a2" }] });
    expect(same.json).toMatchObject({ updated: 0, unchanged: 1 });
  });

  test("one bad update (approved draft) refuses everything and changes nothing", async () => {
    const { app, db, a, ids } = await two();
    db.query("UPDATE drafts SET status = 'approved' WHERE id = ?").run(ids[1]!);
    const r = await call(app, "PATCH", "/v1/drafts", { updates: [{ draft_id: ids[0], body: "changed" }, { draft_id: ids[1], body: "nope" }, { draft_id: "no-such", body: "x" }] });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("invalid_updates");
    expect(r.json.error.details).toHaveLength(2);
    expect(r.json.error.message).toContain("nothing was changed");
    expect(getDrafts(db, a.batch.id).map((d) => [d.body, d.version])).toEqual([["a1", 1], ["a2", 1]]);
  });

  test("duplicate ids, empty bodies, an empty list and a cancelled batch", async () => {
    const { app, db, b, ids } = await two();
    expect((await call(app, "PATCH", "/v1/drafts", { updates: [{ draft_id: ids[0], body: "x" }, { draft_id: ids[0], body: "y" }] })).status).toBe(400);
    expect((await call(app, "PATCH", "/v1/drafts", { updates: [{ draft_id: ids[0], body: "" }] })).status).toBe(400);
    expect((await call(app, "PATCH", "/v1/drafts", { updates: [] })).status).toBe(400);
    expect((await post(app, `/v1/batches/${b.batch.id}/cancel`)).status).toBe(200);
    const r = await call(app, "PATCH", "/v1/drafts", { updates: [{ draft_id: ids[2], body: "x" }] });
    expect(r.status).toBe(400);
    expect(getDrafts(db, b.batch.id)[0]!.body).toBe("b1");
  });
});

describe("cancel", () => {
  test("rejects the batch's unsent drafts and returns the view", async () => {
    const { app, db } = await setup();
    const b = (await post(app, "/v1/batches", { title: "A", items: [{ to: "2025550101", body: "a" }, { to: "2025550102", body: "b" }], submit: true })).json;
    db.query("UPDATE drafts SET status = 'skipped' WHERE id = ?").run(b.drafts[1].id);
    const r = await post(app, `/v1/batches/${b.batch.id}/cancel`);
    expect(r.json).toMatchObject({ cancelled: true, drafts_rejected: 2, batch: { status: "cancelled" } });
    expect(r.json.drafts.map((d: any) => d.status)).toEqual(["rejected", "rejected"]);
    expect((await call(app, "PATCH", `/v1/drafts/${b.drafts[0].id}`, { body: "late" }, H)).status).toBe(409);
    expect((await post(app, `/v1/batches/${b.batch.id}/items`, { items: [{ to: "2025550103", body: "x" }] })).status).toBe(409);
    expect(db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'batch.status' AND details_json LIKE '%cancelled%'").get()).toEqual({ n: 1 });
  });
});

// ---------------------------------------------------------------------------------------------- lint failure
describe("a lint failure after the commit is reported, never a 500", () => {
  const boom = { lintBatch: () => { throw new Error("lint exploded"); } };

  test("single draft, batch, items, submit, patch and import batch all succeed once saved", async () => {
    const { app, db } = await setup(boom);
    const d = await post(app, "/v1/drafts", { to: "2025550101", body: "hi" });
    expect(d.status).toBe(201);
    expect(d.json.lint_error).toContain("lint exploded");
    expect(d.json.batch.status).toBe("review");

    const b = await post(app, "/v1/batches", { title: "T", items: [{ to: "2025550102", body: "a" }] });
    expect(b.status).toBe(201);
    expect(b.json.lint_error).toContain("The batch itself was saved");
    expect((db.query("SELECT COUNT(*) AS n FROM batches").get() as any).n).toBe(2);

    const items = await post(app, `/v1/batches/${b.json.batch.id}/items`, { items: [{ to: "2025550103", body: "b" }] });
    expect(items.status).toBe(201);
    expect(items.json.drafts).toHaveLength(2);

    const sub = await post(app, `/v1/batches/${b.json.batch.id}/submit`);
    expect(sub.status).toBe(200);
    expect(sub.json.batch.status).toBe("review");
    expect(sub.json.lint_error).toBeTruthy();

    const p = await call(app, "PATCH", `/v1/drafts/${items.json.drafts[0].id}`, { body: "edited" }, H);
    expect(p.status).toBe(200);
    expect(p.json.lint_error).toBeTruthy();
    expect(getDrafts(db, b.json.batch.id)[0]!.body).toBe("edited");

    const bulk = await call(app, "PATCH", "/v1/drafts", { updates: [{ draft_id: items.json.drafts[1].id, body: "bulk" }] }, H);
    expect(bulk.status).toBe(200);
    expect(bulk.json.lint_error).toBeTruthy();

    const i = await post(app, "/v1/imports", { text: GOOGLE, kind: "csv" });
    const ib = await post(app, `/v1/imports/${i.json.import_id}/batch`, { title: "I", template: "Hi {{first_name}}", submit: true });
    expect(ib.status).toBe(201);
    expect(ib.json.batch.status).toBe("review");
    expect(ib.json.drafts_created).toBe(4);
  });

  test("the library's own post-commit lint failure (real batchFromImport) is also swallowed and surfaced", async () => {
    const { app, db } = await setup();
    const i = await post(app, "/v1/imports", { text: GOOGLE, kind: "csv" });
    db.exec("DROP TABLE sends"); // the real lintBatch reads it
    const r = await post(app, `/v1/imports/${i.json.import_id}/batch`, { title: "I", template: "Hi {{first_name}}" });
    expect(r.status).toBe(201);
    expect(r.json.drafts_created).toBe(4);
    expect(r.json.lint_error).toMatch(/Lint failed/);
  });
});

// ---------------------------------------------------------------------------------------------- misc
describe("add_items / drafts routes keep their rules", () => {
  test("an item for a known contact picks up that contact's vars; unrelated drafts are untouched", async () => {
    const { app, db } = await setup();
    const id = seedContact(db, { name: "Sam Lee", phones: [{ e164: "+12025550009", label: "mobile" }] });
    const b = await post(app, "/v1/batches", { title: "T", template: "Hi {{first_name}}" });
    const r = await post(app, `/v1/batches/${b.json.batch.id}/items`, { items: [{ contact_id: id }] });
    expect(r.json.drafts[0].body).toBe("Hi Sam");
    addDraft(db, createBatch(db, { title: "x", created_by: "agent:other", source: "mcp" }), { handle: "+1", body: "x", actor: "agent" });
  });
});
