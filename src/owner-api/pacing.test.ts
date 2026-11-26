// "Spread out messages": the settings API, the rows surviving every open, the approval window and the status fields.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db";
import { getSettings } from "../core/store";
import { PACING_OFF } from "../core/pacing";
import { makeHarness, seedBatch } from "./testkit";

const ready = async (n = 3) => { const h = makeHarness(); await h.signUp(); return { h, ...seedBatch(h.db, n) }; };
const patchPacing = (h: Awaited<ReturnType<typeof ready>>["h"], pacing: object) => h.call("PATCH", "/api/settings", { pacing });
const hoursOf = (m: { created_at: string; not_after: string }) => (Date.parse(m.not_after) - Date.parse(m.created_at)) / 3600_000;
const wait = (h: { db: ReturnType<typeof openDb> }, key: string, value: string | null) =>
  h.db.query("INSERT INTO exec_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);

describe("schema rows", () => {
  test("a fresh database has the off defaults, and the rows survive every reopen", () => {
    const path = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "outbox-pace-")), "outbox.db");
    const db = openDb(path);
    expect(getSettings(db).pacing).toEqual(PACING_OFF);
    db.query("UPDATE settings SET value = '1' WHERE key = 'pace_enabled'").run();
    db.query("UPDATE settings SET value = '45' WHERE key = 'pace_min_s'").run();
    db.query("UPDATE settings SET value = '21:00' WHERE key = 'quiet_start'").run();
    db.close();
    const again = openDb(path);          // schema.sql runs at every open: its DELETE must not wipe these
    expect(getSettings(again).pacing).toMatchObject({ enabled: true, min_s: 45, quiet_start: "21:00" });
    expect(again.query("SELECT COUNT(*) AS n FROM settings WHERE key IN ('pace_enabled','pace_min_s','pace_max_s','daily_cap','quiet_start','quiet_end')").get()).toEqual({ n: 6 });
  });
  test("the old burst and timezone rows are still removed at every open", () => {
    const path = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "outbox-pace-")), "outbox.db");
    const db = openDb(path);
    for (const k of ["burst_size_min", "burst_pause_max_s", "timezone"]) db.query("INSERT INTO settings(key, value) VALUES (?, 'x')").run(k);
    db.close();
    expect(openDb(path).query("SELECT COUNT(*) AS n FROM settings WHERE key IN ('burst_size_min','burst_pause_max_s','timezone')").get()).toEqual({ n: 0 });
  });
});

describe("PATCH /api/settings pacing", () => {
  test("off by default; GET returns the pacing object", async () => {
    const { h } = await ready();
    expect((await h.call("GET", "/api/settings")).json.settings.pacing).toEqual(PACING_OFF);
  });
  test("turning it on needs no Touch ID; a preset's values are stored as rows and audited", async () => {
    const { h } = await ready();
    const r = await patchPacing(h, { enabled: true, min_s: 120, max_s: 300, daily_cap: 50, quiet_start: "21:00", quiet_end: "09:00" });
    expect(r.status).toBe(200);
    expect(r.json.settings.pacing).toEqual({ enabled: true, min_s: 120, max_s: 300, daily_cap: 50, quiet_start: "21:00", quiet_end: "09:00" });
    const rows = Object.fromEntries(h.db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings").all().map((x) => [x.key, x.value]));
    expect(rows).toMatchObject({ pace_enabled: "1", pace_min_s: "120", pace_max_s: "300", daily_cap: "50", quiet_start: "21:00", quiet_end: "09:00" });
    const audit = h.db.query<{ target: string }, []>("SELECT target FROM audit_log WHERE action = 'setting.set' AND actor = 'owner'").all().map((x) => x.target);
    expect(audit.sort()).toEqual(["daily_cap", "pace_enabled", "pace_max_s", "pace_min_s", "quiet_end", "quiet_start"]);
  });
  test("a partial change merges with what is stored; unchanged values are not re-audited", async () => {
    const { h } = await ready();
    await patchPacing(h, { enabled: true, min_s: 60, max_s: 90 });
    const before = h.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'setting.set'").get() as { n: number };
    const r = await patchPacing(h, { max_s: 90, daily_cap: 20 });
    expect(r.json.settings.pacing).toMatchObject({ enabled: true, min_s: 60, max_s: 90, daily_cap: 20 });
    expect((h.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'setting.set'").get() as { n: number }).n - before.n).toBe(1);
    expect((await patchPacing(h, { enabled: false })).json.settings.pacing).toMatchObject({ enabled: false, min_s: 60, daily_cap: 20 });
  });
  test("validation: 2 <= min <= max <= 3600, cap 0 to 1000, quiet hours HH:MM pairs; nothing changes on a refusal", async () => {
    const { h } = await ready();
    const before = JSON.stringify(h.db.query("SELECT key, value FROM settings ORDER BY key").all());
    for (const bad of [{ min_s: 1 }, { max_s: 4000 }, { min_s: 200, max_s: 100 }, { daily_cap: 1001 }, { daily_cap: -1 }, { min_s: 2.5 },
      { quiet_start: "21:00" }, { quiet_start: "25:00", quiet_end: "09:00" }, { quiet_start: "9:00", quiet_end: "10:00" }, { quiet_start: "10:00", quiet_end: "10:00" }]) {
      const r = await patchPacing(h, { enabled: true, ...bad });
      expect([r.status, typeof r.json.message]).toEqual([400, "string"]);
    }
    expect(JSON.stringify(h.db.query("SELECT key, value FROM settings ORDER BY key").all())).toBe(before);
  });
  test("strict: unknown keys, wrong types and the old row names inside the object are refused", async () => {
    const { h } = await ready();
    for (const bad of [{ turbo: true }, { enabled: "yes" }, { min_s: "60" }, { pace_enabled: "1" }, { burst_size_max: 3 }, { timezone: "UTC" }]) {
      expect((await patchPacing(h, bad)).status).toBe(400);
    }
    expect((await h.call("PATCH", "/api/settings", { pacing: "on" })).status).toBe(400);
  });
  test("it needs the app token like every owner route", async () => {
    const { h } = await ready();
    expect((await h.call("PATCH", "/api/settings", { pacing: { enabled: true } }, { token: null })).status).toBe(401);
    expect(getSettings(h.db).pacing.enabled).toBe(false);
  });
});

describe("approval window", () => {
  const approveOpts = async (h: Awaited<ReturnType<typeof ready>>["h"], batchId: string, ids: string[]) =>
    (await h.call("POST", `/api/batches/${batchId}/approve/options`, { draft_ids: ids })).json;

  test("pacing off: 24 h exactly and an off plan", async () => {
    const { h, batchId, draftIds } = await ready();
    const o = await approveOpts(h, batchId, draftIds);
    expect(hoursOf(o.manifest)).toBe(24);
    expect(o.plan).toMatchObject({ enabled: false, count: 3, queued_ahead: 0, window_hours: 24, fits: 3 });
  });
  test("pacing on, a small batch: still 24 h, with the estimate in the plan", async () => {
    const { h, batchId, draftIds } = await ready();
    await patchPacing(h, { enabled: true, min_s: 120, max_s: 300, daily_cap: 0, quiet_start: "", quiet_end: "" });
    const o = await approveOpts(h, batchId, draftIds);
    expect(hoursOf(o.manifest)).toBe(24);
    expect(o.plan.enabled).toBe(true);
    expect((Date.parse(o.plan.latest_finish) - Date.now()) / 1000).toBeCloseTo(2 * 300, -1);
  });
  test("pacing on, a big batch: not_after = now + estimate + 12 h (signed into the manifest)", async () => {
    const { h, batchId, draftIds } = await ready(40);
    await patchPacing(h, { enabled: true, min_s: 3000, max_s: 3600 });          // 39 pauses of up to 1 h = 39 h
    const o = await approveOpts(h, batchId, draftIds);
    expect(hoursOf(o.manifest)).toBeCloseTo(39 + 12, 2);
    expect(o.plan.window_hours).toBeCloseTo(51, 2);
    expect(o.plan.fits).toBe(40);
    // and the signature covers that manifest: verifying stores the same not_after
    const v = await h.call("POST", `/api/batches/${batchId}/approve/se-verify`, h.auth.signOptions({ challenge_id: o.challenge_id, manifest_bytes: o.manifest_bytes, se: o.se }));
    expect(v.status).toBe(200);
    expect(v.json.not_after).toBe(o.manifest.not_after);
    expect(h.db.query<{ not_after: string }, []>("SELECT not_after FROM approvals").get()!.not_after).toBe(o.manifest.not_after);
  });
  test("over 7 days: capped at 7 days, and the plan says how many fit", async () => {
    const { h, batchId, draftIds } = await ready(300);
    await patchPacing(h, { enabled: true, min_s: 3600, max_s: 3600 });          // one an hour: 168 in 7 days
    const o = await approveOpts(h, batchId, draftIds);
    expect(hoursOf(o.manifest)).toBe(168);
    expect(o.plan).toMatchObject({ window_hours: 168, fits: 168, count: 300 });
  });
  test("messages already approved and waiting count as queued ahead", async () => {
    const { h, batchId, draftIds } = await ready(5);
    await patchPacing(h, { enabled: true, min_s: 600, max_s: 600 });
    const first = await approveOpts(h, batchId, draftIds.slice(0, 2));
    await h.call("POST", `/api/batches/${batchId}/approve/se-verify`, h.auth.signOptions(first));
    const o = await approveOpts(h, batchId, draftIds.slice(2));
    expect(o.plan).toMatchObject({ queued_ahead: 2, count: 3 });
  });
  test("contact approvals keep their fixed 24 hours", async () => {
    // the contacts manifest uses APPROVAL_HOURS directly; pacing never touches it
    const { APPROVAL_HOURS } = await import("./approval");
    expect(APPROVAL_HOURS).toBe(24);
  });
});

describe("status", () => {
  test("GET /api/status carries the settings and what the executor wrote (hold + next time)", async () => {
    const { h } = await ready();
    expect((await h.call("GET", "/api/status")).json.pacing).toEqual({ ...PACING_OFF, next_send_at: null, hold: null });
    await patchPacing(h, { enabled: true });
    const t = new Date(Date.now() + 90_000).toISOString();
    wait(h, "next_send_at", t); wait(h, "pace_hold", "gap"); wait(h, "pace_until", t);
    expect((await h.call("GET", "/api/status")).json.pacing).toMatchObject({ enabled: true, next_send_at: t, hold: { kind: "gap", until: t } });
    wait(h, "pace_hold", "daily");
    expect((await h.call("GET", "/api/status")).json.pacing.hold.kind).toBe("daily");
    wait(h, "pace_hold", ""); wait(h, "pace_until", "");
    expect((await h.call("GET", "/api/status")).json.pacing.hold).toBeNull();
    wait(h, "pace_hold", "bogus"); wait(h, "pace_until", t);
    expect((await h.call("GET", "/api/status")).json.pacing.hold).toBeNull();
  });
});
