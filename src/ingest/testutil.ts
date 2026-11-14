// Test helpers shared by tests. Import this BEFORE anything that reads src/core/paths.ts so
// OUTBOX_HOME points at a throwaway directory and the real ~/.local/share/agent-outbox is never touched.
import "./testenv";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { newId, nowIso, openDb } from "../db";

export const fixturePath = (name: string) => join(import.meta.dir, "fixtures", name);
export const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(fixturePath(name)));
export const fixtureText = (name: string): string => readFileSync(fixturePath(name), "utf8");

export const memDb = (): Database => openDb(":memory:");
export const tmpImportsDir = (): string => mkdtempSync(join(tmpdir(), "outbox-imports-"));

export function seedContact(
  db: Database,
  c: { given?: string; family?: string; display?: string; phones?: string[]; emails?: string[]; source?: "macos" | "import" | "manual" },
): string {
  const id = newId();
  const phones = (c.phones ?? []).map((e164) => ({ e164, label: "mobile" }));
  const emails = (c.emails ?? []).map((email) => ({ email, label: "home" }));
  const display = c.display ?? [c.given, c.family].filter(Boolean).join(" ");
  db.query(`INSERT INTO contacts(id,source,display_name,given_name,family_name,phones_json,emails_json,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, c.source ?? "macos", display, c.given ?? "", c.family ?? "", JSON.stringify(phones), JSON.stringify(emails), nowIso());
  const h = db.query("INSERT INTO contact_handles(handle, contact_id) VALUES (?,?)");
  for (const p of phones) h.run(p.e164, id);
  for (const e of emails) h.run(e.email, id);
  return id;
}
