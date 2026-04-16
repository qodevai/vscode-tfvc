import * as assert from 'assert';
import * as http from 'http';
import { describe, it, before, after } from 'node:test';
import { AdoRestClient } from '../src/ado/restClient';

interface CapturedRequest {
    method: string;
    url: string;
    query: URLSearchParams;
    body: string;
}

let server: http.Server;
let baseUrl: string;
let captured: CapturedRequest[] = [];
let responder: (req: http.IncomingMessage, body: string) => { status?: number; body: string } =
    () => ({ body: 'server file contents' });

before(async () => {
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            const parsed = new URL(req.url || '', 'http://localhost');
            captured.push({
                method: req.method || 'GET',
                url: req.url || '',
                query: parsed.searchParams,
                body,
            });
            const { status = 200, body: respBody } = responder(req, body);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(respBody);
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
    server.close();
});

describe('AdoRestClient.fetchItemContent', () => {
    it('omits version params when no version is provided (HEAD)', async () => {
        captured = [];
        responder = () => ({ body: 'server file contents' });
        const client = new AdoRestClient('', 'pat', 'TestProject', baseUrl, '');
        await client.fetchItemContent('$/TestProject/file.ts');

        assert.strictEqual(captured.length, 1);
        assert.strictEqual(captured[0].query.get('path'), '$/TestProject/file.ts');
        assert.strictEqual(captured[0].query.has('versionType'), false);
        assert.strictEqual(captured[0].query.has('version'), false);
    });

    it('pins to changeset version when provided (C10 regression)', async () => {
        captured = [];
        responder = () => ({ body: 'server file contents' });
        const client = new AdoRestClient('', 'pat', 'TestProject', baseUrl, '');
        await client.fetchItemContent('$/TestProject/file.ts', 42);

        assert.strictEqual(captured.length, 1);
        assert.strictEqual(captured[0].query.get('versionType'), 'Changeset');
        assert.strictEqual(captured[0].query.get('version'), '42');
    });
});

describe('AdoRestClient.queryOpenReviews', () => {
    it('paginates the workitems fetch in batches of 200 (I6 regression)', async () => {
        captured = [];
        // 450 matching IDs — should split across 3 GET /_apis/wit/workitems calls.
        const ids = Array.from({ length: 450 }, (_, i) => i + 1);
        responder = (req) => {
            if (req.method === 'POST') {
                // WIQL query
                return {
                    body: JSON.stringify({ workItems: ids.map(id => ({ id, url: '' })) }),
                };
            }
            // GET /_apis/wit/workitems
            const parsed = new URL(req.url || '', 'http://localhost');
            const batchIds = (parsed.searchParams.get('ids') || '').split(',').filter(Boolean);
            return {
                body: JSON.stringify({
                    value: batchIds.map(id => ({ id: Number(id), fields: { 'System.Title': `Review ${id}` } })),
                }),
            };
        };

        const client = new AdoRestClient('', 'pat', 'TestProject', baseUrl, '');
        const reviews = await client.queryOpenReviews();

        assert.strictEqual(reviews.length, 450, 'all reviews returned, not truncated');

        const workitemsCalls = captured.filter(c =>
            c.method === 'GET' && c.url.includes('/_apis/wit/workitems')
        );
        assert.strictEqual(workitemsCalls.length, 3, 'three batches expected');

        // Each batch must respect the 200-id cap.
        for (const call of workitemsCalls) {
            const batchSize = (call.query.get('ids') || '').split(',').length;
            assert.ok(batchSize <= 200, `batch of ${batchSize} exceeds 200`);
        }
    });
});
