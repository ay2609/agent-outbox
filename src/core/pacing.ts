// Optional pacing ("Spread out messages"): settings shape, validation, presets and the schedule estimate.
// outbox-exec does the real pacing (exec/Sources/OutboxExecCore/Scheduler.swift); planSends() here only predicts it, so the
// approve sheet can say how long a batch will take and so the approval window can be long enough to outlive it.
// Times are the Mac's local time (the server and the executor run on the same Mac). No I/O, no clock: everything is passed in.

export interface Pacing {
  enabled: boolean;
  /** Random pause between the end of one send and the start of the next, uniform in [min_s, max_s]. */
  min_s: number;
  max_s: number;
  /** Most sends that may start per local day; 0 = no limit. */
  daily_cap: number;
  /** Quiet hours, local "HH:MM" (may wrap midnight, e.g. 21:00 to 09:00). Both '' = none. */
  quiet_start: string;
  quiet_end: string;
}

export const PACING_OFF: Pacing = { enabled: false, min_s: 30, max_s: 90, daily_cap: 0, quiet_start: "", quiet_end: "" };
export const PACE_PRESETS = {
  gentle: { min_s: 30, max_s: 90, daily_cap: 150, quiet_start: "", quiet_end: "" },
  careful: { min_s: 120, max_s: 300, daily_cap: 50, quiet_start: "21:00", quiet_end: "09:00" },
} as const;

export const PACE_LIMITS = { min_s: 2, max_s: 3600, daily_cap: 1000 } as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const hhmmToMinutes = (s: string): number | null => (HHMM.test(s) ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) : null);

/** Lenient read of the settings rows (anything unreadable falls back to the off defaults). */
export function parsePacing(m: Record<string, string | undefined>): Pacing {
  const num = (k: string, d: number): number => { const n = Number(m[k]); return m[k] !== undefined && m[k] !== "" && Number.isFinite(n) ? n : d; };
  return {
    enabled: m.pace_enabled === "1",
    min_s: num("pace_min_s", PACING_OFF.min_s), max_s: num("pace_max_s", PACING_OFF.max_s), daily_cap: num("daily_cap", 0),
    quiet_start: m.quiet_start ?? "", quiet_end: m.quiet_end ?? "",
  };
}

/** A plain-words problem with these values, or null. Checked on every change (even while pacing is off, so Custom can't store nonsense). */
export function pacingProblem(p: Pacing): string | null {
  const int = Number.isInteger;
  if (!int(p.min_s) || !int(p.max_s) || p.min_s < PACE_LIMITS.min_s || p.max_s > PACE_LIMITS.max_s) return `The pause between messages must be ${PACE_LIMITS.min_s} to ${PACE_LIMITS.max_s} seconds.`;
  if (p.min_s > p.max_s) return "The shortest pause can't be longer than the longest.";
  if (!int(p.daily_cap) || p.daily_cap < 0 || p.daily_cap > PACE_LIMITS.daily_cap) return `The daily limit must be 0 (no limit) to ${PACE_LIMITS.daily_cap}.`;
  const noQ = p.quiet_start === "" && p.quiet_end === "";
  if (!noQ) {
    const s = hhmmToMinutes(p.quiet_start), e = hhmmToMinutes(p.quiet_end);
    if (s === null || e === null) return "Quiet hours need a start and an end time, like 21:00 and 09:00.";
    if (s === e) return "Quiet hours can't start and end at the same time.";
  }
  return null;
}

// ---------- the schedule estimate ----------
export interface PlanInput {
  now: Date;
  pacing: Pacing;
  /** Approved messages already waiting to send ahead of this batch. */
  queued: number;
  /** Messages in this approval. */
  count: number;
  /** Sends that already started today (local day). */
  sentToday?: number;
  /** The executor's persisted earliest next start (exec_state next_send_at), if any. */
  nextSendAt?: Date | null;
}
export interface Plan {
  enabled: boolean;
  count: number;
  queued_ahead: number;
  /** Start of the last message, with the average pause. */
  expected_finish: string;
  /** The same with the longest pause: what the approval window is sized from. */
  latest_finish: string;
  /** Hours the approval stays valid: max(24, worst-case estimate + 12), at most 7 days. */
  window_hours: number;
  /** Messages of THIS approval that start inside the 7-day cap; fewer than `count` means the rest would expire. */
  fits: number;
}

export const MIN_WINDOW_HOURS = 24;
export const WINDOW_MARGIN_HOURS = 12;
export const MAX_WINDOW_HOURS = 24 * 7;
/** Without pacing: right away, one every 2 s (SendGap in outbox-exec). */
const OFF_GAP_S = 2;

const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const minutesOfDay = (d: Date): number => d.getHours() * 60 + d.getMinutes();
function inQuiet(t: Date, qs: number, qe: number): boolean {
  const c = minutesOfDay(t);
  return qs < qe ? c >= qs && c < qe : c >= qs || c < qe;
}
/** The next time of day `minutes` strictly after t. */
function nextAt(t: Date, minutes: number): Date {
  const d = new Date(t.getTime());
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  if (d.getTime() <= t.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/** Start times of `total` sends, in order, with the given pause between them. Stops once a start passes `horizon`. */
function simulate(now: Date, p: Pacing, total: number, gapS: number, sentToday: number, nextSendAt: Date | null, horizon: Date): Date[] {
  const out: Date[] = [];
  const qs = hhmmToMinutes(p.quiet_start), qe = hhmmToMinutes(p.quiet_end);
  const quiet = qs !== null && qe !== null && qs !== qe;
  const counts = new Map<string, number>([[dayKey(now), sentToday]]);
  let t = nextSendAt && nextSendAt.getTime() > now.getTime() ? nextSendAt : now;
  for (let i = 0; i < total; i++) {
    for (let guard = 0; guard < 8; guard++) {
      if (quiet && inQuiet(t, qs!, qe!)) { t = nextAt(t, qe!); continue; }
      if (p.daily_cap > 0 && (counts.get(dayKey(t)) ?? 0) >= p.daily_cap) { t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1); continue; }
      break;
    }
    if (t.getTime() >= horizon.getTime()) break;
    out.push(t);
    counts.set(dayKey(t), (counts.get(dayKey(t)) ?? 0) + 1);
    t = new Date(t.getTime() + gapS * 1000);
  }
  return out;
}

/** The estimate and the approval window for `count` new messages behind `queued` already waiting. Pure. */
export function planSends(i: PlanInput): Plan {
  const total = i.queued + i.count;
  const horizon = new Date(i.now.getTime() + MAX_WINDOW_HOURS * 3600_000);
  const p = i.pacing.enabled ? i.pacing : { ...PACING_OFF, min_s: OFF_GAP_S, max_s: OFF_GAP_S };
  const nextSend = i.pacing.enabled ? (i.nextSendAt ?? null) : null;
  const avg = simulate(i.now, p, total, (p.min_s + p.max_s) / 2, i.sentToday ?? 0, nextSend, horizon);
  const worst = simulate(i.now, p, total, p.max_s, i.sentToday ?? 0, nextSend, horizon);
  const last = (a: Date[]): Date => a[a.length - 1] ?? i.now;
  const fits = Math.max(0, Math.min(i.count, worst.length - i.queued));
  const overflow = worst.length < total;
  const worstEnd = overflow ? horizon : last(worst);
  const window = i.pacing.enabled ? Math.min(MAX_WINDOW_HOURS, Math.max(MIN_WINDOW_HOURS, (worstEnd.getTime() - i.now.getTime()) / 3600_000 + WINDOW_MARGIN_HOURS)) : MIN_WINDOW_HOURS;
  return {
    enabled: i.pacing.enabled, count: i.count, queued_ahead: i.queued,
    expected_finish: (avg.length === total ? last(avg) : horizon).toISOString(),
    latest_finish: worstEnd.toISOString(),
    window_hours: window, fits,
  };
}
