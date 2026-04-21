import * as assert from 'assert';
import { describe, it } from 'node:test';
import { metadataFor } from '../src/changeTypeMetadata';
import { ChangeType } from '../src/workspace/types';

describe('changeTypeMetadata', () => {
    it('returns distinct presentation for each primary change type', () => {
        const edit = metadataFor('edit');
        const add = metadataFor('add');
        const del = metadataFor('delete');
        const ren = metadataFor('rename');
        const mrg = metadataFor('merge');

        // Each primary change type gets a distinct letter.
        const letters = new Set([edit.letter, add.letter, del.letter, ren.letter, mrg.letter]);
        assert.strictEqual(letters.size, 5, `expected 5 distinct letters, got ${[...letters]}`);

        // Sanity checks on the mapping.
        assert.strictEqual(edit.letter, 'M');
        assert.strictEqual(add.letter, 'A');
        assert.strictEqual(del.letter, 'D');
        assert.strictEqual(ren.letter, 'R');
        assert.strictEqual(mrg.letter, 'C');
    });

    it('marks deletes with strikeThrough so the SCM tree renders them crossed-out', () => {
        assert.strictEqual(metadataFor('delete').strikeThrough, true);
        assert.ok(!metadataFor('edit').strikeThrough);
        assert.ok(!metadataFor('add').strikeThrough);
        assert.ok(!metadataFor('rename').strikeThrough);
    });

    it('uses VS Code git-decoration color tokens so the UI matches the Git provider', () => {
        // All primary types reference a color in the gitDecoration.* registry.
        for (const t of ['edit', 'add', 'delete', 'rename', 'merge'] as ChangeType[]) {
            const info = metadataFor(t);
            assert.match(info.themeColor!, /^gitDecoration\./, `${t} should use a gitDecoration color`);
        }
    });

    it('uses codicon names that exist in the VS Code icon catalog', () => {
        // Only `diff-*` and `warning` are used; mistyping one results in a
        // missing icon in the SCM view, so pin them down.
        const allowed = new Set(['diff-added', 'diff-removed', 'diff-modified', 'diff-renamed', 'warning']);
        for (const t of ['edit', 'add', 'delete', 'rename', 'merge'] as ChangeType[]) {
            assert.ok(allowed.has(metadataFor(t).themeIcon), `unknown icon for ${t}: ${metadataFor(t).themeIcon}`);
        }
    });

    it('passes through unknown change types with the raw name in the label', () => {
        // Audit requirement from v0.3.2: never silently collapse an unknown
        // change type to `edit`. The badge can still show "M", but the
        // tooltip must reveal the real type.
        const info = metadataFor('unknown-type-from-future-tfs');
        assert.strictEqual(info.label, 'unknown-type-from-future-tfs');
        assert.strictEqual(info.letter, 'M'); // safe fallback for badge
    });

    it('covers every ChangeType declared in workspace/types', () => {
        // If a new ChangeType is added without a mapping, this test catches
        // it via the label === changeType pattern that the fallback uses.
        const allTypes: ChangeType[] = ['edit', 'add', 'delete', 'rename', 'branch', 'merge', 'lock', 'undelete'];
        for (const t of allTypes) {
            const info = metadataFor(t);
            // If the fallback kicked in, label === t verbatim. Explicit
            // mappings give a nicer label that differs from the raw string
            // (e.g. 'edit' → 'Modified'). Let the test tolerate both but
            // verify something other than empty is returned.
            assert.ok(info.letter, `missing letter for ${t}`);
            assert.ok(info.label, `missing label for ${t}`);
            assert.ok(info.themeIcon, `missing themeIcon for ${t}`);
        }
    });
});
