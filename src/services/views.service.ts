import { randomUUID } from "node:crypto";
import { pool } from "../config/postgres.js";
import { track } from "./analytics.service.js";

type Logger = { error: (o: object, m: string) => void; info: (o: object, m: string) => void };

const DEDUPE_WINDOW_MS = 30 * 60 * 1000;
const FLUSH_INTERVAL_MS = 10_000;
const MAX_TRACKED_VIEWERS = 200_000;

/**
 * Views are buffered in memory and flushed in aggregate, so a page visit never costs one
 * database write. Repeat views by the same viewer inside the window are ignored.
 *
 * Trade off: a crash can lose up to FLUSH_INTERVAL_MS of view counts. The graceful shutdown
 * hook flushes first. For multi instance deployments move this buffer to Redis or a queue.
 */
export class ViewAggregator {
  private pending = new Map<string, number>();
  private seen = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private log: Logger) {}

  start() {
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  /** Returns true if the view was counted. */
  record(workId: string, viewerKey: string): boolean {
    const key = `${workId}:${viewerKey}`;
    const now = Date.now();
    const last = this.seen.get(key);
    if (last && now - last < DEDUPE_WINDOW_MS) return false;
    if (this.seen.size >= MAX_TRACKED_VIEWERS) this.prune(now);
    this.seen.set(key, now);
    this.pending.set(workId, (this.pending.get(workId) ?? 0) + 1);
    return true;
  }

  private prune(now: number) {
    for (const [k, t] of this.seen) if (now - t >= DEDUPE_WINDOW_MS) this.seen.delete(k);
    if (this.seen.size >= MAX_TRACKED_VIEWERS) this.seen.clear();
  }

  async flush() {
    if (this.pending.size === 0) return;
    const snapshot = this.pending;
    this.pending = new Map();
    const flushId = randomUUID();
    let total = 0;
    for (const count of snapshot.values()) total += count;
    try {
      // One statement for the whole batch. Works removed since the view was recorded simply match no row.
      await pool.query(
        `UPDATE works w SET view_count = w.view_count + v.n
           FROM unnest($1::text[], $2::int[]) AS v(id, n) WHERE w.id = v.id`,
        [[...snapshot.keys()], [...snapshot.values()]],
      );
    } catch (err) {
      // Do not retry forever. A lost flush costs a few view counts, never a request.
      this.log.error({ works: snapshot.size, total, err: (err as Error).message }, "VIEW_FLUSH_FAILED");
    }
    track({ eventId: `views:${flushId}`, metric: "views", delta: total }, this.log);
  }
}
