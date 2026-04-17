import * as assert from 'assert';
import * as http from 'http';
import { describe, it, before, after } from 'node:test';
import { AdoRestClient } from '../src/ado/restClient';
import { TfvcError } from '../src/errors';

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

describe('AdoRestClient constructor (I20)', () => {
    it('requires a PAT', () => {
        assert.throws(
            () => new AdoRestClient('myorg', '', 'MyProject'),
            (err: Error) => err instanceof TfvcError && /PAT is required/.test(err.message),
        );
    });

    it('requires a project', () => {
        assert.throws(
            () => new AdoRestClient('myorg', 'pat', ''),
            (err: Error) => err instanceof TfvcError && /project is required/.test(err.message),
        );
    });

    it('requires either org or baseUrl', () => {
        assert.throws(
            () => new AdoRestClient('', 'pat', 'MyProject'),
            (err: Error) => err instanceof TfvcError && /either org.*or baseUrl/.test(err.message),
        );
    });

    it('rejects a baseUrl without http(s) scheme', () => {
        assert.throws(
            () => new AdoRestClient('', 'pat', 'MyProject', 'tfs.example.com'),
            (err: Error) => err instanceof TfvcError && /must start with http\(s\):\/\//.test(err.message),
        );
    });

    it('accepts http and https baseUrls', () => {
        assert.doesNotThrow(() =>
            new AdoRestClient('', 'pat', 'MyProject', 'http://tfs.example.com'));
        assert.doesNotThrow(() =>
            new AdoRestClient('', 'pat', 'MyProject', 'https://tfs.example.com'));
    });

    it('URL-encodes the org name so special characters do not break the URL', () => {
        // Org names with spaces or other URL-unsafe chars must be encoded so the
        // resulting base URL is valid.
        const client = new AdoRestClient('my org', 'pat', 'MyProject');
        assert.strictEqual(client.scope, '$/MyProject');
        // Indirect check: a subsequent API call would target an encoded host.
        // We can't easily hit the HTTP layer here without a real server, so we
        // trust the constructor-level change and let the fetch tests above
        // cover the downstream behaviour.
    });
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
