import { describe, expect, test } from "bun:test";
import { getBatch, getDrafts } from "../core/store";
import { getImport, ingestFile, setMapping } from "../ingest/ingest";
import { fixture, memDb, seedContact, tmpImportsDir } from "../ingest/testutil";
import { batchFromImport, NoDraftsError, proposedFor, varsForRow } from "./from-import";

const enc = (s: string) => new TextEncoder().encode(s);

function setup() {
  const db = memDb();
  const jane = seedContact(db, { given: "Jane", family: "Smith", phones: ["+13015550123"] });
  const bobOld = seedContact(db, { given: "Bob", family: "Jones", phones: ["+12025550100"] });
  const s = ingestFile(db, { bytes: fixture("google-sheets.csv"), filename: "google-sheets.csv", created_by: "t", importsDir: tmpImportsDir() });
  return { db, s, jane, bobOld };
}
const opts = { title: "Gala invites", template: "Hi {{first_name}}, it's Avi. Coming to the gala, {{ favorite_color | friend }}?", created_by: "agent:test", source: "cli" as const };

describe("batchFromImport", () => {
  test("creates a drafting batch with one draft per usable row", () => {
    const { db, s } = setup();
    const r = batchFromImport(db, s.import_id, opts);
    // rows: Jane(matched) Bob(ambiguous) Alice(new) Carol(new via email) Dan(duplicate) Eve(new)
    expect(r.drafts).toBe(5);
    expect(r.skipped).toEqual([{ row_index: 4, reason: "Duplicate of row 0" }]);
    const batch = getBatch(db, r.batch_id)!;
    expect(batch).toMatchObject({ title: "Gala invites", status: "drafting", source: "cli", created_by: "agent:test", import_id: s.import_id, template: opts.template });
    expect(getDrafts(db, r.batch_id)).toHaveLength(5);
  });

  test("renders the template per row, with standard vars and column slugs", () => {
    const { db, s } = setup();
    const ds = getDrafts(db, batchFromImport(db, s.import_id, opts).batch_id);
    const jane = ds.find((d) => d.recipient_name === "Jane Smith")!;
    expect(jane.body).toBe("Hi Jane, it's Avi. Coming to the gala, blue?");
    const alice = ds.find((d) => d.recipient_name === "Alice Nguyen")!;
    expect(alice.body).toBe("Hi Alice, it's Avi. Coming to the gala, friend?"); // empty column -> fallback
    expect(jane.vars).toMatchObject({ first_name: "Jane", last_name: "Smith", full_name: "Jane Smith", name: "Jane", org: "Acme Corp", favorite_color: "blue", company: "Acme Corp", notes: "Met at the expo, loves coffee" });
  });

  test("draft fields: handle, recipient_name, import link, revision actor 'template', status review", () => {
    const { db, s } = setup();
    const r = batchFromImport(db, s.import_id, opts);
    const d = getDrafts(db, r.batch_id)[0]!;
    expect(d).toMatchObject({ handle: "+13015550123", recipient_name: "Jane Smith", import_id: s.import_id, import_row: 0, service: "auto", status: "review", version: 1 });
    const rev = db.query("SELECT actor FROM draft_revisions WHERE draft_id = ?").all(d.id);
    expect(rev).toEqual([{ actor: "template" }]);
  });

  test("matched rows carry contact_id and no proposed contact", () => {
    const { db, s, jane } = setup();
    const d = getDrafts(db, batchFromImport(db, s.import_id, opts).batch_id)[0]!;
    expect(d.contact_id).toBe(jane);
    expect(d.proposed_contact).toBeNull();
    expect(d.create_contact).toBe(false);
  });

  test("new rows get a proposed contact, create_contact on by default", () => {
    const { db, s } = setup();
    const ds = getDrafts(db, batchFromImport(db, s.import_id, opts).batch_id);
    const alice = ds.find((d) => d.recipient_name === "Alice Nguyen")!;
    expect(alice.contact_id).toBeNull();
    expect(alice.create_contact).toBe(true);
    expect(alice.proposed_contact).toEqual({
      given_name: "Alice", family_name: "Nguyen", org: "Initech",
      phones: [{ e164: "+12025550143", label: "mobile" }], emails: [], note: "Imported from google-sheets.csv", // exactly the draft's handle (contract v2 §4)
    });
    expect(alice.warnings.map((w) => w.code)).toContain("new_contact");
  });

  test("create_new_contacts:false keeps the proposal but turns creation off", () => {
    const { db, s } = setup();
    const ds = getDrafts(db, batchFromImport(db, s.import_id, { ...opts, create_new_contacts: false }).batch_id);
    const alice = ds.find((d) => d.recipient_name === "Alice Nguyen")!;
    expect(alice.proposed_contact).not.toBeNull();
    expect(alice.create_contact).toBe(false);
  });

  test("a new row that only has an email proposes an email-only contact", () => {
    const { db, s } = setup();
    const carol = getDrafts(db, batchFromImport(db, s.import_id, opts).batch_id).find((d) => d.recipient_name === "Carol Diaz")!;
    expect(carol.handle).toBe("carol@example.net");
    expect(carol.proposed_contact).toMatchObject({ phones: [], emails: [{ email: "carol@example.net", label: "other" }] });
  });

  test("ambiguous rows: no contact_id, no proposal, ambiguous_contact warning, candidates in notes", () => {
    const { db, s, bobOld } = setup();
    const bob = getDrafts(db, batchFromImport(db, s.import_id, opts).batch_id).find((d) => d.recipient_name === "Bob Jones")!;
    expect(bob.contact_id).toBeNull();
    expect(bob.proposed_contact).toBeNull();
    expect(bob.warnings.map((w) => w.code)).toContain("ambiguous_contact");
    expect(bob.notes).toContain("Bob Jones");
    expect(bob.notes).toContain("+12025550100");
    expect(bobOld).toBeTruthy();
  });

  test("invalid and duplicate rows are skipped with reasons", () => {
    const db = memDb();
    const s = ingestFile(db, { bytes: enc("Name,Phone\nJane Smith,301-555-0123\nBad Row,nope\nJane Again,301-555-0123\nAl Ng,202-555-0143\n"), filename: "a.csv", created_by: "t", importsDir: tmpImportsDir() });
    const r = batchFromImport(db, s.import_id, { ...opts, template: "Hi {{first_name}}" });
    expect(r.drafts).toBe(2);
    expect(r.skipped).toEqual([{ row_index: 1, reason: "No usable phone number or email" }, { row_index: 2, reason: "Duplicate of row 0" }]);
  });

  test("include limits rows; explicitly included invalid rows are still reported as skipped", () => {
    const { db, s } = setup();
    const r = batchFromImport(db, s.import_id, { ...opts, include: [0, 2] });
    expect(r.drafts).toBe(2);
    expect(r.skipped).toEqual([]);
    expect(getDrafts(db, r.batch_id).map((d) => d.import_row)).toEqual([0, 2]);
    // only a duplicate row selected: nothing to draft, so it is refused (and no empty batch is left behind)
    const before = (db.query("SELECT COUNT(*) AS n FROM batches").get() as any).n;
    expect(() => batchFromImport(db, s.import_id, { ...opts, include: [4] })).toThrow(/No drafts would be created/);
    expect((db.query("SELECT COUNT(*) AS n FROM batches").get() as any).n).toBe(before);
  });

  test("per_row_bodies override the rendered template", () => {
    const { db, s } = setup();
    const r = batchFromImport(db, s.import_id, { ...opts, per_row_bodies: { 0: "Jane, custom note just for you", 5: "Eve: custom too" } });
    const ds = getDrafts(db, r.batch_id);
    expect(ds.find((d) => d.import_row === 0)!.body).toBe("Jane, custom note just for you");
    expect(ds.find((d) => d.import_row === 5)!.body).toBe("Eve: custom too");
    expect(ds.find((d) => d.import_row === 2)!.body).toContain("Hi Alice");
  });

  test("lint runs: unresolved vars are flagged, and the batch stays 'drafting'", () => {
    const { db, s } = setup();
    const r = batchFromImport(db, s.import_id, { ...opts, template: "Hi {{first_name}}, {{nickname}}?" });
    for (const d of getDrafts(db, r.batch_id)) expect(d.warnings.map((w) => w.code)).toContain("unresolved_var");
    expect(getBatch(db, r.batch_id)!.status).toBe("drafting");
  });

  test("empty_var: a blank company with a template that has no fallback", () => {
    const { db, s } = setup();
    const r = batchFromImport(db, s.import_id, { ...opts, template: "Hi {{first_name}}, how is {{org}}?" });
    const ds = getDrafts(db, r.batch_id);
    expect(ds.find((d) => d.recipient_name === "Jane Smith")!.warnings.map((w) => w.code)).not.toContain("empty_var");
    expect(ds.find((d) => d.recipient_name === "Eve Park")!.warnings.map((w) => w.code)).toContain("empty_var");
  });

  test("instructions asking for personalisation flag untouched template copies", () => {
    const { db, s } = setup();
    const r = batchFromImport(db, s.import_id, { ...opts, template: "Join us Friday!", instructions: "Personalise every message" });
    expect(getDrafts(db, r.batch_id)[0]!.warnings.map((w) => w.code)).toContain("identical_to_template");
  });

  test("duplicate recipients across two batches from the same import show pending_elsewhere", () => {
    const { db, s } = setup();
    batchFromImport(db, s.import_id, opts);
    const second = batchFromImport(db, s.import_id, opts);
    expect(getDrafts(db, second.batch_id)[0]!.warnings.map((w) => w.code)).toContain("pending_elsewhere");
  });

  test("after setMapping, a new batch uses the new normalisation", () => {
    const db = memDb();
    const s = ingestFile(db, { bytes: enc("A,B,C\nJane Doe,301-555-0123,x\nBob Jones,301-555-0188,y\nAl Ng,202-555-0143,z\n"), filename: "a.csv", created_by: "t", importsDir: tmpImportsDir() });
    expect(s.needs_confirmation).toBe(true);
    setMapping(db, s.import_id, { fields: { display_name: { column: "A", confidence: 1 }, phone: { column: "B", confidence: 1 } } });
    const r = batchFromImport(db, s.import_id, { ...opts, template: "Hi {{first_name}} ({{c}})" });
    expect(getDrafts(db, r.batch_id).map((d) => d.body)).toEqual(["Hi Jane (x)", "Hi Bob (y)", "Hi Al (z)"]);
  });

  test("an unknown import id throws", () => {
    expect(() => batchFromImport(memDb(), "nope", opts)).toThrow();
  });

  test("a failure midway rolls back: no batch and no drafts are left behind", () => {
    const { db, s } = setup();
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON drafts WHEN NEW.position = 2 BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    expect(() => batchFromImport(db, s.import_id, opts)).toThrow(/boom/);
    expect((db.query("SELECT COUNT(*) AS n FROM batches").get() as any).n).toBe(0);
    expect((db.query("SELECT COUNT(*) AS n FROM drafts").get() as any).n).toBe(0);
  });
});

describe("varsForRow", () => {
  test("standard vars win over a column with the same slug; name falls back to the full name", () => {
    const row = {
      row_index: 0, raw: { Name: "Smith, Jane", Org: "Acme" }, contact_id: null, match: "new" as const, issues: [],
      normalized: { given_name: "Jane", family_name: "Smith", display_name: "Jane Smith", phone_e164: null, email: null, org: "Acme", notes: "", tags: [], handle: "x", handle_kind: "phone" as const, mobile: true, vars: {} },
    };
    const v = varsForRow(row, ["Name", "Org"]);
    expect(v.name).toBe("Jane");
    expect(v.org).toBe("Acme");
    expect(varsForRow({ ...row, normalized: { ...row.normalized, given_name: "" } }, ["Name"]).name).toBe("Jane Smith");
  });

  test("getImport rows carry the vars used above", () => {
    const { db, s } = setup();
    expect(getImport(db, s.import_id).rows[0]!.normalized.vars).toEqual({ favorite_color: "blue" });
  });
});

describe("proposed contacts have exactly one handle, equal to the draft's (contract v2 §4)", () => {
  const OUTLOOK = [
    "First Name,Last Name,E-mail Address,Mobile Phone,Home Phone,Categories,City",
    "Ann,Lee,ann@example.com,(301) 555-0123,202-555-0143,Climbing; Family,Oslo",
    "Ben,Roe,ben@example.com,,,College Friends,Rome",
    "Cat,Poe,,202-555-0188,,,",
  ].join("\n");
  function outlook() {
    const db = memDb();
    const s = ingestFile(db, { bytes: enc(OUTLOOK), filename: "outlook.csv", created_by: "t", importsDir: tmpImportsDir() });
    return { db, s };
  }

  test("a phone row proposes only that phone, even when the row has an email and a second number", () => {
    const { db, s } = outlook();
    const ds = getDrafts(db, batchFromImport(db, s.import_id, { ...opts, template: "Hi {{first_name}}" }).batch_id);
    const ann = ds.find((d) => d.recipient_name === "Ann Lee")!;
    expect(ann.handle).toBe("+13015550123");
    expect(ann.proposed_contact!.phones.map((p) => p.e164)).toEqual([ann.handle]);
    expect(ann.proposed_contact!.emails).toEqual([]);
  });

  test("an email-only row proposes only that email", () => {
    const { db, s } = outlook();
    const ben = getDrafts(db, batchFromImport(db, s.import_id, { ...opts, template: "Hi {{first_name}}" }).batch_id).find((d) => d.recipient_name === "Ben Roe")!;
    expect(ben.handle).toBe("ben@example.com");
    expect(ben.proposed_contact!.phones).toEqual([]);
    expect(ben.proposed_contact!.emails.map((e) => e.email)).toEqual([ben.handle]);
  });

  test("every proposal in the batch satisfies the rule", () => {
    const { db, s } = outlook();
    for (const d of getDrafts(db, batchFromImport(db, s.import_id, { ...opts, template: "Hi" }).batch_id)) {
      const p = d.proposed_contact!;
      expect(p.phones.length + p.emails.length).toBe(1);
      expect([...p.phones.map((x) => x.e164), ...p.emails.map((x) => x.email)]).toEqual([d.handle]);
    }
  });

  test("import tags reach the proposed contact and the draft vars, and city is a var", () => {
    const { db, s } = outlook();
    const ds = getDrafts(db, batchFromImport(db, s.import_id, { ...opts, template: "Hi {{first_name}} in {{city}} ({{tags}})" }).batch_id);
    const ann = ds.find((d) => d.recipient_name === "Ann Lee")!;
    expect(ann.proposed_contact!.tags).toEqual(["Climbing", "Family"]);
    expect(ann.vars.tags).toBe("Climbing, Family");
    expect(ann.body).toBe("Hi Ann in Oslo (Climbing, Family)");
    expect(ds.find((d) => d.recipient_name === "Cat Poe")!.proposed_contact!.tags).toBeUndefined();
  });

  test("proposedFor builds the same shape directly", () => {
    const n = { given_name: "A", family_name: "B", display_name: "A B", phone_e164: "+13015550123", email: "a@b.co", org: "Acme", notes: "", tags: ["x"], handle: "+13015550123", handle_kind: "phone" as const, mobile: true, vars: {} };
    expect(proposedFor(n, "+13015550123", "phone", "n")).toEqual({ given_name: "A", family_name: "B", org: "Acme", phones: [{ e164: "+13015550123", label: "mobile" }], emails: [], note: "n", tags: ["x"] });
    expect(proposedFor(n, "a@b.co", "email", "n").emails).toEqual([{ email: "a@b.co", label: "other" }]);
  });
});

describe("refusals and robustness", () => {
  test("zero drafts: refused with the reasons, and nothing is left behind (NoDraftsError code no_drafts)", () => {
    const db = memDb();
    const s = ingestFile(db, { bytes: enc("Name,Phone\nBad One,nope\nBad Two,123\n"), filename: "a.csv", created_by: "t", importsDir: tmpImportsDir() });
    let err: any;
    try { batchFromImport(db, s.import_id, opts); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(NoDraftsError);
    expect(err.code).toBe("no_drafts");
    expect(err.message).toContain("No usable phone number or email");
    expect(err.skipped).toHaveLength(2);
    expect((db.query("SELECT COUNT(*) AS n FROM batches").get() as any).n).toBe(0);
  });

  test("a lint failure after the commit doesn't throw: the batch exists and the failure is reported", () => {
    const { db, s } = setup();
    db.exec("DROP TABLE sends"); // lintBatch reads it
    const r = batchFromImport(db, s.import_id, opts);
    expect(r.drafts).toBe(5);
    expect(r.lint_error).toMatch(/sends/);
    expect(getBatch(db, r.batch_id)!.status).toBe("drafting");
    expect(getDrafts(db, r.batch_id)).toHaveLength(5);
  });

  test("instructions are stored on the batch", () => {
    const { db, s } = setup();
    const r = batchFromImport(db, s.import_id, { ...opts, instructions: "Invite the gala guests, keep it short" });
    expect(getBatch(db, r.batch_id)!.instructions).toBe("Invite the gala guests, keep it short");
  });

  test("a duplicate person is skipped with a reason naming the kept row", () => {
    const db = memDb();
    const id = seedContact(db, { given: "Jane", family: "Smith", phones: ["+13015550123", "+12025550143"] });
    const s = ingestFile(db, { bytes: enc("Name,Phone\nJane Smith,301-555-0123\nJane Smith,202-555-0143\n"), filename: "a.csv", created_by: "t", importsDir: tmpImportsDir() });
    const r = batchFromImport(db, s.import_id, { ...opts, template: "Hi {{first_name}}" });
    expect(r.drafts).toBe(1);
    expect(r.skipped).toEqual([{ row_index: 1, reason: "Same person as row 0" }]);
    expect(getDrafts(db, r.batch_id)[0]!.contact_id).toBe(id);
  });
});
