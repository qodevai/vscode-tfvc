import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { WorkspaceState } from './workspace/workspaceState';
import { PendingChange, CheckinResult, SyncResult, HistoryEntry, ChangeType } from './workspace/types';
import { localToServer, serverToLocal } from './workspace/pathMapping';
import { AdoRestClient } from './ado/restClient';
import { encodeFileContent } from './ado/encoding';
import { ShelvesetInfo } from './ado/types';
import { TfvcError } from './errors';
import { logError } from './outputChannel';

export { PendingChange, ChangeType } from './workspace/types';

export class TfvcRepository implements vscode.Disposable {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    private _pendingChanges: PendingChange[] = [];
    private _excludedPaths = new Set<string>();

    private refreshTimer: ReturnType<typeof setInterval> | undefined;
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private isRefreshing = false;

    constructor(
        private state: WorkspaceState,
        private restClient: AdoRestClient
    ) {}

    get pendingChanges(): PendingChange[] {
        return this._pendingChanges;
    }

    get includedChanges(): PendingChange[] {
        return this._pendingChanges.filter(c => !this._excludedPaths.has(c.localPath));
    }

    get excludedChanges(): PendingChange[] {
        return this._pendingChanges.filter(c => this._excludedPaths.has(c.localPath));
    }

    get conflicts(): PendingChange[] {
        return this._pendingChanges.filter(c => c.changeType === 'merge');
    }

    isExcluded(localPath: string): boolean {
        return this._excludedPaths.has(localPath);
    }

    include(localPath: string): void {
        this._excludedPaths.delete(localPath);
        this._onDidChange.fire();
    }

    exclude(localPath: string): void {
        this._excludedPaths.add(localPath);
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
            const currentPaths = new Set(this._pendingChanges.map(c => c.localPath));
            for (const excluded of this._excludedPaths) {
                if (!currentPaths.has(excluded)) {
                    this._excludedPaths.delete(excluded);
                }
            }
            this._onDidChange.fire();
        } catch (err) {
            logError(`Refresh failed: ${err}`);
            this._pendingChanges = [];
            this._onDidChange.fire();
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

    async shelve(name: string, comment?: string): Promise<void> {
        // Try REST-based shelving first, fall back to local
        try {
            const changes = await this.state.getPendingChanges();
            if (changes.length === 0) {
                throw new TfvcError('No changes to shelve.');
            }

            const apiChanges = await Promise.all(changes.map(async c => {
                const payload: any = {
                    changeType: c.changeType,
                    item: { path: c.serverPath },
                };

                if (c.changeType !== 'delete' && fs.existsSync(c.localPath)) {
                    payload.newContent = encodeFileContent(fs.readFileSync(c.localPath));
                }

                return payload;
            }));

            await this.restClient.createShelveset(name, apiChanges, comment);
        } catch {
            // REST shelving unavailable — fall back to local
            await this.state.saveLocalShelf(name, comment);
        }
    }

    async unshelve(name: string): Promise<void> {
        // Try REST unshelve first: download shelveset changes and apply
        try {
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
                    // Download and apply the shelved content
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
        } catch {
            // Fall back to local shelf
            await this.state.applyLocalShelf(name);
        }

        await this.refresh();
    }

    async listShelvesets(owner?: string): Promise<Array<{ name: string; owner: string; date: string; comment: string }>> {
        try {
            const shelvesets = await this.restClient.listShelvesets(owner);
            return shelvesets.map(s => ({
                name: s.name,
                owner: s.owner,
                date: s.createdDate,
                comment: s.comment,
            }));
        } catch {
            // Fall back to local shelves
            return this.state.listLocalShelves().map(s => ({
                name: s.name,
                owner: '(local)',
                date: s.date,
                comment: s.comment,
            }));
        }
    }

    async deleteShelve(name: string): Promise<void> {
        try {
            const identity = await this.restClient.getBotIdentity();
            await this.restClient.deleteShelveset(name, identity.displayName);
        } catch {
            // Fall back to deleting local shelf
            this.state.deleteLocalShelf(name);
        }
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

    async getServerContent(serverPath: string, _version?: string): Promise<string> {
        return this.restClient.fetchItemContent(serverPath);
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
