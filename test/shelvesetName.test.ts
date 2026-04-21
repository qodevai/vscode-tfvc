import * as assert from 'assert';
import { describe, it } from 'node:test';
import { validateShelvesetName } from '../src/shelvesetName';

describe('validateShelvesetName', () => {
    it('accepts ordinary names', () => {
        assert.strictEqual(validateShelvesetName('my-work'), undefined);
        assert.strictEqual(validateShelvesetName('feature_branch_42'), undefined);
        assert.strictEqual(validateShelvesetName('Ticket 12345'), undefined);
    });

    it('rejects empty or whitespace-only names', () => {
        assert.match(validateShelvesetName('')!, /empty/i);
        assert.match(validateShelvesetName('   ')!, /empty/i);
        assert.match(validateShelvesetName('\t\n')!, /empty/i);
    });

    it('rejects names starting with a dash', () => {
        // Dashes at start are a foot-gun: they can be interpreted as CLI flags
        // when a shelveset name is interpolated into a command. Reject upfront.
        assert.match(validateShelvesetName('-rf')!, /dash/i);
        assert.match(validateShelvesetName('-feature')!, /dash/i);
    });

    it('allows dashes mid-name', () => {
        assert.strictEqual(validateShelvesetName('my-feature'), undefined);
        assert.strictEqual(validateShelvesetName('a-b-c-d'), undefined);
    });

    it('rejects shell metacharacters', () => {
        for (const ch of [';', '$', '<', '>', '|', '&']) {
            const name = `bad${ch}name`;
            assert.match(validateShelvesetName(name)!, /invalid/i, `should reject "${name}"`);
        }
    });

    it('rejects even one metachar anywhere in the string', () => {
        assert.ok(validateShelvesetName('myshelveset;')!);
        assert.ok(validateShelvesetName(';myshelveset')!);
        assert.ok(validateShelvesetName('my$(whoami)shelveset')!);
    });

    it('allows non-ASCII word characters (unicode names are fine)', () => {
        assert.strictEqual(validateShelvesetName('änderung'), undefined);
        assert.strictEqual(validateShelvesetName('修正'), undefined);
    });
});
