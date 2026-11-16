// GET /api/contacts: offset paging over a stable order, search that pages too, and the limit bounds.
import { describe, expect, test } from "bun:test";
import { makeHarness } from "./testkit";

const N = 450;

async function seeded() {
  const h = makeHarness();
  await h.signUp();
  const ins = h.db.query("INSERT INTO contacts(id, source, display_name, given_name, family_name, org, phones_json, updated_at) VALUES (?, 'manual', ?, '', '', ?, '[]', '2026-01-01T00:00:00Z')");
  const insH = h.db.query("INSERT INTO contact_handles(handle, contact_id) VALUES (?, ?)");
  h.db.transaction(() => {
    for (let i = 0; i < N; i++) {
      const id = `c${String(i).padStart(4, "0")}`;
      // Many duplicate names, mixed case: order must still be total (name, then id).
      const name = `${["amy", "Ben", "CARL", "dee"][i % 4]} ${i % 25}`;
      ins.run(id, name, i % 3 === 0 ? "Acme Roasters" : "");
      insH.run(`+1202555${String(1000 + i)}`, id);
      if (i % 3 === 0) insH.run(`p${i}@example.com`, id); // a second handle must not duplicate the row in search
    }
  })();
  return h;
}
const page = async (h: Awaited<ReturnType<typeof seeded>>, qs: string) => (await h.call("GET", `/api/contacts?${qs}`)).json;

describe("GET /api/contacts paging", () => {
  test("pages of 100 cover everyone once, with no gaps or repeats, and has_more is false at the end", async () => {
    const h = await seeded();
    const seen: string[] = [];
    let offset = 0;
    const flags: boolean[] = [];
    for (let guard = 0; guard < 10; guard++) {
      const r = await page(h, `offset=${offset}`);
      expect(r).toMatchObject({ total: N, matched: N, offset, limit: 100 });
      seen.push(...r.contacts.map((c: any) => c.id));
      flags.push(r.has_more);
      offset += r.contacts.length;
      if (!r.has_more) break;
    }
    expect(flags).toEqual([true, true, true, true, false]);
    expect(seen).toHaveLength(N);
    expect(new Set(seen).size).toBe(N);
    // Same order as one big query: name (case-insensitive), then id.
    const all = h.db.query<{ id: string }, []>("SELECT id FROM contacts ORDER BY display_name COLLATE NOCASE, id").all().map((r) => r.id);
    expect(seen).toEqual(all);
  });

  test("an exact multiple of the limit ends with has_more false; past the end is an empty page", async () => {
    const h = await seeded();
    h.db.query("DELETE FROM contacts WHERE id >= 'c0400'").run(); // 400 left
    expect((await page(h, "offset=300")).has_more).toBe(false);
    const past = await page(h, "offset=400");
    expect(past).toMatchObject({ contacts: [], total: 400, matched: 400, offset: 400, has_more: false });
    expect((await page(h, "offset=9999")).contacts).toEqual([]);
  });

  test("search pages too: matched counts distinct contacts, not handle rows, and total stays the whole book", async () => {
    const h = await seeded();
    const first = await page(h, "q=acme&limit=60");
    expect(first).toMatchObject({ total: N, matched: 150, offset: 0, limit: 60, has_more: true });
    const ids: string[] = first.contacts.map((c: any) => c.id);
    for (let offset = 60; offset < 150; offset += 60) {
      const r = await page(h, `q=acme&limit=60&offset=${offset}`);
      expect(r.matched).toBe(150);
      ids.push(...r.contacts.map((c: any) => c.id));
      expect(r.has_more).toBe(offset + 60 < 150);
    }
    expect(ids).toHaveLength(150);
    expect(new Set(ids).size).toBe(150);
    expect(ids.every((id) => Number(id.slice(1)) % 3 === 0)).toBe(true);
    // a phone fragment and no matches
    expect((await page(h, "q=2025551449")).contacts.map((c: any) => c.id)).toEqual(["c0449"]);
    expect(await page(h, "q=zzzzz")).toMatchObject({ contacts: [], total: N, matched: 0, has_more: false });
  });

  test("limit is clamped to 1..200 (default 100); bad numbers fall back; offset never goes negative", async () => {
    const h = await seeded();
    expect((await page(h, "")).limit).toBe(100);
    expect((await page(h, "limit=500")).contacts).toHaveLength(200);
    expect((await page(h, "limit=500")).limit).toBe(200);
    expect((await page(h, "limit=0")).limit).toBe(1);
    expect((await page(h, "limit=-5")).limit).toBe(1);
    expect((await page(h, "limit=abc")).limit).toBe(100);
    expect((await page(h, "offset=-10&limit=5")).offset).toBe(0);
    expect((await page(h, "offset=abc&limit=5")).offset).toBe(0);
    expect((await page(h, "limit=7")).contacts).toHaveLength(7);
  });

  test("an empty address book answers with zeros", async () => {
    const h = makeHarness();
    await h.signUp();
    expect(await page(h, "")).toEqual({ contacts: [], total: 0, matched: 0, offset: 0, limit: 100, has_more: false });
  });
});
