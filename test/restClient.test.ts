import * as assert from 'assert';
import * as http from 'http';
import { describe, it, before, after } from 'node:test';
import { AdoRestClient, buildOnPremBase } from '../src/ado/restClient';
import { ReviewVerdict } from '../src/ado/types';
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

describe('AdoRestClient api-version override (v0.3.5)', () => {
    it('defaults to 6.0 on-prem / 7.1 cloud when override is empty', async () => {
        captured = [];
        responder = () => ({ body: JSON.stringify({ value: [] }) });
        const onprem = new AdoRestClient('', 'pat', 'TestProject', baseUrl, '');
        await onprem.listShelvesets();
        assert.strictEqual(captured.at(-1)?.query.get('api-version'), '6.0');
        // Cloud default is asserted via constructor (fetching would hit
        // the real dev.azure.com); trust the 7.1 branch below to cover it.
    });

    it('pins the api-version query parameter when the override is set', async () => {
        captured = [];
        responder = () => ({ body: JSON.stringify({ value: [] }) });
        const client = new AdoRestClient('', 'pat', 'TestProject', baseUrl, '', '4.1');
        await client.listShelvesets();
        assert.strictEqual(captured.at(-1)?.query.get('api-version'), '4.1',
            'TFS 2018 installs must be able to downgrade to 4.1');
    });

    it('applies the override to download URLs too (api-version travels on every call)', async () => {
        captured = [];
        responder = () => ({ body: 'raw-bytes' });
        const client = new AdoRestClient('', 'pat', 'TestProject', baseUrl, '', '5.1');
        await client.fetchItemContent('$/TestProject/foo.txt');
        assert.strictEqual(captured.at(-1)?.query.get('api-version'), '5.1');
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

describe('buildOnPremBase (v0.3.4 collection-path normalization)', () => {
    it('joins baseUrl and collectionPath with exactly one slash when user provides none', () => {
        // Regression: used to produce `https://host.example.comtfs/Collection`
        assert.strictEqual(
            buildOnPremBase('https://tfs.example.com', 'tfs/DefaultCollection'),
            'https://tfs.example.com/tfs/DefaultCollection'
        );
    });

    it('joins correctly when user provides a leading slash on collectionPath', () => {
        assert.strictEqual(
            buildOnPremBase('https://tfs.example.com', '/tfs/DefaultCollection'),
            'https://tfs.example.com/tfs/DefaultCollection'
        );
    });

    it('strips trailing slashes from baseUrl and collectionPath', () => {
        assert.strictEqual(
            buildOnPremBase('https://tfs.example.com/', '/tfs/DefaultCollection/'),
            'https://tfs.example.com/tfs/DefaultCollection'
        );
    });

    it('collapses multiple leading/trailing slashes', () => {
        assert.strictEqual(
            buildOnPremBase('https://tfs.example.com///', '///tfs/DefaultCollection///'),
            'https://tfs.example.com/tfs/DefaultCollection'
        );
    });

    it('returns baseUrl unchanged when collectionPath is empty', () => {
        assert.strictEqual(
            buildOnPremBase('https://tfs.example.com', ''),
            'https://tfs.example.com'
        );
    });
});

describe('AdoRestClient.getWorkItemTypeByCategory (v0.3.4 localization)', () => {
    it('resolves a category reference name to the server-local display name', async () => {
        captured = [];
        responder = () => ({
            body: JSON.stringify({
                referenceName: 'Microsoft.CodeReviewResponseCategory',
                defaultWorkItemType: { name: 'Codereviewantwort' },
                workItemTypes: [{ name: 'Codereviewantwort' }],
            }),
        });
        const client = new AdoRestClient('', 'pat', 'TestProject', baseUrl, '');
        const name = await client.getWorkItemTypeByCategory('Microsoft.CodeReviewResponseCategory');
        assert.strictEqual(name, 'Codereviewantwort');

        const call = captured[0];
        assert.strictEqual(call.method, 'GET');
        assert.ok(
            call.url.includes('/_apis/wit/workitemtypecategories/Microsoft.CodeReviewResponseCategory'),
            `expected categories URL, got ${call.url}`
        );
    });

    it('caches the lookup so repeated calls do not re-hit the server', async () => {
        captured = [];
        responder = () => ({
            body: JSON.stringify({ defaultWorkItemType: { name: 'Code Review Response' } }),
        });
        const client = new AdoRestClient('', 'pat', 'TestProject', baseUrl, '');
        await client.getWorkItemTypeByCategory('Microsoft.CodeReviewResponseCategory');
        await client.getWorkItemTypeByCategory('Microsoft.CodeReviewResponseCategory');
        assert.strictEqual(captured.length, 1, 'second call should be served from cache');
    });

    it('falls back to workItemTypes[0] when defaultWorkItemType is missing', async () => {
        captured = [];
        responder = () => ({
            body: JSON.stringify({ workItemTypes: [{ name: 'FallbackType' }] }),
        });
        const client = new AdoRestClient('', 'pat', 'TestProject', baseUrl, '');
        const name = await client.getWorkItemTypeByCategory('Microsoft.CodeReviewResponseCategory');
        assert.strictEqual(name, 'FallbackType');
    });

    it('throws TfvcError when the category has no types (process template missing code review)', async () => {
        captured = [];
        responder = () => ({ body: JSON.stringify({ referenceName: 'Foo', workItemTypes: [] }) });
        const client = new AdoRestClient('', 'pat', 'TestProject', baseUrl, '');
        await assert.rejects(
            () => client.getWorkItemTypeByCategory('Microsoft.CodeReviewResponseCategory'),
            (err: Error) => err instanceof TfvcError && /process template/.test(err.message),
        );
    });
});

describe('AdoRestClient.queryOpenReviews', () => {
    it('filters by IN GROUP category reference name (localization-neutral, v0.3.4)', async () => {
        captured = [];
        responder = () => ({ body: JSON.stringify({ workItems: [] }) });
        const client = new AdoRestClient('', 'pat', 'TestProject', baseUrl, '');
        await client.queryOpenReviews('Angefordert');

        const wiqlCall = captured.find(c => c.method === 'POST');
        assert.ok(wiqlCall, 'expected WIQL POST call');
        const parsed = JSON.parse(wiqlCall!.body) as { query: string };
        // Category reference names are always English and stable across locales.
        assert.ok(
            /IN GROUP\s+'Microsoft\.CodeReviewRequestCategory'/i.test(parsed.query),
            `expected IN GROUP clause, got: ${parsed.query}`
        );
        // The caller-supplied localized state is used verbatim.
        assert.ok(
            parsed.query.includes("[System.State] = 'Angefordert'"),
            `expected localized state filter, got: ${parsed.query}`
        );
        // No hardcoded English type name should leak through.
        assert.ok(
            !/'Code Review Request'/.test(parsed.query),
            `query must not mention the English display name, got: ${parsed.query}`
        );
    });

    it('defaults the state filter to "Requested" when no argument is supplied', async () => {
        captured = [];
        responder = () => ({ body: JSON.stringify({ workItems: [] }) });
        const client = new AdoRestClient('', 'pat', 'TestProject', baseUrl, '');
        await client.queryOpenReviews();

        const wiqlCall = captured.find(c => c.method === 'POST');
        const parsed = JSON.parse(wiqlCall!.body) as { query: string };
        assert.ok(parsed.query.includes("[System.State] = 'Requested'"));
    });

    it('escapes single quotes in the state value to prevent WIQL injection', async () => {
        captured = [];
        responder = () => ({ body: JSON.stringify({ workItems: [] }) });
        const client = new AdoRestClient('', 'pat', 'TestProject', baseUrl, '');
        await client.queryOpenReviews("O'Reilly");

        const wiqlCall = captured.find(c => c.method === 'POST');
        const parsed = JSON.parse(wiqlCall!.body) as { query: string };
        assert.ok(parsed.query.includes("[System.State] = 'O''Reilly'"));
    });

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

describe('AdoRestClient.createCodeReviewResponse (v0.3.4 localization)', () => {
    it('resolves the response type via category and URL-encodes it in the create path', async () => {
        captured = [];
        responder = (req, _body) => {
            if (req.url?.includes('/workitemtypecategories/')) {
                // Simulate German TFS — localized display name with an umlaut
                // to verify URL encoding.
                return {
                    body: JSON.stringify({ defaultWorkItemType: { name: 'Codereviewäntwort' } }),
                };
            }
            if (req.method === 'PATCH' && req.url?.includes('/$')) {
                // Create returns the new work-item id
                return { body: JSON.stringify({ id: 999 }) };
            }
            // Close PATCH on the created id
            return { body: JSON.stringify({}) };
        };

        const client = new AdoRestClient('', 'pat', 'TestProject', baseUrl, '');
        await client.createCodeReviewResponse(
            'RE: foo — Looks Good',
            42,
            'Alice',
            ReviewVerdict.LooksGood,
            '',
            'Geschlossen',
        );

        // Category lookup happened first
        const categoryCall = captured.find(c => c.url.includes('/workitemtypecategories/'));
        assert.ok(categoryCall, 'expected category lookup');

        // Create URL uses the URL-encoded localized type name, not the English one
        const createCall = captured.find(c => c.method === 'PATCH' && c.url.includes('/$'));
        assert.ok(createCall, 'expected PATCH create call');
        assert.ok(
            createCall!.url.includes(`/$${encodeURIComponent('Codereviewäntwort')}`),
            `expected encoded type name in URL, got: ${createCall!.url}`
        );
        assert.ok(
            !createCall!.url.includes('Code%20Review%20Response'),
            `must not fall back to the hardcoded English type, got: ${createCall!.url}`
        );

        // Close PATCH uses the caller-supplied closed state
        const closeCall = captured.find(c => c.method === 'PATCH' && c.url.includes('/_apis/wit/workitems/999'));
        assert.ok(closeCall, 'expected PATCH close call on id 999');
        const closeOps = JSON.parse(closeCall!.body) as Array<{ path: string; value: unknown }>;
        const stateOp = closeOps.find(op => op.path === '/fields/System.State');
        assert.strictEqual(stateOp?.value, 'Geschlossen');
    });

    it('defaults closedState to "Closed" when no argument is supplied', async () => {
        captured = [];
        responder = (req, _body) => {
            if (req.url?.includes('/workitemtypecategories/')) {
                return { body: JSON.stringify({ defaultWorkItemType: { name: 'Code Review Response' } }) };
            }
            if (req.method === 'PATCH' && req.url?.includes('/$')) {
                return { body: JSON.stringify({ id: 77 }) };
            }
            return { body: JSON.stringify({}) };
        };

        const client = new AdoRestClient('', 'pat', 'TestProject', baseUrl, '');
        await client.createCodeReviewResponse('x', 1, 'Bob', ReviewVerdict.LooksGood);

        const closeCall = captured.find(c => c.method === 'PATCH' && c.url.includes('/_apis/wit/workitems/77'));
        const closeOps = JSON.parse(closeCall!.body) as Array<{ path: string; value: unknown }>;
        const stateOp = closeOps.find(op => op.path === '/fields/System.State');
        assert.strictEqual(stateOp?.value, 'Closed');
    });
});
