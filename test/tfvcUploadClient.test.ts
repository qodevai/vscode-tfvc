import * as assert from 'assert';
import * as http from 'http';
import * as crypto from 'crypto';
import { describe, it, before, after } from 'node:test';
import { TfvcUploadClient } from '../src/ado/tfvcUploadClient';

interface Captured {
    method: string;
    path: string;
    contentType: string | undefined;
    authorization: string | undefined;
    body: Buffer;
}

let server: http.Server;
let base: string;
let captured: Captured[] = [];
let responder: () => { status?: number; body: string } = () => ({ body: '<ArrayOfInt><int>7</int></ArrayOfInt>' });

before(async () => {
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            captured.push({
                method: req.method || '',
                path: req.url || '',
                contentType: req.headers['content-type'] as string | undefined,
                authorization: req.headers['authorization'] as string | undefined,
                body: Buffer.concat(chunks),
            });
            const { status = 200, body } = responder();
            res.writeHead(status, { 'Content-Type': 'text/xml' });
            res.end(body);
        });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
});

after(() => { server.close(); });

function parseMultipart(body: Buffer, boundary: string): Map<string, Buffer> {
    const parts = new Map<string, Buffer>();
    const delim = Buffer.from(`--${boundary}`);
    const bodyStr = body.toString('binary');
    let idx = bodyStr.indexOf(`--${boundary}`);
    while (idx !== -1) {
        const nextStart = idx + delim.length;
        // stop on final boundary "--boundary--"
        if (bodyStr.slice(nextStart, nextStart + 2) === '--') { break; }
        const headerEnd = bodyStr.indexOf('\r\n\r\n', nextStart);
        if (headerEnd === -1) { break; }
        const headers = bodyStr.slice(nextStart, headerEnd);
        const nameMatch = /name="([^"]+)"/.exec(headers);
        const name = nameMatch ? nameMatch[1] : '(unknown)';
        const valueStart = headerEnd + 4; // \r\n\r\n
        const nextBoundary = bodyStr.indexOf(`--${boundary}`, valueStart);
        const valueEnd = nextBoundary === -1 ? body.length : nextBoundary - 2; // minus trailing \r\n
        parts.set(name, body.subarray(valueStart, valueEnd));
        idx = nextBoundary;
    }
    return parts;
}

describe('TfvcUploadClient basic request shape', () => {
    it('POSTs to /VersionControl/v1.0/upload.ashx with multipart/form-data', async () => {
        captured = [];
        responder = () => ({ body: '<ArrayOfInt><int>42</int></ArrayOfInt>' });
        const c = new TfvcUploadClient(base, 'pat');
        const result = await c.uploadFile({
            serverPath: '$/Proj/a.ts',
            workspaceName: 'ws',
            workspaceOwner: 'alice',
            content: Buffer.from('hello'),
        });
        assert.strictEqual(captured[0].method, 'POST');
        assert.strictEqual(captured[0].path, '/VersionControl/v1.0/upload.ashx');
        assert.match(captured[0].contentType || '', /multipart\/form-data; boundary=----tfvc-upload-/);
        assert.strictEqual(result.downloadId, 42);
        assert.strictEqual(result.hash, crypto.createHash('md5').update(Buffer.from('hello')).digest('base64'));
    });

    it('sends the full TEE field set (item, wsname, wsowner, filelength, hash, range, content)', async () => {
        captured = [];
        responder = () => ({ body: '<ArrayOfInt><int>1</int></ArrayOfInt>' });
        const c = new TfvcUploadClient(base, 'pat');
        const payload = Buffer.from('payload-bytes');
        await c.uploadFile({
            serverPath: '$/P/x.ts',
            workspaceName: 'ws',
            workspaceOwner: 'alice',
            content: payload,
        });
        const ct = captured[0].contentType || '';
        const bm = /boundary=(.*)$/.exec(ct);
        assert.ok(bm, `expected boundary in ${ct}`);
        const parts = parseMultipart(captured[0].body, bm![1]);

        assert.strictEqual(parts.get('item')?.toString('utf8'), '$/P/x.ts');
        assert.strictEqual(parts.get('wsname')?.toString('utf8'), 'ws');
        assert.strictEqual(parts.get('wsowner')?.toString('utf8'), 'alice');
        assert.strictEqual(parts.get('filelength')?.toString('utf8'), String(payload.length));
        assert.strictEqual(
            parts.get('hash')?.toString('utf8'),
            crypto.createHash('md5').update(payload).digest('base64'),
        );
        assert.strictEqual(
            parts.get('range')?.toString('utf8'),
            `bytes=0-${payload.length - 1}/${payload.length}`,
        );
        // Content part preserves raw bytes exactly.
        assert.ok(parts.get('content')!.equals(payload), 'content part must be byte-equal to input');
    });

    it('sends binary bytes byte-exact (no UTF-8 round-trip corruption)', async () => {
        captured = [];
        responder = () => ({ body: '<ArrayOfInt><int>1</int></ArrayOfInt>' });
        const c = new TfvcUploadClient(base, 'pat');
        // A buffer with bytes that would break if we accidentally stringified as UTF-8.
        const payload = Buffer.from([0x00, 0xFF, 0xFE, 0xCA, 0xFE, 0xBA, 0xBE, 0x80]);
        await c.uploadFile({
            serverPath: '$/P/bin.dat',
            workspaceName: 'ws',
            workspaceOwner: 'alice',
            content: payload,
        });
        const bm = /boundary=(.*)$/.exec(captured[0].contentType || '');
        const parts = parseMultipart(captured[0].body, bm![1]);
        assert.ok(parts.get('content')!.equals(payload));
    });
});

describe('TfvcUploadClient limits and failure modes', () => {
    it('rejects files above the single-chunk cap', async () => {
        const c = new TfvcUploadClient(base, 'pat');
        const big = Buffer.alloc(5 * 1024 * 1024 + 1);
        await assert.rejects(
            () => c.uploadFile({
                serverPath: '$/big.bin',
                workspaceName: 'ws',
                workspaceOwner: 'alice',
                content: big,
            }),
            (err: Error) => /exceeds the .+single-chunk cap/.test(err.message),
        );
    });

    it('throws on server error with status preserved', async () => {
        captured = [];
        responder = () => ({ status: 401, body: 'unauthorized' });
        const c = new TfvcUploadClient(base, 'pat');
        await assert.rejects(
            () => c.uploadFile({
                serverPath: '$/x',
                workspaceName: 'ws',
                workspaceOwner: 'alice',
                content: Buffer.from('x'),
            }),
            (err: Error & { statusCode?: number }) => err.statusCode === 401,
        );
    });

    it('tolerates an empty body (legacy servers): returns downloadId 0', async () => {
        captured = [];
        responder = () => ({ body: '' });
        const c = new TfvcUploadClient(base, 'pat');
        const result = await c.uploadFile({
            serverPath: '$/x',
            workspaceName: 'ws',
            workspaceOwner: 'alice',
            content: Buffer.from('x'),
        });
        assert.strictEqual(result.downloadId, 0);
    });
});
