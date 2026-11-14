// Imports the executor's address-book export (paths.contactsExport) into the contacts table.
// Format (written atomically by outbox-exec): {"exported_at", "contacts":[{"macos_id","given_name","family_name",
// "nickname","org","phones":[{"raw","label"}],"emails":[{"email","label"}], and optionally "groups":["College friends"],
// "city","birthday"}]}. Groups become tags; city and birthday become template vars on the contact (see contactAttrs).
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { newId, nowIso } from "../db";
import { loadBDeps, type PhoneInfo } from "./deps";
import { paths } from "./paths";
import { audit } from "./store";
import type { Email, Phone } from "./types";

const birthdayS = z.union([
  z.string(),
  z.object({ year: z.number().nullish(), month: z.number().nullish(), day: z.number().nullish() }),
]);
const exportS = z.object({
  exported_at: z.string().optional(),
  contacts: z.array(z.object({
    macos_id: z.string().min(1),
    given_name: z.string().default(""), family_name: z.string().default(""), nickname: z.string().default(""), org: z.string().default(""),
    phones: z.array(z.object({ raw: z.string(), label: z.string().default("") })).default([]),
    emails: z.array(z.object({ email: z.string(), label: z.string().default("") })).default([]),
    // Newer executors add these. Absent (undefined) means "not exported": keep what we have. null / [] clears.
    groups: z.array(z.string()).nullish(),
    city: z.string().nullish(),
    birthday: birthdayS.nullish(),
  })),
});

function formatBirthday(b: z.infer<typeof birthdayS> | null | undefined): string {
  if (b == null) return "";
  if (typeof b === "string") return b.trim();
  const p2 = (n: number) => String(n).padStart(2, "0");
  if (!b.month || !b.day) return b.year ? String(b.year) : "";
  return b.year ? `${b.year}-${p2(b.month)}-${p2(b.day)}` : `--${p2(b.month)}-${p2(b.day)}`;
}

/** Extra per-contact attributes that have no column in `contacts`: the macOS groups that became tags (so a group that
 *  disappears can be removed again without touching the user's own tags), plus city and birthday. Created on first use. */
export function ensureContactAttrs(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS contact_attrs (
    contact_id  TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
    groups_json TEXT NOT NULL DEFAULT '[]',
    city        TEXT NOT NULL DEFAULT '',
    birthday    TEXT NOT NULL DEFAULT ''
  )`);
}

export interface ContactAttrs { groups: string[]; city: string; birthday: string }
export function contactAttrs(db: Database, contactId: string): ContactAttrs {
  try {
    const r = db.query("SELECT groups_json, city, birthday FROM contact_attrs WHERE contact_id = ?").get(contactId) as any;
    if (r) return { groups: safeJson(r.groups_json, []), city: r.city, birthday: r.birthday };
  } catch { /* table not created yet: no export has carried these fields */ }
  return { groups: [], city: "", birthday: "" };
}
/** Template vars a contact brings along: city and birthday, when known. */
export function contactVars(db: Database, contactId: string): Record<string, string> {
  const a = contactAttrs(db, contactId);
  return { ...(a.city ? { city: a.city } : {}), ...(a.birthday ? { birthday: a.birthday } : {}) };
}

const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const uniqTags = (tags: string[]): string[] => tags.reduce<string[]>((acc, t) => (t && !acc.some((x) => sameTag(x, t)) ? [...acc, t] : acc), []);

export interface SyncStats {
  total: number; added: number; updated: number; unchanged: number;
  removed: number; kept_removed: number; invalid_phones: number; skipped_deletion?: string;
}
export interface SyncOptions {
  path?: string;
  region?: string;
  normalizePhone?: (raw: string, region?: string) => PhoneInfo;
}

/** CNLabel values look like "_$!<Mobile>!$_"; keep the readable part. */
const cleanLabel = (l: string): string => l.replace(/_\$!<(.*?)>!\$_/g, "$1").trim().toLowerCase();

const REMOVED_TAG = "removed";

function displayName(c: { given_name: string; family_name: string; nickname: string; org: string }, firstHandle: string): string {
  return [c.given_name, c.family_name].filter(Boolean).join(" ") || c.nickname || c.org || firstHandle;
}

export async function syncContactsExport(db: Database, opts: SyncOptions = {}): Promise<SyncStats> {
  const file = opts.path ?? paths.contactsExport;
  const normalizePhone = opts.normalizePhone ?? (await loadBDeps()).normalizePhone;
  ensureContactAttrs(db);
  const parsed = exportS.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`contacts export is malformed: ${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`);
  const data = parsed.data;
  const now = nowIso();
  const stats: SyncStats = { total: data.contacts.length, added: 0, updated: 0, unchanged: 0, removed: 0, kept_removed: 0, invalid_phones: 0 };

  const existing = new Map<string, any>();
  for (const r of db.query("SELECT * FROM contacts WHERE macos_id IS NOT NULL").all() as any[]) existing.set(r.macos_id, r);

  const setHandles = (id: string, phones: Phone[], emails: Email[]) => {
    db.query("DELETE FROM contact_handles WHERE contact_id = ?").run(id);
    const ins = db.query("INSERT OR IGNORE INTO contact_handles(handle, contact_id) VALUES (?, ?)");
    for (const p of phones) ins.run(p.e164, id);
    for (const e of emails) ins.run(e.email, id);
  };

  const seen = new Set<string>();
  db.transaction(() => {
    for (const c of data.contacts) {
      seen.add(c.macos_id);
      const phones: Phone[] = []; const have = new Set<string>();
      for (const p of c.phones) {
        const n = normalizePhone(p.raw, opts.region ?? "US");
        if (!n.valid || !n.e164) { stats.invalid_phones++; continue; }
        if (have.has(n.e164)) continue;
        have.add(n.e164);
        phones.push({ e164: n.e164, label: cleanLabel(p.label), raw: p.raw });
      }
      const emails: Email[] = []; const haveE = new Set<string>();
      for (const e of c.emails) {
        const addr = e.email.trim().toLowerCase();
        if (!addr || !addr.includes("@") || haveE.has(addr)) continue;
        haveE.add(addr);
        emails.push({ email: addr, label: cleanLabel(e.label) });
      }
      const given = c.given_name.trim(), family = c.family_name.trim(), nick = c.nickname.trim(), org = c.org.trim();
      const name = displayName({ given_name: given, family_name: family, nickname: nick, org }, phones[0]?.e164 ?? emails[0]?.email ?? "");
      const phonesJson = JSON.stringify(phones), emailsJson = JSON.stringify(emails);

      const groupsIn = c.groups == null ? undefined : uniqTags(c.groups.map((g) => g.trim()));
      const cityIn = c.city === undefined ? undefined : (c.city ?? "").trim();
      const bdayIn = c.birthday === undefined ? undefined : formatBirthday(c.birthday);
      const writeAttrs = (id: string, next: ContactAttrs) => {
        if (!next.groups.length && !next.city && !next.birthday) { db.query("DELETE FROM contact_attrs WHERE contact_id = ?").run(id); return; }
        db.query(`INSERT INTO contact_attrs(contact_id, groups_json, city, birthday) VALUES (?,?,?,?)
                  ON CONFLICT(contact_id) DO UPDATE SET groups_json=excluded.groups_json, city=excluded.city, birthday=excluded.birthday`)
          .run(id, JSON.stringify(next.groups), next.city, next.birthday);
      };

      const cur = existing.get(c.macos_id);
      if (!cur) {
        const id = newId();
        db.query(`INSERT INTO contacts(id, source, macos_id, display_name, given_name, family_name, nickname, org, phones_json, emails_json, tags_json, notes, updated_at, synced_at)
                  VALUES (?, 'macos', ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`)
          .run(id, c.macos_id, name, given, family, nick, org, phonesJson, emailsJson, JSON.stringify(groupsIn ?? []), now, now);
        setHandles(id, phones, emails);
        writeAttrs(id, { groups: groupsIn ?? [], city: cityIn ?? "", birthday: bdayIn ?? "" });
        stats.added++;
        continue;
      }
      const tags: string[] = safeJson(cur.tags_json, []);
      const wasRemoved = tags.includes(REMOVED_TAG);
      const old = contactAttrs(db, cur.id);
      const next: ContactAttrs = { groups: groupsIn ?? old.groups, city: cityIn ?? old.city, birthday: bdayIn ?? old.birthday };
      // The user's own tags stay; the tags that came from groups are swapped for the current groups.
      const ownerTags = tags.filter((t) => t !== REMOVED_TAG && !old.groups.some((g) => sameTag(g, t)));
      const newTags = uniqTags([...ownerTags, ...next.groups]);
      const attrsChanged = JSON.stringify(old) !== JSON.stringify(next);
      const tagsChanged = JSON.stringify(newTags) !== JSON.stringify(tags.filter((t) => t !== REMOVED_TAG));
      const changed = wasRemoved || attrsChanged || tagsChanged || cur.display_name !== name || cur.given_name !== given || cur.family_name !== family
        || cur.nickname !== nick || cur.org !== org || cur.phones_json !== phonesJson || cur.emails_json !== emailsJson;
      if (!changed) {
        db.query("UPDATE contacts SET synced_at = ? WHERE id = ?").run(now, cur.id);
        stats.unchanged++;
        continue;
      }
      db.query(`UPDATE contacts SET display_name=?, given_name=?, family_name=?, nickname=?, org=?, phones_json=?, emails_json=?, tags_json=?, updated_at=?, synced_at=? WHERE id=?`)
        .run(name, given, family, nick, org, phonesJson, emailsJson, JSON.stringify(newTags), now, now, cur.id);
      setHandles(cur.id, phones, emails);
      if (attrsChanged) writeAttrs(cur.id, next);
      stats.updated++;
    }

    // Contacts that vanished from the address book. An empty export while we hold contacts is more likely a failed
    // export (no access) than a wiped address book, so don't delete on it.
    const vanished = [...existing.values()].filter((r) => r.source === "macos" && !seen.has(r.macos_id));
    if (data.contacts.length === 0 && vanished.length > 0) {
      stats.skipped_deletion = "export had no contacts; kept all existing ones";
      return;
    }
    for (const r of vanished) {
      const referenced = db.query("SELECT 1 FROM drafts WHERE contact_id = ? UNION ALL SELECT 1 FROM import_rows WHERE contact_id = ? LIMIT 1").get(r.id, r.id);
      if (!referenced) {
        db.query("DELETE FROM contacts WHERE id = ?").run(r.id); // handles cascade
        stats.removed++;
      } else {
        const tags: string[] = safeJson(r.tags_json, []);
        if (!tags.includes(REMOVED_TAG)) {
          db.query("UPDATE contacts SET tags_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify([...tags, REMOVED_TAG]), now, r.id);
        }
        db.query("DELETE FROM contact_handles WHERE contact_id = ?").run(r.id); // no longer matchable by new imports
        stats.kept_removed++;
      }
    }
  }).immediate();

  audit(db, "system", "contacts.sync", null, stats);
  return stats;
}

function safeJson<T>(s: string, fallback: T): T { try { return JSON.parse(s) as T; } catch { return fallback; } }

export interface WatcherOptions {
  db: Database;
  path?: string;
  intervalMs?: number;
  log?: (msg: string) => void;
  sync?: typeof syncContactsExport;
  syncOptions?: SyncOptions;
}

/** Polls the export file's mtime and size; imports at start and whenever it changes. Returns a stop function. */
export function startContactsWatcher(o: WatcherOptions): { stop(): void; check(): Promise<SyncStats | null> } {
  const file = o.path ?? paths.contactsExport;
  const log = o.log ?? ((m) => console.log(m));
  const sync = o.sync ?? syncContactsExport;
  let lastKey = "";
  let busy = false;
  const check = async (): Promise<SyncStats | null> => {
    if (busy || !existsSync(file)) return null;
    let key: string;
    try { const st = statSync(file); key = `${st.mtimeMs}:${st.size}`; } catch { return null; }
    if (key === lastKey) return null;
    busy = true;
    lastKey = key; // a bad file is reported once; the next export has a new mtime
    try {
      const stats = await sync(o.db, { ...o.syncOptions, path: file });
      log(`[contacts] imported ${stats.total} contacts: +${stats.added} ~${stats.updated} -${stats.removed} (kept ${stats.kept_removed} referenced)${stats.skipped_deletion ? "; " + stats.skipped_deletion : ""}`);
      return stats;
    } catch (e) {
      log(`[contacts] import failed: ${(e as Error).message}`);
      return null;
    } finally { busy = false; }
  };
  void check();
  const t = setInterval(() => void check(), o.intervalMs ?? 10_000);
  return { stop: () => clearInterval(t), check };
}
