import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { paths } from "../core/paths";
import { sha256Hex } from "../core/store";
import { getImport, ingestFile, NotFoundError, setMapping } from "./ingest";
import { fixture, memDb, seedContact, tmpImportsDir } from "./testutil";

const enc = (s: string) => new TextEncoder().encode(s);
const csv = (s: string) => enc(s);

function ingest(db = memDb(), name = "google-sheets.csv", extra: Record<string, unknown> = {}) {
  const importsDir = tmpImportsDir();
  const s = ingestFile(db, { bytes: fixture(name), filename: name, created_by: "test", importsDir, ...extra });
  return { db, s, importsDir };
}

describe("storing the raw upload", () => {
  test("stored under <sha256>.<ext>, read-only, byte-identical", () => {
    const { importsDir } = ingest();
    const bytes = fixture("google-sheets.csv");
    const p = join(importsDir, `${sha256Hex(bytes)}.csv`);
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p).equals(Buffer.from(bytes))).toBe(true);
    expect(statSync(p).mode & 0o222).toBe(0);
  });

  test("the imports row records filename, sha, kind, stored_path and row_count", () => {
    const { db, s, importsDir } = ingest();
    const r = db.query("SELECT * FROM imports WHERE id = ?").get(s.import_id) as any;
    expect(r).toMatchObject({ filename: "google-sheets.csv", kind: "csv", created_by: "test", row_count: 6 });
    expect(r.sha256).toBe(sha256Hex(fixture("google-sheets.csv")));
    expect(r.stored_path).toBe(join(importsDir, `${r.sha256}.csv`));
    expect(JSON.parse(r.columns_json)).toHaveLength(7);
  });

  test("the same bytes twice: the stored file is left alone (wx), two import rows", () => {
    const db = memDb();
    const importsDir = tmpImportsDir();
    const args = { bytes: fixture("people.jsonl"), filename: "people.jsonl", created_by: "t", importsDir };
    const a = ingestFile(db, args);
    const p = join(importsDir, `${sha256Hex(args.bytes)}.jsonl`);
    const before = statSync(p);
    const b = ingestFile(db, args);
    const after = statSync(p);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
    expect(a.import_id).not.toBe(b.import_id);
    expect((db.query("SELECT COUNT(*) AS n FROM imports").get() as any).n).toBe(2);
  });

  test("an existing stored file with other contents is never overwritten", () => {
    const db = memDb();
    const importsDir = tmpImportsDir();
    const bytes = enc("Name,Phone\nJane,301-555-0123\n");
    ingestFile(db, { bytes, filename: "a.csv", created_by: "t", importsDir });
    const p = join(importsDir, `${sha256Hex(bytes)}.csv`);
    expect(readFileSync(p, "utf8")).toBe("Name,Phone\nJane,301-555-0123\n");
  });

  test("default location is paths.imports (a throwaway dir under tests)", () => {
    if (!paths.state.startsWith(tmpdir())) return; // never write into a real state dir from a test
    const db = memDb();
    const bytes = enc("Name,Phone\nDefault Dir,301-555-0123\n");
    ingestFile(db, { bytes, filename: "d.csv", created_by: "t" });
    expect(existsSync(join(paths.imports, `${sha256Hex(bytes)}.csv`))).toBe(true);
  });

  test("ingest writes an audit row", () => {
    const { db } = ingest();
    expect((db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'import.create'").get() as any).n).toBe(1);
  });
});

describe("matching: matched / new / ambiguous / invalid / duplicate", () => {
  function setup() {
    const db = memDb();
    const jane = seedContact(db, { given: "Jane", family: "Smith", phones: ["+13015550123"], emails: ["jane.smith@example.com"] });
    const bobOld = seedContact(db, { given: "Bob", family: "Jones", phones: ["+12025550100"] });
    const { s } = ingest(db);
    return { db, s, jane, bobOld };
  }

  test("counts", () => {
    const { s } = setup();
    // rows: Jane(matched) Bob(ambiguous: same name, other number) Alice(new) Carol(new via email, bad phone) Dan(duplicate of Jane) Eve(new)
    expect(s.counts).toEqual({ matched: 1, new: 3, ambiguous: 1, invalid: 0, duplicate: 1 });
    expect(s.needs_confirmation).toBe(false);
  });

  test("exact handle match -> matched with contact_id", () => {
    const { db, s, jane } = setup();
    const row = getImport(db, s.import_id).rows[0]!;
    expect(row.match).toBe("matched");
    expect(row.contact_id).toBe(jane);
    expect(row.normalized).toMatchObject({ given_name: "Jane", family_name: "Smith", phone_e164: "+13015550123", email: "jane.smith@example.com", org: "Acme Corp", handle: "+13015550123", handle_kind: "phone" });
    expect(row.normalized.vars).toEqual({ favorite_color: "blue" });
  });

  test("same full name but a different handle -> ambiguous, candidates listed", () => {
    const { db, s, bobOld } = setup();
    const row = getImport(db, s.import_id).rows[1]!;
    expect(row.match).toBe("ambiguous");
    expect(row.contact_id).toBeNull();
    const issue = row.issues.find((i) => i.code === "ambiguous_name")!;
    expect(issue.candidates).toEqual([{ contact_id: bobOld, display_name: "Bob Jones", phones: ["+12025550100"], emails: [] }]);
  });

  test("name matching ignores case and accents", () => {
    const db = memDb();
    seedContact(db, { given: "JOSÉ", family: "garcia", phones: ["+12025550100"] });
    const s = ingestFile(db, { bytes: csv("First,Last,Phone\nJosé,García,301-555-0188\n"), filename: "a.csv", created_by: "t", importsDir: tmpImportsDir() });
    expect(s.counts.ambiguous).toBe(1);
  });

  test("a bare first name never triggers name-based ambiguity", () => {
    const db = memDb();
    seedContact(db, { given: "Madonna", phones: ["+12025550100"] });
    const s = ingestFile(db, { bytes: csv("Name,Phone\nMadonna,301-555-0188\n"), filename: "a.csv", created_by: "t", importsDir: tmpImportsDir() });
    expect(s.counts).toMatchObject({ new: 1, ambiguous: 0 });
  });

  test("no handle match and no name match -> new", () => {
    const { db, s } = setup();
    const rows = getImport(db, s.import_id).rows;
    expect(rows[2]!.match).toBe("new"); // Alice
    expect(rows[2]!.contact_id).toBeNull();
    expect(rows[2]!.normalized.phone_e164).toBe("+12025550143");
  });

  test("bad phone but good email -> usable via the email, with an invalid_phone issue", () => {
    const { db, s } = setup();
    const carol = getImport(db, s.import_id).rows[3]!;
    expect(carol.match).toBe("new");
    expect(carol.normalized).toMatchObject({ phone_e164: null, email: "carol@example.net", handle: "carol@example.net", handle_kind: "email" });
    expect(carol.issues.map((i) => i.code)).toContain("invalid_phone");
  });

  test("later duplicate of a handle -> duplicate, pointing at the first row", () => {
    const { db, s } = setup();
    const dan = getImport(db, s.import_id).rows[4]!;
    expect(dan.match).toBe("duplicate");
    expect(dan.issues.find((i) => i.code === "duplicate_of_row")).toMatchObject({ row: 0 });
  });

  test("rows without any usable handle are invalid", () => {
    const db = memDb();
    const s = ingestFile(db, { bytes: csv("Name,Phone,Email\nJane Smith,,\nBob Jones,12345,bob@\nAl Ng,301-555-0123,\n"), filename: "a.csv", created_by: "t", importsDir: tmpImportsDir() });
    expect(s.counts).toEqual({ matched: 0, new: 1, ambiguous: 0, invalid: 2, duplicate: 0 });
    const rows = getImport(db, s.import_id).rows;
    expect(rows[0]!.issues.map((i) => i.code)).toContain("no_handle");
    expect(rows[1]!.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["invalid_phone", "invalid_email", "no_handle"]));
  });

  test("an invalid row doesn't block a later valid row with the same name", () => {
    const db = memDb();
    const s = ingestFile(db, { bytes: csv("Name,Phone\nJane Smith,bad\nJane Smith,301-555-0123\n"), filename: "a.csv", created_by: "t", importsDir: tmpImportsDir() });
    expect(s.counts).toMatchObject({ invalid: 1, new: 1, duplicate: 0 });
  });

  test("two contacts sharing a handle -> ambiguous_handle", () => {
    const db = memDb();
    seedContact(db, { given: "A", family: "One", phones: ["+13015550123"] });
    seedContact(db, { given: "B", family: "Two", phones: ["+13015550123"] });
    const s = ingestFile(db, { bytes: csv("Name,Phone\nSomeone Else,301-555-0123\n"), filename: "a.csv", created_by: "t", importsDir: tmpImportsDir() });
    const row = getImport(db, s.import_id).rows[0]!;
    expect(row.match).toBe("ambiguous");
    expect(row.issues[0]!.candidates).toHaveLength(2);
  });

  test("email-only row matches a contact by email handle", () => {
    const db = memDb();
    const id = seedContact(db, { given: "Jane", family: "Smith", emails: ["jane@example.com"] });
    const s = ingestFile(db, { bytes: csv("Name,Email\nJane Smith,JANE@Example.com\n"), filename: "a.csv", created_by: "t", importsDir: tmpImportsDir() });
    expect(getImport(db, s.import_id).rows[0]).toMatchObject({ match: "matched", contact_id: id });
  });

  test("phone invalid but email matches an existing contact", () => {
    const db = memDb();
    const id = seedContact(db, { given: "Jane", family: "Smith", emails: ["jane@example.com"] });
    const s = ingestFile(db, { bytes: csv("Name,Phone,Email\nJane Smith,bad,jane@example.com\n"), filename: "a.csv", created_by: "t", importsDir: tmpImportsDir() });
    expect(getImport(db, s.import_id).rows[0]).toMatchObject({ match: "matched", contact_id: id });
  });

  test("a row matched on the phone falls back to the email handle when the phone is unknown", () => {
    const db = memDb();
    const id = seedContact(db, { given: "Jane", family: "Smith", emails: ["jane@example.com"] });
    const s = ingestFile(db, { bytes: csv("Name,Phone,Email\nJane Smith,301-555-0123,jane@example.com\n"), filename: "a.csv", created_by: "t", importsDir: tmpImportsDir() });
    expect(getImport(db, s.import_id).rows[0]).toMatchObject({ match: "matched", contact_id: id });
  });

  test("landline / toll-free numbers get a non_mobile issue", () => {
    const db = memDb();
    const s = ingestFile(db, { bytes: csv("Name,Phone\nHelp Desk,800-555-0199\n"), filename: "a.csv", created_by: "t", importsDir: tmpImportsDir() });
    expect(getImport(db, s.import_id).rows[0]!.issues.map((i) => i.code)).toContain("non_mobile");
  });

  test("Excel-mangled phone gets an explanatory issue", () => {
    const db = memDb();
    const s = ingestFile(db, { bytes: csv("Name,Phone,Email\nJane Smith,3.01555E+09,j@x.co\nBob Jones,3.015550188E+09,\n"), filename: "a.csv", created_by: "t", importsDir: tmpImportsDir() });
    const rows = getImport(db, s.import_id).rows;
    expect(rows[0]!.issues.find((i) => i.code === "invalid_phone")!.message).toMatch(/scientific notation/);
    expect(rows[1]!.normalized.phone_e164).toBe("+13015550188");
  });
});

describe("other formats through ingestFile", () => {
  test("xlsx with two sheets and numeric phone cells", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Name", "Phone"], ["Jane Smith", 3015550123], ["Bob Jones", 13015550188]]), "People");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Name", "Phone"], ["Other One", 2025550143]]), "More");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    const db = memDb();
    const dir = tmpImportsDir();
    const s = ingestFile(db, { bytes, filename: "book.xlsx", created_by: "t", importsDir: dir });
    expect(s).toMatchObject({ kind: "xlsx", sheet: "People", sheets: ["People", "More"], counts: { new: 2 } });
    expect(existsSync(join(dir, `${sha256Hex(bytes)}.xlsx`))).toBe(true);
    const s2 = ingestFile(db, { bytes, filename: "book.xlsx", created_by: "t", importsDir: dir, sheet: "More" });
    expect(s2).toMatchObject({ sheet: "More", counts: { new: 1 } });
    expect(getImport(db, s2.import_id).sheets).toEqual(["People", "More"]);
  });

  test("vCard: three cards", () => {
    const { s, db } = ingest(memDb(), "contacts.vcf");
    expect(s.kind).toBe("vcf");
    expect(s.counts.new).toBe(3);
    const rows = getImport(db, s.import_id).rows;
    expect(rows.map((r) => r.normalized.handle)).toEqual(["+13015550123", "+13015550188", "+12025550199"]);
    expect(rows[0]!.normalized.display_name).toBe("Dr. Jane Q. Smith"); // the name as written in the card
    expect(rows[0]!.normalized.given_name).toBe("Jane");
  });

  test("JSON and JSONL", () => {
    const j = ingest(memDb(), "people.json").s;
    expect(j.kind).toBe("json");
    expect(j.counts).toMatchObject({ new: 3, invalid: 0 }); // Alice only has a "phones" array: it is part of the one logical phone list
    const jl = ingest(memDb(), "people.jsonl").s;
    expect(jl.kind).toBe("jsonl");
    expect(jl.mapping.fields.given_name!.column).toBe("first_name");
    expect(jl.mapping.fields.phone!.column).toBe("mobile");
    expect(jl.counts.new).toBe(3);
  });

  test("UTF-16 TSV, windows-1252 CSV, semicolon CSV with title rows", () => {
    const t = ingest(memDb(), "utf16le.tsv").s;
    expect(t.counts.new).toBe(3);
    expect(t.preview[0]!.normalized.display_name).toBe("Zoë Müller");
    const w = ingest(memDb(), "windows1252.csv").s;
    expect(w.preview.map((r) => r.normalized.display_name)).toEqual(["José García", "Zoë Müller", "Renée Côté"]);
    const g = ingest(memDb(), "semicolon-title.csv").s;
    expect(g.preview.map((r) => r.normalized.display_name)).toEqual(["Jane Smith", "Bob Jones", "Dr. Alice Q. Nguyen"]); // "Last, First" is rebuilt; other names stay as written
    expect(g.preview.map((r) => r.normalized.given_name)).toEqual(["Jane", "Bob", "Alice"]);
    expect(g.counts.new).toBe(3);
  });

  test("pasted markdown through a .md/.txt upload", () => {
    const s = ingest(memDb(), "pasted.md").s;
    expect(s.counts.new).toBe(3);
    expect(s.mapping.fields.phone!.column).toBe("Phone");
    expect(s.mapping.vars).toEqual({ role: "Role" });
  });

  test("a parse failure stores nothing in the DB", () => {
    const db = memDb();
    expect(() => ingestFile(db, { bytes: enc("{broken"), filename: "x.json", created_by: "t", importsDir: tmpImportsDir() })).toThrow();
    expect((db.query("SELECT COUNT(*) AS n FROM imports").get() as any).n).toBe(0);
  });
});

describe("summary shape", () => {
  test("contract fields and a 10-row preview", () => {
    const lines = ["Name,Phone", ...Array.from({ length: 25 }, (_, i) => `Person ${String.fromCharCode(65 + i)} Test,30155501${String(i).padStart(2, "0")}`)];
    const s = ingestFile(memDb(), { bytes: csv(lines.join("\n")), filename: "big.csv", created_by: "t", importsDir: tmpImportsDir() });
    expect(Object.keys(s)).toEqual(expect.arrayContaining(["import_id", "filename", "kind", "sheet", "sheets", "columns", "mapping", "needs_confirmation", "counts", "preview"]));
    expect(s.preview).toHaveLength(10);
    expect(s.preview.map((r) => r.row_index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(s.counts.new + s.counts.invalid).toBe(25);
  });
});

describe("setMapping and getImport", () => {
  const headerless = "Jane Doe,301-555-0123,x\nBob Jones,301-555-0188,y\nAl Ng,202-555-0143,z\n";

  test("a weak mapping needs confirmation until the owner sets it", () => {
    const db = memDb();
    const s = ingestFile(db, { bytes: csv(headerless), filename: "h.csv", created_by: "t", importsDir: tmpImportsDir() });
    expect(s.needs_confirmation).toBe(true);
    expect(s.mapping.confirmed).toBe(false);
    const s2 = setMapping(db, s.import_id, { fields: { display_name: { column: "Column 1", confidence: 1 }, phone: { column: "Column 2", confidence: 1 } } });
    expect(s2.needs_confirmation).toBe(false);
    expect(s2.mapping.confirmed).toBe(true);
    expect(s2.mapping.vars).toEqual({ column_3: "Column 3" });
    expect(getImport(db, s.import_id).mapping).toEqual(s2.mapping);
  });

  test("re-normalises: switching the phone column changes handles and invalidates rows", () => {
    const db = memDb();
    const s = ingestFile(db, { bytes: csv("Name,Home,Cell\nJane Smith,bad,301-555-0123\nBob Jones,202-555-0143,bad\n"), filename: "a.csv", created_by: "t", importsDir: tmpImportsDir() });
    const before = getImport(db, s.import_id).rows;
    const homeIsPhone = setMapping(db, s.import_id, { fields: { display_name: { column: "Name", confidence: 1 }, phone: { column: "Home", confidence: 1 } } });
    expect(homeIsPhone.counts).toMatchObject({ new: 1, invalid: 1 });
    const after = getImport(db, s.import_id).rows;
    expect(before[0]!.normalized.handle).toBe("+13015550123");
    expect(after[0]!.match).toBe("invalid");
    expect(after[1]!.normalized.handle).toBe("+12025550143");
    expect(after[1]!.normalized.vars).toEqual({ cell: "bad" });
  });

  test("re-matches against contacts added after the first ingest", () => {
    const db = memDb();
    const s = ingestFile(db, { bytes: csv("Name,Phone\nJane Smith,301-555-0123\n"), filename: "a.csv", created_by: "t", importsDir: tmpImportsDir() });
    expect(s.counts.new).toBe(1);
    const id = seedContact(db, { given: "Jane", family: "Smith", phones: ["+13015550123"] });
    const s2 = setMapping(db, s.import_id, s.mapping);
    expect(s2.counts).toMatchObject({ matched: 1, new: 0 });
    expect(getImport(db, s.import_id).rows[0]!.contact_id).toBe(id);
  });

  test("mapping given/family columns directly", () => {
    const db = memDb();
    const s = ingestFile(db, { bytes: csv("A,B,C\nJane,Smith,301-555-0123\nBob,Jones,301-555-0188\n"), filename: "a.csv", created_by: "t", importsDir: tmpImportsDir() });
    const s2 = setMapping(db, s.import_id, { fields: { given_name: { column: "A", confidence: 1 }, family_name: { column: "B", confidence: 1 }, phone: { column: "C", confidence: 1 } } });
    expect(s2.preview[0]!.normalized).toMatchObject({ given_name: "Jane", family_name: "Smith", display_name: "Jane Smith" });
  });

  test("bad mappings throw and leave the import untouched", () => {
    const db = memDb();
    const s = ingestFile(db, { bytes: csv("Name,Phone\nJane Smith,301-555-0123\n"), filename: "a.csv", created_by: "t", importsDir: tmpImportsDir() });
    expect(() => setMapping(db, s.import_id, { fields: { phone: { column: "Nope", confidence: 1 } } })).toThrow(/Nope/);
    expect(getImport(db, s.import_id).mapping).toEqual(s.mapping);
  });

  test("unknown import ids raise NotFoundError", () => {
    const db = memDb();
    expect(() => getImport(db, "nope")).toThrow(NotFoundError);
    expect(() => setMapping(db, "nope", { fields: {} })).toThrow(NotFoundError);
  });

  test("getImport returns every row with raw and normalized data", () => {
    const { db, s } = ingest();
    const g = getImport(db, s.import_id);
    expect(g.rows).toHaveLength(6);
    expect(g.rows[0]!.raw["First Name"]).toBe("Jane");
    expect(g.counts).toEqual(s.counts);
    expect(g.rows.map((r) => r.row_index)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
