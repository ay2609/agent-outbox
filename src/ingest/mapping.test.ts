import { describe, expect, test } from "bun:test";
import { fixture } from "./testutil";
import { columnSlugs, completeMapping, guessMapping, headerScore, mappingNeedsConfirmation } from "./mapping";
import { parseFile, parseText } from "./parse";

const table = (columns: string[], rows: string[][]) => ({ columns, rows: rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ""]))) });

describe("headerScore", () => {
  const cases: [Parameters<typeof headerScore>[0], string, number][] = [
    ["given_name", "First Name", 0.95], ["given_name", "fname", 0.95], ["given_name", "Given", 0.95],
    ["family_name", "Surname", 0.95], ["family_name", "Last", 0.95],
    ["display_name", "Full Name", 0.95], ["display_name", "Name", 0.95], ["display_name", "Contact", 0.8],
    ["phone", "Mobile", 0.96], ["phone", "Cell #", 0.86], ["phone", "Phone Number", 0.95], ["phone", "WhatsApp", 0.95], ["phone", "Phone 1 - Value", 0.85],
    ["email", "E-mail", 0.95], ["email", "Email Address", 0.95], ["email", "E-mail 1 - Value", 0.95], ["email", "Work Email", 0.85],
    ["org", "Company", 0.95], ["org", "Organisation", 0.95], ["org", "Employer", 0.95], ["org", "Organization Name", 0.95],
    ["notes", "Notes", 0.95], ["tags", "Groups", 0.95],
  ];
  for (const [f, h, min] of cases) test(`${f} <- ${JSON.stringify(h)}`, () => expect(headerScore(f, h)).toBeGreaterThanOrEqual(min - 0.01));

  test("labels and types are not phone/email columns", () => {
    expect(headerScore("phone", "Phone 1 - Label")).toBe(0);
    expect(headerScore("phone", "Phone Type")).toBe(0);
    expect(headerScore("email", "E-mail 1 - Label")).toBe(0);
    expect(headerScore("email", "Email Status")).toBe(0);
    expect(headerScore("org", "Organization Title")).toBe(0);
    expect(headerScore("display_name", "Company Name")).toBe(0);
    expect(headerScore("display_name", "Nickname")).toBe(0);
  });
});

describe("guessMapping", () => {
  test("Google-Sheets CSV maps cleanly and is confident", () => {
    const t = parseFile(fixture("google-sheets.csv"), "c.csv");
    const m = guessMapping(t);
    expect(m.fields.given_name!.column).toBe("First Name");
    expect(m.fields.family_name!.column).toBe("Last Name");
    expect(m.fields.phone!.column).toBe("Mobile Phone");
    expect(m.fields.email!.column).toBe("Email");
    expect(m.fields.org!.column).toBe("Company");
    expect(m.fields.notes!.column).toBe("Notes");
    for (const f of ["given_name", "family_name", "phone", "email"] as const) expect(m.fields[f]!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(m.vars).toEqual({ favorite_color: "Favorite Color" });
    expect(m.confirmed).toBe(false);
    expect(mappingNeedsConfirmation(m)).toBe(false);
  });

  test("semicolon file: full name + cell + e-mail", () => {
    const m = guessMapping(parseFile(fixture("semicolon-title.csv"), "g.csv"));
    expect(m.fields.display_name!.column).toBe("Full Name");
    expect(m.fields.phone!.column).toBe("Cell");
    expect(m.fields.email!.column).toBe("E-mail");
    expect(m.vars).toEqual({ city: "City" });
    expect(mappingNeedsConfirmation(m)).toBe(false);
  });

  test("vCard columns map directly", () => {
    const m = guessMapping(parseFile(fixture("contacts.vcf"), "c.vcf"));
    expect(m.fields.given_name!.column).toBe("given_name");
    expect(m.fields.phone!.column).toBe("phone");
    expect(m.fields.email!.column).toBe("email");
    expect(m.fields.org!.column).toBe("org");
    expect(m.fields.display_name!.column).toBe("full_name");
    expect(Object.keys(m.vars)).toEqual(["phone_2", "email_2"]);
  });

  test("headerless data: phone found by value sniffing, name by shape, and confirmation is required for the name", () => {
    const m = guessMapping(parseText("Jane Doe,301-555-0123\nBob Jones,301-555-0188\nAl Ng,202-555-0143"));
    expect(m.fields.phone!.column).toBe("Column 2");
    expect(m.fields.phone!.confidence).toBeCloseTo(0.85, 2);
    expect(m.fields.display_name!.column).toBe("Column 1");
    expect(m.fields.display_name!.confidence).toBeLessThan(0.8);
    expect(mappingNeedsConfirmation(m)).toBe(true);
  });

  test("a mystery header over phone-looking values is found by sniffing", () => {
    const t = table(["Who", "Reach"], [["Jane Smith", "301-555-0123"], ["Bob Jones", "301-555-0188"], ["Al Ng", "202-555-0143"]]);
    const m = guessMapping(t);
    expect(m.fields.phone!.column).toBe("Reach");
    expect(m.fields.display_name!.column).toBe("Who");
  });

  test("email columns are recognised from values alone", () => {
    const t = table(["Name", "x"], [["Jane", "j@x.co"], ["Bob", "b@x.co"]]);
    expect(guessMapping(t).fields.email).toEqual({ column: "x", confidence: 0.95 });
  });

  test("header says phone but values are junk: low confidence, needs confirmation", () => {
    const t = table(["Name", "Phone"], [["Jane", "n/a"], ["Bob", "ask her"], ["Al", "???"]]);
    const m = guessMapping(t);
    expect(m.fields.phone!.confidence).toBeLessThan(0.8);
    expect(mappingNeedsConfirmation(m)).toBe(true);
  });

  test("no phone or email column at all: missing field means confirmation", () => {
    const m = guessMapping(table(["Name", "City"], [["Jane Smith", "Paris"], ["Bob Jones", "Rome"]]));
    expect(m.fields.phone).toBeUndefined();
    expect(m.fields.email).toBeUndefined();
    expect(mappingNeedsConfirmation(m)).toBe(true);
  });

  test("phone but no name: confirmation required", () => {
    const m = guessMapping(table(["Phone"], [["301-555-0123"], ["301-555-0188"]]));
    expect(m.fields.phone!.confidence).toBeGreaterThanOrEqual(0.8);
    expect(mappingNeedsConfirmation(m)).toBe(true);
  });

  test("a column is never mapped twice, and the better phone column wins", () => {
    const t = table(["Name", "Home Phone", "Mobile Phone"], [["Jane", "202-555-0143", "301-555-0123"], ["Bob", "202-555-0199", "301-555-0188"]]);
    const m = guessMapping(t);
    expect(m.fields.phone!.column).toBe("Mobile Phone");
    expect(m.vars).toEqual({ home_phone: "Home Phone" });
    const cols = Object.values(m.fields).map((f) => f!.column);
    expect(new Set(cols).size).toBe(cols.length);
  });

  test("a 'Name' column full of emails is an email, not a name", () => {
    const m = guessMapping(table(["Name", "Phone"], [["jane@x.co", "301-555-0123"], ["bob@x.co", "301-555-0188"]]));
    expect(m.fields.email!.column).toBe("Name");
    expect(m.fields.display_name).toBeUndefined();
  });

  test("Google Contacts export layout", () => {
    const cols = ["First Name", "Middle Name", "Last Name", "Organization Name", "Organization Title", "E-mail 1 - Label", "E-mail 1 - Value", "Phone 1 - Label", "Phone 1 - Value"];
    const m = guessMapping(table(cols, [["Jane", "", "Smith", "Acme", "CEO", "Work", "j@x.co", "Mobile", "(301) 555-0123"], ["Bob", "Q", "Jones", "", "", "Home", "b@x.co", "Mobile", "301-555-0188"]]));
    expect(m.fields.phone!.column).toBe("Phone 1 - Value");
    expect(m.fields.email!.column).toBe("E-mail 1 - Value");
    expect(m.fields.org!.column).toBe("Organization Name");
    expect(m.vars).toMatchObject({ middle_name: "Middle Name", organization_title: "Organization Title", phone_1_label: "Phone 1 - Label" });
    expect(mappingNeedsConfirmation(m)).toBe(false);
  });

  test("an empty table doesn't throw", () => {
    const m = guessMapping({ columns: [], rows: [] });
    expect(m.fields).toEqual({});
    expect(mappingNeedsConfirmation(m)).toBe(true);
  });
});

describe("columnSlugs and completeMapping", () => {
  test("slug collisions get numeric suffixes", () => {
    expect(columnSlugs(["Phone", "phone", "Phone (2)", "Phone 2"])).toEqual({ Phone: "phone", phone: "phone_2", "Phone (2)": "phone_2_2", "Phone 2": "phone_2_3" });
  });
  test("completeMapping fills vars and defaults confirmed to true", () => {
    const m = completeMapping({ fields: { phone: { column: "B", confidence: 1 } } }, ["A", "B", "C"]);
    expect(m).toEqual({ fields: { phone: { column: "B", confidence: 1 } }, vars: { a: "A", c: "C" }, confirmed: true });
    expect(mappingNeedsConfirmation(m)).toBe(false);
  });
  test("rejects unknown columns, unknown fields and double mapping", () => {
    expect(() => completeMapping({ fields: { phone: { column: "Z", confidence: 1 } } }, ["A"])).toThrow(/Z/);
    expect(() => completeMapping({ fields: { bogus: { column: "A", confidence: 1 } } as any }, ["A"])).toThrow(/bogus/);
    expect(() => completeMapping({ fields: { phone: { column: "A", confidence: 1 }, email: { column: "A", confidence: 1 } } }, ["A"])).toThrow(/one field/);
  });
});
