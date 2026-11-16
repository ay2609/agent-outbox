// Name "skeleton": what a name looks like once the tricks that make two different strings read the same are removed.
// Used to flag a proposed new contact for the user's review when it would look like someone already in Contacts
// (an impersonation: "Alice Smith" with a book emoji, a Cyrillic "а", an accent). This copy runs at propose time against the
// cache and only adds a note for the user: the executor no longer repeats it, because every new contact needs Touch ID anyway.
//
// skeleton(s) = NFKC -> drop ZWJ / VS16 and emoji and symbol characters -> map common Cyrillic and Greek look-alikes to
// Latin -> NFD with combining marks removed -> lowercase -> collapse whitespace.

/** Look-alike letters, by the Latin letter they read as (keyed by the look-alike, capitals included). */
const CONFUSABLE_PAIRS: [string, string][] = [
  // Cyrillic
  ["а", "a"], ["в", "b"], ["е", "e"], ["к", "k"], ["м", "m"], ["н", "h"], ["о", "o"], ["р", "p"], ["с", "c"], ["т", "t"],
  ["у", "y"], ["х", "x"], ["і", "i"], ["ј", "j"], ["ѕ", "s"], ["ԁ", "d"], ["ԛ", "q"], ["ԝ", "w"],
  ["А", "a"], ["В", "b"], ["Е", "e"], ["К", "k"], ["М", "m"], ["Н", "h"], ["О", "o"], ["Р", "p"], ["С", "c"], ["Т", "t"],
  ["У", "y"], ["Х", "x"], ["І", "i"], ["Ј", "j"], ["Ѕ", "s"],
  // Greek
  ["α", "a"], ["β", "b"], ["ε", "e"], ["η", "n"], ["ι", "i"], ["κ", "k"], ["μ", "u"], ["ν", "v"], ["ο", "o"], ["ρ", "p"],
  ["τ", "t"], ["υ", "u"], ["χ", "x"],
  ["Α", "a"], ["Β", "b"], ["Ε", "e"], ["Ζ", "z"], ["Η", "h"], ["Ι", "i"], ["Κ", "k"], ["Μ", "m"], ["Ν", "n"], ["Ο", "o"],
  ["Ρ", "p"], ["Τ", "t"], ["Υ", "y"], ["Χ", "x"],
];
export const CONFUSABLES: ReadonlyMap<string, string> = new Map(CONFUSABLE_PAIRS);

const JOINERS = /[‍️]/gu;
const PICTOGRAPHS = /[\p{Extended_Pictographic}\p{So}\p{Sk}\p{Sm}]/gu;
const MARKS = /\p{M}/gu;

export function nameSkeleton(s: string): string {
  let t = s.normalize("NFKC").replace(JOINERS, "").replace(PICTOGRAPHS, "");
  let mapped = "";
  for (const ch of t) mapped += CONFUSABLES.get(ch) ?? ch;
  t = mapped.normalize("NFD").replace(MARKS, "").toLowerCase();
  return t.replace(/\s+/gu, " ").trim();
}

/** "given family" as one string, then skeleton'd (empty parts don't leave a gap). */
export const fullNameSkeleton = (given: string, family: string): string => nameSkeleton(`${given} ${family}`);
