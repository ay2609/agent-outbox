// Database reads behind the pacing estimate and the Agent Outbox app's "next message" line. Read-only: outbox-exec owns these rows.
import type { Database } from "bun:sqlite";

export interface PaceHold {
  /** "gap": waiting out the random pause. "daily": the daily limit is reached. "quiet": inside quiet hours. */
  kind: "gap" | "daily" | "quiet";
  /** When the executor expects to send again (ISO). */
  until: string;
}
export interface PaceState {
  /** The executor's earliest next start (exec_state next_send_at), or null. */
  next_send_at: string | null;
  /** Why the executor is holding approved messages right now, or null. Written by the executor on every pass. */
  hold: PaceHold | null;
}

const stateValue = (db: Database, key: string): string | null =>
  db.query<{ value: string | null }, [string]>("SELECT value FROM exec_state WHERE key = ?").get(key)?.value || null;

export function readPaceState(db: Database): PaceState {
  const kind = stateValue(db, "pace_hold"), until = stateValue(db, "pace_until");
  const ok = (kind === "gap" || kind === "daily" || kind === "quiet") && until !== null && !Number.isNaN(Date.parse(until));
  return { next_send_at: stateValue(db, "next_send_at"), hold: ok ? { kind, until: until! } : null };
}

/** Approved messages that are still waiting to send (so a new approval queues behind them). */
export function queuedAhead(db: Database): number {
  return db.query<{ n: number }, []>(
    `SELECT COUNT(*) AS n FROM drafts d JOIN batches b ON b.id = d.batch_id WHERE d.status IN ('approved','sending') AND b.status != 'cancelled'`).get()?.n ?? 0;
}

/** Sends that started since local midnight (dry and live both count, as in the executor). */
export function sentSinceLocalMidnight(db: Database, now: Date = new Date()): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sends WHERE started_at >= ?").get(midnight.toISOString())?.n ?? 0;
}
