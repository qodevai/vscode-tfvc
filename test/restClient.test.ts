import * as assert from 'assert';
import * as http from 'http';
import { describe, it, before, after } from 'node:test';
import { AdoRestClient } from '../src/ado/restClient';

interface CapturedRequest {
    method: string;
    url: string;
    query: URLSearchParams;
}

describe('AdoRestClient.fetchItemContent', () => {
    let server: http.Server;
    let baseUrl: string;
    let captured: CapturedRequest[] = [];

    before(async () => {
        server = http.createServer((req, res) => {
            const parsed = new URL(req.url || '', 'http://localhost');
            captured.push({
                method: req.method || 'GET',
                url: req.url || '',
                query: parsed.searchParams,
            });
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('server file contents');
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    after(() => {
        server.close();
    });

    it('omits version params when no version is provided (HEAD)', async () => {
        captured = [];
        const client = new AdoRestClient('', 'pat', 'TestProject', baseUrl, '');
        await client.fetchItemContent('$/TestProject/file.ts');

        assert.strictEqual(captured.length, 1);
        assert.strictEqual(captured[0].query.get('path'), '$/TestProject/file.ts');
        assert.strictEqual(captured[0].query.has('versionType'), false);
        assert.strictEqual(captured[0].query.has('version'), false);
    });

    it('pins to changeset version when provided (C10 regression)', async () => {
        captured = [];
        const client = new AdoRestClient('', 'pat', 'TestProject', baseUrl, '');
        await client.fetchItemContent('$/TestProject/file.ts', 42);

        assert.strictEqual(captured.length, 1);
        assert.strictEqual(captured[0].query.get('versionType'), 'Changeset');
        assert.strictEqual(captured[0].query.get('version'), '42');
    });
});
