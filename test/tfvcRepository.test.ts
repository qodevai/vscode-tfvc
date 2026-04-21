import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { TfvcRepository, ChangeEmitter } from '../src/tfvcRepository';
import { PendingChange, BaselineItem, SyncResult } from '../src/workspace/types';
import { WorkspaceState } from '../src/workspace/workspaceState';
import { AdoRestClient } from '../src/ado/restClient';
import { TfvcSoapClient, PendChangeRequest, WorkspaceInfo, ShelveFailure } from '../src/ado/tfvcSoapClient';
import { TfvcUploadClient, UploadRequest, UploadResult } from '../src/ado/tfvcUploadClient';
import { ServerWorkspace } from '../src/workspace/serverWorkspace';
import { TfvcError } from '../src/errors';
import { ChangesetResponse, ChangesetInfo, ShelvesetInfo, ShelvesetChange, CreateChangesetRequest } from '../src/ado/types';

// ── Test doubles ──────────────────────────────────────────────────────────
//
// Each stub records the calls it received and exposes a minimal surface so
// tests can steer behaviour per-case. Cast through `unknown` at the call
// site — structural typing keeps each stub honest.

class TestEmitter implements ChangeEmitter {
    listeners: Array<(e: void) => void> = [];
    fireCount = 0;
    readonly event = (listener: (e: void) => void) => {
        this.listeners.push(listener);
        return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
    fire(): void {
        this.fireCount += 1;
        this.listeners.forEach(l => l());
    }
    dispose(): void { this.listeners = []; }
}

interface StubStateConfig {
    scope?: string;
    root?: string;
    pendingChanges?: PendingChange[];
    baseline?: Map<string, BaselineItem>;
    syncResult?: SyncResult[];
    throwOnGetPending?: Error;
}

class StubWorkspaceState {
    pendingChanges: PendingChange[];
    baseline: Map<string, BaselineItem>;
    scope: string;
    root: string;
    syncResult: SyncResult[];
    throwOnGetPending: Error | undefined;

    getPendingCalls = 0;
    clearPendingCalls: string[][] = [];
    clearAllCalls = 0;
    markCheckoutCalls: string[][] = [];
    markAddCalls: string[][] = [];
    markDeleteCalls: string[][] = [];
    syncCalls: Array<{ paths: string[] | undefined }> = [];
    undoChangesCalls: Array<string[]> = [];
    updateBaselineAfterCheckinCalls: Array<{ changes: PendingChange[]; version: number }> = [];

    constructor(cfg: StubStateConfig = {}) {
        this.pendingChanges = cfg.pendingChanges ?? [];
        this.baseline = cfg.baseline ?? new Map();
        this.scope = cfg.scope ?? '$/Proj';
        this.root = cfg.root ?? '/work/proj';
        this.syncResult = cfg.syncResult ?? [];
        this.throwOnGetPending = cfg.throwOnGetPending;
    }

    async getPendingChanges(): Promise<PendingChange[]> {
        this.getPendingCalls += 1;
        if (this.throwOnGetPending) { throw this.throwOnGetPending; }
        return this.pendingChanges;
    }
    getBaselineItemByServer(serverPath: string): BaselineItem | undefined {
        return this.baseline.get(serverPath);
    }
    getScope(): string { return this.scope; }
    getRoot(): string { return this.root; }
    clearPending(files: string[]): void { this.clearPendingCalls.push(files); }
    clearAll(): void { this.clearAllCalls += 1; }
    markCheckout(files: string[]): void { this.markCheckoutCalls.push(files); }
    markAdd(files: string[]): void { this.markAddCalls.push(files); }
    markDelete(files: string[]): void { this.markDeleteCalls.push(files); }
    async syncBaseline(_client: unknown, paths?: string[]): Promise<SyncResult[]> {
        this.syncCalls.push({ paths });
        return this.syncResult;
    }
    async undoChanges(_client: unknown, files: string[]): Promise<void> {
        this.undoChangesCalls.push(files);
    }
    async updateBaselineAfterCheckin(changes: PendingChange[], version: number): Promise<void> {
        this.updateBaselineAfterCheckinCalls.push({ changes, version });
    }
}

interface StubRestConfig {
    identity?: { id: string; displayName: string; uniqueName: string };
    changesetId?: number;
    shelvesets?: ShelvesetInfo[];
    shelveChanges?: ShelvesetChange[];
    shelvedContent?: string | ((serverPath: string) => string);
    history?: ChangesetInfo[];
}

class StubRestClient {
    identity = { id: 'guid-1', displayName: 'Alice', uniqueName: 'alice@corp.com' };
    changesetId = 4242;
    shelvesets: ShelvesetInfo[] = [];
    shelveChanges: ShelvesetChange[] = [];
    shelvedContent: string | ((serverPath: string) => string) = '';
    history: ChangesetInfo[] = [];

    createChangesetCalls: CreateChangesetRequest[] = [];
    listShelvesetsCalls: Array<string | undefined> = [];
    listShelvesetChangesCalls: Array<{ name: string; owner: string }> = [];
    fetchShelvedContentCalls: Array<{ path: string; name: string; owner: string }> = [];
    getChangesetsCalls: Array<{ itemPath?: string; top?: number; skip?: number }> = [];
    fetchItemContentCalls: Array<{ path: string; version?: number }> = [];

    constructor(cfg: StubRestConfig = {}) {
        if (cfg.identity) { this.identity = cfg.identity; }
        if (cfg.changesetId !== undefined) { this.changesetId = cfg.changesetId; }
        if (cfg.shelvesets) { this.shelvesets = cfg.shelvesets; }
        if (cfg.shelveChanges) { this.shelveChanges = cfg.shelveChanges; }
        if (cfg.shelvedContent !== undefined) { this.shelvedContent = cfg.shelvedContent; }
        if (cfg.history) { this.history = cfg.history; }
    }

    async getBotIdentity() { return this.identity; }
    async createChangeset(req: CreateChangesetRequest): Promise<ChangesetResponse> {
        this.createChangesetCalls.push(req);
        return { changesetId: this.changesetId, url: '' };
    }
    async listShelvesets(owner?: string): Promise<ShelvesetInfo[]> {
        this.listShelvesetsCalls.push(owner);
        return this.shelvesets;
    }
    async listShelvesetChanges(name: string, owner: string): Promise<ShelvesetChange[]> {
        this.listShelvesetChangesCalls.push({ name, owner });
        return this.shelveChanges;
    }
    async fetchShelvedContent(serverPath: string, name: string, owner: string): Promise<string> {
        this.fetchShelvedContentCalls.push({ path: serverPath, name, owner });
        return typeof this.shelvedContent === 'function' ? this.shelvedContent(serverPath) : this.shelvedContent;
    }
    async getChangesets(opts: { itemPath?: string; top?: number; skip?: number }): Promise<ChangesetInfo[]> {
        this.getChangesetsCalls.push(opts);
        return this.history;
    }
    async fetchItemContent(serverPath: string, version?: number): Promise<string> {
        this.fetchItemContentCalls.push({ path: serverPath, version });
        return '';
    }
}

class StubTfvcSoapClient {
    pendChangesCalls: Array<{ wsName: string; wsOwner: string; requests: PendChangeRequest[] }> = [];
    undoPendingChangesCalls: Array<{ wsName: string; wsOwner: string; items: string[] }> = [];
    shelveCalls: Array<{ wsName: string; wsOwner: string; items: string[]; shelveset: unknown; replace: boolean }> = [];
    deleteShelvesetCalls: Array<{ name: string; owner: string }> = [];

    shelveFailures: ShelveFailure[] = [];
    throwOnShelve: Error | undefined;
    throwOnUndoPending: Error | undefined;

    async pendChanges(wsName: string, wsOwner: string, requests: PendChangeRequest[]): Promise<void> {
        this.pendChangesCalls.push({ wsName, wsOwner, requests });
    }
    async undoPendingChanges(wsName: string, wsOwner: string, items: string[]): Promise<void> {
        this.undoPendingChangesCalls.push({ wsName, wsOwner, items });
        if (this.throwOnUndoPending) { throw this.throwOnUndoPending; }
    }
    async shelve(
        wsName: string, wsOwner: string, items: string[],
        shelveset: unknown, replace: boolean,
    ): Promise<ShelveFailure[]> {
        this.shelveCalls.push({ wsName, wsOwner, items, shelveset, replace });
        if (this.throwOnShelve) { throw this.throwOnShelve; }
        return this.shelveFailures;
    }
    async deleteShelveset(name: string, owner: string): Promise<void> {
        this.deleteShelvesetCalls.push({ name, owner });
    }
}

class StubUploadClient {
    calls: UploadRequest[] = [];
    nextDownloadId = 100;
    async uploadFile(req: UploadRequest): Promise<UploadResult> {
        this.calls.push(req);
        return { downloadId: this.nextDownloadId++, hash: 'stub-hash' };
    }
}

class StubServerWorkspace {
    getOrCreateCalls = 0;
    workspace: WorkspaceInfo = {
        name: 'vscode-tfvc-stub',
        owner: 'alice@corp.com',
        ownerDisplayName: 'Alice',
        computer: 'laptop',
    };
    async getOrCreate(_soap: unknown, _identity: unknown): Promise<WorkspaceInfo> {
        this.getOrCreateCalls += 1;
        return this.workspace;
    }
    async tryDispose(_soap: unknown): Promise<void> { /* no-op */ }
}

// ── Fixture helpers ───────────────────────────────────────────────────────

interface Fixture {
    state: StubWorkspaceState;
    rest: StubRestClient;
    soap: StubTfvcSoapClient;
    upload: StubUploadClient;
    serverWs: StubServerWorkspace;
    emitter: TestEmitter;
    repo: TfvcRepository;
    tmpRoot: string;
}

function makeRepo(
    stateCfg: StubStateConfig = {},
    restCfg: StubRestConfig = {},
    tmpRoot?: string,
): Fixture {
    const root = tmpRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tfvc-repo-'));
    const state = new StubWorkspaceState({ root, ...stateCfg });
    const rest = new StubRestClient(restCfg);
    const soap = new StubTfvcSoapClient();
    const upload = new StubUploadClient();
    const serverWs = new StubServerWorkspace();
    const emitter = new TestEmitter();
    const repo = new TfvcRepository(
        state as unknown as WorkspaceState,
        rest as unknown as AdoRestClient,
        soap as unknown as TfvcSoapClient,
        upload as unknown as TfvcUploadClient,
        serverWs as unknown as ServerWorkspace,
        emitter,
    );
    return { state, rest, soap, upload, serverWs, emitter, repo, tmpRoot: root };
}

const cleanupRoots: string[] = [];
afterEach(() => {
    for (const r of cleanupRoots.splice(0)) {
        try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

function trackRoot(root: string): string {
    cleanupRoots.push(root);
    return root;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('TfvcRepository.refresh', () => {
    it('populates pendingChanges from state and fires onDidChange', async () => {
        const changes: PendingChange[] = [
            { localPath: '/work/proj/a.ts', serverPath: '$/Proj/a.ts', changeType: 'edit' },
        ];
        const f = makeRepo({ pendingChanges: changes });
        trackRoot(f.tmpRoot);
        await f.repo.refresh();
        assert.deepStrictEqual(f.repo.pendingChanges, changes);
        assert.strictEqual(f.emitter.fireCount, 1);
    });

    it('preserves the prior pending list when getPendingChanges throws', async () => {
        const first: PendingChange[] = [
            { localPath: '/work/proj/a.ts', serverPath: '$/Proj/a.ts', changeType: 'edit' },
        ];
        const f = makeRepo({ pendingChanges: first });
        trackRoot(f.tmpRoot);
        await f.repo.refresh();
        assert.strictEqual(f.repo.pendingChanges.length, 1);

        f.state.throwOnGetPending = new Error('disk glitch');
        const priorFireCount = f.emitter.fireCount;
        await f.repo.refresh();

        assert.deepStrictEqual(f.repo.pendingChanges, first, 'prior list must survive transient errors');
        assert.strictEqual(f.emitter.fireCount, priorFireCount, 'should not fire change event on transient error');
    });

    it('drops excluded paths that are no longer pending', async () => {
        const keep: PendingChange = { localPath: '/work/proj/a.ts', serverPath: '$/Proj/a.ts', changeType: 'edit' };
        const gone: PendingChange = { localPath: '/work/proj/b.ts', serverPath: '$/Proj/b.ts', changeType: 'edit' };
        const f = makeRepo({ pendingChanges: [keep, gone] });
        trackRoot(f.tmpRoot);
        await f.repo.refresh();
        f.repo.exclude(keep.localPath);
        f.repo.exclude(gone.localPath);
        assert.strictEqual(f.repo.excludedChanges.length, 2);

        // b.ts no longer pending
        f.state.pendingChanges = [keep];
        await f.repo.refresh();

        assert.strictEqual(f.repo.excludedChanges.length, 1);
        assert.strictEqual(f.repo.excludedChanges[0].localPath, keep.localPath);
    });

    it('is a no-op while another refresh is in flight (no re-entry)', async () => {
        const f = makeRepo();
        trackRoot(f.tmpRoot);
        // First refresh in flight
        const first = f.repo.refresh();
        // Second refresh while first unresolved
        await f.repo.refresh();
        await first;
        // getPendingChanges runs at most once per call to refresh; the second
        // call bails out at the isRefreshing guard before hitting state.
        assert.strictEqual(f.state.getPendingCalls, 1);
    });
});

describe('TfvcRepository.include/exclude', () => {
    it('toggles exclusion and fires onDidChange each time', () => {
        const f = makeRepo();
        trackRoot(f.tmpRoot);
        const p = '/work/proj/a.ts';
        f.repo.exclude(p);
        assert.ok(f.repo.isExcluded(p));
        f.repo.include(p);
        assert.ok(!f.repo.isExcluded(p));
        assert.strictEqual(f.emitter.fireCount, 2);
    });

    it('isExcluded is case-insensitive (Windows/macOS path semantics)', () => {
        const f = makeRepo();
        trackRoot(f.tmpRoot);
        f.repo.exclude('/work/proj/Foo.ts');
        assert.ok(f.repo.isExcluded('/work/proj/foo.ts'));
    });
});

describe('TfvcRepository.checkin', () => {
    beforeEach(() => { /* per-test tmpRoot via trackRoot */ });

    function setupCheckinFile(tmpRoot: string, rel: string, content = 'hello'): string {
        const full = path.join(tmpRoot, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
        return full;
    }

    it('builds a changeset with baseline version for edits and base64-encoded content', async () => {
        const tmpRoot = trackRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'tfvc-repo-')));
        const local = setupCheckinFile(tmpRoot, 'a.ts', 'edit-content');
        const baseline = new Map<string, BaselineItem>([
            ['$/Proj/a.ts', {
                serverPath: '$/Proj/a.ts', localPath: local, version: 7,
                hash: '', mtime: 0, isFolder: false,
            }],
        ]);
        const f = makeRepo({
            root: tmpRoot,
            baseline,
            pendingChanges: [{ localPath: local, serverPath: '$/Proj/a.ts', changeType: 'edit' }],
        }, { changesetId: 99 }, tmpRoot);

        const result = await f.repo.checkin([local], 'msg', [101, 102]);

        assert.strictEqual(result.changeset, 99);
        assert.strictEqual(f.rest.createChangesetCalls.length, 1);
        const req = f.rest.createChangesetCalls[0];
        assert.strictEqual(req.comment, 'msg');
        assert.deepStrictEqual(req.workItems, [{ id: 101 }, { id: 102 }]);
        assert.strictEqual(req.changes.length, 1);
        assert.strictEqual(req.changes[0].changeType, 'edit');
        assert.strictEqual(req.changes[0].item.version, 7);
        assert.ok(req.changes[0].newContent, 'content must be attached for edits');

        assert.strictEqual(f.state.updateBaselineAfterCheckinCalls.length, 1);
        assert.strictEqual(f.state.updateBaselineAfterCheckinCalls[0].version, 99);
        assert.deepStrictEqual(f.state.clearPendingCalls, [[local]]);
    });

    it('throws when none of the requested files are pending', async () => {
        const f = makeRepo({ pendingChanges: [] });
        trackRoot(f.tmpRoot);
        await assert.rejects(
            () => f.repo.checkin(['/not-pending.ts'], 'msg'),
            (err: Error) => err instanceof TfvcError && /No changes to check in/.test(err.message),
        );
    });

    it('omits newContent for deletes but keeps baseline version', async () => {
        const tmpRoot = trackRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'tfvc-repo-')));
        const local = path.join(tmpRoot, 'gone.ts'); // file doesn't exist — deleted
        const baseline = new Map<string, BaselineItem>([
            ['$/Proj/gone.ts', {
                serverPath: '$/Proj/gone.ts', localPath: local, version: 3,
                hash: '', mtime: 0, isFolder: false,
            }],
        ]);
        const f = makeRepo({
            root: tmpRoot,
            baseline,
            pendingChanges: [{ localPath: local, serverPath: '$/Proj/gone.ts', changeType: 'delete' }],
        }, {}, tmpRoot);
        await f.repo.checkin([local], 'bye');
        const change = f.rest.createChangesetCalls[0].changes[0];
        assert.strictEqual(change.changeType, 'delete');
        assert.strictEqual(change.item.version, 3);
        assert.strictEqual(change.newContent, undefined);
    });
});

describe('TfvcRepository.shelve', () => {
    function fixture(): Fixture & { localA: string; localB: string } {
        const tmpRoot = trackRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'tfvc-repo-')));
        const localA = path.join(tmpRoot, 'a.ts');
        const localB = path.join(tmpRoot, 'b.ts');
        fs.mkdirSync(tmpRoot, { recursive: true });
        fs.writeFileSync(localA, 'aaa');
        fs.writeFileSync(localB, 'bbb');
        const f = makeRepo({
            root: tmpRoot,
            pendingChanges: [
                { localPath: localA, serverPath: '$/Proj/a.ts', changeType: 'edit' },
                { localPath: localB, serverPath: '$/Proj/b.ts', changeType: 'add' },
            ],
        }, {}, tmpRoot);
        return { ...f, localA, localB };
    }

    it('runs the full server flow: workspace → pendChanges → upload → shelve → undoPending', async () => {
        const f = fixture();
        const result = await f.repo.shelve('my-shelf', 'wip');
        assert.deepStrictEqual(result, { location: 'server' });
        assert.strictEqual(f.serverWs.getOrCreateCalls, 1);
        assert.strictEqual(f.soap.pendChangesCalls.length, 1);
        assert.strictEqual(f.upload.calls.length, 2, 'uploads one per add/edit');
        assert.strictEqual(f.soap.shelveCalls.length, 1);
        assert.strictEqual(f.soap.shelveCalls[0].replace, true);
        assert.strictEqual(f.soap.undoPendingChangesCalls.length, 1);
    });

    it('sends correct pendChanges shape: Add / Edit / Delete with right downloadId', async () => {
        const tmpRoot = trackRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'tfvc-repo-')));
        const localEdit = path.join(tmpRoot, 'e.ts');
        const localAdd = path.join(tmpRoot, 'n.ts');
        const localDel = path.join(tmpRoot, 'd.ts'); // need not exist
        fs.writeFileSync(localEdit, 'e');
        fs.writeFileSync(localAdd, 'n');
        const f = makeRepo({
            root: tmpRoot,
            pendingChanges: [
                { localPath: localEdit, serverPath: '$/P/e.ts', changeType: 'edit' },
                { localPath: localAdd, serverPath: '$/P/n.ts', changeType: 'add' },
                { localPath: localDel, serverPath: '$/P/d.ts', changeType: 'delete' },
            ],
        }, {}, tmpRoot);

        await f.repo.shelve('s');

        const requests = f.soap.pendChangesCalls[0].requests;
        const byPath = new Map(requests.map(r => [r.serverPath, r]));
        assert.strictEqual(byPath.get('$/P/e.ts')!.changeType, 'Edit');
        assert.strictEqual(byPath.get('$/P/n.ts')!.changeType, 'Add');
        assert.strictEqual(byPath.get('$/P/d.ts')!.changeType, 'Delete');
        assert.strictEqual(byPath.get('$/P/d.ts')!.downloadId, 0, 'deletes carry did=0');
        // Exactly two uploads — edit + add, not delete.
        const uploaded = f.upload.calls.map(c => c.serverPath).sort();
        assert.deepStrictEqual(uploaded, ['$/P/e.ts', '$/P/n.ts']);
    });

    it('throws when there are no pending changes', async () => {
        const f = makeRepo({ pendingChanges: [] });
        trackRoot(f.tmpRoot);
        await assert.rejects(
            () => f.repo.shelve('s'),
            (err: Error) => err instanceof TfvcError && /No changes to shelve/.test(err.message),
        );
        assert.strictEqual(f.serverWs.getOrCreateCalls, 0, 'must not touch server when nothing to shelve');
    });

    it('surfaces per-item shelve failures as a TfvcError', async () => {
        const f = fixture();
        f.soap.shelveFailures = [{ code: 'ItemLocked', severity: 'Error', item: '$/Proj/a.ts', message: 'locked by bob' }];
        await assert.rejects(
            () => f.repo.shelve('s'),
            (err: Error) => err instanceof TfvcError && /ItemLocked/.test(err.message) && /locked by bob/.test(err.message),
        );
    });

    it('still calls undoPendingChanges when shelve throws (keeps queue clean)', async () => {
        const f = fixture();
        f.soap.throwOnShelve = new Error('server boom');
        await assert.rejects(() => f.repo.shelve('s'));
        assert.strictEqual(f.soap.undoPendingChangesCalls.length, 1);
    });

    it('uses the server-echoed workspace.owner (not raw identity) for uploads and shelve', async () => {
        const f = fixture();
        f.serverWs.workspace = {
            name: 'vscode-tfvc-echo', owner: 'canonical@corp.com', ownerDisplayName: 'Canonical', computer: 'c',
        };
        await f.repo.shelve('s');
        for (const u of f.upload.calls) {
            assert.strictEqual(u.workspaceOwner, 'canonical@corp.com');
            assert.strictEqual(u.workspaceName, 'vscode-tfvc-echo');
        }
        assert.strictEqual(f.soap.shelveCalls[0].wsOwner, 'canonical@corp.com');
    });
});

describe('TfvcRepository.unshelve', () => {
    it('applies edits by writing shelved content and marking checkout', async () => {
        const tmpRoot = trackRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'tfvc-repo-')));
        const f = makeRepo({
            scope: '$/Proj',
            root: tmpRoot,
        }, {
            shelveChanges: [{ path: '$/Proj/src/a.ts', changeType: 'edit', downloadUrl: '' }],
            shelvedContent: 'shelved-bytes',
        }, tmpRoot);

        const result = await f.repo.unshelve('my-shelf');

        assert.deepStrictEqual(result, { location: 'server' });
        const expectedLocal = path.join(tmpRoot, 'src', 'a.ts');
        assert.strictEqual(fs.readFileSync(expectedLocal, 'utf8'), 'shelved-bytes');
        assert.deepStrictEqual(f.state.markCheckoutCalls, [[expectedLocal]]);
        assert.strictEqual(f.state.markAddCalls.length, 0);
        assert.strictEqual(f.state.markDeleteCalls.length, 0);
    });

    it('marks delete for shelved deletes without fetching content', async () => {
        const tmpRoot = trackRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'tfvc-repo-')));
        const f = makeRepo({
            scope: '$/Proj', root: tmpRoot,
        }, {
            shelveChanges: [{ path: '$/Proj/gone.ts', changeType: 'delete', downloadUrl: '' }],
        }, tmpRoot);

        await f.repo.unshelve('s');

        assert.strictEqual(f.rest.fetchShelvedContentCalls.length, 0, 'no content fetch for deletes');
        assert.deepStrictEqual(f.state.markDeleteCalls, [[path.join(tmpRoot, 'gone.ts')]]);
    });

    it('marks add for shelved new files', async () => {
        const tmpRoot = trackRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'tfvc-repo-')));
        const f = makeRepo({
            scope: '$/Proj', root: tmpRoot,
        }, {
            shelveChanges: [{ path: '$/Proj/new.ts', changeType: 'add', downloadUrl: '' }],
            shelvedContent: 'new-content',
        }, tmpRoot);

        await f.repo.unshelve('s');
        assert.deepStrictEqual(f.state.markAddCalls, [[path.join(tmpRoot, 'new.ts')]]);
    });

    it('propagates REST errors instead of silently falling back', async () => {
        const tmpRoot = trackRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'tfvc-repo-')));
        const f = makeRepo({ scope: '$/Proj', root: tmpRoot }, {}, tmpRoot);
        // Simulate a server failure by patching the stub method after construction.
        (f.rest as unknown as { listShelvesetChanges: () => Promise<never> }).listShelvesetChanges =
            async () => { throw new TfvcError('Azure DevOps authentication failed', 401); };
        await assert.rejects(
            () => f.repo.unshelve('s'),
            (err: Error) => err instanceof TfvcError && err.message.includes('authentication failed'),
        );
    });
});

describe('TfvcRepository thin delegations', () => {
    it('listShelvesets maps REST response into picker shape', async () => {
        const f = makeRepo({}, {
            shelvesets: [{ name: 'x', owner: 'Alice', ownerUniqueName: 'a@c', createdDate: '2026-01-01', comment: 'c' }],
        });
        trackRoot(f.tmpRoot);
        const res = await f.repo.listShelvesets('alice');
        assert.deepStrictEqual(f.rest.listShelvesetsCalls, ['alice']);
        assert.deepStrictEqual(res, [{ name: 'x', owner: 'Alice', date: '2026-01-01', comment: 'c' }]);
    });

    it('listShelvesets propagates REST errors (no silent fallback)', async () => {
        const f = makeRepo();
        trackRoot(f.tmpRoot);
        (f.rest as unknown as { listShelvesets: () => Promise<never> }).listShelvesets =
            async () => { throw new TfvcError('server went away', 500); };
        await assert.rejects(() => f.repo.listShelvesets());
    });

    it('deleteShelve calls soap.deleteShelveset with uniqueName when available', async () => {
        const f = makeRepo();
        trackRoot(f.tmpRoot);
        await f.repo.deleteShelve('foo');
        assert.deepStrictEqual(f.soap.deleteShelvesetCalls, [{ name: 'foo', owner: 'alice@corp.com' }]);
    });

    it('deleteShelve falls back to displayName when uniqueName is missing', async () => {
        const f = makeRepo({}, { identity: { id: 'g', displayName: 'Alice', uniqueName: '' } });
        trackRoot(f.tmpRoot);
        await f.repo.deleteShelve('foo');
        assert.strictEqual(f.soap.deleteShelvesetCalls[0].owner, 'Alice');
    });

    it('history translates local path to server path and maps response', async () => {
        const tmpRoot = trackRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'tfvc-repo-')));
        const f = makeRepo({ scope: '$/Proj', root: tmpRoot }, {
            history: [{ changesetId: 5, author: 'A', createdDate: '2026', comment: 'c' }],
        }, tmpRoot);
        const res = await f.repo.history(path.join(tmpRoot, 'a.ts'), 10);
        assert.strictEqual(f.rest.getChangesetsCalls[0].top, 10);
        assert.ok(f.rest.getChangesetsCalls[0].itemPath!.includes('a.ts'));
        assert.deepStrictEqual(res, [{ changeset: 5, user: 'A', date: '2026', comment: 'c' }]);
    });
});

describe('TfvcRepository state mutations', () => {
    it('checkout chmods existing files and marks state', async () => {
        const tmpRoot = trackRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'tfvc-repo-')));
        const local = path.join(tmpRoot, 'ro.ts');
        fs.writeFileSync(local, 'x');
        fs.chmodSync(local, 0o444);
        const f = makeRepo({ root: tmpRoot }, {}, tmpRoot);
        await f.repo.checkout([local]);
        const mode = fs.statSync(local).mode & 0o777;
        assert.ok((mode & 0o200) !== 0, 'owner write bit must be set after checkout');
        assert.deepStrictEqual(f.state.markCheckoutCalls, [[local]]);
    });

    it('undoAll delegates paths to state, clears excluded set, and resets pending', async () => {
        const f = makeRepo({
            pendingChanges: [
                { localPath: '/x/a.ts', serverPath: '$/a.ts', changeType: 'edit' },
                { localPath: '/x/b.ts', serverPath: '$/b.ts', changeType: 'add' },
            ],
        });
        trackRoot(f.tmpRoot);
        f.repo.exclude('/x/a.ts');
        await f.repo.undoAll();
        assert.strictEqual(f.state.undoChangesCalls.length, 1);
        assert.deepStrictEqual(f.state.undoChangesCalls[0].sort(), ['/x/a.ts', '/x/b.ts'].sort());
        assert.strictEqual(f.state.clearAllCalls, 1);
        assert.strictEqual(f.repo.excludedChanges.length, 0, 'excluded set cleared');
    });

    it('add, delete, undo, checkout are no-ops for empty file lists', async () => {
        const f = makeRepo();
        trackRoot(f.tmpRoot);
        await f.repo.add([]);
        await f.repo.delete([]);
        await f.repo.undo([]);
        await f.repo.checkout([]);
        assert.strictEqual(f.state.markAddCalls.length, 0);
        assert.strictEqual(f.state.markDeleteCalls.length, 0);
        assert.strictEqual(f.state.markCheckoutCalls.length, 0);
        assert.strictEqual(f.state.undoChangesCalls.length, 0);
    });
});
