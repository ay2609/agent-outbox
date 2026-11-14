// Phone and email columns: ordered lists, coverage weighting, per-row labels, regions, tags, duplicate people.
import { describe, expect, test } from "bun:test";
import { getImport, ingestFile, setMapping } from "./ingest";
import { columnSlugs, completeMapping, guessMapping, mappingNeedsConfirmation } from "./mapping";
import { normalizePhone, normalizePhoneLoose } from "./normalize";
import { parseFile } from "./parse";
import { classifyLabel, labelColumnFor, scanEmails, scanPhones, splitTags } from "./rows";
import { memDb, seedContact, tmpImportsDir } from "./testutil";

const enc = (s: string) => new TextEncoder().encode(s);
const run = (csv: string, extra: Record<string, unknown> = {}, db = memDb(), name = "a.csv") => {
  const s = ingestFile(db, { bytes: enc(csv), filename: name, created_by: "t", importsDir: tmpImportsDir(), ...extra });
  return { db, s, rows: getImport(db, s.import_id).rows };
};

// A Google Contacts export: the mobile number is not in "Phone 1", and one cell holds several numbers.
const GOOGLE = [
  "First Name,Last Name,Organization Name,Labels,E-mail 1 - Label,E-mail 1 - Value,Phone 1 - Label,Phone 1 - Value,Phone 2 - Label,Phone 2 - Value,Phone 3 - Label,Phone 3 - Value",
  "Jane,Smith,Acme,* myContacts ::: College Friends,Home,jane@example.com,Work,202-555-0143,Mobile,(301) 555-0123,,",
  "Bob,Jones,,* myContacts,Work,bob@example.com,Work ::: Mobile,301-555-0150 ::: 301-555-0188,,,,",
  "Cy,Dee,,College Friends ::: Climbing,Home,cy@example.com,Home,202-555-0100,,,,",
  "Dana,Ng,,* myContacts,,,Work,202-555-0111,iPhone,202-555-0112,Home,202-555-0113",
  "Eli,Park,,* myContacts,,eli@example.com,Work,202-555-0114,,,,",
  "Fay,Roe,,* myContacts,,,Mobile,301-555-0177,,,,",
].join("\n");

describe("Google CSV: the draft goes to the mobile number, not the work number", () => {
  test("per-row labels pick the mobile; a multi-value cell is split on ' ::: '", () => {
    const { rows } = run(GOOGLE);
    expect(rows.map((r) => r.normalized.handle)).toEqual([
      "+13015550123", // Phone 2 is the Mobile
      "+13015550188", // second value of "Work ::: Mobile"
      "+12025550100", // only a Home number: first valid phone
      "+12025550112", // iPhone beats Work and Home
      "+12025550114", // only a Work number, no mobile: still the first valid phone
      "+13015550177",
    ]);
    expect(rows[1]!.normalized.phones).toEqual(["+13015550188", "+13015550150"]);
    expect(rows[1]!.issues.find((i) => i.code === "phone_note")!.message).toContain("using +13015550188 (mobile)");
  });

  test("the mapping lists every phone column; the dense Phone 1 column leads when nothing is labelled mobile in the header", () => {
    const m = guessMapping(parseFile(enc(GOOGLE), "g.csv"));
    expect(m.fields.phone!.column).toBe("Phone 1 - Value");
    expect(m.fields.phone!.columns).toEqual(["Phone 1 - Value", "Phone 2 - Value", "Phone 3 - Value"]);
    expect(m.fields.phone!.confidence).toBeGreaterThanOrEqual(0.9);
    // label columns are not phone columns
    expect(m.fields.phone!.columns).not.toContain("Phone 1 - Label");
    expect(mappingNeedsConfirmation(m)).toBe(false);
  });

  test("labelColumnFor pairs value columns with their label column", () => {
    const cols = ["Phone 1 - Label", "Phone 1 - Value", "phones.0.number", "phones.0.type", "phone", "phone_label", "Mobile Phone"];
    expect(labelColumnFor("Phone 1 - Value", cols)).toBe("Phone 1 - Label");
    expect(labelColumnFor("phones.0.number", cols)).toBe("phones.0.type");
    expect(labelColumnFor("phone", cols)).toBe("phone_label");
    expect(labelColumnFor("Mobile Phone", cols)).toBeNull();
  });

  test("classifyLabel: Apple custom labels, Google 'Mobile', home/work/main, fax is skipped", () => {
    expect(classifyLabel("_$!<Mobile>!$_")).toBe("mobile");
    expect(classifyLabel("iPhone")).toBe("mobile");
    expect(classifyLabel("Cell")).toBe("mobile");
    expect(classifyLabel("Work")).toBe("fixed");
    expect(classifyLabel("_$!<Home>!$_")).toBe("fixed");
    expect(classifyLabel("Main")).toBe("fixed");
    expect(classifyLabel("Mom")).toBe("none");
    expect(classifyLabel("Work Fax")).toBe("skip");
    expect(classifyLabel("")).toBe("none");
  });
});

describe("coverage weighting", () => {
  test("a phone column filled by one record out of twenty is no longer 'confident'", () => {
    const lines = ["Name,Phone", "Jane Smith,301-555-0123", ...Array.from({ length: 19 }, (_, i) => `Person${i} Test,`)];
    const m = guessMapping(parseFile(enc(lines.join("\n")), "a.csv"));
    expect(m.fields.phone!.column).toBe("Phone");
    expect(m.fields.phone!.confidence).toBeLessThan(0.6);
    expect(mappingNeedsConfirmation(m)).toBe(true);
  });

  test("a sparse mobile column does not outrank a dense one on score, but both are mapped and each row uses its own best", () => {
    const rows = ["Name,Phone,Mobile"];
    for (let i = 0; i < 10; i++) rows.push(`Person${i} Test,202-555-01${String(i).padStart(2, "0")},${i === 3 ? "301-555-0199" : ""}`);
    const m = guessMapping(parseFile(enc(rows.join("\n")), "a.csv"));
    expect(m.fields.phone!.columns).toEqual(["Mobile", "Phone"]); // mobile header first
    expect(m.fields.phone!.confidence).toBeGreaterThanOrEqual(0.9); // the union of both columns covers every row
    const { rows: out } = run(rows.join("\n"));
    expect(out[3]!.normalized.handle).toBe("+13015550199");
    expect(out[4]!.normalized.handle).toBe("+12025550104");
  });

  test("a spouse / emergency / assistant phone column is never a recipient column", () => {
    const m = guessMapping(parseFile(enc("Name,Mobile,Spouse Phone,Emergency Contact Phone,Assistant Email\nJane Smith,301-555-0123,301-555-0188,202-555-0143,pa@x.co\nBob Jones,301-555-0124,301-555-0189,202-555-0144,pb@x.co\n"), "a.csv"));
    expect(m.fields.phone!.columns ?? [m.fields.phone!.column]).toEqual(["Mobile"]);
    expect(m.fields.email).toBeUndefined();
    expect(Object.values(m.vars)).toEqual(expect.arrayContaining(["Spouse Phone", "Emergency Contact Phone", "Assistant Email"]));
  });

  test("fax columns are left out of the phone list", () => {
    const m = guessMapping(parseFile(enc("Name,Mobile Phone,Business Fax\nJane Smith,301-555-0123,301-555-0100\nBob Jones,301-555-0124,301-555-0101\n"), "a.csv"));
    expect(m.fields.phone!.columns ?? [m.fields.phone!.column]).toEqual(["Mobile Phone"]);
  });
});

describe("Outlook CSV", () => {
  const OUTLOOK = [
    "First Name,Last Name,Company,E-mail Address,Mobile Phone,Home Phone,Business Phone,Categories",
    "Jane,Smith,Acme,jane@example.com,,301-555-0123,202-555-0143,Climbing; Family",
    "Bob,Jones,,bob@example.com,(301) 555-0188,202-555-0199,,Work",
  ].join("\n");

  test("columns are an ordered list, mobile first; Home Phone is used when there is no mobile", () => {
    const m = guessMapping(parseFile(enc(OUTLOOK), "o.csv"));
    expect(m.fields.phone!.columns).toEqual(["Mobile Phone", "Home Phone", "Business Phone"]);
    const { rows } = run(OUTLOOK);
    expect(rows[0]!.normalized.handle).toBe("+13015550123"); // home beats business (both unmapped to a mobile)
    expect(rows[1]!.normalized.handle).toBe("+13015550188");
  });

  test("a row whose HOME phone is an existing contact's number matches that contact", () => {
    const db = memDb();
    const id = seedContact(db, { given: "Jane", family: "Smith", phones: ["+13015550123"] });
    const { rows, s } = run(OUTLOOK, {}, db);
    expect(rows[0]).toMatchObject({ match: "matched", contact_id: id });
    expect(s.counts).toMatchObject({ matched: 1, new: 1 });
  });

  test("matching tries every phone and email: a number that is not the best one still matches", () => {
    const db = memDb();
    // the contact has Jane's BUSINESS number only; her best number (Mobile) is not saved
    const id = seedContact(db, { given: "Jane", family: "Smith", phones: ["+12025550143"] });
    const csv = "First Name,Last Name,Mobile Phone,Business Phone\nJane,Smith,301-555-0123,202-555-0143\n";
    const { rows } = run(csv, {}, db);
    expect(rows[0]).toMatchObject({ match: "matched", contact_id: id });
    // the draft goes to a number the contact really has, and the owner is told why
    expect(rows[0]!.normalized.handle).toBe("+12025550143");
    expect(rows[0]!.issues.filter((i) => i.code === "phone_note").map((i) => i.message).join(" | ")).toContain("is in your contacts");
  });

  test("a row's email matches a contact when the phone doesn't", () => {
    const db = memDb();
    const id = seedContact(db, { given: "Jane", family: "Smith", emails: ["jane@example.com"] });
    const { rows } = run(OUTLOOK, {}, db);
    expect(rows[0]).toMatchObject({ match: "matched", contact_id: id });
    expect(rows[0]!.normalized.handle).toBe("jane@example.com"); // the contact's own address, not a number it doesn't have
  });

  test("Categories become tags", () => {
    const { rows } = run(OUTLOOK);
    expect(rows[0]!.normalized.tags).toEqual(["Climbing", "Family"]);
    expect(rows[1]!.normalized.tags).toEqual(["Work"]);
  });
});

describe("flattened JSON: phones.N.number is one logical list", () => {
  const JSON_PEOPLE = JSON.stringify([
    { name: "Jane Smith", phones: [{ type: "work", number: "202-555-0143" }, { type: "mobile", number: "301-555-0123" }] },
    { name: "Bob Jones", phones: [{ type: "home", number: "202-555-0199" }] },
    { name: "Cy Dee", phones: [{ number: "301-555-0150" }, { number: "301-555-0151" }] },
  ]);
  test("per-item type labels are used; the list order breaks ties", () => {
    const { s, rows } = run(JSON_PEOPLE, {}, memDb(), "p.json");
    expect(s.mapping.fields.phone!.columns).toEqual(["phones.0.number", "phones.1.number"]);
    expect(rows.map((r) => r.normalized.handle)).toEqual(["+13015550123", "+12025550199", "+13015550150"]);
  });
  test("a bare array of strings in one cell is split", () => {
    const { rows } = run(JSON.stringify([{ name: "Alice Nguyen", phones: ["bad", "202-555-0143", "202-555-0199"] }]), {}, memDb(), "p.json");
    expect(rows[0]!.normalized.phones).toEqual(["+12025550143", "+12025550199"]);
  });
});

describe("region and international numbers", () => {
  const UK = "Name,Mobile\nAnn Lee,07911 123456\nBen Roe,447911123457\nCat Poe,+44 7911 123458\n";
  test("with region GB, national numbers parse; the region is stored in mapping_json and shown in the summary", () => {
    const db = memDb();
    const { s, rows } = run(UK, { region: "gb" }, db);
    expect(s.mapping.region).toBe("GB");
    expect(rows.map((r) => r.normalized.handle)).toEqual(["+447911123456", "+447911123457", "+447911123458"]);
    const stored = JSON.parse((db.query("SELECT mapping_json FROM imports WHERE id = ?").get(s.import_id) as any).mapping_json);
    expect(stored.region).toBe("GB");
  });

  test("US default: an 11+ digit number without '+' is retried as international and flagged", () => {
    const { rows } = run("Name,Mobile\nBen Roe,447911123457\nCat Poe,+44 7911 123458\nDan Fox,07911 123456\n");
    expect(rows[0]!.normalized.handle).toBe("+447911123457");
    expect(rows[0]!.issues.find((i) => i.code === "phone_note")!.message).toMatch(/no country code.*\+447911123457.*region/);
    expect(rows[1]!.normalized.handle).toBe("+447911123458");
    expect(rows[1]!.issues.find((i) => i.code === "phone_note")).toBeUndefined();
    expect(rows[2]!.match).toBe("invalid");
  });

  test("an invalid number says how to fix it", () => {
    const { rows } = run("Name,Mobile\nDan Fox,07911 123456\n");
    const msg = rows[0]!.issues.find((i) => i.code === "invalid_phone")!.message;
    expect(msg).toContain("country code like +44");
    expect(msg).toContain("set region");
  });

  test("setMapping can set the region later, re-normalises, and keeps it on the next call", () => {
    const db = memDb();
    const { s, rows } = run("Name,Mobile\nDan Fox,07911 123456\n", {}, db);
    expect(rows[0]!.match).toBe("invalid");
    const s2 = setMapping(db, s.import_id, { fields: { display_name: { column: "Name", confidence: 1 }, phone: { column: "Mobile", confidence: 1 } }, region: "GB" });
    expect(s2.mapping.region).toBe("GB");
    expect(s2.counts).toMatchObject({ new: 1, invalid: 0 });
    // a later mapping call without a region keeps GB
    const s3 = setMapping(db, s.import_id, { fields: { display_name: { column: "Name", confidence: 1 }, phone: { column: "Mobile", confidence: 1 } } });
    expect(s3.mapping.region).toBe("GB");
    expect(s3.counts.new).toBe(1);
    // and the owner API's call shape (region as a 4th argument) works too
    const s4 = setMapping(db, s.import_id, { fields: { display_name: { column: "Name", confidence: 1 }, phone: { column: "Mobile", confidence: 1 } } }, { region: "us" });
    expect(s4.mapping.region).toBe("US");
    expect(s4.counts.invalid).toBe(1);
  });

  test("a bad region is refused", () => {
    expect(() => run("Name,Mobile\nA B,301-555-0123\n", { region: "UK1" })).toThrow(/two-letter country code/);
    expect(() => run("Name,Mobile\nA B,301-555-0123\n", { region: "ZZ" })).toThrow(/country code/);
  });

  test("normalizePhoneLoose", () => {
    expect(normalizePhone("447911123457").valid).toBe(false); // the strict one is unchanged
    expect(normalizePhoneLoose("447911123457")).toMatchObject({ valid: true, e164: "+447911123457", note: "assumed_country_code" });
    expect(normalizePhoneLoose("(301) 555-0123")).toMatchObject({ valid: true, e164: "+13015550123" });
    expect(normalizePhoneLoose("12345678901234567890").valid).toBe(false); // too long
    expect(normalizePhoneLoose("3.01555E+09").note).toBe("excel_scientific_notation");
  });
});

describe("tags", () => {
  test("Google Labels: '* myContacts' is dropped, the rest become tags and a template var", () => {
    const { rows, db, s } = run(GOOGLE);
    expect(rows[0]!.normalized.tags).toEqual(["College Friends"]);
    expect(rows[1]!.normalized.tags).toEqual([]);
    expect(rows[2]!.normalized.tags).toEqual(["College Friends", "Climbing"]);
    expect(s.mapping.fields.tags!.column).toBe("Labels");
    expect(getImport(db, s.import_id).rows[2]!.vars!.tags).toBe("College Friends, Climbing");
  });
  test("splitTags", () => {
    expect(splitTags("* myContacts ::: * starred ::: Work, Family; family")).toEqual(["starred", "Work", "Family"]);
    expect(splitTags("")).toEqual([]);
  });
});

describe("mapping details", () => {
  test("column names match case-insensitively; the exact header is stored", () => {
    const m = completeMapping({ fields: { phone: { column: "mobile phone", confidence: 1 }, display_name: { column: " NAME ", confidence: 1 } } }, ["Name", "Mobile Phone", "City"]);
    expect(m.fields.phone!.column).toBe("Mobile Phone");
    expect(m.fields.display_name!.column).toBe("Name");
    expect(m.vars).toEqual({ city: "City" });
  });
  test("phone may carry columns next to column; column leads; a column can't be in two fields", () => {
    const cols = ["Name", "Home", "Cell", "Work Email"];
    const m = completeMapping({ fields: { phone: { column: "Cell", columns: ["home", "cell"], confidence: 1 } } }, cols);
    expect(m.fields.phone).toEqual({ column: "Cell", confidence: 1, columns: ["Cell", "Home"] });
    expect(m.vars).toMatchObject({ home: "Home", name: "Name" }); // extra phone columns stay available as {{home}}
    expect(() => completeMapping({ fields: { phone: { column: "Cell", columns: ["Home"], confidence: 1 }, email: { column: "home", confidence: 1 } } }, cols)).toThrow(/one field/);
    expect(() => completeMapping({ fields: { org: { column: "Name", columns: ["Home"], confidence: 1 } } }, cols)).toThrow(/only supported for phone/);
    expect(() => completeMapping({ fields: { phone: { columns: [], confidence: 1 } as any } }, cols)).toThrow(/needs a column/);
  });
  test("manager / assistant / spouse / children / referred-by columns are not names", () => {
    const m = guessMapping(parseFile(enc("Manager Name,Assistant Name,Spouse Name,Children Name,Referred By Name,Full Name,Phone\nA B,C D,E F,G H,I J,Jane Smith,301-555-0123\nA B,C D,E F,G H,I J,Bob Jones,301-555-0124\n"), "a.csv"));
    expect(m.fields.display_name!.column).toBe("Full Name");
    for (const c of ["Manager Name", "Assistant Name", "Spouse Name", "Children Name", "Referred By Name"]) expect(Object.values(m.fields).map((f) => f!.column)).not.toContain(c);
  });
  test("columnSlugs unchanged for the standard cases", () => {
    expect(columnSlugs(["Phone 1 - Value"])["Phone 1 - Value"]).toBe("phone_1_value");
  });
});

describe("scanPhones / scanEmails directly", () => {
  test("rank: mobile label < unlabelled < home/work; invalid values are reported; fax is skipped", () => {
    const raw = { a: "202-555-0111", a_label: "Work", b: "301-555-0123", b_label: "", c: "301-555-0188", c_label: "Cell", d: "not a number", f: "202-555-0100", f_label: "Work Fax" };
    const r = scanPhones(raw, ["a", "b", "c", "d", "f"], "US");
    expect(r.entries.map((e) => e.e164)).toEqual(["+13015550188", "+13015550123", "+12025550111"]);
    expect(r.invalid).toEqual([{ column: "d", raw: "not a number" }]);
  });
  test("emails: work addresses rank after personal ones; labels split on :::", () => {
    const r = scanEmails({ e1: "w@acme.com ::: h@home.com", e1_label: "Work ::: Home", e2: "bad@" }, ["e1", "e2"]);
    expect(r.entries.map((e) => e.email)).toEqual(["h@home.com", "w@acme.com"]);
    expect(r.invalid).toEqual([{ column: "e2", raw: "bad@" }]);
  });
});

describe("duplicate people", () => {
  test("same name, matched to the same contact through different numbers: the later row is a duplicate naming the kept row", () => {
    const db = memDb();
    const id = seedContact(db, { given: "Jane", family: "Smith", phones: ["+13015550123", "+12025550143"] });
    const csv = "Name,Phone\nJane Smith,301-555-0123\nJane Smith,202-555-0143\nBob Jones,301-555-0188\n";
    const { s, rows } = run(csv, {}, db);
    expect(rows[0]).toMatchObject({ match: "matched", contact_id: id });
    expect(rows[1]!.match).toBe("duplicate");
    expect(rows[1]!.issues.find((i) => i.code === "duplicate_person")).toMatchObject({ row: 0 });
    expect(rows[1]!.contact_id).toBeNull();
    expect(s.counts).toMatchObject({ matched: 1, duplicate: 1, new: 1 });
  });

  test("same name listed twice with one shared number (not the chosen one) is the same person", () => {
    const csv = "Name,Mobile,Home\nJane Smith,301-555-0123,202-555-0143\nJane Smith,301-555-0999,202-555-0143\n";
    const { rows } = run(csv);
    expect(rows[1]!.match).toBe("duplicate");
    expect(rows[1]!.issues.map((i) => i.code)).toContain("duplicate_person");
  });

  test("two different people who share a household landline are NOT merged", () => {
    const csv = "Name,Mobile,Home\nJane Smith,301-555-0123,202-555-0143\nJohn Smith,301-555-0124,202-555-0143\n";
    const { s } = run(csv);
    expect(s.counts).toMatchObject({ new: 2, duplicate: 0 });
  });

  test("same name with unrelated numbers stays two rows (two real people called the same)", () => {
    const { s } = run("Name,Phone\nJohn Smith,301-555-0123\nJohn Smith,202-555-0143\n");
    expect(s.counts).toMatchObject({ new: 2, duplicate: 0 });
  });
});

describe("names", () => {
  test("the display name stays as written, middle names go into given_name, multi-part surnames are kept", () => {
    const { rows } = run("Full Name,Phone\nMary Jane Watson,301-555-0123\nAna de la Cruz,301-555-0124\nDr. Alice Q. Nguyen,301-555-0125\n\"Smith, Jane\",301-555-0126\nLUDWIG VAN BEETHOVEN,301-555-0127\n");
    expect(rows.map((r) => r.normalized.display_name)).toEqual(["Mary Jane Watson", "Ana de la Cruz", "Dr. Alice Q. Nguyen", "Jane Smith", "Ludwig Van Beethoven"]);
    expect(rows.map((r) => [r.normalized.given_name, r.normalized.family_name])).toEqual([
      ["Mary Jane", "Watson"], ["Ana", "de la Cruz"], ["Alice", "Nguyen"], ["Jane", "Smith"], ["Ludwig", "Van Beethoven"],
    ]);
  });
  test("mixed-case names are left alone", () => {
    const { rows } = run("Full Name,Phone\nMcDonald O'Neil,301-555-0123\nAJ lee,301-555-0124\n");
    expect(rows[0]!.normalized.display_name).toBe("McDonald O'Neil");
    expect(rows[1]!.normalized.display_name).toBe("AJ lee");
  });
});

describe("empty input and unlabelled columns", () => {
  test("empty and whitespace-only text are an empty_file error; a header with no rows is no_rows", () => {
    const err = (fn: () => unknown) => { try { fn(); } catch (e) { return e as Error & { code?: string }; } throw new Error("did not throw"); };
    expect(err(() => run("")).code).toBe("empty_file");
    expect(err(() => run("  \n \n")).code).toBe("empty_file");
    const none = err(() => run("Name,Phone\n"));
    expect(none.code).toBe("no_rows");
    expect(none.message).toContain("No data rows");
  });
  test("a data column under a blank header forces confirmation", () => {
    const csv = "Name,Phone,\nJane Smith,301-555-0123,vip\nBob Jones,301-555-0188,\n";
    const db = memDb();
    const { s } = run(csv, {}, db);
    expect(s.columns).toEqual(["Name", "Phone", "Column 3"]);
    expect(s.unlabeled_columns).toEqual(["Column 3"]);
    expect(s.needs_confirmation).toBe(true);
    expect(s.warnings.join(" ")).toContain("Column 3");
    // once the owner confirms the mapping it stops asking
    const s2 = setMapping(db, s.import_id, { fields: { display_name: { column: "Name", confidence: 1 }, phone: { column: "Phone", confidence: 1 } } });
    expect(s2.needs_confirmation).toBe(false);
  });
  test("a blank trailing header with no data does not count", () => {
    const { s } = run("Name,Phone,\nJane Smith,301-555-0123,\n");
    expect(s.unlabeled_columns).toBeUndefined();
    expect(s.needs_confirmation).toBe(false);
  });
});
