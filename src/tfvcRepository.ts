import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceState } from './workspace/workspaceState';
import { PendingChange, CheckinResult, SyncResult, HistoryEntry, ChangeType } from './workspace/types';
import { localToServer, serverToLocal, pathKey, samePath } from './workspace/pathMapping';
import { AdoRestClient } from './ado/restClient';
import { TfvcSoapClient, PendChangeRequest } from './ado/tfvcSoapClient';
import { TfvcUploadClient } from './ado/tfvcUploadClient';
import { ServerWorkspace } from './workspace/serverWorkspace';
import { encodeFileContent } from './ado/encoding';
import { ShelvesetInfo } from './ado/types';
import { TfvcError } from './errors';
import { logError } from './outputChannel';

export { PendingChange, ChangeType } from './workspace/types';

/**
 * Minimal subset of `vscode.EventEmitter<T>` that this class needs — kept
 * as a local interface so TfvcRepository doesn't take a runtime dependency
 * on the `vscode` module. `vscode.EventEmitter` satisfies it structurally,
 * so `extension.ts` can keep passing `new vscode.EventEmitter<void>()`.
 * Tests inject a trivial stand-in.
 */
export interface ChangeEmitter {
    readonly event: (listener: (e: void) => void) => { dispose(): void };
    fire(data: void): void;
    dispose(): void;
}

export class TfvcRepository {
    readonly onDidChange: ChangeEmitter['event'];

    private _pendingChanges: PendingChange[] = [];
    private _excludedPaths = new Set<string>();

    private refreshTimer: ReturnType<typeof setInterval> | undefined;
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private isRefreshing = false;

    constructor(
        private state: WorkspaceState,
        private restClient: AdoRestClient,
        private soapClient: TfvcSoapClient,
        private uploadClient: TfvcUploadClient,
        private serverWorkspace: ServerWorkspace,
        private _onDidChange: ChangeEmitter,
    ) {
        this.onDidChange = _onDidChange.event;
    }

    get pendingChanges(): PendingChange[] {
        return this._pendingChanges;
    }

    get includedChanges(): PendingChange[] {
        return this._pendingChanges.filter(c => !this._excludedPaths.has(pathKey(c.localPath)));
    }

    get excludedChanges(): PendingChange[] {
        return this._pendingChanges.filter(c => this._excludedPaths.has(pathKey(c.localPath)));
    }

    get conflicts(): PendingChange[] {
        return this._pendingChanges.filter(c => c.changeType === 'merge');
    }

    isExcluded(localPath: string): boolean {
        return this._excludedPaths.has(pathKey(localPath));
    }

    include(localPath: string): void {
        this._excludedPaths.delete(pathKey(localPath));
        this._onDidChange.fire();
    }

    exclude(localPath: string): void {
        this._excludedPaths.add(pathKey(localPath));
        this._onDidChange.fire();
    }

    /** Debounced refresh — coalesces rapid triggers into one actual refresh. */
    debouncedRefresh(delayMs = 1000): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => this.refresh(), delayMs);
    }

    async refresh(): Promise<void> {
        if (this.isRefreshing) { return; }
        this.isRefreshing = true;

        try {
            this._pendingChanges = await this.state.getPendingChanges();
            // Remove excluded paths that are no longer in pending changes
            const currentPaths = new Set(this._pendingChanges.map(c => pathKey(c.localPath)));
            for (const excluded of this._excludedPaths) {
                if (!currentPaths.has(excluded)) {
                    this._excludedPaths.delete(excluded);
                }
            }
            this._onDidChange.fire();
        } catch (err) {
            // Transient failure reading local state (file I/O, hashing). Keep
            // the last-known pending list so the SCM tree doesn't suddenly
            // blank out during an edit — the user's actual changes haven't
            // disappeared, we just couldn't re-compute the diff this tick.
            // The next successful refresh recovers.
            logError(`Refresh failed (keeping last-known pending changes): ${err}`);
        } finally {
            this.isRefreshing = false;
        }
    }

    startAutoRefresh(intervalSeconds: number): void {
        this.stopAutoRefresh();
        if (intervalSeconds <= 0) { return; }
        this.refreshTimer = setInterval(
            () => this.refresh(),
            intervalSeconds * 1000
        );
    }

    stopAutoRefresh(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    // --- Delegated commands ---

    async checkin(files: string[], comment: string, workItems?: number[]): Promise<CheckinResult> {
        const changes = await this.state.getPendingChanges();
        const fileSet = new Set(files);
        const toCheckin = changes.filter(c => fileSet.has(c.localPath));

        if (toCheckin.length === 0) {
            throw new TfvcError('No changes to check in.');
        }

        // Build changeset payload
        const apiChanges = await Promise.all(toCheckin.map(async c => {
            const payload: any = {
                changeType: c.changeType,
                item: {
                    path: c.serverPath,
                },
            };

            // For edits and adds, include the base line version and file content
            if (c.changeType === 'edit') {
                const baseline = this.state.getBaselineItemByServer(c.serverPath);
                if (baseline) {
                    payload.item.version = baseline.version;
                }
            }

            if (c.changeType !== 'delete') {
                payload.newContent = encodeFileContent(fs.readFileSync(c.localPath));
            } else {
                const baseline = this.state.getBaselineItemByServer(c.serverPath);
                if (baseline) {
                    payload.item.version = baseline.version;
                }
            }

            return payload;
        }));

        const result = await this.restClient.createChangeset({
            comment,
            changes: apiChanges,
            workItems: workItems?.map(id => ({ id })),
        });

        // Update baseline with new version
        await this.state.updateBaselineAfterCheckin(toCheckin, result.changesetId);
        this.state.clearPending(files);

        await this.refresh();
        return { changeset: result.changesetId };
    }

    async checkout(files: string[]): Promise<void> {
        if (files.length === 0) { return; }

        for (const file of files) {
            try {
                fs.chmodSync(file, 0o644);
            } catch (err) {
                throw new TfvcError(`Failed to make ${file} writable: ${err}`);
            }
        }

        this.state.markCheckout(files);
        await this.refresh();
    }

    async getLatest(paths?: string[]): Promise<SyncResult[]> {
        const results = await this.state.syncBaseline(this.restClient, paths);
        await this.refresh();
        return results;
    }

    async undo(files: string[]): Promise<void> {
        if (files.length === 0) { return; }
        await this.state.undoChanges(this.restClient, files);
        await this.refresh();
    }

    async undoAll(): Promise<void> {
        const changes = await this.state.getPendingChanges();
        const allPaths = changes.map(c => c.localPath);
        if (allPaths.length > 0) {
            await this.state.undoChanges(this.restClient, allPaths);
        }
        this._excludedPaths.clear();
        this.state.clearAll();
        await this.refresh();
    }

    async add(files: string[]): Promise<void> {
        if (files.length === 0) { return; }
        this.state.markAdd(files);
        await this.refresh();
    }

    async delete(files: string[]): Promise<void> {
        if (files.length === 0) { return; }

        for (const file of files) {
            try {
                if (fs.existsSync(file)) {
                    fs.chmodSync(file, 0o644);
                    fs.unlinkSync(file);
                }
            } catch (err) {
                logError(`Failed to delete ${file}: ${err}`);
            }
        }

        this.state.markDelete(files);
        await this.refresh();
    }

    /**
     * Shelve pending changes. Returns where the shelveset was persisted so the
     * caller can tell the user: server-side shelvesets are visible to
     * teammates and across machines; the local fallback is not.
     */
    async shelve(name: string, comment?: string): Promise<{ location: 'server' }> {
        const changes = await this.state.getPendingChanges();
        if (changes.length === 0) {
            throw new TfvcError('No changes to shelve.');
        }

        // SOAP shelve requires a server-registered workspace with pending
        // changes already registered there. The flow is:
        //   1. Get/create the workspace (lazy, persisted across sessions).
        //   2. Upload content for every add/edit.
        //   3. PendChanges to stage the set server-side.
        //   4. Shelve the pended set into the named shelveset.
        //   5. UndoPendingChanges so the queue is clean for next time.
        //
        // On failure anywhere, we throw. Previous versions silently fell back
        // to a machine-local `.vscode-tfvc/shelves/` copy, but that produced
        // invisible "shelvesets" reviewers couldn't find. Loud errors let the
        // user retry or check permissions.
        const identity = await this.restClient.getBotIdentity();
        const workspace = await this.serverWorkspace.getOrCreate(this.soapClient, {
            // Cloud ADO's /_apis/connectionData doesn't populate uniqueName,
            // but the authenticatedUser.id (GUID) is always present and the
            // server resolves it to a canonical identity before echoing it
            // back in the CreateWorkspace response. Subsequent calls use
            // `workspace.owner` — the server's canonical form.
            owner: identity.uniqueName || identity.id,
            ownerDisplayName: identity.displayName,
            ownerUniqueName: identity.uniqueName || identity.id,
        });

        const pendRequests: PendChangeRequest[] = [];
        const serverItems: string[] = [];
        const uploadQueue: Array<{ serverPath: string; content: Buffer }> = [];
        for (const c of changes) {
            serverItems.push(c.serverPath);
            if (c.changeType === 'delete') {
                pendRequests.push({
                    serverPath: c.serverPath,
                    changeType: 'Delete',
                    itemType: 'File',
                    downloadId: 0,
                });
                continue;
            }
            // Add or edit — both upload content under the same multipart
            // shape. PendChanges runs BEFORE the upload (the server expects
            // the item to already be in the pending queue; otherwise
            // upload.ashx returns "item is not checked out").
            pendRequests.push({
                serverPath: c.serverPath,
                changeType: c.changeType === 'add' ? 'Add' : 'Edit',
                itemType: 'File',
                downloadId: 0,
            });
            const content = fs.existsSync(c.localPath) ? fs.readFileSync(c.localPath) : Buffer.alloc(0);
            uploadQueue.push({ serverPath: c.serverPath, content });
        }

        await this.soapClient.pendChanges(workspace.name, workspace.owner, pendRequests);

        for (const u of uploadQueue) {
            await this.uploadClient.uploadFile({
                serverPath: u.serverPath,
                workspaceName: workspace.name,
                workspaceOwner: workspace.owner,
                content: u.content,
            });
        }
        try {
            const failures = await this.soapClient.shelve(
                workspace.name,
                workspace.owner,
                serverItems,
                {
                    name,
                    owner: workspace.owner,
                    ownerDisplayName: identity.displayName,
                    comment,
                },
                /* replace */ true,
            );
            if (failures.length > 0) {
                const first = failures[0];
                throw new TfvcError(
                    `Shelve reported ${failures.length} failure(s). First: ${first.code}` +
                    (first.item ? ` on ${first.item}` : '') +
                    (first.message ? ` — ${first.message}` : ''),
                );
            }
        } finally {
            // Clear the workspace's pending queue regardless of shelve
            // outcome; otherwise the next shelve inherits leftovers.
            try {
                await this.soapClient.undoPendingChanges(workspace.name, workspace.owner, serverItems);
            } catch (undoErr) {
                logError(`UndoPendingChanges after shelve failed (non-fatal): ${undoErr}`);
            }
        }
        return { location: 'server' };
    }

    /**
     * Unshelve by name. Downloads the shelved changes from the server and
     * applies them locally. Throws on failure so the user sees the real
     * error (auth, missing shelveset, connectivity) instead of a misleading
     * "success" that silently applied a machine-local `.vscode-tfvc/shelves/`
     * copy of something with the same name — different data, invisible to
     * teammates.
     */
    async unshelve(name: string): Promise<{ location: 'server' }> {
        const identity = await this.restClient.getBotIdentity();
        const shelveChanges = await this.restClient.listShelvesetChanges(name, identity.displayName);

        for (const change of shelveChanges) {
            const localPath = change.path.startsWith(this.state.getScope())
                ? serverToLocal(change.path, this.state.getScope(), this.state.getRoot())
                : change.path;

            const changeLabel = change.changeType.toLowerCase().split(/[,\s]+/)[0];

            if (changeLabel === 'delete') {
                this.state.markDelete([localPath]);
            } else {
                const content = await this.restClient.fetchShelvedContent(
                    change.path, name, identity.displayName
                );
                fs.mkdirSync(path.dirname(localPath), { recursive: true });
                try { fs.chmodSync(localPath, 0o644); } catch { /* may not exist */ }
                fs.writeFileSync(localPath, content);

                if (changeLabel === 'add') {
                    this.state.markAdd([localPath]);
                } else {
                    this.state.markCheckout([localPath]);
                }
            }
        }
        await this.refresh();
        return { location: 'server' };
    }

    async listShelvesets(owner?: string): Promise<Array<{ name: string; owner: string; date: string; comment: string }>> {
        // REST errors (401, 403, 500, network) propagate to the caller so the
        // user sees a real diagnostic toast. Previous versions swallowed
        // everything and silently returned local `.vscode-tfvc/shelves/`
        // entries, which look identical to server shelvesets in the picker
        // but hold unrelated data — auth failures looked like "you have no
        // shelvesets."
        const shelvesets = await this.restClient.listShelvesets(owner);
        return shelvesets.map(s => ({
            name: s.name,
            owner: s.owner,
            date: s.createdDate,
            comment: s.comment,
        }));
    }

    async deleteShelve(name: string): Promise<{ location: 'server' }> {
        // SOAP deleteShelveset is the correct endpoint — see issue #10.
        // No fallback: if the server rejects, let the user know so they can
        // retry or check permissions.
        const identity = await this.restClient.getBotIdentity();
        // Shelveset owner is stored server-side as the display name
        // (matches what listShelvesets returns); uniqueName is empty on
        // cloud ADO so fall back to displayName there.
        await this.soapClient.deleteShelveset(name, identity.uniqueName || identity.displayName);
        return { location: 'server' };
    }

    async history(filePath: string, count = 25): Promise<HistoryEntry[]> {
        const serverPath = localToServer(filePath, this.state.getScope(), this.state.getRoot());
        const changesets = await this.restClient.getChangesets({
            itemPath: serverPath,
            top: count,
        });

        return changesets.map(cs => ({
            changeset: cs.changesetId,
            user: cs.author,
            date: cs.createdDate,
            comment: cs.comment,
        }));
    }

    /**
     * Fetch file content from the server. When `version` is omitted, returns
     * HEAD. For diffs against the user's synced state, prefer the baseline
     * version (see `getBaselineServerContent`) so local edits diff against
     * what the user actually has, not a newer server revision.
     */
    async getServerContent(serverPath: string, version?: number): Promise<string> {
        return this.restClient.fetchItemContent(serverPath, version);
    }

    /**
     * Fetch the version of a file that matches the user's current baseline —
     * i.e. the server revision the user last synced. This is what quick-diff
     * should compare against so in-flight edits aren't mixed with server-side
     * changes the user hasn't pulled yet.
     */
    async getBaselineServerContent(serverPath: string): Promise<string> {
        const baseline = this.state.getBaselineItemByServer(serverPath);
        return this.restClient.fetchItemContent(serverPath, baseline?.version);
    }

    /** Initialize the workspace (first-time setup). */
    async initializeWorkspace(onProgress?: (message: string) => void): Promise<void> {
        await this.state.initialize(this.restClient, onProgress);
        await this.refresh();
    }

    dispose(): void {
        this.stopAutoRefresh();
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this._onDidChange.dispose();
    }
}
