import * as assert from 'assert';
import { describe, it } from 'node:test';
import { normalizeChangeLabel } from '../src/changeType';

describe('normalizeChangeLabel', () => {
    it('returns canonical labels for simple change types', () => {
        assert.strictEqual(normalizeChangeLabel('add'), 'add');
        assert.strictEqual(normalizeChangeLabel('edit'), 'edit');
        assert.strictEqual(normalizeChangeLabel('delete'), 'delete');
        assert.strictEqual(normalizeChangeLabel('rename'), 'rename');
    });

    it('maps branch and undelete to add', () => {
        assert.strictEqual(normalizeChangeLabel('branch'), 'add');
        assert.strictEqual(normalizeChangeLabel('undelete'), 'add');
    });

    it('prefers the most specific token in compound change labels', () => {
        // "edit, encoding" is just an edit
        assert.strictEqual(normalizeChangeLabel('edit, encoding'), 'edit');
        // "rename, edit" should report as rename (the more specific action)
        assert.strictEqual(normalizeChangeLabel('rename, edit'), 'rename');
        // "delete, merge" should report as delete
        assert.strictEqual(normalizeChangeLabel('delete, merge'), 'delete');
    });

    it('preserves unknown tokens instead of collapsing to edit (I15)', () => {
        // ADO could introduce new change types; previously these got mislabeled
        // as 'edit' — now they pass through verbatim.
        assert.strictEqual(normalizeChangeLabel('sourcerename'), 'sourcerename');
        assert.strictEqual(normalizeChangeLabel('lock'), 'lock');
        assert.strictEqual(normalizeChangeLabel('rollback'), 'rollback');
    });

    it('handles whitespace and casing variations', () => {
        assert.strictEqual(normalizeChangeLabel('  EDIT  '), 'edit');
        assert.strictEqual(normalizeChangeLabel('Add, Edit'), 'add');
    });

    it('defaults to edit for empty or blank input', () => {
        assert.strictEqual(normalizeChangeLabel(''), 'edit');
        assert.strictEqual(normalizeChangeLabel(',,,'), 'edit');
    });
});
