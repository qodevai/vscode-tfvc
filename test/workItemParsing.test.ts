import * as assert from 'assert';
import { describe, it } from 'node:test';
import { parseWorkItemIds } from '../src/workItemParsing';

describe('parseWorkItemIds', () => {
    it('extracts IDs from #nnnn references', () => {
        assert.deepStrictEqual(parseWorkItemIds('fixes #1234 and #5678'), [1234, 5678]);
    });

    it('extracts IDs from WI:nnnn references', () => {
        assert.deepStrictEqual(parseWorkItemIds('closes WI:42 touches WI:7'), [42, 7]);
    });

    it('mixes both forms', () => {
        assert.deepStrictEqual(parseWorkItemIds('#10 and WI:20'), [10, 20]);
    });

    it('dedupes repeated IDs (I17)', () => {
        // Previously this returned [1234, 1234] which ADO rejects as a
        // duplicate work item link.
        assert.deepStrictEqual(parseWorkItemIds('#1234 fixes #1234'), [1234]);
        assert.deepStrictEqual(parseWorkItemIds('#42 and WI:42'), [42]);
    });

    it('preserves first-seen order', () => {
        assert.deepStrictEqual(parseWorkItemIds('#3 #1 #2 #1 #3'), [3, 1, 2]);
    });

    it('returns empty array when no IDs are mentioned', () => {
        assert.deepStrictEqual(parseWorkItemIds('just a regular comment'), []);
        assert.deepStrictEqual(parseWorkItemIds(''), []);
    });

    it('is case-insensitive on the WI: prefix', () => {
        assert.deepStrictEqual(parseWorkItemIds('wi:99 Wi:88'), [99, 88]);
    });
});
