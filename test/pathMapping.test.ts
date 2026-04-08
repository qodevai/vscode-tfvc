import * as assert from 'assert';
import { describe, it } from 'node:test';
import { serverToLocal, localToServer } from '../src/workspace/pathMapping';

describe('serverToLocal', () => {
    it('converts a server path to local path', () => {
        const result = serverToLocal('$/MyProject/src/app.ts', '$/MyProject', '/home/user/repo');
        assert.strictEqual(result, '/home/user/repo/src/app.ts');
    });

    it('handles scope root path', () => {
        const result = serverToLocal('$/MyProject', '$/MyProject', '/home/user/repo');
        assert.strictEqual(result, '/home/user/repo');
    });

    it('handles nested directories', () => {
        const result = serverToLocal('$/MyProject/a/b/c/file.txt', '$/MyProject', '/home/user/repo');
        assert.strictEqual(result, '/home/user/repo/a/b/c/file.txt');
    });

    it('throws for paths outside scope', () => {
        assert.throws(
            () => serverToLocal('$/OtherProject/file.txt', '$/MyProject', '/home/user/repo'),
            /not under scope/
        );
    });

    it('handles scope with trailing slash', () => {
        const result = serverToLocal('$/MyProject/file.txt', '$/MyProject/', '/home/user/repo');
        assert.strictEqual(result, '/home/user/repo/file.txt');
    });
});

describe('localToServer', () => {
    it('converts a local path to server path', () => {
        const result = localToServer('/home/user/repo/src/app.ts', '$/MyProject', '/home/user/repo');
        assert.strictEqual(result, '$/MyProject/src/app.ts');
    });

    it('handles workspace root path', () => {
        const result = localToServer('/home/user/repo', '$/MyProject', '/home/user/repo');
        assert.strictEqual(result, '$/MyProject');
    });

    it('handles nested directories', () => {
        const result = localToServer('/home/user/repo/a/b/c/file.txt', '$/MyProject', '/home/user/repo');
        assert.strictEqual(result, '$/MyProject/a/b/c/file.txt');
    });

    it('throws for paths outside root', () => {
        assert.throws(
            () => localToServer('/other/path/file.txt', '$/MyProject', '/home/user/repo'),
            /not under root/
        );
    });

    it('round-trips with serverToLocal', () => {
        const serverPath = '$/MyProject/src/deep/file.ts';
        const scope = '$/MyProject';
        const root = '/home/user/repo';

        const localPath = serverToLocal(serverPath, scope, root);
        const roundTripped = localToServer(localPath, scope, root);
        assert.strictEqual(roundTripped, serverPath);
    });
});
