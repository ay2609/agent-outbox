// The owner's side of saved groups: the app token is required (browsers are refused), then create / rename / add people / remove / delete.
import { describe, expect, test } from "bun:test";
import { seedContact } from "../../tests/helpers";
import { createGroup, addMembers } from "../core/groups";
import { fakeHandle } from "../../tests/helpers";
import { makeHarness } from "./testkit";

async function ready() {
  const h = makeHarness();
  await h.signUp();
  return h;
}

describe("/api/groups: gate", () => {
  test("every route needs the app token, and a request carrying an Origin header is refused as a browser", async () => {
    const h = await ready();
    const g = createGroup(h.db, { name: "Crew", actor: "owner" });
    const reads: [string, string][] = [["GET", "/api/groups"], ["GET", `/api/groups/${g.id}`]];
    const writes: [string, string, unknown][] = [
      ["POST", "/api/groups", { name: "X" }], ["PATCH", `/api/groups/${g.id}`, { name: "Y" }],
      ["POST", `/api/groups/${g.id}/members`, { members: [{ to: "4151230001" }] }], ["POST", `/api/groups/${g.id}/remove`, { handles: ["4151230001"] }],
      ["DELETE", `/api/groups/${g.id}`, undefined],
    ];
    for (const [m, p] of reads) expect((await h.call(m, p, undefined, { token: null })).status).toBe(401);
    for (const [m, p, b] of writes) {
      expect((await h.call(m, p, b, { token: null })).status).toBe(401);
      const r = await h.call(m, p, b, { headers: { origin: "http://localhost:9999" } });
      expect(r.status).toBe(403); expect(r.json.error).toBe("browser_refused");
    }
    // nothing changed
    expect(h.db.query("SELECT name FROM contact_groups").all()).toEqual([{ name: "Crew" }]);
    expect(h.db.query("SELECT COUNT(*) AS n FROM contact_group_members").get()).toEqual({ n: 0 });
  });
});

describe("/api/groups: use", () => {
  test("create, list, rename (409 on a clash), description, get", async () => {
    const h = await ready();
    const a = await h.call("POST", "/api/groups", { name: "  Book   club ", description: "Thursdays" });
    expect(a.status).toBe(201);
    expect(a.json.group).toMatchObject({ name: "Book club", description: "Thursdays", members: 0, created_by: "owner" });
    const clash = await h.call("POST", "/api/groups", { name: "BOOK CLUB" });
    expect(clash.status).toBe(409); expect(clash.json).toMatchObject({ error: "group_exists", id: a.json.group.id });
    const b = await h.call("POST", "/api/groups", { name: "Climbing" });
    expect((await h.call("PATCH", `/api/groups/${b.json.group.id}`, { name: "book club" })).status).toBe(409);
    const r = await h.call("PATCH", `/api/groups/${a.json.group.id}`, { name: "Readers", description: "" });
    expect(r.json.group).toMatchObject({ name: "Readers", description: "" });
    expect((await h.call("PATCH", `/api/groups/${a.json.group.id}`, {})).status).toBe(400);
    expect((await h.call("PATCH", `/api/groups/${a.json.group.id}`, { status: "x" })).status).toBe(400);
    expect((await h.call("POST", "/api/groups", { name: "" })).status).toBe(400);
    expect((await h.call("POST", "/api/groups", { name: "x".repeat(81) })).status).toBe(400);
    const list = await h.call("GET", "/api/groups");
    expect(list.json.groups.map((g: any) => g.name)).toEqual(["Climbing", "Readers"]);
    expect((await h.call("GET", `/api/groups/${a.json.group.id}`)).json.group.name).toBe("Readers");
    expect((await h.call("GET", "/api/groups/nope")).status).toBe(404);
    expect((await h.call("PATCH", "/api/groups/nope", { name: "z" })).status).toBe(404);
    const acts = (h.db.query("SELECT action, actor FROM audit_log WHERE action LIKE 'group.%' ORDER BY id").all() as any[]);
    expect(acts.map((x) => x.action)).toEqual(["group.create", "group.create", "group.rename"]);
    expect(acts.every((x) => x.actor === "owner")).toBe(true);
  });

  test("add people by contact id and by number; dedupe; remove by handle", async () => {
    const h = await ready();
    const sam = seedContact(h.db, { name: "Sam Lee", phones: [{ e164: "+12025550009", label: "mobile" }] });
    const g = (await h.call("POST", "/api/groups", { name: "Crew" })).json.group;
    const add = await h.call("POST", `/api/groups/${g.id}/members`, { contact_ids: [sam], members: [{ to: "(415) 555-0123", name: "Zed" }, { to: "nope" }] });
    expect(add.status).toBe(200);
    expect(add.json.added.map((x: any) => x.handle)).toEqual(["+14155550123", "+12025550009"]);
    expect(add.json.invalid).toHaveLength(1);
    expect(add.json.group.members).toBe(2);
    const again = await h.call("POST", `/api/groups/${g.id}/members`, { contact_ids: [sam] });
    expect(again.json.added).toEqual([]); expect(again.json.already).toHaveLength(1);
    expect((await h.call("POST", `/api/groups/${g.id}/members`, {})).status).toBe(400);
    expect((await h.call("POST", `/api/groups/${g.id}/members`, { from_import: { import_id: "missing" } })).status).toBe(404);
    const got = (await h.call("GET", `/api/groups/${g.id}`)).json;
    expect(got.members.find((m: any) => m.contact_id === sam)).toMatchObject({ handle: "+12025550009", contact: { display_name: "Sam Lee" } });
    const rm = await h.call("POST", `/api/groups/${g.id}/remove`, { handles: ["+14155550123", "+19999999999"] });
    expect(rm.json).toMatchObject({ removed: ["+14155550123"], not_found: ["+19999999999"], group: { members: 1 } });
    expect((await h.call("POST", `/api/groups/${g.id}/remove`, {})).status).toBe(400);
  });

  test("delete takes the group and its people with it; a deleted contact does not disturb a group", async () => {
    const h = await ready();
    const sam = seedContact(h.db, { name: "Sam Lee", phones: [{ e164: "+12025550009", label: "mobile" }] });
    const g = (await h.call("POST", "/api/groups", { name: "Crew", })).json.group;
    await h.call("POST", `/api/groups/${g.id}/members`, { contact_ids: [sam] });
    h.db.query("DELETE FROM contact_handles WHERE contact_id = ?").run(sam);
    h.db.query("DELETE FROM contacts WHERE id = ?").run(sam);
    const m = (await h.call("GET", `/api/groups/${g.id}`)).json.members[0];
    expect(m).toMatchObject({ handle: "+12025550009", name: "Sam Lee", contact_id: null, contact: null });
    const del = await h.call("DELETE", `/api/groups/${g.id}`);
    expect(del.json).toMatchObject({ ok: true, deleted: { name: "Crew", members: 1 } });
    expect((await h.call("GET", "/api/groups")).json.groups).toEqual([]);
    expect(h.db.query("SELECT COUNT(*) AS n FROM contact_group_members").get()).toEqual({ n: 0 });
    expect((await h.call("DELETE", `/api/groups/${g.id}`)).status).toBe(404);
    expect(h.db.query("SELECT actor FROM audit_log WHERE action = 'group.delete'").get()).toEqual({ actor: "owner" });
  });

  test("a group made by an agent can be edited and deleted here", async () => {
    const h = await ready();
    const g = createGroup(h.db, { name: "Agent made", actor: "agent:x" });
    addMembers(h.db, { normalizeHandle: fakeHandle }, g.id, [{ to: "4151230001" }], { actor: "agent:x" });
    expect((await h.call("GET", `/api/groups/${g.id}`)).json.group).toMatchObject({ created_by: "agent:x", members: 1 });
    expect((await h.call("DELETE", `/api/groups/${g.id}`)).status).toBe(200);
  });
});
