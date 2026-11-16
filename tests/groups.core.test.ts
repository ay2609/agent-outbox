// Saved groups, the core module: names, dedupe, limits, contact deletion, refs by name, import rows, batch items.
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { newId, nowIso } from "../src/db";
import {
  GroupError, MAX_DESCRIPTION, MAX_GROUPS, MAX_MEMBERS, MAX_NAME, addMembers, cleanName, createGroup, deleteGroup, getGroup, itemsForBatch,
  listGroups, membersFromContactIds, membersFromImport, nameKey, removeMembers, resolveGroup, updateGroup,
} from "../src/core/groups";
import { fakeHandle, memDb, seedContact } from "./helpers";

const deps = { normalizeHandle: fakeHandle };
const A = "agent:test";
let db: Database;
beforeEach(() => { db = memDb(); });

const err = (fn: () => unknown): GroupError => { try { fn(); } catch (e) { if (e instanceof GroupError) return e; throw e; } throw new Error("expected a GroupError"); };
const mk = (name = "Book club") => createGroup(db, { name, actor: A });

describe("groups: names", () => {
  test("cleanName collapses spaces, and limits length and control characters", () => {
    expect(cleanName("  Book   club ")).toBe("Book club");
    expect(nameKey("  Book   CLUB ")).toBe("book club");
    expect(() => cleanName("   ")).toThrow(GroupError);
    expect(() => cleanName("x".repeat(MAX_NAME + 1))).toThrow(/at most 80/);
    expect(cleanName("x".repeat(MAX_NAME))).toHaveLength(MAX_NAME);
    expect(() => cleanName("a​b")).toThrow(/invisible/);
    expect(cleanName("Climbing 🧗")).toBe("Climbing 🧗");
  });

  test("create: unique case-insensitively, 409 with the existing id; description limit", () => {
    const g = createGroup(db, { name: "Book club", description: " Thursday readers ", actor: A, createdBy: "cli" });
    expect(g).toMatchObject({ name: "Book club", description: "Thursday readers", members: 0, created_by: "cli" });
    const e = err(() => createGroup(db, { name: "  BOOK  club", actor: A }));
    expect(e.status).toBe(409); expect(e.code).toBe("group_exists"); expect(e.details).toEqual({ id: g.id });
    expect(err(() => createGroup(db, { name: "x", description: "d".repeat(MAX_DESCRIPTION + 1), actor: A })).status).toBe(400);
    expect(db.query("SELECT COUNT(*) AS n FROM contact_groups").get()).toEqual({ n: 1 });
  });

  test("at most 500 groups", () => {
    const t = nowIso();
    for (let i = 0; i < MAX_GROUPS; i++) db.query("INSERT INTO contact_groups(id,name,name_key,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(newId(), `g${i}`, `g${i}`, A, t, t);
    const e = err(() => mk("one too many"));
    expect(e.code).toBe("group_limit");
  });

  test("a group is found by id or by exact name in any capitalisation", () => {
    const g = mk("Book club");
    expect(resolveGroup(db, g.id)?.id).toBe(g.id);
    expect(resolveGroup(db, "book CLUB")?.id).toBe(g.id);
    expect(resolveGroup(db, "book")).toBeNull();
    expect(err(() => getGroup(db, "nope")).status).toBe(404);
  });

  test("rename: 409 onto another group's name, ok to change only the capitalisation; description; audit", () => {
    const a = mk("Book club"); const b = mk("Climbing");
    const e = err(() => updateGroup(db, b.id, { name: "book CLUB", actor: A }));
    expect(e.status).toBe(409); expect(e.details).toEqual({ id: a.id });
    expect(updateGroup(db, "book club", { name: "Book Club", actor: A }).name).toBe("Book Club");
    expect(updateGroup(db, a.id, { description: "Readers", actor: A }).description).toBe("Readers");
    expect(resolveGroup(db, "BOOK CLUB")?.id).toBe(a.id);
    const acts = (db.query("SELECT action, actor, target FROM audit_log WHERE action LIKE 'group.%' ORDER BY id").all() as any[]).map((r) => r.action);
    expect(acts).toEqual(["group.create", "group.create", "group.rename"]);
  });

  test("list: with member counts, alphabetical", () => {
    mk("b"); const a = mk("A");
    addMembers(db, deps, a.id, [{ to: "4151230001" }, { to: "4151230002" }], { actor: A });
    expect(listGroups(db).map((g) => [g.name, g.members])).toEqual([["A", 2], ["b", 0]]);
  });
});

describe("groups: members", () => {
  test("add by number, email, contact id; normalised; deduped; reported as added / already / invalid", () => {
    const g = mk();
    const sam = seedContact(db, { name: "Sam Lee", phones: [{ e164: "+12025550009", label: "mobile" }] });
    const r = addMembers(db, deps, g.id, [
      { to: "(415) 123-0001", name: "Ann" }, { to: "Bob@Example.com" }, { contact_id: sam }, { to: "4151230001" }, { to: "garbage" }, { contact_id: "missing" }, {},
    ], { actor: A });
    expect(r.added.map((x) => x.handle)).toEqual(["+14151230001", "bob@example.com", "+12025550009"]);
    expect(r.added[2]).toMatchObject({ name: "Sam Lee", contact_id: sam });
    expect(r.already.map((x) => x.handle)).toEqual(["+14151230001"]);
    expect(r.invalid.map((x) => x.index)).toEqual([4, 5, 6]);
    expect(r.invalid[0]!.reason).toContain("not a valid phone");
    expect(r.group.members).toBe(3);
    // adding the same people again changes nothing
    const again = addMembers(db, deps, g.id, [{ to: "415-123-0001", name: "Different" }], { actor: A });
    expect(again.added).toEqual([]); expect(again.already).toHaveLength(1);
    expect(getGroup(db, g.id).members.find((m) => m.handle === "+14151230001")!.name).toBe("Ann");
  });

  test("a number is linked to its contact when exactly one contact has it; to + contact_id must agree", () => {
    const g = mk();
    const ann = seedContact(db, { name: "Ann Lee", phones: [{ e164: "+14155550101", label: "mobile" }], emails: ["ann@x.com"] });
    const r = addMembers(db, deps, g.id, [{ to: "4155550101" }, { to: "ann@x.com", contact_id: ann }, { to: "4155550999", contact_id: ann }], { actor: A });
    expect(r.added.map((x) => [x.handle, x.contact_id])).toEqual([["+14155550101", ann], ["ann@x.com", ann]]);
    expect(r.invalid[0]!.reason).toContain("is not a number or email of contact Ann Lee");
    // two contacts share a number: not linked (ambiguous)
    const g2 = mk("Shared");
    seedContact(db, { name: "Twin One", phones: [{ e164: "+14155550300", label: "mobile" }] });
    seedContact(db, { name: "Twin Two", phones: [{ e164: "+14155550300", label: "mobile" }] });
    expect(addMembers(db, deps, g2.id, [{ to: "4155550300" }], { actor: A }).added[0]!.contact_id).toBeNull();
  });

  test("with a contact id only, the contact's best handle is used (a mobile before a landline)", () => {
    const g = mk();
    const c = seedContact(db, { name: "Dee", phones: [{ e164: "+14155550401", label: "home" }, { e164: "+14155550402", label: "mobile" }] });
    expect(addMembers(db, deps, g.id, membersFromContactIds([c]), { actor: A }).added[0]!.handle).toBe("+14155550402");
    const none = seedContact(db, { name: "No Number" });
    expect(addMembers(db, deps, g.id, [{ contact_id: none }], { actor: A }).invalid[0]!.reason).toContain("no phone number or email");
  });

  test("per-member vars are kept (as strings, capped)", () => {
    const g = mk();
    addMembers(db, deps, g.id, [{ to: "4151230001", vars: { city: "Boston", n: 3, ok: true, long: "x".repeat(900) } }], { actor: A });
    const v = getGroup(db, g.id).members[0]!.vars;
    expect(v).toMatchObject({ city: "Boston", n: "3", ok: "true" });
    expect(v.long).toHaveLength(500);
  });

  test("limit: a group holds at most 5000 people; going over adds nobody", () => {
    const g = mk();
    const ins = db.query("INSERT INTO contact_group_members(group_id, handle, name, added_by, added_at) VALUES (?,?,?,?,?)");
    db.transaction(() => { for (let i = 0; i < MAX_MEMBERS - 1; i++) ins.run(g.id, `+1${String(2000000000 + i)}`, "", A, nowIso()); })();
    const e = err(() => addMembers(db, deps, g.id, [{ to: "4151230001" }, { to: "4151230002" }], { actor: A }));
    expect(e.code).toBe("group_full");
    expect(getGroup(db, g.id).group.members).toBe(MAX_MEMBERS - 1);
    expect(addMembers(db, deps, g.id, [{ to: "4151230001" }], { actor: A }).group.members).toBe(MAX_MEMBERS);
  });

  test("remove by handle (as typed) and by contact id; unknown ones are reported", () => {
    const g = mk();
    const sam = seedContact(db, { name: "Sam", phones: [{ e164: "+12025550009", label: "mobile" }] });
    addMembers(db, deps, g.id, [{ to: "4151230001" }, { to: "bob@x.com" }, { contact_id: sam }, { to: "4151230003" }], { actor: A });
    const r = removeMembers(db, deps, g.id, { handles: ["(415) 123-0001", "BOB@x.com", "4159999999"], contact_ids: [sam, "nobody"], actor: A });
    expect(r.removed.sort()).toEqual(["+12025550009", "+14151230001", "bob@x.com"]);
    expect(r.not_found).toEqual(["4159999999", "nobody"]);
    expect(r.group.members).toBe(1);
  });

  test("deleting a contact (contacts sync) keeps the member, with its stored handle and name; contact_id goes null", () => {
    const g = mk();
    const ann = seedContact(db, { name: "Ann Lee", phones: [{ e164: "+14155550101", label: "mobile" }] });
    addMembers(db, deps, g.id, [{ contact_id: ann, vars: { city: "Oslo" } }], { actor: A });
    expect(getGroup(db, g.id).members[0]!.contact?.display_name).toBe("Ann Lee");
    db.query("DELETE FROM contact_handles WHERE contact_id = ?").run(ann);
    db.query("DELETE FROM contacts WHERE id = ?").run(ann);
    const m = getGroup(db, g.id).members[0]!;
    expect(m).toMatchObject({ handle: "+14155550101", contact_id: null, name: "Ann Lee", contact: null });
    expect(itemsForBatch(db, deps, g.id).items).toEqual([{ to: "+14155550101", recipient_name: "Ann Lee", vars: { city: "Oslo" } }]);
    removeMembers(db, deps, g.id, { handles: ["+14155550101"], actor: A });
  });

  test("members come back joined with the current contact (new name, org, other numbers)", () => {
    const g = mk();
    const ann = seedContact(db, { name: "Ann Lee", org: "Acme", phones: [{ e164: "+14155550101", label: "mobile" }, { e164: "+14155550102", label: "home" }] });
    addMembers(db, deps, g.id, [{ contact_id: ann }], { actor: A });
    db.query("UPDATE contacts SET display_name = 'Annie Lee' WHERE id = ?").run(ann);
    const m = getGroup(db, g.id).members[0]!;
    expect(m.name).toBe("Ann Lee");
    expect(m.contact).toEqual({ id: ann, display_name: "Annie Lee", org: "Acme", other_handles: ["+14155550102"] });
    expect(itemsForBatch(db, deps, g.id).items[0]).toMatchObject({ contact_id: ann, recipient_name: "Annie Lee" });
  });

  test("delete removes the group and its members, and is audited", () => {
    const g = mk();
    addMembers(db, deps, g.id, [{ to: "4151230001" }], { actor: A });
    expect(deleteGroup(db, "book club", "owner")).toMatchObject({ name: "Book club", members: 1 });
    expect(db.query("SELECT COUNT(*) AS n FROM contact_group_members").get()).toEqual({ n: 0 });
    expect(db.query("SELECT actor, details_json FROM audit_log WHERE action = 'group.delete'").get()).toMatchObject({ actor: "owner" });
    expect(err(() => deleteGroup(db, g.id, "owner")).status).toBe(404);
  });
});

describe("groups: imports and batch items", () => {
  const imp = {
    rows: [
      { row_index: 0, match: "matched", contact_id: "", normalized: { handle: "+14151230001", display_name: "Ann" }, vars: { first_name: "Ann", city: "Boston" } },
      { row_index: 1, match: "new", contact_id: null, normalized: { handle: "+14151230002", display_name: "Bo" }, vars: { first_name: "Bo" } },
      { row_index: 2, match: "invalid", normalized: { handle: null, display_name: "Cy" } },
      { row_index: 3, match: "duplicate", normalized: { handle: "+14151230002", display_name: "Bo again" } },
      { row_index: 4, match: "ambiguous", contact_id: null, normalized: { handle: "+14151230005", display_name: "Di" }, vars: {} },
    ],
  };

  test("from an import: names, handles and row vars; invalid and duplicate rows are reported, not added; rows filter", () => {
    const g = mk();
    const ann = seedContact(db, { name: "Ann Lee", phones: [{ e164: "+14151230001", label: "mobile" }] });
    imp.rows[0]!.contact_id = ann;
    const { members, invalid } = membersFromImport(imp);
    expect(invalid.map((i) => [i.index, i.reason])).toEqual([[2, "no usable phone number or email"], [3, "duplicate of another row"]]);
    const r = addMembers(db, deps, g.id, members, { actor: A, lenient: true, source: "import x" });
    expect(r.added.map((x) => [x.handle, x.name, x.contact_id])).toEqual([["+14151230001", "Ann", ann], ["+14151230002", "Bo", null], ["+14151230005", "Di", null]]);
    expect(getGroup(db, g.id).members.find((m) => m.handle === "+14151230001")!.vars).toMatchObject({ city: "Boston" });
    expect(membersFromImport(imp, [1]).members).toHaveLength(1);
    expect(db.query("SELECT details_json FROM audit_log WHERE action = 'group.add'").get()).toEqual({ details_json: JSON.stringify({ count: 3, source: "import x" }) });
  });

  test("an import row whose contact doesn't own the handle is kept as a plain handle (lenient)", () => {
    const g = mk();
    const c = seedContact(db, { name: "Other", phones: [{ e164: "+14159990000", label: "mobile" }] });
    const r = addMembers(db, deps, g.id, [{ to: "+14151230001", contact_id: c, name: "Row name" }], { actor: A, lenient: true });
    expect(r.added[0]).toMatchObject({ handle: "+14151230001", contact_id: null, name: "Row name" });
  });

  test("itemsForBatch: everyone, or only some (normalised); unknown handles are refused", () => {
    const g = mk();
    addMembers(db, deps, g.id, [{ to: "4151230001", name: "Ann" }, { to: "4151230002", name: "Bo" }, { to: "c@x.com", name: "Cy" }], { actor: A });
    expect(itemsForBatch(db, deps, g.id).items.map((i) => i.to)).toEqual(["+14151230001", "+14151230002", "c@x.com"]);
    expect(itemsForBatch(db, deps, "BOOK club", { only: ["(415) 123-0002", "C@X.com"] }).items.map((i) => i.recipient_name)).toEqual(["Bo", "Cy"]);
    const e = err(() => itemsForBatch(db, deps, g.id, { only: ["4159999999"] }));
    expect(e.code).toBe("not_in_group");
  });

  test("a contact whose numbers changed is not passed along as the owner of the handle", () => {
    const g = mk();
    const c = seedContact(db, { name: "Ann Lee", phones: [{ e164: "+14155550101", label: "mobile" }] });
    addMembers(db, deps, g.id, [{ contact_id: c }], { actor: A });
    db.query("DELETE FROM contact_handles WHERE contact_id = ?").run(c);
    expect(itemsForBatch(db, deps, g.id).items[0]).toEqual({ to: "+14155550101", recipient_name: "Ann Lee", vars: {} });
  });
});
