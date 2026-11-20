import { randomUUID } from "node:crypto";
import { withTransaction } from "../config/postgres.js";
import { dayKey, monthKey, yearKey } from "../utils/time.js";
import type { MetricName } from "../types/domain.js";

/** Whitelist: metric names are interpolated into SQL, so only these literals are allowed. */
const COLUMN: Record<MetricName, string> = {
  signups: "signups",
  works_created: "works_created",
  works_published: "works_published",
  likes: "likes",
  comments: "comments",
  shares: "shares",
  views: "views",
};

export interface TrackInput {
  /** Deterministic id for the real world event. Reprocessing the same id never double counts. */
  eventId: string;
  metric: MetricName;
  delta?: number;
  at?: Date;
}

type Logger = { error: (o: object, m: string) => void };

/**
 * Records one event and bumps the daily, monthly and yearly rollups in one transaction.
 * The unique event id makes the whole operation idempotent for retries.
 */
export async function recordEvent({ eventId, metric, delta = 1, at = new Date() }: TrackInput): Promise<boolean> {
  const column = COLUMN[metric];
  return withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO analytics_events (event_id, metric, delta, occurred_at)
       VALUES ($1,$2,$3,$4) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [eventId, metric, delta, at],
    );
    if (inserted.rowCount === 0) return false;

    await client.query(
      `INSERT INTO daily_metrics (date, ${column}) VALUES ($1,$2)
       ON CONFLICT (date) DO UPDATE SET ${column} = daily_metrics.${column} + EXCLUDED.${column}, updated_at = now()`,
      [dayKey(at), delta],
    );
    await client.query(
      `INSERT INTO monthly_metrics (month, ${column}) VALUES ($1,$2)
       ON CONFLICT (month) DO UPDATE SET ${column} = monthly_metrics.${column} + EXCLUDED.${column}, updated_at = now()`,
      [monthKey(at), delta],
    );
    await client.query(
      `INSERT INTO yearly_metrics (year, ${column}) VALUES ($1,$2)
       ON CONFLICT (year) DO UPDATE SET ${column} = yearly_metrics.${column} + EXCLUDED.${column}, updated_at = now()`,
      [yearKey(at), delta],
    );
    return true;
  });
}

/**
 * Fire and forget with retries. Analytics must never fail or slow a user action, and the
 * deterministic event id keeps retries safe.
 */
export function track(input: TrackInput, log: Logger): void {
  const attempt = (n: number) => {
    recordEvent(input).catch((err: Error) => {
      if (n >= 4) {
        log.error({ event: input, err: err.message }, "ANALYTICS_EVENT_DROPPED");
        return;
      }
      setTimeout(() => attempt(n + 1), 500 * 2 ** n).unref();
    });
  };
  attempt(0);
}

export const newEventId = (prefix: string) => `${prefix}:${randomUUID()}`;
