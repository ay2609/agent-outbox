import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paths, ensureStateDirs } from "../core/paths";

export const SCHEMA_VERSION = 1;
let db: Database | null = null;

/** Opens (and migrates) the shared DB. Pass a path for tests; defaults to the state dir. */
export function openDb(path: string = paths.db): Database {
  if (path === paths.db) ensureStateDirs();
  const d = new Database(path, { create: true, strict: true });
  d.exec("PRAGMA busy_timeout = 5000;");
  d.exec(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));
  const v = d.query<{ version: number }, []>("SELECT version FROM schema_version").get();
  if (!v) d.query("INSERT INTO schema_version(version) VALUES (?)").run(SCHEMA_VERSION);
  return d;
}

/** Process-wide singleton for servers. */
export function getDb(): Database {
  db ??= openDb();
  return db;
}

export const newId = (): string => Bun.randomUUIDv7();
export const nowIso = (): string => new Date().toISOString();
