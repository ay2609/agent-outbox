import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { fixture, fixtureText } from "./testutil";
import { decodeBytes, dedupeHeaders, parseFile, parseText, sniffDelimiter } from "./parse";

const enc = (s: string) => new TextEncoder().encode(s);

describe("encoding", () => {
  test("UTF-8 BOM is stripped", () => {
    const t = parseFile(fixture("utf8-bom.csv"), "x.csv");
    expect(t.columns).toEqual(["Name", "Phone"]);
    expect(t.rows[0]!.Name).toBe("José García");
  });
  test("UTF-16LE with BOM", () => {
    const t = parseFile(fixture("utf16le.tsv"), "export.tsv");
    expect(t.kind).toBe("tsv");
    expect(t.columns).toEqual(["Name", "Phone", "Email"]);
    expect(t.rows.map((r) => r.Name)).toEqual(["Zoë Müller", "José García", "Seán Ó Briain"]);
    expect(t.rows[2]!.Email).toBe("");
  });
  test("UTF-16BE with BOM", () => {
    const t = parseFile(fixture("utf16be.tsv"), "export.txt");
    expect(t.rows.map((r) => r.Name)).toEqual(["Zoë Müller", "José García", "Seán Ó Briain"]);
    expect(t.kind).toBe("tsv");
  });
  test("BOM-less UTF-16LE is detected by NUL density", () => {
    const s = "Name,Phone\nJane,301-555-0123\n";
    const b = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) b[i * 2] = s.charCodeAt(i);
    const d = decodeBytes(b);
    expect(d.encoding).toBe("utf-16le");
    expect(d.text).toBe(s);
  });
  test("invalid UTF-8 falls back to windows-1252 with a warning", () => {
    const t = parseFile(fixture("windows1252.csv"), "old.csv");
    expect(t.rows.map((r) => r.First)).toEqual(["José", "Zoë", "Renée"]);
    expect(t.rows.map((r) => r.Last)).toEqual(["García", "Müller", "Côté"]);
    expect(t.warnings.join(" ")).toContain("windows-1252");
  });
  test("valid UTF-8 without BOM is left alone", () => {
    expect(decodeBytes(enc("Zoë")).encoding).toBe("utf-8");
  });
});

describe("delimited text", () => {
  test("Google-Sheets-style CSV: quoted commas, blank rows, trailing blank column", () => {
    const t = parseFile(fixture("google-sheets.csv"), "contacts.csv");
    expect(t.kind).toBe("csv");
    expect(t.columns).toEqual(["First Name", "Last Name", "Mobile Phone", "Email", "Company", "Notes", "Favorite Color"]);
    expect(t.rows).toHaveLength(6); // the all-blank row is skipped
    expect(t.rows[0]!.Notes).toBe("Met at the expo, loves coffee");
    expect(t.rows[1]!.Company).toBe("Jones, Bob & Sons");
    expect(t.rows[1]!.Notes).toBe("");
  });

  test("semicolon CSV with a title row, a subtitle and a blank row above the header", () => {
    const t = parseFile(fixture("semicolon-title.csv"), "gala.csv");
    expect(t.columns).toEqual(["Full Name", "Cell", "E-mail", "City"]);
    expect(t.rows).toHaveLength(3);
    expect(t.rows[0]!["Full Name"]).toBe("Smith, Jane");
    expect(t.rows[1]!.City).toBe("Silver Spring");
    expect(t.warnings.join(" ")).toMatch(/Skipped 2 row/);
  });

  test("delimiter sniffing: comma, semicolon, tab, pipe", () => {
    const body = (d: string) => ["Name", "Phone", "Email"].join(d) + "\n" + ["Jane", "301-555-0123", "j@x.co"].join(d) + "\n" + ["Bob", "301-555-0188", "b@x.co"].join(d);
    expect(sniffDelimiter(body(",")).delimiter).toBe(",");
    expect(sniffDelimiter(body(";")).delimiter).toBe(";");
    expect(sniffDelimiter(body("\t")).delimiter).toBe("\t");
    expect(sniffDelimiter(body("|")).delimiter).toBe("|");
    for (const d of [",", ";", "\t", "|"]) expect(parseText(body(d)).columns).toEqual(["Name", "Phone", "Email"]);
  });

  test("commas inside a semicolon file don't confuse the sniffer", () => {
    const t = parseText('Name;Phone;Note\n"Smith, Jane";301-555-0123;"hi, there"\nBob;301-555-0188;ok');
    expect(t.columns).toEqual(["Name", "Phone", "Note"]);
    expect(t.rows[0]!.Name).toBe("Smith, Jane");
  });

  test("duplicate and blank headers are deduped", () => {
    expect(dedupeHeaders(["Phone", "Phone", "", "phone", "Phone"])).toEqual(["Phone", "Phone (2)", "Column 3", "phone (3)", "Phone (4)"]);
    const t = parseText("Name,Phone,,Phone\nJane,301-555-0123,x,202-555-0143\nBob,301-555-0188,y,202-555-0199");
    expect(t.columns).toEqual(["Name", "Phone", "Column 3", "Phone (2)"]);
    expect(t.rows[0]!["Phone (2)"]).toBe("202-555-0143");
  });

  test("cells are trimmed (including NBSP) and short rows are padded", () => {
    const t = parseText("Name,Phone,Email\n  Jane  , 301-555-0123\nBob,301-555-0188,b@x.co");
    expect(t.rows[0]).toEqual({ Name: "Jane", Phone: "301-555-0123", Email: "" });
  });

  test("a file with no header row gets generated names", () => {
    const t = parseText("Jane Doe,301-555-0123\nBob Jones,301-555-0188\nAl Ng,202-555-0143");
    expect(t.columns).toEqual(["Column 1", "Column 2"]);
    expect(t.rows).toHaveLength(3);
    expect(t.warnings.join(" ")).toMatch(/No header row/);
  });

  test("Excel's sep= hint line is dropped", () => {
    const t = parseText("sep=;\nName;Phone\nJane;301-555-0123");
    expect(t.columns).toEqual(["Name", "Phone"]);
  });

  test("CRLF and CR-only line endings", () => {
    expect(parseText("Name,Phone\r\nJane,301-555-0123\r\nBob,301-555-0188\r\n").rows).toHaveLength(2);
    expect(parseText("Name,Phone\rJane,301-555-0123\rBob,301-555-0188\r").rows).toHaveLength(2);
  });

  test("quoted newlines stay inside the cell", () => {
    const t = parseText('Name,Notes\nJane,"line one\nline two"\nBob,ok');
    expect(t.rows[0]!.Notes).toBe("line one\nline two");
  });

  test("empty input", () => {
    const t = parseText("   \n  ");
    expect(t.rows).toEqual([]);
    expect(t.warnings.join(" ")).toMatch(/empty/i);
  });

  test("a single column of numbers", () => {
    const t = parseText("301-555-0123\n301-555-0188\n202-555-0143");
    expect(t.rows).toHaveLength(3);
  });
});

describe("spreadsheets", () => {
  function workbook(): Uint8Array {
    const wb = XLSX.utils.book_new();
    const s1 = XLSX.utils.aoa_to_sheet([
      ["Quarterly outreach", null, null],
      [null, null, null],
      ["Name", "Phone", "Joined"],
      ["Jane Smith", 3015550123, new Date(Date.UTC(2026, 0, 5))],
      ["Bob Jones", 13015550188, new Date(Date.UTC(2026, 1, 9))],
      ["Alice Nguyen", "202-555-0143", "2026-03-01"],
      ["UK Eve", 447911123456, null],
    ], { cellDates: true });
    XLSX.utils.book_append_sheet(wb, s1, "People");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Name", "Phone"], ["Other", "202-555-0199"]]), "Second");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "Empty");
    return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
  }

  test("lists every sheet and defaults to the first non-empty one", () => {
    const t = parseFile(workbook(), "book.xlsx");
    expect(t.kind).toBe("xlsx");
    expect(t.sheets).toEqual(["People", "Second", "Empty"]);
    expect(t.sheet).toBe("People");
    expect(t.columns).toEqual(["Name", "Phone", "Joined"]);
  });

  test("numeric phone cells come out as digit text, not 3.01555E+09", () => {
    const t = parseFile(workbook(), "book.xlsx");
    expect(t.rows.map((r) => r.Phone)).toEqual(["3015550123", "13015550188", "202-555-0143", "447911123456"]);
  });

  test("dates come out as text", () => {
    const t = parseFile(workbook(), "book.xlsx");
    expect(t.rows[0]!.Joined).toMatch(/2026|1\/5\/26|01-05/);
    expect(typeof t.rows[0]!.Joined).toBe("string");
    expect(t.rows[2]!.Joined).toBe("2026-03-01");
  });

  test("a sheet can be picked by name, case-insensitively, or by index", () => {
    expect(parseFile(workbook(), "b.xlsx", { sheet: "Second" }).rows[0]!.Name).toBe("Other");
    expect(parseFile(workbook(), "b.xlsx", { sheet: "second" }).sheet).toBe("Second");
    expect(parseFile(workbook(), "b.xlsx", { sheet: "1" }).sheet).toBe("Second");
  });

  test("an unknown sheet is a clear error", () => {
    expect(() => parseFile(workbook(), "b.xlsx", { sheet: "Nope" })).toThrow(/Nope.*People/);
  });

  test("an empty sheet gives an empty table, not a crash", () => {
    const t = parseFile(workbook(), "b.xlsx", { sheet: "Empty" });
    expect(t.rows).toEqual([]);
  });

  test("a number stored with scientific format still yields every digit", () => {
    const ws = XLSX.utils.aoa_to_sheet([["Phone"], [3015550123]]);
    ws["A2"]!.z = "0.00E+00";
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    expect(parseFile(bytes, "s.xlsx").rows[0]!.Phone).toBe("3015550123");
  });

  test("legacy .xls and .ods round-trip through SheetJS", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Name", "Phone"], ["Jane", 3015550123]]), "S");
    for (const [bookType, ext, kind] of [["biff8", "xls", "xls"], ["ods", "ods", "ods"]] as const) {
      const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType }) as ArrayBuffer);
      const t = parseFile(bytes, `book.${ext}`);
      expect(t.kind).toBe(kind);
      expect(t.rows[0]).toEqual({ Name: "Jane", Phone: "3015550123" });
    }
  });

  test("unknown extension with zip magic is read as a spreadsheet", () => {
    expect(parseFile(workbook(), "upload.bin").kind).toBe("xlsx");
  });

  test("a corrupt workbook gives a readable error", () => {
    expect(() => parseFile(enc("PK\u0003\u0004 not really a zip"), "x.xlsx")).toThrow();
  });

  test("PDFs are rejected with a hint", () => {
    expect(() => parseFile(enc("%PDF-1.7 ..."), "x.pdf")).toThrow(/PDF/);
  });
});

describe("vCard", () => {
  const t = () => parseFile(enc(fixtureText("contacts.vcf")), "contacts.vcf");

  test("three cards across 3.0, 2.1 and 4.0 versions", () => {
    const x = t();
    expect(x.kind).toBe("vcf");
    expect(x.rows).toHaveLength(3);
  });

  test("N, FN, ORG, multiple TEL and EMAIL", () => {
    const [jane] = t().rows;
    expect(jane).toMatchObject({ given_name: "Jane", family_name: "Smith", full_name: "Dr. Jane Q. Smith", org: "Acme Corp" });
    expect(jane!.email).toBe("jane@example.com"); // PREF first
    expect(jane!.email_2).toBe("jane@home.example.net");
  });

  test("mobile numbers come first, faxes are dropped", () => {
    const [jane] = t().rows;
    expect(jane!.phone).toBe("(301) 555-0123");
    expect(jane!.phone_2).toBe("+1 202 555 0143");
    expect(Object.values(jane!)).not.toContain("202-555-0100");
  });

  test("escaped commas and newlines in NOTE", () => {
    expect(t().rows[0]!.notes).toBe("Met at the expo, loves coffee\nCall before 5");
  });

  test("quoted-printable with UTF-8 and soft line breaks (2.1)", () => {
    const jose = t().rows[1]!;
    expect(jose).toMatchObject({ given_name: "José", family_name: "García", full_name: "José García", phone: "301-555-0188" });
    expect(jose.notes).toBe("Line one\nLine two");
  });

  test("vCard 4.0: tel: URI, folded lines, base64 PHOTO ignored", () => {
    const alice = t().rows[2]!;
    expect(alice).toMatchObject({ given_name: "Alice", family_name: "Nguyen", phone: "+1-202-555-0199", email: "alice@example.org", org: "Initech" });
    expect(alice.notes).toBe("A very long note that gets folded onto the next line by the sender so that the parser has to unfold it correctly");
  });

  test("columns that no card uses are dropped", () => {
    expect(t().columns).not.toContain("nickname");
    expect(t().columns).toContain("phone_2");
  });

  test("a card with only FN is split into given/family", () => {
    const x = parseText("BEGIN:VCARD\nVERSION:3.0\nFN:Smith, Jane\nTEL:3015550123\nEND:VCARD");
    expect(x.rows[0]).toMatchObject({ given_name: "Jane", family_name: "Smith", phone: "3015550123" });
  });

  test("LF-only endings, group prefixes, a truncated final card", () => {
    const x = parseText("BEGIN:VCARD\nVERSION:3.0\nitem1.TEL;type=pref:301-555-0123\nitem1.X-ABLabel:main\nFN:A B\nEND:VCARD\nBEGIN:VCARD\nFN:C D\nTEL:202-555-0143");
    expect(x.rows.map((r) => r.phone)).toEqual(["301-555-0123", "202-555-0143"]);
  });

  test("a .vcf with no cards warns", () => {
    expect(parseFile(enc("nothing here"), "x.vcf").warnings.join(" ")).toMatch(/No vCards/);
  });
});

describe("JSON and JSONL", () => {
  test("{contacts:[...]} with nested objects and arrays flattened", () => {
    const t = parseFile(enc(fixtureText("people.json")), "people.json");
    expect(t.kind).toBe("json");
    expect(t.rows).toHaveLength(3);
    expect(t.columns).toContain("address.city");
    expect(t.columns).toContain("phones");
    expect(t.rows[2]!.phones).toBe("202-555-0143; 202-555-0199");
    expect(t.rows[0]!.tags).toBe("vip; gala");
    expect(t.rows[1]!.phone).toBe("13015550188"); // numbers become digit text
    expect(t.rows[1]!["address.city"]).toBe("Silver Spring");
    expect(t.rows[0]!["address.city"]).toBe("");
  });

  test("a bare array of objects", () => {
    const t = parseText('[{"name":"Jane","phone":"301-555-0123"},{"name":"Bob","email":"b@x.co"}]');
    expect(t.columns).toEqual(["name", "phone", "email"]);
    expect(t.rows).toHaveLength(2);
  });

  test("{data:[...]}", () => {
    expect(parseText('{"data":[{"n":"a"},{"n":"b"}]}').rows).toHaveLength(2);
  });

  test("array of arrays: first row is the header", () => {
    const t = parseText('[["Name","Phone"],["Jane","301-555-0123"]]');
    expect(t.rows[0]).toEqual({ Name: "Jane", Phone: "301-555-0123" });
  });

  test("JSONL, with a blank line", () => {
    const t = parseFile(enc(fixtureText("people.jsonl")), "people.jsonl");
    expect(t.kind).toBe("jsonl");
    expect(t.rows).toHaveLength(3);
    expect(t.columns).toEqual(["first_name", "last_name", "mobile", "note"]);
  });

  test("JSONL skips bad lines with a warning", () => {
    const t = parseText('{"a":"1"}\nnot json\n{"a":"2"}');
    expect(t.rows).toHaveLength(2);
    expect(t.warnings.join(" ")).toMatch(/Skipped 1/);
  });

  test("a single object is one row", () => {
    expect(parseText('{"name":"Jane","phone":"301-555-0123"}').rows).toHaveLength(1);
  });

  test("broken JSON given a .json name is an error", () => {
    expect(() => parseFile(enc("{oops"), "x.json")).toThrow();
  });
});

describe("pasted text", () => {
  test("markdown table: emphasis, links and escaped pipes are cleaned", () => {
    const t = parseText(fixtureText("pasted.md"));
    expect(t.columns).toEqual(["Name", "Phone", "Email", "Role"]);
    expect(t.rows).toHaveLength(3);
    expect(t.rows[0]).toEqual({ Name: "Jane Smith", Phone: "(301) 555-0123", Email: "jane@example.com", Role: "Host" });
    expect(t.rows[2]!.Role).toBe("Guest | VIP");
  });

  test("pasted TSV from a spreadsheet", () => {
    const t = parseText("Name\tPhone\nJane Smith\t(301) 555-0123\nBob Jones\t301-555-0188");
    expect(t.kind).toBe("tsv");
    expect(t.rows).toHaveLength(2);
  });

  test("'Name - phone' lines", () => {
    const t = parseText("Jane Smith - (301) 555-0123\nBob Jones: 301-555-0188\nAlice Nguyen 202-555-0143\n+44 7911 123456 - Eve");
    expect(t.columns).toEqual(["Name", "Phone"]);
    expect(t.rows.map((r) => r.Name)).toEqual(["Jane Smith", "Bob Jones", "Alice Nguyen", "Eve"]);
    expect(t.rows.map((r) => r.Phone)).toEqual(["(301) 555-0123", "301-555-0188", "202-555-0143", "+44 7911 123456"]);
  });

  test("lines with emails, bullets and angle brackets", () => {
    const t = parseText("1. Jane Smith <jane@example.com>\n- bob@example.com Bob Jones\n* Alice - alice@example.org");
    expect(t.columns).toEqual(["Name", "Email"]);
    expect(t.rows.map((r) => r.Email)).toEqual(["jane@example.com", "bob@example.com", "alice@example.org"]);
    expect(t.rows.map((r) => r.Name)).toEqual(["Jane Smith", "Bob Jones", "Alice"]);
  });

  test("'Last, First - phone' lines are not mistaken for a CSV", () => {
    const t = parseText("Smith, Jane - 301-555-0123\nJones, Bob - 301-555-0188\nNguyen, Alice - 202-555-0143");
    expect(t.columns).toEqual(["Name", "Phone"]);
    expect(t.rows[0]).toEqual({ Name: "Smith, Jane", Phone: "301-555-0123" });
  });

  test("bare phone numbers, one per line", () => {
    const t = parseText("301-555-0123\n(301) 555-0188\n202.555.0143");
    expect(t.columns).toEqual(["Phone"]);
    expect(t.rows).toHaveLength(3);
  });

  test("pasted vCard and JSON are recognised", () => {
    expect(parseText(fixtureText("contacts.vcf")).kind).toBe("vcf");
    expect(parseText('[{"a":"1"}]').kind).toBe("json");
  });

  test("hint can force csv/tsv", () => {
    expect(parseText("a,b\n1,2", "csv").kind).toBe("csv");
  });

  test("name list with no contact info stays a plain column", () => {
    const t = parseText("Jane Smith\nBob Jones\nAlice Nguyen");
    expect(t.rows).toHaveLength(3);
    expect(t.columns).toHaveLength(1);
  });
});

describe("kind detection from filename and content", () => {
  test(".txt holding a CSV", () => {
    expect(parseFile(enc("Name,Phone\nJane,301-555-0123\nBob,301-555-0188"), "paste.txt").columns).toEqual(["Name", "Phone"]);
  });
  test("no extension with JSON content", () => {
    expect(parseFile(enc('[{"a":1}]'), "upload").kind).toBe("json");
  });
  test("opts.kind overrides the extension", () => {
    expect(parseFile(enc("Name\tPhone\nJane\t301-555-0123"), "data.dat", { kind: "tsv" }).kind).toBe("tsv");
  });
  test(".tsv forced tab even with commas in names", () => {
    const t = parseFile(enc("Name\tPhone\nSmith, Jane\t301-555-0123\nJones, Bob\t301-555-0188"), "x.tsv");
    expect(t.rows[0]!.Name).toBe("Smith, Jane");
  });
});
