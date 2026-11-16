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

describe("contacts are never added automatically: open-time migration", () => {
  const insertSet = (db: ReturnType<typeof openDb>, id: string, status: string) =>
    db.query("INSERT INTO contact_change_sets(id, title, created_by, source, status, created_at, updated_at) VALUES (?, 't', 'agent:x', 'mcp', ?, 'now', 'now')").run(id, status);
  const insertChange = (db: ReturnType<typeof openDb>, id: string, set: string, status: string, requires: number, note = "") =>
    db.query("INSERT INTO contact_changes(id, set_id, position, kind, payload_json, requires_approval, status, note, created_at) VALUES (?, ?, 0, 'create', '{}', ?, ?, ?, 'now')").run(id, set, requires, status, note);

  test("a leftover auto_queued create (requires_approval 0) becomes review / requires_approval 1 at open, its drafting set becomes review; idempotent", () => {
    const path = tmpDb();
    const a = openDb(path);
    insertSet(a, "s1", "drafting");
    insertChange(a, "c1", "s1", "auto_queued", 0);
    insertChange(a, "c2", "s1", "auto_queued", 0, "same name as an existing contact");
    insertChange(a, "c3", "s1", "review", 0);                       // a review row that claims no approval is needed
    insertChange(a, "c4", "s1", "applied", 0);                      // history is left alone ...
    insertChange(a, "c5", "s1", "auto_queued", 0);                  // ... and so is a row the executor already consumed
    a.query("INSERT INTO contact_applies(id, change_id, approval_id, transport, started_at) VALUES ('a5', 'c5', NULL, 'live', 'now')").run();
    insertSet(a, "s2", "done");
    a.close();
    for (let i = 0; i < 2; i++) { // the second open changes nothing more
      const b = openDb(path);
      const rows = b.query("SELECT id, status, requires_approval, note FROM contact_changes ORDER BY id").all();
      expect(rows).toEqual([
        { id: "c1", status: "review", requires_approval: 1, note: "new contact" },
        { id: "c2", status: "review", requires_approval: 1, note: "same name as an existing contact" },
        { id: "c3", status: "review", requires_approval: 1, note: "new contact" },
        { id: "c4", status: "applied", requires_approval: 0, note: "" },
        { id: "c5", status: "auto_queued", requires_approval: 0, note: "" },
      ]);
      expect(b.query("SELECT id, status FROM contact_change_sets ORDER BY id").all()).toEqual([{ id: "s1", status: "review" }, { id: "s2", status: "done" }]);
      b.close();
    }
  });
});
