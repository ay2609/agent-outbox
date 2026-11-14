// iPhone / Apple vCards (itemN labels, CATEGORIES, ADR) and spreadsheets with merged two-level headers.
import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { getImport, ingestFile } from "./ingest";
import { guessMapping, mappingNeedsConfirmation } from "./mapping";
import { mergeHeaderRows, parseFile, parseVcard } from "./parse";
import { memDb, tmpImportsDir } from "./testutil";

const enc = (s: string) => new TextEncoder().encode(s);

const IPHONE_VCF = [
  "BEGIN:VCARD", "VERSION:3.0", "PRODID:-//Apple Inc.//iPhone OS 17.5//EN",
  "N:Smith;Jane;Marie;;", "FN:Jane Marie Smith", "ORG:Acme Corp;", "CATEGORIES:College Friends,Climbing",
  "item1.TEL;type=pref:+1 (202) 555-0143", "item1.X-ABLabel:_$!<Main>!$_",
  "item2.TEL;type=pref:(301) 555-0123", "item2.X-ABLabel:_$!<Mobile>!$_",
  "TEL;type=HOME;type=VOICE:202-555-0100",
  "item3.ADR;type=HOME;type=pref:;;1 Main St;Bethesda;MD;20814;USA", "item3.X-ABADR:us",
  "EMAIL;type=INTERNET;type=HOME;type=pref:jane@example.com",
  "END:VCARD",
  "BEGIN:VCARD", "VERSION:3.0", "N:;;;;", "FN:Bob Jones",
  "TEL;type=WORK;type=VOICE:202-555-0188", "item1.TEL;type=pref:301-555-0150", "item1.X-ABLabel:iPhone",
  "TEL;type=FAX:202-555-0199",
  "END:VCARD",
  "BEGIN:VCARD", "VERSION:3.0", "ORG:Smith Plumbing;", "TEL;type=CELL:202-555-0166", "END:VCARD",
  "",
].join("\r\n");

describe("iPhone vCards", () => {
  const t = parseVcard(IPHONE_VCF);

  test("itemN.X-ABLabel is read per group: Mobile / iPhone first, then Main, then Home; fax is dropped", () => {
    expect(t.rows[0]).toMatchObject({ phone: "(301) 555-0123", phone_2: "+1 (202) 555-0143", phone_3: "202-555-0100" });
    expect(t.rows[1]).toMatchObject({ phone: "301-555-0150", phone_2: "202-555-0188" });
    expect(t.rows[1]!.phone_3).toBe(""); // the fax number is not a phone
  });

  test("CATEGORIES become a tags column and the ADR city a city column", () => {
    expect(t.rows[0]).toMatchObject({ tags: "College Friends, Climbing", city: "Bethesda", org: "Acme Corp" });
    expect(t.columns).toContain("tags");
    expect(t.columns).toContain("city");
  });

  test("with no name at all the organisation is the display name", () => {
    expect(t.rows[2]).toMatchObject({ full_name: "Smith Plumbing", given_name: "Smith Plumbing" });
  });

  test("through ingest: the mobile is the handle, tags and city carry into the row, the org card keeps its whole name", () => {
    const db = memDb();
    const s = ingestFile(db, { bytes: enc(IPHONE_VCF), filename: "contacts.vcf", created_by: "t", importsDir: tmpImportsDir() });
    expect(s.mapping.fields.tags!.column).toBe("tags");
    const rows = getImport(db, s.import_id).rows;
    expect(rows.map((r) => r.normalized.handle)).toEqual(["+13015550123", "+13015550150", "+12025550166"]);
    expect(rows[0]!.normalized.tags).toEqual(["College Friends", "Climbing"]);
    expect(rows[0]!.vars!.city).toBe("Bethesda");
    expect(rows[0]!.normalized).toMatchObject({ given_name: "Jane", family_name: "Smith", display_name: "Jane Marie Smith" });
    expect(rows[2]!.normalized).toMatchObject({ display_name: "Smith Plumbing", given_name: "Smith Plumbing", family_name: "" });
    expect(rows[2]!.issues.map((i) => i.code)).not.toContain("missing_name");
  });

  test("Apple's label syntax without a group (TEL;X-ABLabel in TYPE) and iPhone as a TYPE still rank first", () => {
    const v = parseVcard(["BEGIN:VCARD", "VERSION:3.0", "FN:Al Ng", "TEL;type=WORK:202-555-0101", "TEL;type=IPHONE;type=CELL;type=VOICE:301-555-0102", "END:VCARD", ""].join("\n"));
    expect(v.rows[0]).toMatchObject({ phone: "301-555-0102", phone_2: "202-555-0101" });
  });
});

function workbook(aoa: string[][], merges: XLSX.Range[]): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = merges;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Guests");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}
const R = (r0: number, c0: number, r1: number, c1: number): XLSX.Range => ({ s: { r: r0, c: c0 }, e: { r: r1, c: c1 } });

describe("two-level headers in merged XLSX cells", () => {
  const data = [
    ["Spring Gala Guest List", "", "", ""],
    ["Name", "", "Contact", ""],
    ["First", "Last", "Phone", "Email"],
    ["Jane", "Smith", "(301) 555-0123", "jane@example.com"],
    ["Bob", "Jones", "301-555-0188", "bob@example.com"],
  ];

  test("group labels are combined with the lower row ('Name First'); a whole-sheet title merge is left alone", () => {
    const t = parseFile(workbook(data, [R(0, 0, 0, 3), R(1, 0, 1, 1), R(1, 2, 1, 3)]), "g.xlsx");
    expect(t.columns).toEqual(["Name First", "Name Last", "Contact Phone", "Contact Email"]);
    expect(t.rows[0]).toMatchObject({ "Name First": "Jane", "Name Last": "Smith", "Contact Phone": "(301) 555-0123" });
    expect(t.unlabeled).toBeUndefined();
    const m = guessMapping(t);
    expect(m.fields.given_name!.column).toBe("Name First");
    expect(m.fields.family_name!.column).toBe("Name Last");
    expect(m.fields.phone!.column).toBe("Contact Phone");
    expect(m.fields.email!.column).toBe("Contact Email");
    expect(mappingNeedsConfirmation(m)).toBe(false);
  });

  test("a label merged down over both header rows keeps its single name", () => {
    const aoa = [["Name", "", "Mobile", "Email"], ["First", "Last", "", ""], ["Jane", "Smith", "(301) 555-0123", "jane@example.com"], ["Bob", "Jones", "301-555-0188", "bob@example.com"]];
    const t = parseFile(workbook(aoa, [R(0, 0, 0, 1), R(0, 2, 1, 2), R(0, 3, 1, 3)]), "g.xlsx");
    expect(t.columns).toEqual(["Name First", "Name Last", "Mobile", "Email"]);
    expect(t.rows).toHaveLength(2);
  });

  test("without any merges the lower label row is the header (as before)", () => {
    const t = parseFile(workbook(data.slice(1).map((r, i) => (i === 0 ? ["", "", "", ""] : r)), []), "g.xlsx");
    expect(t.columns).toEqual(["First", "Last", "Phone", "Email"]);
  });

  test("through ingest, with the sheet's merges honoured", () => {
    const db = memDb();
    const s = ingestFile(db, { bytes: workbook(data, [R(0, 0, 0, 3), R(1, 0, 1, 1), R(1, 2, 1, 3)]), filename: "g.xlsx", created_by: "t", importsDir: tmpImportsDir() });
    expect(s.needs_confirmation).toBe(false);
    expect(s.preview.map((r) => r.normalized.display_name)).toEqual(["Jane Smith", "Bob Jones"]);
  });

  test("mergeHeaderRows is a no-op when the data rows themselves contain merged cells or the child row has values", () => {
    const m = [["Group", "", "x"], ["301-555-0123", "202-555-0143", "a"], ["301-555-0124", "202-555-0144", "b"]];
    expect(mergeHeaderRows(m, [R(0, 0, 0, 1)])).toEqual(m);
  });
});

describe("a data column with no header needs confirmation (xlsx too)", () => {
  test("blank header cell over data", () => {
    const aoa = [["Name", "Phone", ""], ["Jane Smith", "301-555-0123", "VIP"], ["Bob Jones", "301-555-0188", ""]];
    const s = ingestFile(memDb(), { bytes: workbook(aoa, []), filename: "g.xlsx", created_by: "t", importsDir: tmpImportsDir() });
    expect(s.unlabeled_columns).toEqual(["Column 3"]);
    expect(s.needs_confirmation).toBe(true);
  });
});
