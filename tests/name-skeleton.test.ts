// The name skeleton: two names that read the same collapse to the same string (the impersonation note on proposed new contacts).
import { describe, expect, test } from "bun:test";
import { fullNameSkeleton, nameSkeleton } from "../src/core/name-skeleton";

const same = (a: string, b: string) => expect(nameSkeleton(a)).toBe(nameSkeleton(b));

describe("nameSkeleton", () => {
  test("a plain name: lowercased, whitespace collapsed", () => {
    expect(nameSkeleton("  Alice   SMITH ")).toBe("alice smith");
    expect(fullNameSkeleton("Alice", "Smith")).toBe("alice smith");
    expect(fullNameSkeleton("Alice", "")).toBe("alice"); // an empty part leaves no gap
  });
  test("emoji, symbols and joiners are dropped", () => {
    same("Alice📚 Smith", "Alice Smith");
    same("Alice Smith 👩‍👩‍👧", "Alice Smith");
    same("Ali‍ce️ Smith", "Alice Smith");
    same("Alice© Smith", "Alice Smith");
    same("Alice Smith ✓", "Alice Smith");
  });
  test("accents and other marks are removed", () => {
    same("Álice Smíth", "Alice Smith");
    same("Zoë Müller", "Zoe Muller");
    same("Ａlice Ｓmith", "Alice Smith"); // fullwidth, through NFKC
  });
  test("Cyrillic and Greek look-alikes read as Latin, capitals included", () => {
    same("Jаne Doe", "Jane Doe");            // Cyrillic а
    same("Ѕаm Реtеrs", "Sam Peters");        // Cyrillic Ѕ а Р е е
    same("Αlice Βrown", "Alice Brown");      // Greek capitals
    same("Νικ Ηοlt", "Nik Holt");            // Greek Ν ι κ, Η ο ... (Greek lower-case ι κ)
    same("Mаrсо Кох", "Marco Kox");
  });
  test("different names stay different", () => {
    expect(nameSkeleton("Alice Smyth")).not.toBe(nameSkeleton("Alice Smith"));
    expect(nameSkeleton("Alice Smith")).not.toBe(nameSkeleton("Smith Alice"));
    expect(nameSkeleton("Jane Doe")).not.toBe(nameSkeleton("Jan Doe"));
  });
  test("a name made only of symbols has an empty skeleton", () => {
    expect(nameSkeleton("📚📚")).toBe("");
    expect(nameSkeleton("  ")).toBe("");
  });
});
