import * as assert from 'assert';
import * as http from 'http';
import { describe, it, before, after } from 'node:test';
import { TfvcSoapClient } from '../src/ado/tfvcSoapClient';
import { TfvcError } from '../src/errors';

interface Captured {
    method: string;
    path: string;
    soapAction: string | undefined;
    contentType: string | undefined;
    body: string;
}

let server: http.Server;
let base: string;
let captured: Captured[] = [];
let responder: () => { status?: number; body: string } = () => ({ body: '<Envelope/>' });

before(async () => {
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            captured.push({
                method: req.method || '',
                path: req.url || '',
                soapAction: req.headers['soapaction'] as string | undefined,
                contentType: req.headers['content-type'] as string | undefined,
                body: Buffer.concat(chunks).toString('utf8'),
            });
            const { status = 200, body } = responder();
            res.writeHead(status, { 'Content-Type': 'text/xml; charset=utf-8' });
            res.end(body);
        });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
});

after(() => { server.close(); });

describe('TfvcSoapClient endpoint + envelope framing', () => {
    it('POSTs to /VersionControl/v1.0/Repository.asmx with SOAP 1.1 headers', async () => {
        captured = [];
        responder = () => ({ body: '<soap:Envelope><soap:Body><DeleteShelvesetResponse/></soap:Body></soap:Envelope>' });
        const c = new TfvcSoapClient(base, 'pat');
        await c.deleteShelveset('foo', 'alice');
        assert.strictEqual(captured[0].method, 'POST');
        assert.strictEqual(captured[0].path, '/VersionControl/v1.0/Repository.asmx');
        assert.match(captured[0].contentType || '', /text\/xml/);
        // SOAPAction carries the full namespaced action.
        assert.match(
            captured[0].soapAction || '',
            /"http:\/\/schemas\.microsoft\.com\/TeamFoundation\/2005\/06\/VersionControl\/ClientServices\/03\/DeleteShelveset"/,
        );
    });

    it('wraps the operation body in a soap:Envelope with the TFVC namespace', async () => {
        captured = [];
        responder = () => ({ body: '<Envelope><Body><CreateWorkspaceResponse><Workspace name="x" owner="y" ownerdisp="Y" computer="z"/></CreateWorkspaceResponse></Body></Envelope>' });
        const c = new TfvcSoapClient(base, 'pat');
        await c.createWorkspace({ name: 'ws', owner: 'u', ownerDisplayName: 'U', computer: 'machine' });
        const envelope = captured[0].body;
        assert.match(envelope, /<soap:Envelope[^>]+xmlns:soap="http:\/\/schemas\.xmlsoap\.org\/soap\/envelope\/"/);
        assert.match(envelope, /xmlns:t="http:\/\/schemas\.microsoft\.com\/TeamFoundation\/2005\/06\/VersionControl\/ClientServices\/03"/);
        assert.match(envelope, /<t:CreateWorkspace>/);
        assert.match(envelope, /<\/t:CreateWorkspace>/);
    });
});

describe('TfvcSoapClient.createWorkspace', () => {
    it('round-trips the workspace and parses the server-confirmed values', async () => {
        captured = [];
        responder = () => ({
            body: '<soap:Envelope><soap:Body><CreateWorkspaceResponse><Workspace name="vscode-tfvc-1" owner="alice@corp" ownerdisp="Alice" computer="laptop-1"/></CreateWorkspaceResponse></soap:Body></soap:Envelope>',
        });
        const c = new TfvcSoapClient(base, 'pat');
        const ws = await c.createWorkspace({
            name: 'vscode-tfvc-1',
            owner: 'alice@corp',
            ownerDisplayName: 'Alice',
            computer: 'laptop-1',
            comment: 'test',
        });
        // Request shape
        assert.match(captured[0].body, /<t:Workspace[^>]+name="vscode-tfvc-1"/);
        assert.match(captured[0].body, /comment="test"/);
        assert.match(captured[0].body, /islocal="false"/);
        // Parsed response
        assert.strictEqual(ws.name, 'vscode-tfvc-1');
        assert.strictEqual(ws.owner, 'alice@corp');
        assert.strictEqual(ws.ownerDisplayName, 'Alice');
        assert.strictEqual(ws.computer, 'laptop-1');
    });

    it('escapes XML-special chars in names and computer', async () => {
        captured = [];
        responder = () => ({ body: '<Envelope><Body><CreateWorkspaceResponse><Workspace name="a" owner="b" ownerdisp="b" computer="c"/></CreateWorkspaceResponse></Body></Envelope>' });
        const c = new TfvcSoapClient(base, 'pat');
        await c.createWorkspace({
            name: 'a <b> "c" & d',
            owner: 'alice',
            ownerDisplayName: 'alice',
            computer: 'machine',
        });
        const envelope = captured[0].body;
        assert.match(envelope, /name="a &lt;b&gt; &quot;c&quot; &amp; d"/);
        assert.ok(!envelope.includes('name="a <b>'), 'raw unescaped chars must not appear');
    });
});

describe('TfvcSoapClient.queryWorkspace', () => {
    it('returns undefined when the server reports WorkspaceNotFound', async () => {
        captured = [];
        responder = () => ({
            status: 500,
            body: '<soap:Envelope><soap:Body><soap:Fault><faultstring>WorkspaceNotFound: vscode-tfvc-old</faultstring></soap:Fault></soap:Body></soap:Envelope>',
        });
        const c = new TfvcSoapClient(base, 'pat');
        const result = await c.queryWorkspace('vscode-tfvc-old', 'alice');
        assert.strictEqual(result, undefined);
    });

    it('rethrows non-404 server errors unchanged', async () => {
        captured = [];
        responder = () => ({ status: 500, body: '<soap:Fault><faultstring>internal boom</faultstring></soap:Fault>' });
        const c = new TfvcSoapClient(base, 'pat');
        await assert.rejects(
            () => c.queryWorkspace('ws', 'alice'),
            (err: Error & { statusCode?: number; detail?: string }) =>
                err instanceof TfvcError && err.statusCode === 500 && /internal boom/i.test(err.detail || ''),
        );
    });
});

describe('TfvcSoapClient.pendChanges', () => {
    it('emits one ChangeRequest per change with download-id, type, and path', async () => {
        captured = [];
        responder = () => ({ body: '<Envelope><Body><PendChangesResponse/></Body></Envelope>' });
        const c = new TfvcSoapClient(base, 'pat');
        await c.pendChanges('ws', 'alice', [
            { serverPath: '$/Proj/a.ts', changeType: 'Add', itemType: 'File', downloadId: 42 },
            { serverPath: '$/Proj/b.ts', changeType: 'Delete', itemType: 'File', downloadId: 0 },
        ]);
        const body = captured[0].body;
        assert.match(body, /<t:workspaceName>ws<\/t:workspaceName>/);
        assert.match(body, /<t:ownerName>alice<\/t:ownerName>/);
        // First change: Add with did=42
        assert.match(body, /<t:ChangeRequest[^>]*req="Add"[^>]*did="42"[^>]*>[^<]*<t:item item="\$\/Proj\/a\.ts"/);
        // Second change: Delete with did=0
        assert.match(body, /<t:ChangeRequest[^>]*req="Delete"[^>]*did="0"[^>]*>[^<]*<t:item item="\$\/Proj\/b\.ts"/);
    });
});

describe('TfvcSoapClient.shelve', () => {
    it('sends shelveset metadata + server items + replace flag', async () => {
        captured = [];
        responder = () => ({ body: '<Envelope><Body><ShelveResponse/></Body></Envelope>' });
        const c = new TfvcSoapClient(base, 'pat');
        const failures = await c.shelve(
            'ws', 'alice',
            ['$/Proj/a.ts', '$/Proj/b.ts'],
            { name: 'my-shelve', owner: 'alice', ownerDisplayName: 'Alice', comment: 'wip' },
            true,
        );
        assert.deepStrictEqual(failures, []);
        const body = captured[0].body;
        assert.match(body, /<t:string>\$\/Proj\/a\.ts<\/t:string>/);
        assert.match(body, /<t:string>\$\/Proj\/b\.ts<\/t:string>/);
        assert.match(body, /<t:shelveset[^>]+name="my-shelve"/);
        assert.match(body, /ownerdisp="Alice"/);
        assert.match(body, /<t:Comment>wip<\/t:Comment>/);
        assert.match(body, /<t:replace>true<\/t:replace>/);
    });

    it('surfaces per-item failures from the server response', async () => {
        captured = [];
        responder = () => ({
            body: '<Envelope><Body><ShelveResponse><ShelveResult>' +
                '<Failure code="ItemLocked" sev="Error" item="$/Proj/a.ts">' +
                '<message>Locked by bob</message>' +
                '</Failure>' +
                '</ShelveResult></ShelveResponse></Body></Envelope>',
        });
        const c = new TfvcSoapClient(base, 'pat');
        const failures = await c.shelve('ws', 'alice', ['$/Proj/a.ts'],
            { name: 's', owner: 'a', ownerDisplayName: 'A' }, false);
        assert.strictEqual(failures.length, 1);
        assert.strictEqual(failures[0].code, 'ItemLocked');
        assert.strictEqual(failures[0].severity, 'Error');
        assert.strictEqual(failures[0].item, '$/Proj/a.ts');
        assert.strictEqual(failures[0].message, 'Locked by bob');
    });
});

describe('TfvcSoapClient.deleteShelveset + undoPendingChanges', () => {
    it('deleteShelveset sends name + owner', async () => {
        captured = [];
        responder = () => ({ body: '<Envelope><Body><DeleteShelvesetResponse/></Body></Envelope>' });
        const c = new TfvcSoapClient(base, 'pat');
        await c.deleteShelveset("O'Reilly's shelve", 'alice');
        // Note the apostrophe gets escaped as &apos;.
        assert.match(captured[0].body, /<t:shelvesetName>O&apos;Reilly&apos;s shelve<\/t:shelvesetName>/);
        assert.match(captured[0].body, /<t:ownerName>alice<\/t:ownerName>/);
    });

    it('undoPendingChanges wraps each path in an ItemSpec with recurse=None', async () => {
        captured = [];
        responder = () => ({ body: '<Envelope><Body><UndoPendingChangesResponse/></Body></Envelope>' });
        const c = new TfvcSoapClient(base, 'pat');
        await c.undoPendingChanges('ws', 'alice', ['$/a', '$/b']);
        const body = captured[0].body;
        assert.match(body, /<t:ItemSpec item="\$\/a" recurse="None"/);
        assert.match(body, /<t:ItemSpec item="\$\/b" recurse="None"/);
    });
});
