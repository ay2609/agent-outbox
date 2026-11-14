// v4 native contact management, agent side: validation, propose / convert, the import transform, the read views,
// and the MCP tools and CLI verbs that sit on top. No sockets: the MCP server and CLI call the Hono app in-process.
const HOME = (await import("./helpers")).tmpDir("outbox-cc-home-");
process.env.OUTBOX_HOME = HOME;

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { join } from "node:path";
import { createAgentApp } from "../src/agent-api/app";
import { createAgentClient } from "../src/agent-api/client";
import { main } from "../src/cli";
import {
  ContactValidationError, checkStoredPayload, convertCreateToUpdate, isEffective, validateCreate, validateUndo, validateUpdate,
} from "../src/core/contact-changes";
import type { BDeps } from "../src/core/deps";
import { getContact } from "../src/core/store";
import { createOutboxMcpServer } from "../src/mcp/server";
import { call, memDb, seedContact, tmpDir } from "./helpers";

const origin = "https://outbox.test";
const H = { "X-Outbox-Client": "cc-test" };

async function setup() {
  const db = memDb();
  const [norm, ing, from, lint, tpl] = await Promise.all([
    import("../src/ingest/normalize"), import("../src/ingest/ingest"), import("../src/personalize/from-import"),
    import("../src/personalize/lint"), import("../src/personalize/template"),
  ]);
  const importsDir = tmpDir("outbox-cc-imports-");
  const deps: BDeps = {
    normalizeHandle: norm.normalizeHandle as any, normalizePhone: norm.normalizePhone as any,
    ingestFile: (d, a) => ing.ingestFile(d, { ...a, importsDir }), setMapping: ing.setMapping as any, getImport: ing.getImport as any,
    batchFromImport: from.batchFromImport as any, lintBatch: lint.lintBatch as any, renderTemplate: tpl.renderTemplate as any,
  };
  const app = createAgentApp({ db: () => db, deps: async () => deps, origin });
  return { db, app };
}
const post = (app: any, path: string, body?: unknown) => call(app, "POST", path, body, H);
const get = (app: any, path: string) => call(app, "GET", path, undefined, H);
const err = (f: () => unknown): string => { try { f(); } catch (e) { if (e instanceof ContactValidationError) return e.message; throw e; } return "NO ERROR"; };

// ---------------------------------------------------------------------------------------------- validation
describe("validation (the contract's rules)", () => {
  const ok = { given_name: "Ana", family_name: "Ruiz", phones: ["415 555 0123"] };

  test("a create is canonical: trimmed names, E.164 phones, lowercased emails, fixed key order, default labels", () => {
    const p = validateCreate({ phones: [" (415) 555-0123 "], emails: ["Ana@Example.COM"], family_name: " Ruiz ", given_name: " Ana 📚 ", org: " Acme ", groups: ["A", "A", "B"] });
    expect(p).toEqual({ given_name: "Ana 📚", family_name: "Ruiz", org: "Acme", phones: [{ e164: "+14155550123", label: "mobile" }], emails: [{ email: "ana@example.com", label: "home" }], groups: ["A", "B"] });
    expect(Object.keys(p)).toEqual(["given_name", "family_name", "org", "phones", "emails", "groups"]);
    // empty optional fields are left out, so nothing unsigned or empty rides along
    expect(Object.keys(validateCreate({ ...ok, nickname: "  ", org: "" }))).toEqual(["given_name", "family_name", "phones", "emails"]);
  });

  test("names, nicknames, orgs and group names are at most 100 characters; emoji are fine", () => {
    expect(validateCreate({ ...ok, given_name: "a".repeat(100) }).given_name).toHaveLength(100);
    expect(err(() => validateCreate({ ...ok, given_name: "a".repeat(101) }))).toMatch(/longer than 100/);
    expect(err(() => validateCreate({ ...ok, org: "o".repeat(101) }))).toMatch(/org is longer than 100/);
    expect(err(() => validateCreate({ ...ok, nickname: "n".repeat(101) }))).toMatch(/nickname/);
    expect(err(() => validateCreate({ ...ok, groups: ["g".repeat(101)] }))).toMatch(/group/);
    expect(validateCreate({ ...ok, given_name: "📚".repeat(50) }).given_name).toBe("📚".repeat(50)); // 100 UTF-16 units
    expect(err(() => validateCreate({ ...ok, given_name: "📚".repeat(51) }))).toMatch(/longer than 100/); // the strictest count
    expect(err(() => validateCreate({ ...ok, given_name: 5 }))).toMatch(/must be a string/);
  });

  test("control characters and direction overrides are refused (C0, C1, U+2028/2029, U+202A-202E, U+2066-2069)", () => {
    for (const bad of ["Ana\u0007", "A\u0000na", "A\tna", "A\nna", "A\u0085na", "A\u009Fna", "A\u2028na", "A\u2029na", "Ana\u202E", "\u202AAna", "A\u2066na", "Ana\u2069", "A\u007Fna"]) {
      expect([JSON.stringify(bad), err(() => validateCreate({ ...ok, given_name: bad }))]).toEqual([JSON.stringify(bad), expect.stringMatching(/control or direction-override/)]);
    }
    expect(err(() => validateCreate({ ...ok, groups: ["a\u202Eb"] }))).toMatch(/direction-override/);
    expect(err(() => validateUpdate({ set: { org: "x\u0001" } }))).toMatch(/set org/);
    // surrounding whitespace (including a trailing newline) is trimmed, not refused
    expect(validateCreate({ ...ok, given_name: " Ana\n" }).given_name).toBe("Ana");
    // other zero-width characters are not on the contract's list
    expect(validateCreate({ ...ok, given_name: "A\u200Dna" }).given_name).toBe("A\u200Dna");
  });

  test("a create needs a name and at least one valid handle; counts, validity and duplicates", () => {
    expect(err(() => validateCreate({ phones: ["4155550123"] }))).toMatch(/first or last name/);
    expect(validateCreate({ family_name: "Ruiz", phones: ["4155550123"] }).given_name).toBe("");
    expect(err(() => validateCreate({ given_name: "Ana" }))).toMatch(/at least one phone number or email/);
    expect(err(() => validateCreate({ ...ok, phones: ["12345"] }))).toMatch(/isn't a valid phone number/);
    expect(err(() => validateCreate({ ...ok, phones: [], emails: ["not-an-email"] }))).toMatch(/isn't a valid email/);
    expect(err(() => validateCreate({ ...ok, phones: ["4155550123", "+1 (415) 555-0123"] }))).toMatch(/listed twice/);
    expect(err(() => validateCreate({ ...ok, phones: [], emails: ["a@b.co", "A@B.CO"] }))).toMatch(/listed twice/);
    const six = ["+14155550101", "+14155550102", "+14155550103", "+14155550104", "+14155550105", "+14155550106"];
    expect(err(() => validateCreate({ ...ok, phones: six }))).toMatch(/more than 5/);
    expect(validateCreate({ ...ok, phones: six.slice(0, 5) }).phones).toHaveLength(5);
    expect(err(() => validateCreate({ ...ok, phones: [], emails: ["a@b.co", "b@b.co", "c@b.co", "d@b.co", "e@b.co", "f@b.co"] }))).toMatch(/more than 5/);
    expect(err(() => validateCreate({ ...ok, groups: ["1", "2", "3", "4", "5", "6"] }))).toMatch(/more than 5 groups/);
    expect(err(() => validateCreate({ ...ok, groups: [""] }))).toMatch(/empty group/);
    // a region lets a local number through
    expect(validateCreate({ ...ok, phones: ["07911 123456"] }, "GB").phones[0]!.e164).toBe("+447911123456");
  });

  test("unknown keys are refused everywhere, so nothing unsigned rides along", () => {
    expect(err(() => validateCreate({ ...ok, status: "applied" }))).toMatch(/unknown field\(s\): status/);
    expect(err(() => validateCreate({ ...ok, phones: [{ e164: "+14155550123", primary: true }] }))).toMatch(/unknown field/);
    expect(err(() => validateCreate({ ...ok, emails: [{ email: "a@b.co", x: 1 }] }))).toMatch(/unknown field/);
    expect(err(() => validateUpdate({ set: { given_name: "A", phone: "1" } }))).toMatch(/unknown field/);
    expect(err(() => validateUpdate({ set: { given_name: "A" }, remove_phones: [] }))).toMatch(/unknown field/);
    expect(err(() => validateUpdate({ set: { given_name: "A" }, from_create: true }))).toMatch(/unknown field\(s\): from_create/); // never from an agent
    expect(err(() => validateUndo({ undo_of: "x", undo_kind: "create", before_vcard_sha256: null, after_fingerprint: "", sneaky: 1 }))).toMatch(/unknown field/);
  });

  test("an edit needs at least one change; set takes only the four name fields and \"\" clears one", () => {
    expect(err(() => validateUpdate({}))).toMatch(/at least one change/);
    expect(err(() => validateUpdate({ set: {} }))).toMatch(/at least one change/);
    expect(err(() => validateUpdate({ add_phones: [] }))).toMatch(/at least one change/);
    expect(validateUpdate({ set: { nickname: "" } })).toEqual({ set: { nickname: "" } });
    expect(validateUpdate({ add_groups: ["Friends"], set: { given_name: "A" }, add_emails: ["X@Y.co"], add_phones: ["4155550123"] }))
      .toEqual({ set: { given_name: "A" }, add_phones: [{ e164: "+14155550123", label: "mobile" }], add_emails: [{ email: "x@y.co", label: "home" }], add_groups: ["Friends"] });
    expect(validateUpdate({ set: { given_name: "A" } }, { allowFromCreate: false })).toEqual({ set: { given_name: "A" } });
    expect(validateUpdate({ add_groups: ["g"], from_create: true }, { allowFromCreate: true })).toEqual({ add_groups: ["g"], from_create: true });
  });

  test("a stored payload is re-checked by kind (this is what runs just before a signature is accepted)", () => {
    expect(() => checkStoredPayload("create", JSON.stringify(validateCreate(ok)))).not.toThrow();
    expect(() => checkStoredPayload("update", JSON.stringify({ add_groups: ["g"], from_create: true }))).not.toThrow();
    expect(() => checkStoredPayload("update", JSON.stringify({ add_groups: ["g"], evil: 1 }))).toThrow(/unknown field/);
    expect(() => checkStoredPayload("update", "{not json")).toThrow(/valid JSON/);
    expect(() => checkStoredPayload("create", JSON.stringify({ ...ok, phones: ["+0"] }))).toThrow();
    expect(() => checkStoredPayload("undo", JSON.stringify({ undo_of: "c", undo_kind: "update", before_vcard_sha256: "a".repeat(64), after_fingerprint: "b".repeat(64) }))).not.toThrow();
    expect(() => checkStoredPayload("undo", JSON.stringify({ undo_of: "c", undo_kind: "delete", before_vcard_sha256: null, after_fingerprint: "" }))).toThrow(/undo_kind/);
  });
});

// ---------------------------------------------------------------------------------------------- convert
describe("convert: a create whose handle the cache already has becomes an edit of that card", () => {
  const card = (db: any, o: any = {}) => getContact(db, seedContact(db, { name: "Ann Lee", given: "Ann", family: "Lee", phones: [{ e164: "+14155550123", label: "mobile" }], tags: ["Friends"], ...o }))!;

  test("pure rule: set = differing non-empty name fields, add_* = handles the card lacks, add_groups = the create's groups, from_create", () => {
    const db = memDb();
    const c = card(db, { org: "Acme" });
    const create = validateCreate({ given_name: "Ann 📚", family_name: "Lee", org: "Acme", phones: ["+14155550123", "+14155550199"], emails: ["ann@x.co"], groups: ["Book club"] });
    const u = convertCreateToUpdate(c, create);
    expect(u).toEqual({
      set: { given_name: "Ann 📚" }, add_phones: [{ e164: "+14155550199", label: "mobile" }], add_emails: [{ email: "ann@x.co", label: "home" }],
      add_groups: ["Book club"], from_create: true,
    });
    expect(Object.keys(u)).toEqual(["set", "add_phones", "add_emails", "add_groups", "from_create"]);
    expect(isEffective(c, u)).toBe(true);
    // identical to the card: nothing would change (and the group is already a tag)
    const same = convertCreateToUpdate(c, validateCreate({ given_name: "Ann", family_name: "Lee", org: "Acme", phones: ["+14155550123"], groups: ["friends"] }));
    expect(same).toEqual({ add_groups: ["friends"], from_create: true });
    expect(isEffective(c, same)).toBe(false); // "friends" is already a tag, compared case-insensitively
    // an empty name field in the create never clears the card's
    expect(convertCreateToUpdate(c, validateCreate({ given_name: "Ann", phones: ["+14155550123"] })).set).toBeUndefined();
  });

  test("propose: a create with a cached handle is stored as an edit in review, with the note and from_create; nothing auto-applies", async () => {
    const { db, app } = await setup();
    const c = card(db);
    const r = await post(app, "/v1/contact-changes", { title: "T", creates: [{ given_name: "Ann 📚", family_name: "Lee", phones: ["415-555-0123"], emails: ["ann@x.co"] }] });
    expect(r.status).toBe(201);
    expect(r.json.counts).toEqual({ auto_queued: 0, review: 1, rejected: 0 });
    expect(r.json.changes[0]).toMatchObject({ kind: "update", status: "review", note: "already in Contacts" });
    const row = db.query("SELECT * FROM contact_changes WHERE id = ?").get(r.json.changes[0].id) as any;
    expect(row).toMatchObject({ kind: "update", requires_approval: 1, status: "review", target_contact_id: c.id, target_macos_id: c.macos_id });
    expect(JSON.parse(row.payload_json)).toEqual({ set: { given_name: "Ann 📚" }, add_emails: [{ email: "ann@x.co", label: "home" }], from_create: true });
  });

  test("propose: nothing to change -> rejected, \"already in Contacts, nothing to change\"; several cards -> rejected; non-macOS cache rows don't count", async () => {
    const { db, app } = await setup();
    card(db);
    const same = await post(app, "/v1/contact-changes", { title: "T", creates: [{ given_name: "Ann", family_name: "Lee", phones: ["+14155550123"] }] });
    expect(same.json.changes[0]).toMatchObject({ kind: "update", status: "rejected", note: "already in Contacts, nothing to change" });
    expect(same.json.status).toBe("cancelled"); // nothing for anyone to do

    seedContact(db, { name: "Bo One", phones: [{ e164: "+14155550201", label: "mobile" }] });
    seedContact(db, { name: "Bo Two", phones: [{ e164: "+14155550202", label: "mobile" }] });
    const two = await post(app, "/v1/contact-changes", { title: "T", creates: [{ given_name: "Bo", phones: ["+14155550201", "+14155550202"] }] });
    expect(two.json.changes[0]).toMatchObject({ kind: "create", status: "rejected" });
    expect(two.json.changes[0].note).toMatch(/match 2 different contacts/);

    // a cached contact that isn't in macOS (imported) can't be edited, so the create stays an automatic create
    seedContact(db, { name: "Cy Import", source: "import", macos_id: null, phones: [{ e164: "+14155550301", label: "mobile" }] });
    const imp = await post(app, "/v1/contact-changes", { title: "T", creates: [{ given_name: "Cy", family_name: "Zed", phones: ["+14155550301"] }] });
    expect(imp.json.changes[0]).toMatchObject({ kind: "create", status: "auto_queued" });
  });
});

// ---------------------------------------------------------------------------------------------- propose
describe("POST /v1/contact-changes", () => {
  test("creates are auto_queued with requires_approval 0, edits are review; payload_json is JSON.stringify(payload) written once", async () => {
    const { db, app } = await setup();
    const id = seedContact(db, { name: "Sam Lee", given: "Sam", family: "Lee", phones: [{ e164: "+12025550009", label: "mobile" }] });
    const r = await post(app, "/v1/contact-changes", {
      title: "Mixed",
      creates: [{ given_name: "New", family_name: "Person", phones: ["4155550123"], org: "Acme" }],
      updates: [{ contact_id: id, set: { given_name: "Sam 📚" }, add_groups: ["Book club"] }],
    });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ status: "review", counts: { auto_queued: 1, review: 1, rejected: 0 } });
    expect(r.json.dashboard_url).toBe(`${origin}/#/contacts/changes/${r.json.set_id}`);
    expect(r.json.message).toMatch(/added automatically/);
    expect(r.json.message).toMatch(/Touch ID/);
    expect(r.json.message).toMatch(/can undo/);
    const set = db.query("SELECT * FROM contact_change_sets WHERE id = ?").get(r.json.set_id) as any;
    expect(set).toMatchObject({ title: "Mixed", created_by: "agent:cc-test", source: "mcp", status: "review" });
    const rows = db.query("SELECT * FROM contact_changes WHERE set_id = ? ORDER BY position").all(r.json.set_id) as any[];
    expect(rows.map((x) => [x.position, x.kind, x.status, x.requires_approval])).toEqual([[0, "create", "auto_queued", 0], [1, "update", "review", 1]]);
    expect(rows[0].payload_json).toBe(JSON.stringify(JSON.parse(rows[0].payload_json)));
    expect(rows[0].payload_json).toBe('{"given_name":"New","family_name":"Person","org":"Acme","phones":[{"e164":"+14155550123","label":"mobile"}],"emails":[]}');
    expect(rows[1].payload_json).toBe('{"set":{"given_name":"Sam 📚"},"add_groups":["Book club"]}');
    expect(rows[1]).toMatchObject({ target_contact_id: id, transport: null, before_vcard: null, after_fingerprint: null, result_macos_id: null, undo_of: null });
    expect(db.query("SELECT actor, action, target FROM audit_log WHERE action = 'contact_changes.propose'").all()).toEqual([{ actor: "agent:cc-test", action: "contact_changes.propose", target: r.json.set_id }]);
  });

  test("a set with only automatic creates is 'drafting' (nothing waits for the owner); a CLI caller is source 'cli'", async () => {
    const { db, app } = await setup();
    const r = await call(app, "POST", "/v1/contact-changes", { title: "Only new", creates: [{ given_name: "A", family_name: "Aardvark", phones: ["4155550124"] }] }, { ...H, "X-Outbox-Source": "cli" });
    expect(r.json.status).toBe("drafting");
    expect(db.query("SELECT source FROM contact_change_sets WHERE id = ?").get(r.json.set_id)).toEqual({ source: "cli" });
  });

  test("refusals: all or nothing, with every problem listed; nothing is created", async () => {
    const { db, app } = await setup();
    const noMac = seedContact(db, { name: "Imported", source: "import", macos_id: null, phones: [{ e164: "+12025550010", label: "mobile" }] });
    const ok = seedContact(db, { name: "Fine Person", phones: [{ e164: "+12025550011", label: "mobile" }] });
    const bad = await post(app, "/v1/contact-changes", {
      title: "x",
      creates: [{ given_name: "A", phones: ["4155550124"] }, { given_name: "B" }, { given_name: "C", phones: ["4155550124"] }],
      updates: [{ contact_id: noMac, set: { org: "X" } }, { contact_id: "nope", set: { org: "X" } }, { contact_id: ok, set: { given_name: "Q\u202E" } }, { contact_id: ok, set: { org: "Y" } }],
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("invalid_contact_changes");
    for (const part of ["creates[1]", "creates[2]: +14155550124 is also in creates[0]", "updates[0]", "no macOS id", "updates[1]", "not found", "updates[2]", "direction-override"]) {
      expect([part, bad.json.error.message.includes(part)]).toEqual([part, true]);
    }
    expect(db.query("SELECT COUNT(*) AS n FROM contact_change_sets").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM contact_changes").get()).toEqual({ n: 0 });
    expect((await post(app, "/v1/contact-changes", { title: "x" })).json.error.message).toMatch(/nothing to propose/);
    expect((await post(app, "/v1/contact-changes", { creates: [] })).status).toBe(400); // title
    expect((await post(app, "/v1/contact-changes", { title: "x", creates: Array.from({ length: 501 }, (_, i) => ({ given_name: "A", phones: [`+1415555${String(i).padStart(4, "0")}`] })) })).status).toBe(400);
    // an edit listed twice in one call
    const twice = await post(app, "/v1/contact-changes", { title: "x", updates: [{ contact_id: ok, set: { org: "A" } }, { contact_id: ok, set: { org: "B" } }] });
    expect(twice.json.error.message).toMatch(/edited twice/);
  });

  test("an edit that changes nothing on the cached card is stored as rejected, not sent for approval", async () => {
    const { db, app } = await setup();
    const id = seedContact(db, { name: "Sam Lee", given: "Sam", family: "Lee", phones: [{ e164: "+12025550009", label: "mobile" }], tags: ["Friends"] });
    const r = await post(app, "/v1/contact-changes", { title: "x", updates: [{ contact_id: id, set: { given_name: "Sam" }, add_phones: ["+12025550009"], add_groups: ["friends"] }] });
    expect(r.json.changes[0]).toMatchObject({ kind: "update", status: "rejected" });
    expect(r.json.changes[0].note).toMatch(/nothing to change/);
    expect(r.json.counts).toEqual({ auto_queued: 0, review: 0, rejected: 1 });
  });

  test("a region argument makes local numbers valid", async () => {
    const { db, app } = await setup();
    const r = await post(app, "/v1/contact-changes", { title: "UK", region: "GB", creates: [{ given_name: "A", phones: ["07911 123456"] }] });
    expect(r.status).toBe(201);
    expect(JSON.parse((db.query("SELECT payload_json FROM contact_changes").get() as any).payload_json).phones[0].e164).toBe("+447911123456");
  });
});

// ---------------------------------------------------------------------------------------------- reading
describe("GET /v1/contact-changes", () => {
  test("detail: parsed payloads, the cache card as `before` for edits, no vCard, dashboard_url; list with counts and a status filter", async () => {
    const { db, app } = await setup();
    const id = seedContact(db, { name: "Sam Lee", given: "Sam", family: "Lee", org: "Acme", phones: [{ e164: "+12025550009", label: "mobile" }], emails: ["sam@x.co"], tags: ["Friends"] });
    const r = await post(app, "/v1/contact-changes", { title: "Mixed", creates: [{ given_name: "New", family_name: "Person", phones: ["4155550123"] }], updates: [{ contact_id: id, set: { given_name: "Sam 📚" } }] });
    db.query("UPDATE contact_changes SET before_vcard = 'BEGIN:VCARD' WHERE set_id = ?").run(r.json.set_id); // what the executor would have stored
    const d = await get(app, `/v1/contact-changes/${r.json.set_id}`);
    expect(d.status).toBe(200);
    expect(d.json.dashboard_url).toBe(`${origin}/#/contacts/changes/${r.json.set_id}`);
    expect(d.json.counts).toEqual({ auto_queued: 1, review: 1 });
    const [create, edit] = d.json.changes;
    expect(create).toMatchObject({ kind: "create", status: "auto_queued", before: null, payload: { given_name: "New", phones: [{ e164: "+14155550123" }] } });
    expect(edit).toMatchObject({ kind: "update", status: "review", payload: { set: { given_name: "Sam 📚" } } });
    expect(edit.before).toEqual({ contact_id: id, display_name: "Sam Lee", given_name: "Sam", family_name: "Lee", nickname: "", org: "Acme", phones: ["+12025550009"], emails: ["sam@x.co"], groups: ["Friends"] });
    expect(JSON.stringify(d.json)).not.toContain("BEGIN:VCARD");
    expect(edit.has_snapshot).toBe(true);
    const l = await get(app, "/v1/contact-changes");
    expect(l.json.sets).toHaveLength(1);
    expect(l.json.sets[0]).toMatchObject({ id: r.json.set_id, counts: { auto_queued: 1, review: 1 }, status: "review", dashboard_url: d.json.dashboard_url });
    expect((await get(app, "/v1/contact-changes?status=review")).json.sets).toHaveLength(1);
    expect((await get(app, "/v1/contact-changes?status=done")).json.sets).toHaveLength(0);
    expect((await get(app, "/v1/contact-changes?status=bogus")).status).toBe(400);
    expect((await get(app, "/v1/contact-changes/nope")).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------- import
describe("POST /v1/imports/:id/contact-changes", () => {
  const CSV = [
    "Name,Phone,Email", // 0 matched (cache name Ann), 1 matched already done, 2 new, 3 new with email, 4 invalid, 5 duplicate of 2
    "Annie Different,415-555-0101,", "Ben Roe,415-555-0102,", "Cara New,415-555-0103,cara@x.co", "Dee Email,,dee@x.co", "Nobody,not a phone,", "Cara New,415-555-0103,",
  ].join("\n");

  async function seeded() {
    const s = await setup();
    const ann = seedContact(s.db, { name: "Ann Lee", given: "Ann", family: "Lee", phones: [{ e164: "+14155550101", label: "mobile" }] });
    const ben = seedContact(s.db, { name: "Ben 📚 Roe", given: "Ben 📚", family: "Roe", phones: [{ e164: "+14155550102", label: "mobile" }] });
    const imp = await post(s.app, "/v1/imports", { text: CSV, kind: "csv", filename: "people.csv" });
    expect(imp.status).toBe(201);
    return { ...s, ann, ben, importId: imp.json.import_id as string };
  }

  test("matched rows become edits with the CACHE name (prefix + given + suffix), new rows become creates, the rest are skipped with reasons", async () => {
    const { db, app, ann, ben, importId } = await seeded();
    const r = await post(app, `/v1/imports/${importId}/contact-changes`, { first_name_suffix: "📚", groups: ["Book club"] });
    expect(r.status).toBe(201);
    expect(r.json.title).toBeUndefined();
    const rows = db.query("SELECT * FROM contact_changes WHERE set_id = ? ORDER BY position").all(r.json.set_id) as any[];
    const creates = rows.filter((x) => x.kind === "create").map((x) => JSON.parse(x.payload_json));
    const edits = rows.filter((x) => x.kind === "update");
    // Ann: the spreadsheet says "Annie", the cache says "Ann": the cache wins
    expect(edits).toHaveLength(2);
    expect(JSON.parse(edits[0].payload_json)).toEqual({ set: { given_name: "Ann📚" }, add_groups: ["Book club"] });
    expect(edits[0]).toMatchObject({ target_contact_id: ann, status: "review", requires_approval: 1 });
    // Ben already has the suffix ("already done"), but not the group: only the group is added, no name change
    expect(JSON.parse(edits[1].payload_json)).toEqual({ add_groups: ["Book club"] });
    expect(edits[1]).toMatchObject({ target_contact_id: ben });
    expect(creates.map((c) => c.given_name)).toEqual(["Cara📚", "Dee📚"]);
    expect(creates[0]).toEqual({ given_name: "Cara📚", family_name: "New", phones: [{ e164: "+14155550103", label: "mobile" }], emails: [{ email: "cara@x.co", label: "home" }], groups: ["Book club"] });
    expect(creates[1]).toMatchObject({ phones: [], emails: [{ email: "dee@x.co", label: "home" }] });
    expect(r.json.skipped.map((s: any) => s.reason)).toEqual(expect.arrayContaining([expect.stringMatching(/No usable phone number or email/), expect.stringMatching(/Duplicate|Same person/)]));
    expect(r.json.counts).toMatchObject({ auto_queued: 2 });
    expect(r.json.import_id).toBe(importId);
    expect(db.query("SELECT source, status, title FROM contact_change_sets WHERE id = ?").get(r.json.set_id)).toEqual({ source: "import", status: "review", title: "Contacts from people.csv" });
  });

  test("idempotent: a given name that already starts with the prefix and ends with the suffix is skipped as already done", async () => {
    const { db, app, ann, importId } = await seeded();
    const first = await post(app, `/v1/imports/${importId}/contact-changes`, { first_name_suffix: "📚" });
    expect(first.status).toBe(201);
    // ... what the executor's export would do after applying: the cache card now has the suffix
    db.query("UPDATE contacts SET given_name = 'Ann📚' WHERE id = ?").run(ann);
    const again = await post(app, `/v1/imports/${importId}/contact-changes`, { first_name_suffix: "📚", include: [0, 1] });
    expect(again.status).toBe(400);
    expect(again.json.error.code).toBe("no_changes");
    expect(again.json.error.details.skipped).toEqual([{ row_index: 0, reason: "Already done" }, { row_index: 1, reason: "Already done" }]);
    // a prefix works the same way
    const pre = await post(app, `/v1/imports/${importId}/contact-changes`, { first_name_prefix: "Dr ", include: [0] });
    expect(JSON.parse((db.query("SELECT payload_json FROM contact_changes WHERE set_id = ?").get(pre.json.set_id) as any).payload_json)).toEqual({ set: { given_name: "Dr Ann📚" } });
  });

  test("a new row whose sheet name already has the suffix (or prefix) doesn't get it twice", async () => {
    const { db, app } = await seeded();
    const imp = await post(app, "/v1/imports", { text: "Name,Phone\nEve📚 Club,415-555-0109\nZoFay Club,415-555-0110", kind: "csv", filename: "tagged.csv" });
    const r = await post(app, `/v1/imports/${imp.json.import_id}/contact-changes`, { first_name_suffix: "📚" });
    const pre = await post(app, `/v1/imports/${imp.json.import_id}/contact-changes`, { first_name_prefix: "Zo", include: [1] });
    const given = (setId: string) => (db.query("SELECT payload_json FROM contact_changes WHERE set_id = ? ORDER BY position").all(setId) as any[])
      .map((x) => JSON.parse(x.payload_json).given_name);
    expect(given(r.json.set_id)).toEqual(["Eve📚", "ZoFay📚"]);
    expect(given(pre.json.set_id)).toEqual(["ZoFay"]);
  });

  test("no prefix or suffix: matched rows have nothing to change, new rows are created as they are; include limits the rows", async () => {
    const { app, importId } = await seeded();
    const r = await post(app, `/v1/imports/${importId}/contact-changes`, { title: "Plain" });
    expect(r.json.changes.map((c: any) => c.kind)).toEqual(["create", "create"]);
    expect(r.json.skipped.find((s: any) => s.row_index === 0).reason).toBe("No name change asked for");
    const only = await post(app, `/v1/imports/${importId}/contact-changes`, { include: [3] });
    expect(only.json.changes).toHaveLength(1);
  });

  test("unusable input: unknown import, an over-long name, an invalid prefix", async () => {
    const { app, importId } = await seeded();
    expect((await post(app, "/v1/imports/nope/contact-changes", {})).status).toBe(404);
    const long = await post(app, `/v1/imports/${importId}/contact-changes`, { first_name_suffix: "📚".repeat(60) });
    expect(long.status).toBe(400);
    const badChar = await post(app, `/v1/imports/${importId}/contact-changes`, { first_name_suffix: "\u202E" });
    expect(badChar.json.error.message).toMatch(/direction-override/);
    expect((await post(app, `/v1/imports/${importId}/contact-changes`, { first_name_suffix: "x", kind: "undo" })).status).toBe(400); // strict
  });
});

// ---------------------------------------------------------------------------------------------- MCP and CLI
describe("MCP tools and CLI verbs", () => {
  async function connect() {
    const { db, app } = await setup();
    const mcp = createOutboxMcpServer({ label: "mcp-cc", fetchImpl: (url, init) => Promise.resolve(app.fetch(new Request(url, init))) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([mcp.connect(a), client.connect(b)]);
    return { db, app, client };
  }
  const textOf = (r: any): string => r.content.map((c: any) => c.text).join("\n");
  const jsonOf = (r: any) => JSON.parse(textOf(r).slice(textOf(r).indexOf("{")));

  test("descriptions say plainly: new contacts are automatic after a duplicate check, edits wait for Touch ID, the user can undo, you can't approve", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const d = Object.fromEntries(tools.map((t) => [t.name, t.description ?? ""]));
    for (const n of ["outbox_propose_contacts", "outbox_contacts_from_import"]) {
      expect(d[n]).toContain("added to the user's Contacts automatically");
      expect(d[n]).toContain("live duplicate check");
      expect(d[n]).toContain("Touch ID approval");
      expect(d[n]).toContain("can undo any change");
      expect(d[n]).toContain("You cannot approve, apply or undo");
      // fix round: what waits for the owner even though it is a new contact
      expect(d[n]).toContain("only a first or only a last name");
      expect(d[n]).toContain("looks like one already in Contacts");
      expect(d[n]).toContain("joins a Contacts group that already exists");
      expect(d[n]).toContain("invisible characters");
    }
    expect(d.outbox_contacts_from_import).toContain("first_name_suffix");
    expect(d.outbox_propose_contacts).toMatch(/100 characters/);
    expect(tools.find((t) => t.name === "outbox_get_contact_changes")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "outbox_propose_contacts")?.annotations?.readOnlyHint).toBe(false);
  });

  test("propose -> get -> list, import -> contact changes, and errors come back as tool errors", async () => {
    const { db, client } = await connect();
    const id = seedContact(db, { name: "Sam Lee", given: "Sam", family: "Lee", phones: [{ e164: "+12025550009", label: "mobile" }] });
    const p = await client.callTool({ name: "outbox_propose_contacts", arguments: { title: "Via MCP", creates: [{ given_name: "New", family_name: "Person", phones: ["4155550123"] }], updates: [{ contact_id: id, set: { given_name: "Sam 📚" } }] } }) as any;
    expect(p.isError).toBeFalsy();
    expect(textOf(p)).toMatch(/^Contact change set .*: 1 automatic, 1 waiting for the user's approval, 0 not needed\. Review link: https:\/\/outbox\.test\/#\/contacts\/changes\//);
    const set_id = jsonOf(p).set_id;
    expect(db.query("SELECT created_by, source FROM contact_change_sets WHERE id = ?").get(set_id)).toEqual({ created_by: "agent:mcp-cc", source: "mcp" });
    const g = await client.callTool({ name: "outbox_get_contact_changes", arguments: { set_id } }) as any;
    expect(jsonOf(g).changes.map((c: any) => c.status)).toEqual(["auto_queued", "review"]);
    const l = await client.callTool({ name: "outbox_get_contact_changes", arguments: { status: "review" } }) as any;
    expect(jsonOf(l).sets[0].id).toBe(set_id);
    const bad = await client.callTool({ name: "outbox_propose_contacts", arguments: { title: "Bad", creates: [{ given_name: "A" }] } }) as any;
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("invalid_contact_changes");
    const imp = await client.callTool({ name: "outbox_ingest_file", arguments: { text: "Name,Phone\nPat Q,415-555-0144\n", kind: "csv", filename: "p.csv" } }) as any;
    const fi = await client.callTool({ name: "outbox_contacts_from_import", arguments: { import_id: jsonOf(imp).import_id, first_name_suffix: "📚" } }) as any;
    expect(fi.isError).toBeFalsy();
    expect(jsonOf(fi).counts).toMatchObject({ auto_queued: 1 });
  });

  async function runCli(app: any, args: string[], stdin = "") {
    const out: string[] = []; const e: string[] = [];
    const client = createAgentClient({ client: "cli-cc", source: "cli", fetchImpl: (url, init) => Promise.resolve(app.fetch(new Request(url, init))) });
    const code = await main(args, { out: (s) => out.push(s), err: (s) => e.push(s), readStdin: async () => stdin, client });
    return { code, out: out.join("\n"), err: e.join("\n") };
  }

  test("outbox contacts propose --file / from-import / changes", async () => {
    const { db, app } = await setup();
    const sam = seedContact(db, { name: "Sam Lee", given: "Sam", family: "Lee", phones: [{ e164: "+12025550009", label: "mobile" }] });
    const file = join(tmpDir(), "p.json");
    await Bun.write(file, JSON.stringify({ title: "CLI", creates: [{ given_name: "New", family_name: "Person", phones: ["4155550123"] }], updates: [{ contact_id: sam, set: { given_name: "Sam 📚" } }] }));
    const p = await runCli(app, ["contacts", "propose", "--file", file]);
    expect(p.code).toBe(0);
    expect(p.out).toContain("1 automatic, 1 waiting for the user's approval, 0 not needed");
    expect(p.out).toContain("dashboard: https://outbox.test/#/contacts/changes/");
    const set_id = (db.query("SELECT id FROM contact_change_sets").get() as any).id;
    expect(db.query("SELECT created_by, source FROM contact_change_sets WHERE id = ?").get(set_id)).toEqual({ created_by: "agent:cli-cc", source: "cli" });
    const c = await runCli(app, ["contacts", "changes", set_id]);
    expect(c.out).toContain("CLI  [review]");
    expect(c.out).toContain("Sam Lee");
    expect(c.out).toContain('set given_name="Sam 📚"');
    expect(c.out).toContain("[auto_queued]");
    expect((await runCli(app, ["contacts", "changes"])).out).toContain(set_id);
    expect((await runCli(app, ["contacts", "changes", "--status", "done"])).out).toBe("no contact change sets");
    const j = await runCli(app, ["contacts", "changes", set_id, "--json"]);
    expect(JSON.parse(j.out).set.id).toBe(set_id);
    const imp = await runCli(app, ["import", "-", "--kind", "csv", "--filename", "p.csv", "--json"], "Name,Phone\nPat Q,415-555-0144\n");
    const fi = await runCli(app, ["contacts", "from-import", JSON.parse(imp.out).import_id, "--suffix", "📚", "--group", "Book club", "--group", "Two"]);
    expect(fi.code).toBe(0);
    expect(fi.out).toContain("1 automatic");
    const created = JSON.parse((db.query("SELECT payload_json FROM contact_changes WHERE set_id <> ? AND kind = 'create'").get(set_id) as any).payload_json);
    expect(created).toMatchObject({ given_name: "Pat📚", groups: ["Book club", "Two"] });
    // usage and errors
    expect((await runCli(app, ["contacts", "propose"])).code).toBe(2);
    expect((await runCli(app, ["contacts", "propose", "--file", "-"], "{oops")).code).toBe(2);
    expect((await runCli(app, ["contacts", "from-import"])).code).toBe(2);
    const bad = await runCli(app, ["contacts", "propose", "--file", "-"], JSON.stringify({ title: "x", creates: [{ given_name: "A" }] }));
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("invalid_contact_changes");
    expect((await runCli(app, ["help"])).out).toMatch(/contacts propose --file/);
  });
});

// ---------------------------------------------------------------------------------------------- impersonation guards (fix round 2026-11-10)
describe("invisible characters, email length and undo fingerprints are refused", () => {
  const ok = { given_name: "Ana", family_name: "Ruiz", phones: ["415 555 0123"] };
  const invisible = ["­", "͏", "؜", "ᅟ", "ᅠ", "឴", "឵", "᠋", "᠍", "᠏", "​", "‌", "‎", "‏",
    "⁠", "⁢", "⁯", "ㅤ", "︀", "︎", "﻿", "ﾠ", "\u{E0001}", "\u{E0020}", "\u{E0FFF}"];

  test("every default-ignorable code point on the list is refused in names, nicknames, orgs, groups and edit fields", () => {
    for (const ch of invisible) {
      const label = `U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`;
      for (const make of [
        () => validateCreate({ ...ok, given_name: `Al${ch}ice` }),
        () => validateCreate({ ...ok, family_name: `${ch}Smith` }),
        () => validateCreate({ ...ok, nickname: `Al${ch}` }),
        () => validateCreate({ ...ok, org: `Acme${ch}` }),
        () => validateCreate({ ...ok, groups: [`Fam${ch}`] }),
        () => validateUpdate({ set: { given_name: `A${ch}` } }),
        () => validateUpdate({ add_groups: [`G${ch}`] }),
      ]) expect([label, err(make)]).toEqual([label, expect.stringMatching(/contains an invisible character/)]);
    }
    // a name that is ONLY an invisible character: trim() doesn't remove it, the check does
    expect(err(() => validateCreate({ ...ok, given_name: "ㅤ" }))).toMatch(/invisible/);
  });

  test("ZWJ (U+200D) and VS16 (U+FE0F) stay allowed, so emoji sequences work; the control and bidi bans are unchanged", () => {
    expect(validateCreate({ ...ok, given_name: "Ana 👩‍👩‍👧" }).given_name).toBe("Ana 👩‍👩‍👧");
    expect(validateCreate({ ...ok, family_name: "Ruiz ❤️" }).family_name).toBe("Ruiz ❤️");
    expect(err(() => validateCreate({ ...ok, given_name: "Ana‮" }))).toMatch(/direction-override/);
    expect(err(() => validateCreate({ ...ok, given_name: "Ana\u0007" }))).toMatch(/control/);
  });

  test("emails are at most 254 characters", () => {
    const at254 = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`; // 64+1+63+1+63+1+57+4 = 254
    expect(at254).toHaveLength(254);
    expect(validateCreate({ ...ok, emails: [at254] }).emails[0]!.email).toBe(at254);
    const at255 = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(58)}.com`;
    expect(err(() => validateCreate({ ...ok, emails: [at255] }))).toMatch(/longer than 254|isn't a valid email/);
    expect(err(() => validateUpdate({ add_emails: [at255] }))).toMatch(/longer than 254|isn't a valid email/);
  });

  test("an undo's after_fingerprint must be 64 lowercase hex characters (empty and uppercase are refused)", () => {
    const base = { undo_of: "c", undo_kind: "update", before_vcard_sha256: null };
    expect(() => validateUndo({ ...base, after_fingerprint: "a".repeat(64) })).not.toThrow();
    for (const fp of ["", "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), 5, null]) {
      expect([String(fp), err(() => validateUndo({ ...base, after_fingerprint: fp }))]).toEqual([String(fp), expect.stringMatching(/after_fingerprint must be 64 lowercase hex/)]);
    }
  });
});

describe("auto creates that could impersonate someone wait for the user", () => {
  const person = (extra: object = {}) => ({ given_name: "Dana", family_name: "Wells", phones: ["4155550444"], ...extra });
  const setNick = (db: any, id: string, nick: string) => db.query("UPDATE contacts SET nickname = ? WHERE id = ?").run(nick, id);
  const setGroups = (db: any, id: string, groups: string[]) => db.query("INSERT INTO contact_attrs(contact_id, groups_json) VALUES (?,?)").run(id, JSON.stringify(groups));
  const only = async (app: any, body: object) => { const r = await post(app, "/v1/contact-changes", { title: "T", ...body }); expect(r.status).toBe(201); return r.json; };

  test("a clean two-name create is still automatic", async () => {
    const { db, app } = await setup();
    seedContact(db, { name: "Alice Smith", given: "Alice", family: "Smith", phones: [{ e164: "+12025550001", label: "mobile" }] });
    const r = await only(app, { creates: [person()] });
    expect(r.changes[0]).toMatchObject({ kind: "create", status: "auto_queued", note: "" });
    expect(r.status).toBe("drafting");
  });

  test("only one name (given or family) -> review as a create, requires_approval 1, note 'only one name; please check'", async () => {
    const { db, app } = await setup();
    const r = await only(app, { creates: [{ given_name: "Dana", phones: ["4155550444"] }, { family_name: "Wells", phones: ["4155550445"] }] });
    expect(r.changes.map((c: any) => [c.kind, c.status, c.note])).toEqual([["create", "review", "only one name; please check"], ["create", "review", "only one name; please check"]]);
    expect(r.counts).toMatchObject({ auto_queued: 0, review: 2 });
    expect(r.status).toBe("review");
    expect(db.query("SELECT requires_approval, status, kind FROM contact_changes WHERE set_id = ?").all(r.set_id)).toEqual([
      { requires_approval: 1, status: "review", kind: "create" }, { requires_approval: 1, status: "review", kind: "create" }]);
  });

  test("a name that matches a cached contact once emoji, accents and look-alike letters are ignored -> review 'same name as an existing contact'", async () => {
    const { db, app } = await setup();
    seedContact(db, { name: "Alice Smith", given: "Alice", family: "Smith", phones: [{ e164: "+12025550001", label: "mobile" }] });
    seedContact(db, { name: "Jane Doe", given: "Jane", family: "Doe", phones: [{ e164: "+12025550002", label: "mobile" }] });
    const r = await only(app, { creates: [
      { given_name: "Alice📚", family_name: "Smith", phones: ["4155550101"] },      // emoji
      { given_name: "Jаne", family_name: "Doe", phones: ["4155550102"] },      // Cyrillic а
      { given_name: "Álice", family_name: "Smith", phones: ["4155550103"] },        // accent
      { given_name: "alice", family_name: "SMITH", phones: ["4155550104"] },        // case
      { given_name: "Alice", family_name: "Smyth", phones: ["4155550105"] },        // different name: stays automatic
    ] });
    expect(r.changes.map((c: any) => [c.status, c.note])).toEqual([
      ["review", "same name as an existing contact"], ["review", "same name as an existing contact"], ["review", "same name as an existing contact"],
      ["review", "same name as an existing contact"], ["auto_queued", ""],
    ]);
    expect(r.changes.slice(0, 4).every((c: any) => c.kind === "create")).toBe(true);
  });

  test("a nickname that equals a cached contact's full name, first name or nickname -> review; cached contacts outside the address book don't count", async () => {
    const { db, app } = await setup();
    seedContact(db, { name: "Alice Smith", given: "Alice", family: "Smith", phones: [{ e164: "+12025550001", label: "mobile" }] });
    const bob = seedContact(db, { name: "Robert Jones", given: "Robert", family: "Jones", phones: [{ e164: "+12025550002", label: "mobile" }] });
    setNick(db, bob, "Bobby");
    seedContact(db, { name: "Cy Import", given: "Cy", family: "Import", source: "import", macos_id: null, phones: [{ e164: "+12025550003", label: "mobile" }] });
    const r = await only(app, { creates: [
      person({ nickname: "Alice Smith", phones: ["4155550201"] }),
      person({ nickname: "Alice", phones: ["4155550202"] }),
      person({ nickname: "Bоbby", phones: ["4155550203"] }),   // Cyrillic о
      person({ nickname: "Cy Import", phones: ["4155550204"] }),   // only in the import cache
      person({ nickname: "Dani", phones: ["4155550205"] }),
    ] });
    expect(r.changes.map((c: any) => c.status)).toEqual(["review", "review", "review", "auto_queued", "auto_queued"]);
    expect(r.changes[0].note).toBe("same name as an existing contact");
  });

  test("joining a group that exists in the cache (other than 'Outbox imports') -> review 'joins an existing group'", async () => {
    const { db, app } = await setup();
    const a = seedContact(db, { name: "Alice Smith", given: "Alice", family: "Smith", phones: [{ e164: "+12025550001", label: "mobile" }] });
    setGroups(db, a, ["Family", "Outbox imports"]);
    const r = await only(app, { creates: [
      person({ groups: ["Family"], phones: ["4155550301"] }),
      person({ groups: ["family"], phones: ["4155550302"] }),            // case-insensitive
      person({ groups: ["Outbox imports"], phones: ["4155550303"] }),    // the standard group is fine
      person({ groups: ["Brand New"], phones: ["4155550304"] }),         // a group nobody is in yet
    ] });
    expect(r.changes.map((c: any) => [c.status, c.note])).toEqual([
      ["review", "joins an existing group"], ["review", "joins an existing group"], ["auto_queued", ""], ["auto_queued", ""]]);
  });

  test("several reasons are all in the note; a create whose handle is already known still converts to an edit (not a create in review)", async () => {
    const { db, app } = await setup();
    const a = seedContact(db, { name: "Alice Smith", given: "Alice", family: "Smith", phones: [{ e164: "+12025550001", label: "mobile" }] });
    setGroups(db, a, ["Family"]);
    const r = await only(app, { creates: [
      { given_name: "Alice", family_name: "Smith", groups: ["Family"], phones: ["4155550401"] },
      { given_name: "Alicia", phones: ["+12025550001"] },
    ] });
    expect(r.changes[0]).toMatchObject({ kind: "create", status: "review", note: "same name as an existing contact; joins an existing group" });
    expect(r.changes[1]).toMatchObject({ kind: "update", status: "review", note: "already in Contacts" });
  });
});
