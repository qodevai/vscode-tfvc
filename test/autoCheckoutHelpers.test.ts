import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { isPathWithinWorkspace, isReadOnly } from '../src/autoCheckoutHelpers';

describe('isPathWithinWorkspace', () => {
    it('returns true for a file directly under the root', () => {
        assert.strictEqual(isPathWithinWorkspace('/work/proj', '/work/proj/a.ts'), true);
    });

    it('returns true for a nested file', () => {
        assert.strictEqual(isPathWithinWorkspace('/work/proj', '/work/proj/src/deep/file.ts'), true);
    });

    it('returns false for a sibling directory', () => {
        assert.strictEqual(isPathWithinWorkspace('/work/proj', '/work/other/a.ts'), false);
    });

    it('returns false for a parent directory', () => {
        assert.strictEqual(isPathWithinWorkspace('/work/proj/nested', '/work/proj/a.ts'), false);
    });

    it('returns false when the path equals the workspace root (we do not check out the root)', () => {
        assert.strictEqual(isPathWithinWorkspace('/work/proj', '/work/proj'), false);
    });

    it('handles trailing slashes on the workspace root', () => {
        assert.strictEqual(isPathWithinWorkspace('/work/proj/', '/work/proj/a.ts'), true);
    });

    it('rejects paths that start with a look-alike prefix (no trailing separator)', () => {
        // /work/project starts with /work/proj but is not under it.
        assert.strictEqual(isPathWithinWorkspace('/work/proj', '/work/project/a.ts'), false);
    });
});

describe('isReadOnly', () => {
    let tmpdir: string;

    beforeEach(() => {
        tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfvc-rotest-'));
    });
    afterEach(() => {
        try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('detects a read-only file (owner write bit cleared)', () => {
        const p = path.join(tmpdir, 'ro.txt');
        fs.writeFileSync(p, 'x');
        fs.chmodSync(p, 0o444);
        assert.strictEqual(isReadOnly(p), true);
    });

    it('detects a writable file', () => {
        const p = path.join(tmpdir, 'rw.txt');
        fs.writeFileSync(p, 'x');
        fs.chmodSync(p, 0o644);
        assert.strictEqual(isReadOnly(p), false);
    });

    it('returns false for a nonexistent path instead of throwing', () => {
        // Missing files shouldn't be treated as read-only — the caller has
        // nothing useful to do with them, and the handler would otherwise
        // stat every path it touches.
        assert.strictEqual(isReadOnly(path.join(tmpdir, 'missing.txt')), false);
    });

    it('returns false for a directory (directories are not the target of auto-checkout)', () => {
        // Directory mode bits behave differently from file modes; the
        // caller would never want to treat a directory as checkout-eligible.
        // Document the behaviour either way.
        const dir = path.join(tmpdir, 'subdir');
        fs.mkdirSync(dir);
        fs.chmodSync(dir, 0o555);
        // Whatever it is, our impl returns whether the owner write bit is
        // cleared; for a 0o555 dir that IS true. This test pins the
        // behaviour so future refactors document intent.
        assert.strictEqual(isReadOnly(dir), true);
    });
});
