import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { describe, it, before, after } from 'node:test';
import { computeFileHash } from '../src/workspace/hashing';

describe('computeFileHash', () => {
    let tmpDir: string;

    before(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfvc-test-'));
    });

    after(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns base64-encoded MD5 for a text file', async () => {
        const content = 'Hello, world!\n';
        const filePath = path.join(tmpDir, 'hello.txt');
        fs.writeFileSync(filePath, content);

        const hash = await computeFileHash(filePath);

        // Compute expected hash
        const expected = crypto.createHash('md5').update(content).digest('base64');
        assert.strictEqual(hash, expected);
    });

    it('returns different hashes for different content', async () => {
        const file1 = path.join(tmpDir, 'file1.txt');
        const file2 = path.join(tmpDir, 'file2.txt');
        fs.writeFileSync(file1, 'content A');
        fs.writeFileSync(file2, 'content B');

        const hash1 = await computeFileHash(file1);
        const hash2 = await computeFileHash(file2);

        assert.notStrictEqual(hash1, hash2);
    });

    it('returns the same hash for identical content', async () => {
        const file1 = path.join(tmpDir, 'same1.txt');
        const file2 = path.join(tmpDir, 'same2.txt');
        fs.writeFileSync(file1, 'identical content');
        fs.writeFileSync(file2, 'identical content');

        const hash1 = await computeFileHash(file1);
        const hash2 = await computeFileHash(file2);

        assert.strictEqual(hash1, hash2);
    });

    it('handles empty files', async () => {
        const filePath = path.join(tmpDir, 'empty.txt');
        fs.writeFileSync(filePath, '');

        const hash = await computeFileHash(filePath);
        const expected = crypto.createHash('md5').update('').digest('base64');
        assert.strictEqual(hash, expected);
    });

    it('handles binary content', async () => {
        const filePath = path.join(tmpDir, 'binary.bin');
        const buf = Buffer.from([0x00, 0xFF, 0x80, 0x7F, 0x01]);
        fs.writeFileSync(filePath, buf);

        const hash = await computeFileHash(filePath);
        const expected = crypto.createHash('md5').update(buf).digest('base64');
        assert.strictEqual(hash, expected);
    });
});
