import * as assert from 'assert';
import { describe, it } from 'node:test';
import { encodeFileContent } from '../src/ado/encoding';

describe('encodeFileContent', () => {
    it('round-trips an ASCII file byte-exact', () => {
        const input = Buffer.from('hello world\n');
        const { content, contentType } = encodeFileContent(input);
        assert.strictEqual(contentType, 'base64Encoded');
        const decoded = Buffer.from(content, 'base64');
        assert.ok(decoded.equals(input));
    });

    it('round-trips a UTF-16 text file byte-exact (regression: null bytes are not binary)', () => {
        // UTF-16 LE BOM + "hi" — contains null bytes that the old heuristic
        // incorrectly classified as binary, then (if sent as UTF-8) mangled.
        const input = Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
        const { content, contentType } = encodeFileContent(input);
        assert.strictEqual(contentType, 'base64Encoded');
        const decoded = Buffer.from(content, 'base64');
        assert.ok(decoded.equals(input));
    });

    it('round-trips binary bytes byte-exact', () => {
        // Random bytes including non-UTF-8 sequences (0xff, 0xfe alone are
        // invalid as UTF-8 continuations; toString('utf8') would replace them
        // with U+FFFD).
        const input = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x7f, 0x01, 0x02]);
        const { content } = encodeFileContent(input);
        const decoded = Buffer.from(content, 'base64');
        assert.ok(decoded.equals(input));
    });

    it('round-trips a latin-1 text file (regression: non-UTF-8 text was mangled)', () => {
        // Latin-1 "café" — 0xe9 is not a valid UTF-8 start byte on its own.
        const input = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
        const { content } = encodeFileContent(input);
        const decoded = Buffer.from(content, 'base64');
        assert.ok(decoded.equals(input));
    });

    it('handles empty file', () => {
        const input = Buffer.alloc(0);
        const { content, contentType } = encodeFileContent(input);
        assert.strictEqual(content, '');
        assert.strictEqual(contentType, 'base64Encoded');
    });
});
