// Integration against real modules (skipped if they aren't there). Raw uploads go to a temp dir.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createAgentApp } from "../src/agent-api/app";
import type { BDeps } from "../src/core/deps";
import { call, memDb, seedContact, tmpDir } from "./helpers";

const ROOT = join(import.meta.dir, "..");
const have = ["ingest/normalize", "ingest/ingest", "personalize/from-import", "personalize/lint", "personalize/template"].every((m) => existsSync(join(ROOT, "src", `${m}.ts`)));

describe.skipIf(!have)("agent API with real modules", () => {
  async function setup() {
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
      lintBatch: lint.lintBatch as any, renderTemplate: tpl.renderTemplate as any,
    };
    return { db, app: createAgentApp({ db: () => db, deps: async () => deps, origin: "https://outbox.test" }) };
  }

  test("single draft: real normalizeHandle + lint", async () => {
    const { app } = await setup();
    const r = await call(app, "POST", "/v1/drafts", { to: "(415) 555-2671", body: "Hey {{first_name}}, lunch?" });
    expect(r.status).toBe(201);
    expect(r.json.draft.handle).toBe("+14155552671");
    expect(r.json.warnings.map((w: any) => w.code)).toContain("unresolved_var");
    const bad = await call(app, "POST", "/v1/drafts", { to: "12", body: "x" });
    expect(bad.status).toBe(400);
  });

  test("ingest text → mapping → batch from import → edit → submit, with a matched contact", async () => {
    const { app, db } = await setup();
    seedContact(db, { name: "Ann Lee", given: "Ann", family: "Lee", phones: [{ e164: "+14155552671", label: "mobile" }] });
    const csv = "First Name,Last Name,Mobile,City\nAnn,Lee,(415) 555-2671,Oslo\nBob,Roe,415-555-0134,Rome\nBad,Row,nope,Nowhere\n";
    const i = await call(app, "POST", "/v1/imports", { text: csv, kind: "csv" });
    expect(i.status).toBe(201);
    expect(i.json.counts.matched).toBe(1);
    expect(i.json.counts.invalid).toBe(1);
    const id = i.json.import_id;
    const g = await call(app, "GET", `/v1/imports/${id}`);
    expect(g.json.rows.length).toBe(3);
    const m = await call(app, "PUT", `/v1/imports/${id}/mapping`, { fields: { phone: { column: "Mobile" } }, vars: { city: "City" } });
    expect(m.status).toBe(200);
    expect((await call(app, "PUT", `/v1/imports/${id}/mapping`, { fields: { phone: { column: "Nope" } } })).status).toBe(400);
    const b = await call(app, "POST", `/v1/imports/${id}/batch`, { title: "Hellos", template: "Hi {{first_name|there}}, how's {{city}}?", per_row_bodies: { "1": "Bob! Rome still treating you well?" } });
    expect(b.status).toBe(201);
    expect(b.json.drafts_created).toBe(2);
    expect(b.json.skipped).toHaveLength(1);
    expect(b.json.drafts.map((d: any) => d.body)).toEqual(["Hi Ann, how's Oslo?", "Bob! Rome still treating you well?"]);
    expect(b.json.batch.status).toBe("drafting");
    const bid = b.json.batch.id;
    const up = await call(app, "PATCH", `/v1/drafts/${b.json.drafts[0].id}`, { body: "Ann! How's Oslo?" });
    expect(up.json.draft.version).toBe(2);
    const s = await call(app, "POST", `/v1/batches/${bid}/submit`);
    expect(s.json.batch.status).toBe("review");
    expect(s.json.dashboard_url).toBe(`https://outbox.test/#/batch/${bid}`);
    expect((await call(app, "GET", "/v1/imports/does-not-exist")).status).toBe(404);
  });

  test("a group member whose contact lost the number is not labelled with the old name without a warning, even after a re-lint", async () => {
    const { app, db } = await setup();
    const alice = seedContact(db, { name: "Alice Ng", phones: [{ e164: "+14155550101", label: "mobile" }] });
    const sam = seedContact(db, { name: "Sam Fox", phones: [{ e164: "+14155550102", label: "mobile" }] });
    const bob = seedContact(db, { name: "Bob Roe", phones: [{ e164: "+14155550199", label: "mobile" }] });
    const H = { "X-Outbox-Client": "g-test" };
    await call(app, "POST", "/v1/groups", { name: "Crew", contact_ids: [alice, sam] }, H);
    // a contacts sync moves Alice's old number to Bob and gives her a new one
    db.query("DELETE FROM contact_handles WHERE contact_id = ?").run(alice);
    db.query("INSERT INTO contact_handles(handle, contact_id) VALUES ('+14155550101', ?), ('+14155550177', ?)").run(bob, alice);
    const r = await call(app, "POST", "/v1/groups/Crew/batch", { title: "t", template: "Hi {{first_name|there}}" }, H);
    expect(r.status).toBe(201);
    const a = r.json.drafts.find((d: any) => d.handle === "+14155550101");
    const s = r.json.drafts.find((d: any) => d.handle === "+14155550102");
    expect(a.recipient_name).toBe("Alice Ng");
    expect(a.warnings.map((w: any) => w.code)).toContain("group_contact_changed");
    expect(a.warnings.find((w: any) => w.code === "group_contact_changed").message).toContain("now listed under Bob Roe");
    expect(s.warnings.map((w: any) => w.code)).not.toContain("group_contact_changed");
    expect(r.json.warnings.filter((w: any) => w.code === "group_contact_changed")).toHaveLength(1);
    // the warning survives the next lint (server start, edits)
    const lint = await import("../src/personalize/lint");
    lint.lintBatch(db, r.json.batch.id);
    const again = await call(app, "GET", `/v1/batches/${r.json.batch.id}`, undefined, H);
    expect(again.json.warnings.filter((w: any) => w.code === "group_contact_changed")).toHaveLength(1);
  });

  test("batch items with a template use the real renderTemplate", async () => {
    const { app } = await setup();
    const r = await call(app, "POST", "/v1/batches", { title: "T", template: "Hi {{first_name|there}} from {{org|nowhere}}", items: [{ to: "4155550134" }, { to: "4155550135", recipient_name: "Cy Dee" }] });
    expect(r.status).toBe(201);
    expect(r.json.drafts.map((d: any) => d.body)).toEqual(["Hi there from nowhere", "Hi Cy from nowhere"]);
  });
});
