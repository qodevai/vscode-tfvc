import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { ServerWorkspace, computeWorkspaceName } from '../src/workspace/serverWorkspace';
import { TfvcSoapClient, WorkspaceInfo } from '../src/ado/tfvcSoapClient';

/**
 * Stub AdoSoapClient-derived class — we only exercise the three methods
 * ServerWorkspace touches (query, create, delete). Each call records its
 * args so tests can assert what the server saw.
 */
class StubSoap {
    queryCalls: Array<{ name: string; owner: string }> = [];
    createCalls: WorkspaceInfo[] = [];
    deleteCalls: Array<{ name: string; owner: string }> = [];

    queryResponse: WorkspaceInfo | undefined = undefined;
    createResponseOverride: WorkspaceInfo | undefined = undefined;

    async queryWorkspace(name: string, owner: string): Promise<WorkspaceInfo | undefined> {
        this.queryCalls.push({ name, owner });
        return this.queryResponse;
    }

    async createWorkspace(ws: WorkspaceInfo): Promise<WorkspaceInfo> {
        this.createCalls.push(ws);
        // The real server echoes back the canonical name/owner; stub passes
        // through unless a test overrode.
        return this.createResponseOverride ?? ws;
    }

    async deleteWorkspace(name: string, owner: string): Promise<void> {
        this.deleteCalls.push({ name, owner });
    }
}

function makeStub(): TfvcSoapClient {
    // Cast — StubSoap structurally provides everything ServerWorkspace uses.
    return new StubSoap() as unknown as TfvcSoapClient;
}

let tmpdir: string;
let stateDir: string;
let workspaceRoot: string;

beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfvc-srvws-'));
    workspaceRoot = path.join(tmpdir, 'repo');
    stateDir = path.join(workspaceRoot, '.vscode-tfvc');
    fs.mkdirSync(workspaceRoot, { recursive: true });
});

afterEach(() => {
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('computeWorkspaceName', () => {
    it('is deterministic for the same workspace root + machine', () => {
        const a = computeWorkspaceName('/work/proj', 'alice-laptop');
        const b = computeWorkspaceName('/work/proj', 'alice-laptop');
        assert.strictEqual(a, b);
    });

    it('differs across workspace roots on the same machine', () => {
        const a = computeWorkspaceName('/work/proj-a', 'alice-laptop');
        const b = computeWorkspaceName('/work/proj-b', 'alice-laptop');
        assert.notStrictEqual(a, b);
    });

    it('starts with the vscode-tfvc- prefix so humans can identify our workspaces', () => {
        const name = computeWorkspaceName('/work/proj', 'alice');
        assert.ok(name.startsWith('vscode-tfvc-'), name);
    });

    it('sanitises the machine-name component (no spaces, punctuation)', () => {
        const name = computeWorkspaceName('/work/proj', 'Alice\'s MacBook Pro (work)');
        assert.ok(/^vscode-tfvc-[A-Za-z0-9]+-[0-9a-f]{8}$/.test(name), `expected sanitised, got: ${name}`);
    });

    it('caps the machine-name segment so workspace names stay short', () => {
        const name = computeWorkspaceName('/work/proj', 'a'.repeat(200));
        const machineSegment = name.slice('vscode-tfvc-'.length, name.lastIndexOf('-'));
        assert.ok(machineSegment.length <= 24, `expected <=24 chars, got ${machineSegment.length}`);
    });
});

describe('ServerWorkspace.getOrCreate', () => {
    it('creates a new workspace on first call (no persisted state, server reports not-found)', async () => {
        const stub = new StubSoap();
        // queryResponse undefined → not found
        const sw = new ServerWorkspace(workspaceRoot, stateDir);
        const ws = await sw.getOrCreate(stub as unknown as TfvcSoapClient, {
            owner: 'alice@corp', ownerDisplayName: 'Alice',
        });
        assert.strictEqual(stub.queryCalls.length, 1);
        assert.strictEqual(stub.createCalls.length, 1);
        assert.ok(ws.name.startsWith('vscode-tfvc-'), ws.name);
        assert.strictEqual(ws.owner, 'alice@corp');

        // State file must be persisted for next boot.
        const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'server-workspace.json'), 'utf8'));
        assert.strictEqual(saved.name, ws.name);
        assert.strictEqual(saved.owner, 'alice@corp');
    });

    it('reuses the persisted name across process restarts — no duplicate server workspace', async () => {
        const stub = new StubSoap();
        stub.queryResponse = { name: 'vscode-tfvc-existing', owner: 'alice@corp', ownerDisplayName: 'Alice', computer: 'laptop' };

        // Seed state as if a prior session created it.
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(
            path.join(stateDir, 'server-workspace.json'),
            JSON.stringify({
                name: 'vscode-tfvc-existing',
                owner: 'alice@corp',
                ownerDisplayName: 'Alice',
                computer: 'laptop',
                createdDate: '2026-04-01T00:00:00Z',
            }),
        );

        const sw = new ServerWorkspace(workspaceRoot, stateDir);
        const ws = await sw.getOrCreate(stub as unknown as TfvcSoapClient, {
            owner: 'alice@corp', ownerDisplayName: 'Alice',
        });
        // Server confirmed it exists; we must NOT call create again.
        assert.strictEqual(stub.queryCalls[0].name, 'vscode-tfvc-existing');
        assert.strictEqual(stub.createCalls.length, 0);
        assert.strictEqual(ws.name, 'vscode-tfvc-existing');
    });

    it('recreates transparently when a persisted workspace is missing server-side (admin sweep)', async () => {
        const stub = new StubSoap();
        stub.queryResponse = undefined; // server says NotFound

        // Seed stale state.
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(
            path.join(stateDir, 'server-workspace.json'),
            JSON.stringify({
                name: 'vscode-tfvc-stale',
                owner: 'alice@corp',
                ownerDisplayName: 'Alice',
                computer: 'laptop',
                createdDate: '2024-01-01T00:00:00Z',
            }),
        );

        const sw = new ServerWorkspace(workspaceRoot, stateDir);
        const ws = await sw.getOrCreate(stub as unknown as TfvcSoapClient, {
            owner: 'alice@corp', ownerDisplayName: 'Alice',
        });
        assert.strictEqual(stub.queryCalls.length, 1);
        // Create was called with the persisted (stale) name — server decides
        // whether to honour it or return its canonical form.
        assert.strictEqual(stub.createCalls.length, 1);
        assert.strictEqual(stub.createCalls[0].name, 'vscode-tfvc-stale');
        assert.strictEqual(ws.name, 'vscode-tfvc-stale');
    });

    it('persists the server-confirmed name when it differs from what we asked for', async () => {
        const stub = new StubSoap();
        stub.queryResponse = undefined;
        stub.createResponseOverride = {
            name: 'vscode-tfvc-SERVER-NORMALIZED',
            owner: 'alice@corp',
            ownerDisplayName: 'Alice',
            computer: 'laptop',
        };

        const sw = new ServerWorkspace(workspaceRoot, stateDir);
        const ws = await sw.getOrCreate(stub as unknown as TfvcSoapClient, {
            owner: 'alice@corp', ownerDisplayName: 'Alice',
        });
        assert.strictEqual(ws.name, 'vscode-tfvc-SERVER-NORMALIZED');

        const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'server-workspace.json'), 'utf8'));
        assert.strictEqual(saved.name, 'vscode-tfvc-SERVER-NORMALIZED', 'persisted name must match server, not initial guess');
    });

    it('tolerates a corrupt state file (reinitialises)', async () => {
        const stub = new StubSoap();
        stub.queryResponse = undefined;

        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(path.join(stateDir, 'server-workspace.json'), '{ not valid json');

        const sw = new ServerWorkspace(workspaceRoot, stateDir);
        const ws = await sw.getOrCreate(stub as unknown as TfvcSoapClient, {
            owner: 'alice@corp', ownerDisplayName: 'Alice',
        });
        // Fresh computed name, no crash.
        assert.ok(ws.name.startsWith('vscode-tfvc-'));
    });
});

describe('ServerWorkspace.tryDispose', () => {
    it('deletes the server workspace and the local state file', async () => {
        const stub = new StubSoap();
        stub.queryResponse = undefined;
        const sw = new ServerWorkspace(workspaceRoot, stateDir);
        await sw.getOrCreate(stub as unknown as TfvcSoapClient, { owner: 'alice', ownerDisplayName: 'Alice' });

        const stateFile = path.join(stateDir, 'server-workspace.json');
        assert.ok(fs.existsSync(stateFile));

        await sw.tryDispose(stub as unknown as TfvcSoapClient);
        assert.strictEqual(stub.deleteCalls.length, 1);
        assert.ok(!fs.existsSync(stateFile), 'state file should be gone after tryDispose');
    });

    it('swallows server-side delete errors (shutdown path should not throw)', async () => {
        const stub = new StubSoap();
        stub.queryResponse = undefined;
        const sw = new ServerWorkspace(workspaceRoot, stateDir);
        await sw.getOrCreate(stub as unknown as TfvcSoapClient, { owner: 'alice', ownerDisplayName: 'Alice' });

        // Stub a failing delete.
        stub.deleteWorkspace = async () => { throw new Error('network down'); };

        // Must not throw.
        await sw.tryDispose(stub as unknown as TfvcSoapClient);
    });
});
