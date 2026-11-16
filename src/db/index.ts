import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paths, ensureStateDirs } from "../core/paths";

export const SCHEMA_VERSION = 1;
let db: Database | null = null;

export interface OpenOptions {
  /** Only for a database that does not exist yet (a fresh install): start live instead of dry. Both transports go live and the
   *  stored pin policy allows live sending and live contact changes, so the first message the user approves in Touch ID really
   *  sends. Every send still needs that approval. Ignored for an existing database (upgrades change nothing). */
  liveDefaults?: boolean;
}

/** Opens (and migrates) the shared DB. Pass a path for tests; defaults to the state dir.
 *  Without `liveDefaults` a new database starts dry (schema.sql's defaults; the executor's selftest relies on them). */
export function openDb(path: string = paths.db, opts: OpenOptions = {}): Database {
  if (path === paths.db) ensureStateDirs();
  const d = new Database(path, { create: true, strict: true });
  d.exec("PRAGMA busy_timeout = 5000;");
  // "Fresh" = the schema has never run here. Decided before schema.sql creates schema_version.
  const fresh = !d.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
  d.exec(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));
  const v = d.query<{ version: number }, []>("SELECT version FROM schema_version").get();
  if (!v) d.query("INSERT INTO schema_version(version) VALUES (?)").run(SCHEMA_VERSION);
  if (fresh && opts.liveDefaults) seedLiveDefaults(d);
  return d;
}

/** The fresh-install settings: live transports and an explicit policy row (a missing row would mean "all false"). */
function seedLiveDefaults(d: Database): void {
  d.transaction(() => {
    d.query("UPDATE settings SET value = 'live' WHERE key IN ('transport','contacts_transport')").run();
    d.query("INSERT OR IGNORE INTO settings(key, value) VALUES ('pin_policy', ?)").run(JSON.stringify({ live_allowed: true, contacts_live_allowed: true }));
    d.query("INSERT INTO audit_log(at, actor, action, target, details_json) VALUES (?,?,?,?,?)")
      .run(nowIso(), "system", "setup.live_defaults", null, JSON.stringify({ transport: "live", contacts_transport: "live", live_allowed: true, contacts_live_allowed: true }));
  }).immediate();
}

/** Process-wide singleton for servers. A new install starts live (see OpenOptions.liveDefaults). */
export function getDb(): Database {
  db ??= openDb(paths.db, { liveDefaults: true });
  return db;
}

export const newId = (): string => Bun.randomUUIDv7();
export const nowIso = (): string => new Date().toISOString();
