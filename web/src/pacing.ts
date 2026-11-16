// Plain-words formatting for "Spread out messages". The presets mirror PACE_PRESETS in src/core/pacing.ts.
export interface Pacing { enabled: boolean; min_s: number; max_s: number; daily_cap: number; quiet_start: string; quiet_end: string }

export const PRESETS: Record<"gentle" | "careful", Omit<Pacing, "enabled">> = {
  gentle: { min_s: 30, max_s: 90, daily_cap: 150, quiet_start: "", quiet_end: "" },
  careful: { min_s: 120, max_s: 300, daily_cap: 50, quiet_start: "21:00", quiet_end: "09:00" },
};
export type Preset = "off" | "gentle" | "careful" | "custom";

export function presetOf(p: Pacing): Preset {
  if (!p.enabled) return "off";
  for (const k of ["gentle", "careful"] as const) {
    const x = PRESETS[k];
    if (x.min_s === p.min_s && x.max_s === p.max_s && x.daily_cap === p.daily_cap && x.quiet_start === p.quiet_start && x.quiet_end === p.quiet_end) return k;
  }
  return "custom";
}

/** "45 s", "2 min", "1 h 30 min", "2 days 3 h". */
export function fmtSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24), hh = h % 24;
  return `${d} day${d === 1 ? "" : "s"}${hh ? ` ${hh} h` : ""}`;
}
/** The approval window: "24 hours", "51 hours", "7 days". */
export function fmtWindow(hours: number): string {
  const h = Math.round(hours);
  return h < 48 ? `${h} hours` : h % 24 === 0 ? `${h / 24} days` : `${h} hours`;
}
/** "4:30 pm". */
export const fmtClock = (d: Date | string): string => new Date(d).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
/** "4:30 pm" today, "tomorrow at 9:00 am" or "Fri at 9:00 am" otherwise. */
export function fmtWhen(iso: string | Date, now: Date = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  if (diff === 0) return fmtClock(d);
  if (diff === 1) return `tomorrow at ${fmtClock(d)}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short" })} at ${fmtClock(d)}`;
}
const hhmm = (s: string): string => fmtClock(new Date(2000, 0, 1, Number(s.slice(0, 2)), Number(s.slice(3))));
const secs = (s: number): string => (s < 90 ? `${s} s` : `${Math.round(s / 60)} min`);

/** One sentence for the Settings card, e.g. "A pause of 2 to 5 min between messages, up to 50 a day, none from 9:00 PM to 9:00 AM." */
export function describePacing(p: Pacing): string {
  const pause = p.min_s === p.max_s ? `A pause of ${secs(p.min_s)} between messages` : `A pause of ${secs(p.min_s)} to ${secs(p.max_s)} between messages`;
  const cap = p.daily_cap > 0 ? `, up to ${p.daily_cap} a day` : "";
  const quiet = p.quiet_start && p.quiet_end ? `, none from ${hhmm(p.quiet_start)} to ${hhmm(p.quiet_end)}` : "";
  return `${pause}${cap}${quiet}.`;
}

/** What the sender is doing about pacing right now, for the batch page. */
export function nextSendLine(hold: { kind: string; until: string } | null, now: Date = new Date()): string {
  if (!hold || Date.parse(hold.until) <= now.getTime()) return "Sending now, one message at a time.";
  const when = fmtWhen(hold.until, now);
  if (hold.kind === "daily") return `Daily limit reached, continues ${when}.`;
  if (hold.kind === "quiet") return `Quiet hours until ${when}.`;
  return `Next message around ${when}.`;
}
