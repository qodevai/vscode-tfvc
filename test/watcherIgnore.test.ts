import * as assert from 'assert';
import * as path from 'path';
import { describe, it } from 'node:test';
import { isIgnoredPath } from '../src/workspace/watcherIgnore';

const root = path.sep === '\\' ? 'C:\\workspace' : '/workspace';
const p = (...parts: string[]) => path.join(root, ...parts);

describe('isIgnoredPath', () => {
    it('ignores .vscode-tfvc metadata', () => {
        assert.strictEqual(isIgnoredPath(p('.vscode-tfvc', 'baseline.json'), root), true);
    });

    it('ignores .git metadata (regression: was missed by string startsWith)', () => {
        assert.strictEqual(isIgnoredPath(p('.git', 'HEAD'), root), true);
        assert.strictEqual(isIgnoredPath(p('.git', 'objects', 'abc'), root), true);
    });

    it('ignores common build output directories', () => {
        assert.strictEqual(isIgnoredPath(p('node_modules', 'foo', 'index.js'), root), true);
        assert.strictEqual(isIgnoredPath(p('dist', 'bundle.js'), root), true);
        assert.strictEqual(isIgnoredPath(p('out', 'extension.js'), root), true);
        assert.strictEqual(isIgnoredPath(p('target', 'debug', 'bin'), root), true);
        assert.strictEqual(isIgnoredPath(p('__pycache__', 'mod.pyc'), root), true);
    });

    it('does NOT ignore a file whose name starts with an ignored prefix but is not under that directory (regression: prefix-only match)', () => {
        // Prior logic used `rel.startsWith('.git')` which also matched
        // '.gitignore', '.gitconfig', 'gitlab-ci.yml' in subdirs, etc.
        assert.strictEqual(isIgnoredPath(p('.gitignore'), root), false);
        assert.strictEqual(isIgnoredPath(p('.gitlab-ci.yml'), root), false);
        assert.strictEqual(isIgnoredPath(p('out_of_scope.txt'), root), false);
        assert.strictEqual(isIgnoredPath(p('node_modules_wrapper.ts'), root), false);
    });

    it('does not ignore regular workspace files', () => {
        assert.strictEqual(isIgnoredPath(p('src', 'index.ts'), root), false);
        assert.strictEqual(isIgnoredPath(p('package.json'), root), false);
        assert.strictEqual(isIgnoredPath(p('docs', 'README.md'), root), false);
    });

    it('ignores paths outside the root', () => {
        const outside = path.sep === '\\' ? 'D:\\other\\file.txt' : '/somewhere/else/file.txt';
        assert.strictEqual(isIgnoredPath(outside, root), true);
    });
});
