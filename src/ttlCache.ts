/**
 * Small TTL-based cache used by `TfvcQuickDiffProvider` to memoise
 * baseline file fetches for the 30-second window VS Code typically
 * re-queries during gutter-decoration rendering.
 *
 * Kept as a standalone class (rather than inline in the provider) so
 * the expiry logic — the part that's easy to get wrong — has its own
 * unit tests, and so `now()` can be injected in those tests without
 * needing fake timers.
 */
export class TtlCache<K, V> {
    private entries = new Map<K, { value: V; expiresAt: number }>();

    constructor(
        private readonly ttlMs: number,
        private readonly now: () => number = Date.now,
    ) {}

    /**
     * Return the cached value for `key`, or `undefined` when absent or
     * expired. Expired entries are evicted lazily on access — a reader
     * never sees a stale value, and we don't need a background sweeper.
     */
    get(key: K): V | undefined {
        const entry = this.entries.get(key);
        if (!entry) { return undefined; }
        if (this.now() >= entry.expiresAt) {
            this.entries.delete(key);
            return undefined;
        }
        return entry.value;
    }

    /** Insert / overwrite, resetting the TTL window from now. */
    set(key: K, value: V): void {
        this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    }

    /** Explicit invalidation for a known-stale key. */
    delete(key: K): void {
        this.entries.delete(key);
    }

    /** Drop everything (used on repo change — the whole baseline may have shifted). */
    clear(): void {
        this.entries.clear();
    }

    /** Current number of un-expired entries (counts entries not yet lazily evicted). */
    get size(): number {
        return this.entries.size;
    }
}
