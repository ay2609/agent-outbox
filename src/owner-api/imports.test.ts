// Dashboard import flow: upload -> mapping -> preview -> batch. Skipped cleanly if the ingest library is absent.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { getDrafts, getBatch } from "../core/store";
import { makeHarness } from "./testkit";

const csv = "name,phone,city\nSam Lee,(202) 555-0101,Boston\nPriya Nair,+1 202 555 0102,Austin\nBad Row,not a number,Nowhere\n";

const tmpImports = (): string => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "outbox-imports-"));

async function upload(h: ReturnType<typeof makeHarness>, content: string, name = "people.csv") {
  const fd = new FormData();
  fd.append("file", new File([content], name, { type: "text/csv" }));
  const res = await h.request("/api/imports", { method: "POST", headers: { cookie: h.cookie, "x-outbox": "1" }, body: fd });
  return { status: res.status, json: await res.json() as any };
}

describe("owner imports", () => {
  test("upload, confirm mapping, preview 3 rows, create a review batch", async () => {
    const importsDir = tmpImports();
    const h = makeHarness({ importsDir });
    await h.signUp();
    const up = await upload(h, csv);
    expect(up.status).toBe(200);
    expect(up.json.filename).toBe("people.csv");
    expect(up.json.columns).toEqual(["name", "phone", "city"]);
    expect(up.json.mapping.fields.phone.column).toBe("phone");
    expect(readdirSync(importsDir).some((f) => f.endsWith(".csv"))).toBe(true); // raw bytes stored in the test dir, not the real state dir

    const id = up.json.import_id as string;
    const list = (await h.call("GET", "/api/imports")).json.imports;
    expect(list[0]).toMatchObject({ id, filename: "people.csv", row_count: 3 });

    const mapped = await h.call("PUT", `/api/imports/${id}/mapping`, { fields: up.json.mapping.fields, vars: up.json.mapping.vars ?? {}, confirmed: true });
    expect(mapped.status).toBe(200);
    expect(mapped.json.mapping.confirmed).toBe(true);
    expect((await h.call("GET", `/api/imports/${id}`)).json.counts.new).toBe(2);

    const pv = await h.call("POST", `/api/imports/${id}/preview`, { template: "Hi {{first_name|there}} from {{city}}!", rows: 3 });
    expect(pv.status).toBe(200);
    expect(pv.json.previews.map((p: any) => p.body)).toEqual(["Hi Sam from Boston!", "Hi Priya from Austin!"]); // the invalid row is skipped

    const made = await h.call("POST", `/api/imports/${id}/batch`, { title: "People", template: "Hi {{first_name}}, dinner?" });
    expect(made.status).toBe(200);
    expect(made.json.drafts).toBe(2);
    expect(made.json.skipped).toHaveLength(1);
    const b = getBatch(h.db, made.json.batch_id)!;
    expect(b.status).toBe("review"); // batchFromImport leaves it 'drafting'; the dashboard submits it
    expect(b.source).toBe("dashboard"); expect(b.created_by).toBe("owner");
    expect(getDrafts(h.db, b.id).map((d) => d.body)).toEqual(["Hi Sam, dinner?", "Hi Priya, dinner?"]);
    expect(getDrafts(h.db, b.id).every((d) => d.status === "review")).toBe(true);
  });

  test("pasted text, bad files and missing imports are clean errors", async () => {
    const h = makeHarness({ importsDir: tmpImports() });
    await h.signUp();
    const pasted = await h.call("POST", "/api/imports", { text: csv, filename: "pasted.csv" });
    expect(pasted.status).toBe(200);
    expect((await upload(h, "")).status).toBe(400);
    expect((await h.call("GET", "/api/imports/nope")).status).toBe(404);
    expect((await h.call("POST", "/api/imports/nope/preview", { template: "x" })).status).toBe(404);
    expect((await h.call("POST", "/api/imports", { nope: 1 })).status).toBe(400);
    expect((await h.call("POST", "/api/imports/x/batch", { title: "", template: "" })).status).toBe(400);
  });
});
