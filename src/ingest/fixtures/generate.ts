// Writes the binary fixtures (encodings that a text editor would mangle). Run: bun src/ingest/fixtures/generate.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir;

// UTF-16LE tab-separated with BOM, CRLF line endings (what Excel's "Unicode Text" export produces).
const tsv = "Name\tPhone\tEmail\r\nZoë Müller\t(301) 555-0123\tzoe@example.com\r\nJosé García\t301-555-0188\tjose@example.com\r\nSeán Ó Briain\t202-555-0143\t\r\n";
const le = new Uint8Array(2 + tsv.length * 2);
le[0] = 0xff; le[1] = 0xfe;
for (let i = 0; i < tsv.length; i++) { const c = tsv.charCodeAt(i); le[2 + i * 2] = c & 0xff; le[3 + i * 2] = c >> 8; }
writeFileSync(join(dir, "utf16le.tsv"), le);

// UTF-16BE with BOM.
const be = new Uint8Array(2 + tsv.length * 2);
be[0] = 0xfe; be[1] = 0xff;
for (let i = 0; i < tsv.length; i++) { const c = tsv.charCodeAt(i); be[2 + i * 2] = c >> 8; be[3 + i * 2] = c & 0xff; }
writeFileSync(join(dir, "utf16be.tsv"), be);

// windows-1252 CSV with accented names (invalid as UTF-8).
const cp = "First,Last,Phone\r\nJosé,García,301-555-0123\r\nZoë,Müller,301-555-0188\r\nRenée,Côté,202-555-0143\r\n";
const map: Record<string, number> = { "é": 0xe9, "í": 0xed, "ë": 0xeb, "ü": 0xfc, "ô": 0xf4 };
const out: number[] = [];
for (const ch of cp) out.push(map[ch] ?? ch.charCodeAt(0));
writeFileSync(join(dir, "windows1252.csv"), Uint8Array.from(out));

// UTF-8 with BOM.
writeFileSync(join(dir, "utf8-bom.csv"), "﻿Name,Phone\nJosé García,301-555-0123\n");
