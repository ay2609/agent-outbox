// Fresh installs start live (opt-in, only for a database that doesn't exist yet); everything else stays dry.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./index";
import { getSettings, setSetting } from "../core/store";
import { getPinPolicy } from "../owner-api/auth";
import { DEFAULT_PIN_POLICY } from "../core/types";

const tmpDb = (): string => join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "outbox-seed-")), "outbox.db");
const policyRow = (db: ReturnType<typeof openDb>) => db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'pin_policy'").get()?.value ?? null;

describe("openDb liveDefaults", () => {
  test("a fresh database with liveDefaults: both transports live and an explicit policy row allowing both", () => {
    const db = openDb(tmpDb(), { liveDefaults: true });
    expect(getSettings(db)).toMatchObject({ transport: "live", contacts_transport: "live", kill_switch: false });
    expect(JSON.parse(policyRow(db)!)).toEqual({ live_allowed: true, contacts_live_allowed: true });
    expect(getPinPolicy(db)).toEqual({ live_allowed: true, contacts_live_allowed: true });
    expect(db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'setup.live_defaults'").get()).toEqual({ n: 1 });
  });

  test("without the option a fresh database stays dry with no policy row (unit tests, the executor's schema)", () => {
    const db = openDb(tmpDb());
    expect(getSettings(db)).toMatchObject({ transport: "dry", contacts_transport: "dry" });
    expect(policyRow(db)).toBeNull();
    expect(getPinPolicy(db)).toEqual(DEFAULT_PIN_POLICY);
    expect(openDb(":memory:", { liveDefaults: false }).query("SELECT value FROM settings WHERE key = 'transport'").get()).toEqual({ value: "dry" });
  });

  test("reopening a live database changes nothing (the seed runs once)", () => {
    const path = tmpDb();
    openDb(path, { liveDefaults: true }).close();
    const db = openDb(path, { liveDefaults: true });
    expect(getSettings(db)).toMatchObject({ transport: "live", contacts_transport: "live" });
    expect(getPinPolicy(db)).toEqual({ live_allowed: true, contacts_live_allowed: true });
    expect(db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'setup.live_defaults'").get()).toEqual({ n: 1 });
  });

  test("an existing dry database (made without the option) stays dry and policy-less when opened with it", () => {
    const path = tmpDb();
    openDb(path).close();   // an install from before this change
    const db = openDb(path, { liveDefaults: true });
    expect(getSettings(db)).toMatchObject({ transport: "dry", contacts_transport: "dry" });
    expect(policyRow(db)).toBeNull();
    expect(getPinPolicy(db)).toEqual({ live_allowed: false, contacts_live_allowed: false });
  });

  test("a user who switched a fresh install to dry stays dry after the next open, and so does a policy they turned off", () => {
    const path = tmpDb();
    const a = openDb(path, { liveDefaults: true });
    setSetting(a, "transport", "dry", "owner"); setSetting(a, "contacts_transport", "dry", "owner");
    a.query("UPDATE settings SET value = ? WHERE key = 'pin_policy'").run(JSON.stringify({ live_allowed: false, contacts_live_allowed: false }));
    a.close();
    const b = openDb(path, { liveDefaults: true });
    expect(getSettings(b)).toMatchObject({ transport: "dry", contacts_transport: "dry" });
    expect(getPinPolicy(b)).toEqual({ live_allowed: false, contacts_live_allowed: false });
  });

  test("a stored pin_policy survives every reopen (schema.sql used to delete it)", () => {
    const path = tmpDb();
    const a = openDb(path);
    a.query("INSERT INTO settings(key, value) VALUES ('pin_policy', ?)").run(JSON.stringify({ live_allowed: true }));
    a.close();
    expect(getPinPolicy(openDb(path))).toEqual({ live_allowed: true });
  });
});
