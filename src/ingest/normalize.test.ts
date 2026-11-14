import "./testenv";
import { describe, expect, test } from "bun:test";
import { nameKey, normalizeEmail, normalizeHandle, normalizePhone, slug, splitName } from "./normalize";

describe("normalizePhone", () => {
  const same = ["(301) 555-0123", "301.555.0123", "1-301-555-0123", "tel:+13015550123", "3015550123 ext 5", "3015550123 x5", "'3015550123",
    "13015550123.0", "3.015550123E+09", "+1 301 555 0123", "Mobile: (301) 555-0123", " 301-555-0123 ", "３０１５５５０１２３", "sms:+13015550123"];
  for (const s of same) test(`US format ${JSON.stringify(s)}`, () => {
    const r = normalizePhone(s);
    expect(r.e164).toBe("+13015550123");
    expect(r.valid).toBe(true);
    expect(r.raw).toBe(s);
  });

  test("international numbers and mobile detection", () => {
    const uk = normalizePhone("+44 7911 123456");
    expect(uk).toMatchObject({ e164: "+447911123456", valid: true, mobile: true });
    expect(normalizePhone("00442079460958")).toMatchObject({ e164: "+442079460958", valid: true, mobile: false });
    expect(normalizePhone("+33 6 12 34 56 78").e164).toBe("+33612345678");
    expect(normalizePhone("07911 123456", "GB").e164).toBe("+447911123456");
  });

  test("US numbers are fixed-line-or-mobile, so they count as mobile", () => {
    expect(normalizePhone("(301) 555-0123").mobile).toBe(true);
  });

  test("toll-free is not mobile", () => {
    expect(normalizePhone("800-555-0199")).toMatchObject({ valid: true, mobile: false });
  });

  test("Excel scientific notation: exact digits recover, padded zeros are rejected", () => {
    expect(normalizePhone("3.015550123E+09").e164).toBe("+13015550123");
    expect(normalizePhone("1.3015550123E+10").e164).toBe("+13015550123");
    const lossy = normalizePhone("3.01555E+09");
    expect(lossy).toMatchObject({ e164: null, valid: false, note: "excel_scientific_notation" });
  });

  test("multiple numbers in one cell: first valid wins and a note is set", () => {
    const r = normalizePhone("301-555-0123 / 202-555-0143");
    expect(r.e164).toBe("+13015550123");
    expect(r.note).toBe("multiple_numbers_first_used");
    expect(normalizePhone("not valid; 202-555-0143").e164).toBe("+12025550143");
  });

  test("garbage is invalid with a null e164", () => {
    for (const s of ["", "   ", "call me", "555-0123", "(555) 123-4567", "12345", "abc123", "N/A", "0"]) {
      const r = normalizePhone(s);
      expect(r.valid).toBe(false);
      expect(r.e164).toBeNull();
    }
  });

  test("letters after digits (vanity) are rejected", () => {
    expect(normalizePhone("1-800-FLOWERS").valid).toBe(false);
  });

  test("011 and 00 international prefixes", () => {
    expect(normalizePhone("011 44 7911 123456").e164).toBe("+447911123456");
    expect(normalizePhone("0033612345678").e164).toBe("+33612345678");
  });
});

describe("normalizeEmail", () => {
  test("lowercases and trims", () => {
    expect(normalizeEmail("  Jane.Smith@Example.COM ")).toBe("jane.smith@example.com");
  });
  test("accepts mailto, angle brackets and trailing punctuation", () => {
    expect(normalizeEmail("mailto:A@B.co")).toBe("a@b.co");
    expect(normalizeEmail("Jane <Jane@Example.com>")).toBe("jane@example.com");
    expect(normalizeEmail("jane@example.com.")).toBe("jane@example.com");
  });
  test("rejects non-emails", () => {
    for (const s of ["", "jane", "jane@", "@example.com", "jane@example", "jane smith@example.com", "a@b@c.com"]) expect(normalizeEmail(s)).toBeNull();
  });
  test("plus addressing is preserved", () => {
    expect(normalizeEmail("jane+gala@example.com")).toBe("jane+gala@example.com");
  });
});

describe("normalizeHandle", () => {
  test("phone", () => {
    expect(normalizeHandle("(301) 555-0123")).toEqual({ handle: "+13015550123", kind: "phone", valid: true, mobile: true });
  });
  test("email", () => {
    expect(normalizeHandle("Jane@Example.com")).toEqual({ handle: "jane@example.com", kind: "email", valid: true, mobile: null });
  });
  test("invalid inputs keep their kind", () => {
    expect(normalizeHandle("x@y")).toEqual({ handle: null, kind: "email", valid: false, mobile: null });
    expect(normalizeHandle("12345")).toEqual({ handle: null, kind: "phone", valid: false, mobile: null });
  });
  test("empty", () => {
    expect(normalizeHandle("  ")).toEqual({ handle: null, kind: null, valid: false, mobile: null });
  });
  test("an already-normalised E.164 handle round-trips", () => {
    expect(normalizeHandle("+13015550123").handle).toBe("+13015550123");
  });
});

describe("splitName", () => {
  const cases: [string, string, string][] = [
    ["Jane Smith", "Jane", "Smith"],
    ["Smith, Jane", "Jane", "Smith"],
    ["Smith, Jane Q.", "Jane", "Smith"],
    ["Dr. Jane Q. Smith Jr.", "Jane", "Smith"],
    ["Jane Smith, MD", "Jane", "Smith"],
    ["Smith, Jane, MD", "Jane", "Smith"],
    ["Madonna", "Madonna", ""],
    ["  Jane   Smith  ", "Jane", "Smith"],
    ["JANE SMITH", "Jane", "Smith"],
    ["jane smith", "Jane", "Smith"],
    ["ludwig van beethoven", "Ludwig", "van Beethoven"],
    ["Ludwig van Beethoven", "Ludwig", "van Beethoven"],
    ["Mary Ann O'Brien-Lee", "Mary Ann", "O'Brien-Lee"],
    ["García, José", "José", "García"],
    ["Prof. Zoë Müller III", "Zoë", "Müller"],
    ["Jane \"JJ\" Smith", "Jane", "Smith"],
    ["", "", ""],
    ["Dr.", "", ""],
    // middle names go into given_name, multi-part surnames stay whole
    ["Mary Jane Watson", "Mary Jane", "Watson"],
    ["Ana de la Cruz", "Ana", "de la Cruz"],
    ["de la Cruz, Ana María", "Ana María", "de la Cruz"],
    ["Smith, Mary Jane", "Mary Jane", "Smith"],
    ["Jean-Luc Picard", "Jean-Luc", "Picard"],
    // mixed-case input is never re-cased; all-caps tokens of 3 letters or fewer survive all-caps repair
    ["McDonald O'Neil", "McDonald", "O'Neil"],
    ["DJ Khaled", "DJ", "Khaled"],
    ["AJ SMITH", "AJ", "Smith"],
    ["ALEXANDRA KIMBALL", "Alexandra", "Kimball"],
    ["BOB LEE", "BOB", "LEE"], // documented consequence of "leave all-caps tokens of 3 letters or fewer as they are"
    ["jane mcdonald", "Jane", "Mcdonald"],
  ];
  for (const [input, g, f] of cases) test(JSON.stringify(input), () => expect(splitName(input)).toEqual({ given_name: g, family_name: f }));
});

describe("slug and nameKey", () => {
  test("slug", () => {
    expect(slug("First Name")).toBe("first_name");
    expect(slug("E-mail 1 - Value")).toBe("e_mail_1_value");
    expect(slug("Téléphone (mobile)")).toBe("telephone_mobile");
    expect(slug("Phone (2)")).toBe("phone_2");
    expect(slug("   ")).toBe("col");
    expect(slug("###")).toBe("col");
  });
  test("nameKey ignores case, accents and punctuation", () => {
    expect(nameKey("José  García")).toBe(nameKey("jose garcia"));
    expect(nameKey("O'Brien")).toBe("o brien");
  });
});
