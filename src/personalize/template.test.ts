import "../ingest/testenv";
import { describe, expect, test } from "bun:test";
import { listVars, lookupVar, renderTemplate, varKey, varsWithFallback } from "./template";

const v = { first_name: "Jane", last_name: "Smith", org: "", city: "Paris" };

describe("renderTemplate", () => {
  test("plain substitution", () => {
    expect(renderTemplate("Hi {{first_name}}!", v)).toEqual({ body: "Hi Jane!", unresolved: [], empty: [] });
  });
  test("multiple vars and repeats", () => {
    expect(renderTemplate("{{first_name}} {{last_name}}, {{first_name}}", v).body).toBe("Jane Smith, Jane");
  });
  test("case-insensitive names", () => {
    expect(renderTemplate("{{FIRST_NAME}} {{First_Name}}", v).body).toBe("Jane Jane");
    expect(renderTemplate("{{first_name}}", { First_Name: "Jo" }).body).toBe("Jo");
  });
  test("whitespace tolerant", () => {
    expect(renderTemplate("{{ first_name }}|{{first_name }}|{{\tfirst_name\n}}", v).body).toBe("Jane|Jane|Jane");
  });
  test("spaces and hyphens in names read as underscores", () => {
    expect(renderTemplate("{{First Name}} {{first-name}}", v).body).toBe("Jane Jane");
  });
  test("fallback when missing", () => {
    expect(renderTemplate("Hi {{nickname|there}}", v)).toEqual({ body: "Hi there", unresolved: [], empty: [] });
  });
  test("fallback when empty or whitespace-only", () => {
    expect(renderTemplate("Hi {{org|friend}}", v).body).toBe("Hi friend");
    expect(renderTemplate("Hi {{x|friend}}", { x: "   " }).body).toBe("Hi friend");
  });
  test("value wins over fallback", () => {
    expect(renderTemplate("Hi {{first_name|there}}", v).body).toBe("Hi Jane");
  });
  test("fallback is trimmed and may be empty or contain spaces, commas and punctuation", () => {
    expect(renderTemplate("A{{n| }}B", {}).body).toBe("AB");
    expect(renderTemplate("A{{n| dear friend, }}B", {}).body).toBe("Adear friend,B");
    expect(renderTemplate("{{ n | there }}", {}).body).toBe("there");
  });
  test("an empty fallback is a deliberate blank, not an error", () => {
    expect(renderTemplate("Hi{{n|}}!", {})).toEqual({ body: "Hi!", unresolved: [], empty: [] });
  });
  test("unresolved vars stay in the text and are listed once", () => {
    const r = renderTemplate("Hi {{nope}} and {{ NOPE }} {{first_name}}", v);
    expect(r.body).toBe("Hi {{nope}} and {{ NOPE }} Jane");
    expect(r.unresolved).toEqual(["nope"]);
  });
  test("empty values render blank and are reported", () => {
    const r = renderTemplate("At {{org}}.", v);
    expect(r).toEqual({ body: "At .", unresolved: [], empty: ["org"] });
  });
  test("a var is not 'unresolved' just because its value is an empty string", () => {
    expect(renderTemplate("{{org}}", { org: "" }).unresolved).toEqual([]);
  });
  test("escaped opener gives a literal {{", () => {
    expect(renderTemplate("Use \\{{first_name}} to merge", v).body).toBe("Use {{first_name}} to merge");
    expect(renderTemplate("\\{{ and {{first_name}}", v).body).toBe("{{ and Jane");
  });
  test("escaped tokens aren't reported as unresolved", () => {
    expect(renderTemplate("\\{{nope}}", {}).unresolved).toEqual([]);
  });
  test("values containing {{ are not re-expanded", () => {
    expect(renderTemplate("{{a}}", { a: "{{b}}", b: "x" }).body).toBe("{{b}}");
  });
  test("values with regex/replacement special characters", () => {
    expect(renderTemplate("{{a}}", { a: "$& $1 \\ $$" }).body).toBe("$& $1 \\ $$");
  });
  test("stray braces and lone openers are left alone", () => {
    expect(renderTemplate("{ {a} } {{ }} {{", { a: "x" }).body).toBe("{ {a} } {{ }} {{");
    expect(renderTemplate("}}{{a", { a: "x" }).body).toBe("}}{{a");
  });
  test("numbers and null values in the bag", () => {
    expect(renderTemplate("{{n}}-{{z}}", { n: 5, z: null }).body).toBe("5-");
  });
  test("no vars in the template: returned unchanged", () => {
    expect(renderTemplate("Hello world", v).body).toBe("Hello world");
    expect(renderTemplate("", v).body).toBe("");
  });
  test("multi-line templates and emoji survive", () => {
    expect(renderTemplate("Hi {{first_name}} 👋\nSee you!", v).body).toBe("Hi Jane 👋\nSee you!");
  });
  test("accented and non-latin values", () => {
    expect(renderTemplate("{{first_name}}", { first_name: "Zoë" }).body).toBe("Zoë");
    expect(renderTemplate("{{名前}}", { 名前: "太郎" }).body).toBe("太郎");
  });
});

describe("listVars / varsWithFallback / lookupVar", () => {
  test("distinct, canonical, in order", () => {
    expect(listVars("Hi {{First Name}}, {{org|x}} {{FIRST_NAME}} {{ city }}")).toEqual(["first_name", "org", "city"]);
  });
  test("ignores escaped openers and empty tokens", () => {
    expect(listVars("\\{{a}} {{ }} {{b}}")).toEqual(["b"]);
  });
  test("none", () => expect(listVars("plain")).toEqual([]));
  test("varsWithFallback", () => {
    expect([...varsWithFallback("{{a|x}} {{b}} {{C|}}")].sort()).toEqual(["a", "c"]);
  });
  test("lookupVar is case-insensitive and distinguishes missing from empty", () => {
    expect(lookupVar({ First_Name: "J" }, "first name")).toBe("J");
    expect(lookupVar({ a: "" }, "a")).toBe("");
    expect(lookupVar({}, "a")).toBeUndefined();
  });
  test("varKey", () => expect(varKey("  First Name ")).toBe("first_name"));
});
