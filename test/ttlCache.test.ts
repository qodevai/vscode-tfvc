import * as assert from 'assert';
import { describe, it } from 'node:test';
import { TtlCache } from '../src/ttlCache';

// Injectable clock. Start at a non-zero number so `+=` jumps are easy
// to spot in test output.
function fakeClock(start = 1_000_000): { now: () => number; advance(ms: number): void } {
    let t = start;
    return {
        now: () => t,
        advance(ms: number) { t += ms; },
    };
}

describe('TtlCache', () => {
    it('returns a set value while the TTL window is open', () => {
        const clock = fakeClock();
        const cache = new TtlCache<string, number>(1000, clock.now);
        cache.set('k', 42);
        clock.advance(500);
        assert.strictEqual(cache.get('k'), 42);
    });

    it('returns undefined once the TTL has elapsed', () => {
        const clock = fakeClock();
        const cache = new TtlCache<string, number>(1000, clock.now);
        cache.set('k', 42);
        clock.advance(1000); // exactly at boundary — expired
        assert.strictEqual(cache.get('k'), undefined);
    });

    it('treats the boundary as expired (>= expiresAt, not >)', () => {
        const clock = fakeClock();
        const cache = new TtlCache<string, number>(1000, clock.now);
        cache.set('k', 1);
        clock.advance(999);
        assert.strictEqual(cache.get('k'), 1, 'still valid one tick before boundary');
        clock.advance(1);
        assert.strictEqual(cache.get('k'), undefined, 'expired at boundary');
    });

    it('evicts on access so size reflects reality after reads', () => {
        const clock = fakeClock();
        const cache = new TtlCache<string, number>(1000, clock.now);
        cache.set('a', 1);
        cache.set('b', 2);
        assert.strictEqual(cache.size, 2);
        clock.advance(2000);
        cache.get('a'); // triggers lazy eviction of 'a'
        assert.strictEqual(cache.size, 1, '"a" evicted on access');
        // 'b' has not been accessed, so it's still counted — documents the
        // lazy-eviction behaviour so consumers don't rely on size for
        // "number of live entries".
    });

    it('resets the TTL window on set', () => {
        const clock = fakeClock();
        const cache = new TtlCache<string, number>(1000, clock.now);
        cache.set('k', 1);
        clock.advance(800);
        cache.set('k', 2); // fresh window
        clock.advance(800);
        assert.strictEqual(cache.get('k'), 2, 'still valid in the new window');
        clock.advance(201);
        assert.strictEqual(cache.get('k'), undefined);
    });

    it('delete removes a key without waiting for TTL', () => {
        const cache = new TtlCache<string, number>(1000);
        cache.set('k', 1);
        cache.delete('k');
        assert.strictEqual(cache.get('k'), undefined);
    });

    it('clear drops all entries', () => {
        const cache = new TtlCache<string, number>(1000);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.clear();
        assert.strictEqual(cache.size, 0);
        assert.strictEqual(cache.get('a'), undefined);
    });

    it('returns undefined for never-set keys', () => {
        const cache = new TtlCache<string, number>(1000);
        assert.strictEqual(cache.get('absent'), undefined);
    });

    it('defaults now to Date.now when no clock is injected', () => {
        // Don't exercise expiry here — just verify the default path doesn't
        // throw. Coverage for actual timing is via injected-clock tests above.
        const cache = new TtlCache<string, number>(1_000_000);
        cache.set('k', 9);
        assert.strictEqual(cache.get('k'), 9);
    });
});
