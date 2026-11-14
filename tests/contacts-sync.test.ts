import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { contactAttrs, contactVars, startContactsWatcher, syncContactsExport } from "../src/core/contacts-sync";
import { addDraft, createBatch } from "../src/core/store";
import { fakeHandle, memDb, seedContact, tmpDir } from "./helpers";

const normalizePhone = (raw: string) => {
  const h = fakeHandle(raw);
  return { e164: h.kind === "phone" ? h.handle : null, valid: h.kind === "phone", mobile: h.mobile, raw };
};
const FIXTURE = (contacts: any[]) => JSON.stringify({ exported_at: "2026-11-10T00:00:00Z", contacts });
async function write(contacts: any[]): Promise<string> {
  const p = join(tmpDir(), "contacts-export.json");
  await Bun.write(p, FIXTURE(contacts));
  return p;
}
const sam = { macos_id: "A1:ABPerson", given_name: "Sam", family_name: "Lee", nickname: "", org: "Acme", phones: [{ raw: "(202) 555-0009", label: "_$!<Mobile>!$_" }, { raw: "202-555-0009", label: "home" }, { raw: "junk", label: "other" }], emails: [{ email: "Sam@Lee.io", label: "work" }, { email: "not-an-email", label: "" }] };
const ann = { macos_id: "B2:ABPerson", given_name: "", family_name: "", nickname: "", org: "Ann's Bakery", phones: [{ raw: "415-123-0001", label: "work" }], emails: [] };

const handles = (db: any, id: string) => (db.query("SELECT handle FROM contact_handles WHERE contact_id = ? ORDER BY handle").all(id) as any[]).map((r) => r.handle);
const byMacos = (db: any, m: string) => db.query("SELECT * FROM contacts WHERE macos_id = ?").get(m) as any;

describe("syncContactsExport", () => {
  test("inserts new contacts, normalises phones, dedupes, builds handles, cleans labels", async () => {
    const db = memDb();
    const s = await syncContactsExport(db, { path: await write([sam, ann]), normalizePhone });
    expect(s).toMatchObject({ total: 2, added: 2, updated: 0, unchanged: 0, removed: 0, invalid_phones: 1 });
    const c = byMacos(db, sam.macos_id);
    expect(c.source).toBe("macos");
    expect(c.display_name).toBe("Sam Lee");
    expect(JSON.parse(c.phones_json)).toEqual([{ e164: "+12025550009", label: "mobile", raw: "(202) 555-0009" }]);
    expect(JSON.parse(c.emails_json)).toEqual([{ email: "sam@lee.io", label: "work" }]);
    expect(handles(db, c.id)).toEqual(["+12025550009", "sam@lee.io"]);
    expect(byMacos(db, ann.macos_id).display_name).toBe("Ann's Bakery"); // org fallback
    expect((db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'contacts.sync'").get() as any).n).toBe(1);
  });

  test("re-import is idempotent; changed fields update and handles are rebuilt; owner tags and notes survive", async () => {
    const db = memDb();
    await syncContactsExport(db, { path: await write([sam, ann]), normalizePhone });
    const id = byMacos(db, sam.macos_id).id;
    db.query("UPDATE contacts SET tags_json = '[\"climbing\"]', notes = 'mine' WHERE id = ?").run(id);
    const same = await syncContactsExport(db, { path: await write([sam, ann]), normalizePhone });
    expect(same).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
    const changed = { ...sam, family_name: "Leigh", phones: [{ raw: "303-555-0123", label: "iPhone" }], emails: [] };
    const s = await syncContactsExport(db, { path: await write([changed, ann]), normalizePhone });
    expect(s).toMatchObject({ added: 0, updated: 1, unchanged: 1 });
    const c = byMacos(db, sam.macos_id);
    expect(c.id).toBe(id);
    expect(c.display_name).toBe("Sam Leigh");
    expect(c.tags_json).toBe('["climbing"]');
    expect(c.notes).toBe("mine");
    expect(handles(db, id)).toEqual(["+13035550123"]); // old phone and email handles are gone
  });

  test("vanished contacts: unreferenced are deleted, referenced are kept, tagged `removed`, and unmatchable", async () => {
    const db = memDb();
    await syncContactsExport(db, { path: await write([sam, ann]), normalizePhone });
    const samId = byMacos(db, sam.macos_id).id, annId = byMacos(db, ann.macos_id).id;
    const b = createBatch(db, { title: "t", created_by: "agent:x", source: "mcp", status: "review" });
    addDraft(db, b, { handle: "+12025550009", body: "hi", contact_id: samId, actor: "agent" });
    // an import row referencing ann, too
    db.query("INSERT INTO imports(id, filename, sha256, kind, stored_path, created_by, created_at) VALUES ('i','f','s','csv','p','x','t')").run();
    const keep = seedContact(db, { name: "Imported Person", source: "import", macos_id: null, phones: [{ e164: "+19995550000", label: "mobile" }] });

    const s = await syncContactsExport(db, { path: await write([{ ...ann, macos_id: "C3:ABPerson" }]), normalizePhone });
    // sam: referenced by a draft -> kept; ann (B2) vanished and unreferenced -> deleted
    expect(s).toMatchObject({ added: 1, removed: 1, kept_removed: 1 });
    expect(db.query("SELECT 1 FROM contacts WHERE id = ?").get(annId)).toBeNull();
    expect(handles(db, annId)).toEqual([]);
    const kept = db.query("SELECT * FROM contacts WHERE id = ?").get(samId) as any;
    expect(JSON.parse(kept.tags_json)).toEqual(["removed"]);
    expect(handles(db, samId)).toEqual([]);
    expect(db.query("SELECT 1 FROM contacts WHERE id = ?").get(keep)).toBeTruthy(); // non-macos contact untouched

    // an import_rows reference also protects a contact
    const c3 = (db.query("SELECT id FROM contacts WHERE macos_id = 'C3:ABPerson'").get() as any).id;
    db.query("INSERT INTO import_rows(import_id, row_index, raw_json, contact_id, match) VALUES ('i', 0, '{}', ?, 'matched')").run(c3);
    const s2 = await syncContactsExport(db, { path: await write([sam]), normalizePhone });
    expect(s2.kept_removed).toBe(1); // c3 vanished but is referenced -> kept; sam is back, so its tag clears
    expect(JSON.parse((db.query("SELECT tags_json FROM contacts WHERE id = ?").get(samId) as any).tags_json)).toEqual([]);
    expect(db.query("SELECT 1 FROM contacts WHERE id = ?").get(c3)).toBeTruthy();
  });

  test("a contact that reappears loses the `removed` tag and regains its handles", async () => {
    const db = memDb();
    await syncContactsExport(db, { path: await write([sam]), normalizePhone });
    const id = byMacos(db, sam.macos_id).id;
    const b = createBatch(db, { title: "t", created_by: "agent:x", source: "mcp", status: "review" });
    addDraft(db, b, { handle: "+12025550009", body: "hi", contact_id: id, actor: "agent" });
    await syncContactsExport(db, { path: await write([ann]), normalizePhone });
    expect(JSON.parse(byMacos(db, sam.macos_id).tags_json)).toEqual(["removed"]);
    const s = await syncContactsExport(db, { path: await write([sam, ann]), normalizePhone });
    expect(s.updated).toBe(1);
    expect(JSON.parse(byMacos(db, sam.macos_id).tags_json)).toEqual([]);
    expect(handles(db, id)).toEqual(["+12025550009", "sam@lee.io"]);
  });

  test("an empty export never deletes anything; a malformed one throws", async () => {
    const db = memDb();
    await syncContactsExport(db, { path: await write([sam]), normalizePhone });
    const s = await syncContactsExport(db, { path: await write([]), normalizePhone });
    expect(s.removed + s.kept_removed).toBe(0);
    expect(s.skipped_deletion).toContain("no contacts");
    expect(byMacos(db, sam.macos_id)).toBeTruthy();
    const bad = join(tmpDir(), "bad.json");
    await Bun.write(bad, JSON.stringify({ contacts: [{ given_name: "x" }] }));
    await expect(syncContactsExport(db, { path: bad, normalizePhone })).rejects.toThrow("malformed");
    await Bun.write(bad, "{not json");
    await expect(syncContactsExport(db, { path: bad, normalizePhone })).rejects.toThrow();
  });

  test("a contact created by the executor (source import, macos_id set later) is updated, not duplicated, and never deleted", async () => {
    const db = memDb();
    seedContact(db, { name: "Pat Q", given: "Pat", family: "Q", source: "import", macos_id: "P9:ABPerson", phones: [{ e164: "+12025550123", label: "mobile" }] });
    await syncContactsExport(db, { path: await write([{ macos_id: "P9:ABPerson", given_name: "Pat", family_name: "Quinn", nickname: "", org: "", phones: [{ raw: "202-555-0123", label: "mobile" }], emails: [] }]), normalizePhone });
    expect((db.query("SELECT COUNT(*) AS n FROM contacts").get() as any).n).toBe(1);
    expect(byMacos(db, "P9:ABPerson").display_name).toBe("Pat Quinn");
    expect(byMacos(db, "P9:ABPerson").source).toBe("import");
    await syncContactsExport(db, { path: await write([ann]), normalizePhone });
    expect(byMacos(db, "P9:ABPerson")).toBeTruthy();
  });
});

describe("startContactsWatcher", () => {
  test("imports at start, again only when the file changes, and survives a bad file", async () => {
    const db = memDb();
    const dir = tmpDir(); const file = join(dir, "contacts-export.json");
    const logs: string[] = [];
    await Bun.write(file, FIXTURE([sam]));
    const w = startContactsWatcher({ db, path: file, intervalMs: 3_600_000, log: (m) => logs.push(m), syncOptions: { normalizePhone } });
    await Bun.sleep(30);
    expect((db.query("SELECT COUNT(*) AS n FROM contacts").get() as any).n).toBe(1);
    expect(await w.check()).toBeNull(); // unchanged mtime and size
    await Bun.write(file, FIXTURE([sam, ann]));
    const r = await w.check();
    expect(r?.added).toBe(1);
    await Bun.write(file, "garbage that is longer");
    expect(await w.check()).toBeNull();
    expect(logs.some((l) => l.includes("import failed"))).toBe(true);
    expect(await w.check()).toBeNull(); // not retried (and not re-logged) until the file changes
    expect(logs.filter((l) => l.includes("import failed"))).toHaveLength(1);
    await Bun.write(file, FIXTURE([sam]));
    expect((await w.check())?.total).toBe(1);
    w.stop();
  });

  test("a missing file is not an error", async () => {
    const w = startContactsWatcher({ db: memDb(), path: join(tmpDir(), "nope.json"), intervalMs: 3_600_000, log: () => {}, syncOptions: { normalizePhone } });
    expect(await w.check()).toBeNull();
    w.stop();
  });
});

describe("groups, city and birthday from a newer executor", () => {
  const jo = { macos_id: "J1:ABPerson", given_name: "Jo", family_name: "Park", nickname: "", org: "", phones: [{ raw: "(415) 123-0001", label: "iPhone" }], emails: [], groups: ["College Friends", "Climbing", "college friends"], city: "Boston", birthday: "1998-03-14" };
  const tags = (db: any, m: string) => JSON.parse(byMacos(db, m).tags_json) as string[];

  test("groups become tags (case-insensitive dedupe); city and birthday become vars on the contact", async () => {
    const db = memDb();
    await syncContactsExport(db, { path: await write([jo]), normalizePhone });
    const c = byMacos(db, jo.macos_id);
    expect(tags(db, jo.macos_id)).toEqual(["College Friends", "Climbing"]);
    expect(contactVars(db, c.id)).toEqual({ city: "Boston", birthday: "1998-03-14" });
    expect(contactAttrs(db, c.id).groups).toEqual(["College Friends", "Climbing"]);
  });

  test("a birthday given as components is formatted; a year-less one keeps the '--MM-DD' form", async () => {
    const db = memDb();
    await syncContactsExport(db, { path: await write([jo, { ...sam, birthday: { month: 7, day: 4 } }, { ...ann, birthday: { year: 1990, month: 12, day: 25 }, city: null }]), normalizePhone });
    expect(contactVars(db, byMacos(db, sam.macos_id).id)).toEqual({ birthday: "--07-04" });
    expect(contactVars(db, byMacos(db, ann.macos_id).id)).toEqual({ birthday: "1990-12-25" });
  });

  test("an older executor (no groups/city/birthday keys) changes nothing: tags and vars stay", async () => {
    const db = memDb();
    await syncContactsExport(db, { path: await write([jo]), normalizePhone });
    const { groups: _g, city: _c, birthday: _b, ...old } = jo;
    const s = await syncContactsExport(db, { path: await write([old]), normalizePhone });
    expect(s).toMatchObject({ unchanged: 1, updated: 0 });
    expect(tags(db, jo.macos_id)).toEqual(["College Friends", "Climbing"]);
    expect(contactVars(db, byMacos(db, jo.macos_id).id)).toEqual({ city: "Boston", birthday: "1998-03-14" });
  });

  test("leaving a group removes just that tag; the user's own tags survive; explicit nulls clear the vars", async () => {
    const db = memDb();
    await syncContactsExport(db, { path: await write([jo]), normalizePhone });
    const id = byMacos(db, jo.macos_id).id;
    db.query("UPDATE contacts SET tags_json = ? WHERE id = ?").run(JSON.stringify(["College Friends", "Climbing", "my-own-tag"]), id);
    const s = await syncContactsExport(db, { path: await write([{ ...jo, groups: ["Climbing", "Roommates"], city: null, birthday: null }]), normalizePhone });
    expect(s.updated).toBe(1);
    expect(tags(db, jo.macos_id)).toEqual(["my-own-tag", "Climbing", "Roommates"]);
    expect(contactVars(db, id)).toEqual({});
    // an empty groups list clears all group tags but not the user's
    await syncContactsExport(db, { path: await write([{ ...jo, groups: [], city: undefined, birthday: undefined }]), normalizePhone });
    expect(tags(db, jo.macos_id)).toEqual(["my-own-tag"]);
  });

  test("an unchanged re-export is unchanged; a changed group list alone counts as an update", async () => {
    const db = memDb();
    await syncContactsExport(db, { path: await write([jo]), normalizePhone });
    expect(await syncContactsExport(db, { path: await write([jo]), normalizePhone })).toMatchObject({ unchanged: 1, updated: 0 });
    expect(await syncContactsExport(db, { path: await write([{ ...jo, groups: ["Climbing"] }]), normalizePhone })).toMatchObject({ unchanged: 0, updated: 1 });
  });

  test("deleting a vanished contact cascades its extra attributes", async () => {
    const db = memDb();
    await syncContactsExport(db, { path: await write([jo, ann]), normalizePhone });
    const id = byMacos(db, jo.macos_id).id;
    await syncContactsExport(db, { path: await write([ann]), normalizePhone });
    expect(db.query("SELECT 1 FROM contact_attrs WHERE contact_id = ?").get(id)).toBeNull();
  });

  test("contactVars on a database that never saw those fields is just empty", () => {
    expect(contactVars(memDb(), "nope")).toEqual({});
  });
});
