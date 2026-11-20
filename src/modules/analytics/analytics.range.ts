import type { MetricName } from "../../types/domain.js";

export type Granularity = "daily" | "monthly" | "yearly";

export const METRICS: MetricName[] = [
  "signups",
  "works_created",
  "works_published",
  "likes",
  "comments",
  "shares",
  "views",
];

export const DEFAULT_POINTS: Record<Granularity, number> = { daily: 30, monthly: 12, yearly: 5 };
export const MAX_POINTS: Record<Granularity, number> = { daily: 366, monthly: 60, yearly: 20 };

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Ordered, gap free list of bucket keys ending at `now` (UTC).
 *   daily   -> YYYY-MM-DD
 *   monthly -> YYYY-MM-01
 *   yearly  -> YYYY
 */
export function buildBuckets(granularity: Granularity, points: number, now: Date = new Date()): string[] {
  const n = Math.min(Math.max(1, Math.floor(points)), MAX_POINTS[granularity]);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    if (granularity === "daily") {
      const t = new Date(Date.UTC(y, m, d - i));
      keys.push(`${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`);
    } else if (granularity === "monthly") {
      const t = new Date(Date.UTC(y, m - i, 1));
      keys.push(`${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-01`);
    } else {
      keys.push(String(y - i));
    }
  }
  return keys;
}

export type SeriesRow = { bucket: string } & Record<MetricName, number>;

/** Merges sparse database rows into the full bucket list, filling missing buckets with zeros. */
export function fillSeries(
  buckets: string[],
  rows: Array<Record<string, unknown>>,
  metrics: MetricName[] = METRICS,
): SeriesRow[] {
  const byBucket = new Map(rows.map((r) => [String(r.bucket), r]));
  return buckets.map((bucket) => {
    const row = byBucket.get(bucket);
    const out = { bucket } as SeriesRow;
    for (const m of METRICS) out[m] = metrics.includes(m) ? Number(row?.[m] ?? 0) : 0;
    return out;
  });
}

export const TABLE: Record<Granularity, { table: string; key: string; bucketSql: string }> = {
  daily: { table: "daily_metrics", key: "date", bucketSql: "to_char(date, 'YYYY-MM-DD')" },
  monthly: { table: "monthly_metrics", key: "month", bucketSql: "to_char(month, 'YYYY-MM-DD')" },
  yearly: { table: "yearly_metrics", key: "year", bucketSql: "year::text" },
};
