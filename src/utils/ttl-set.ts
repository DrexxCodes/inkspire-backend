/**
 * A bounded set whose entries expire. Used to drop duplicate share events caused by double
 * taps or client retries, without storing anything permanently.
 */
export class TtlSet {
  private entries = new Map<string, number>();

  constructor(
    private ttlMs: number,
    private maxEntries = 100_000,
    private now: () => number = Date.now,
  ) {}

  /** Returns true if the key was new (or had expired) and is now recorded. */
  addIfNew(key: string): boolean {
    const t = this.now();
    const seen = this.entries.get(key);
    if (seen !== undefined && t - seen < this.ttlMs) return false;
    if (this.entries.size >= this.maxEntries) this.prune(t);
    this.entries.set(key, t);
    return true;
  }

  get size() {
    return this.entries.size;
  }

  private prune(t: number) {
    for (const [k, v] of this.entries) if (t - v >= this.ttlMs) this.entries.delete(k);
    // Still full after dropping expired entries: start over rather than grow without bound.
    if (this.entries.size >= this.maxEntries) this.entries.clear();
  }
}
