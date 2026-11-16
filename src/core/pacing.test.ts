// Pacing: validation, presets and the schedule estimate behind the approval window. Times are local (new Date(y, m, d, h, min)).
import { describe, expect, test } from "bun:test";
import { MAX_WINDOW_HOURS, PACE_PRESETS, PACING_OFF, pacingProblem, parsePacing, planSends, type Pacing } from "./pacing";

const on = (p: Partial<Pacing> = {}): Pacing => ({ ...PACING_OFF, enabled: true, min_s: 60, max_s: 120, ...p });
const at = (d: number, h: number, m = 0): Date => new Date(2026, 10, d, h, m);   // Nov d, 2026, local
const hoursBetween = (a: string, b: Date): number => (Date.parse(a) - b.getTime()) / 3600_000;

describe("parsePacing / pacingProblem", () => {
  test("missing or odd rows fall back to off", () => {
    expect(parsePacing({})).toEqual(PACING_OFF);
    expect(parsePacing({ pace_enabled: "1", pace_min_s: "x", daily_cap: "" })).toMatchObject({ enabled: true, min_s: 30, daily_cap: 0 });
    expect(parsePacing({ pace_enabled: "0", pace_min_s: "5", pace_max_s: "9", daily_cap: "7", quiet_start: "21:00", quiet_end: "09:00" }))
      .toEqual({ enabled: false, min_s: 5, max_s: 9, daily_cap: 7, quiet_start: "21:00", quiet_end: "09:00" });
  });
  test("the presets are valid", () => {
    for (const p of Object.values(PACE_PRESETS)) expect(pacingProblem({ enabled: true, ...p })).toBeNull();
    expect(pacingProblem(PACING_OFF)).toBeNull();
  });
  test("2 <= min <= max <= 3600, cap 0 to 1000, whole numbers, HH:MM pairs that differ", () => {
    const bad = (o: Partial<Pacing>) => pacingProblem({ ...PACING_OFF, ...o });
    expect(bad({ min_s: 1 })).toContain("2 to 3600");
    expect(bad({ max_s: 3601 })).toContain("2 to 3600");
    expect(bad({ min_s: 100, max_s: 50 })).toContain("shortest");
    expect(bad({ min_s: 2.5 })).not.toBeNull();
    expect(bad({ min_s: Number.NaN })).not.toBeNull();
    expect(bad({ daily_cap: -1 })).toContain("0 (no limit) to 1000");
    expect(bad({ daily_cap: 1001 })).not.toBeNull();
    expect(bad({ daily_cap: 1000 })).toBeNull();
    expect(bad({ quiet_start: "21:00" })).toContain("start and an end");
    expect(bad({ quiet_start: "9:00", quiet_end: "10:00" })).not.toBeNull();
    expect(bad({ quiet_start: "24:00", quiet_end: "10:00" })).not.toBeNull();
    expect(bad({ quiet_start: "21:00", quiet_end: "21:00" })).toContain("same time");
    expect(bad({ quiet_start: "21:00", quiet_end: "09:00" })).toBeNull();
  });
});

describe("planSends: the approval window", () => {
  const now = at(16, 10);
  test("pacing off: right away, a flat 24 hours", () => {
    const p = planSends({ now, pacing: PACING_OFF, queued: 0, count: 40 });
    expect(p).toMatchObject({ enabled: false, window_hours: 24, fits: 40 });
    expect(hoursBetween(p.latest_finish, now) * 3600).toBeCloseTo(39 * 2, 0);   // one every 2 s
  });
  test("a small batch keeps the 24 h floor", () => {
    const p = planSends({ now, pacing: on(), queued: 0, count: 10 });   // 9 pauses of 2 min = 18 min
    expect(p.window_hours).toBe(24);
    expect(p.fits).toBe(10);
  });
  test("estimate + 12 h once it passes 12 h: 200 messages at 2 min max = 398 pauses", () => {
    const p = planSends({ now, pacing: on(), queued: 0, count: 200 });
    const est = (199 * 120) / 3600;                                        // 6.63 h: still under the floor
    expect(p.window_hours).toBe(24);
    expect(hoursBetween(p.latest_finish, now)).toBeCloseTo(est, 3);
    const big = planSends({ now, pacing: on({ min_s: 300, max_s: 300 }), queued: 0, count: 200 });   // 199 * 5 min = 16.58 h
    expect(big.window_hours).toBeCloseTo((199 * 300) / 3600 + 12, 3);
    expect(big.fits).toBe(200);
  });
  test("average pause for the shown estimate, longest pause for the window", () => {
    const p = planSends({ now, pacing: on({ min_s: 100, max_s: 300 }), queued: 0, count: 101 });
    expect(hoursBetween(p.expected_finish, now)).toBeCloseTo((100 * 200) / 3600, 3);
    expect(hoursBetween(p.latest_finish, now)).toBeCloseTo((100 * 300) / 3600, 3);
  });
  test("queued messages go first and the persisted next_send_at is respected", () => {
    const a = planSends({ now, pacing: on(), queued: 0, count: 5 });
    const b = planSends({ now, pacing: on(), queued: 20, count: 5 });
    expect(hoursBetween(b.latest_finish, now) - hoursBetween(a.latest_finish, now)).toBeCloseTo((20 * 120) / 3600, 3);
    expect(b.queued_ahead).toBe(20);
    const c = planSends({ now, pacing: on(), queued: 0, count: 1, nextSendAt: new Date(now.getTime() + 3600_000) });
    expect(hoursBetween(c.latest_finish, now)).toBeCloseTo(1, 3);
    const stale = planSends({ now, pacing: on(), queued: 0, count: 1, nextSendAt: new Date(now.getTime() - 3600_000) });
    expect(stale.latest_finish).toBe(now.toISOString());
  });
  test("daily limit: the rest waits for the next local day (today's sends count)", () => {
    // 10:00, limit 10, 4 already sent today, 20 queued: 6 today, 10 on the 17th, 4 on the 18th
    const p = planSends({ now, pacing: on({ min_s: 60, max_s: 60, daily_cap: 10 }), queued: 0, count: 20, sentToday: 4 });
    const last = new Date(p.latest_finish);
    expect([last.getDate(), last.getHours(), last.getMinutes()]).toEqual([18, 0, 3]);   // 4th send of the 18th: 00:00 + 3 pauses
    expect(p.window_hours).toBeCloseTo((last.getTime() - now.getTime()) / 3600_000 + 12, 3);
  });
  test("quiet hours that wrap midnight push the start out and the estimate follows", () => {
    const night = at(16, 22);
    const p = planSends({ now: night, pacing: on({ quiet_start: "21:00", quiet_end: "09:00" }), queued: 0, count: 3 });
    const last = new Date(p.latest_finish);
    expect([last.getDate(), last.getHours(), last.getMinutes()]).toEqual([17, 9, 4]);   // 09:00, 09:02, 09:04
    const day = planSends({ now: at(16, 10), pacing: on({ quiet_start: "21:00", quiet_end: "09:00" }), queued: 0, count: 3 });
    expect(new Date(day.latest_finish).getHours()).toBe(10);
  });
  test("quiet hours inside one day", () => {
    const p = planSends({ now: at(16, 12, 30), pacing: on({ quiet_start: "12:00", quiet_end: "13:00" }), queued: 0, count: 1 });
    expect(new Date(p.latest_finish).getTime()).toBe(at(16, 13).getTime());
  });
  test("capped at 7 days, and the sheet learns how many fit", () => {
    const p = planSends({ now, pacing: on({ min_s: 3600, max_s: 3600 }), queued: 0, count: 500 });   // one an hour: 168 fit in 7 days
    expect(p.window_hours).toBe(MAX_WINDOW_HOURS);
    expect(p.fits).toBe(168);
    expect(p.count).toBe(500);
    const q = planSends({ now, pacing: on({ min_s: 3600, max_s: 3600 }), queued: 100, count: 500 });
    expect(q.fits).toBe(68);                                                // 100 queued ahead use up the first 100 slots
    expect(planSends({ now, pacing: on({ min_s: 3600, max_s: 3600 }), queued: 400, count: 10 }).fits).toBe(0);
  });
  test("exactly 7 days of work still fits: the window is capped, not the batch", () => {
    const p = planSends({ now, pacing: on({ min_s: 3600, max_s: 3600 }), queued: 0, count: 100 });   // 99 h
    expect(p.fits).toBe(100);
    expect(p.window_hours).toBeCloseTo(99 + 12, 3);
  });
});
