import * as vscode from 'vscode';
import { TfvcCli } from './tfvcCli';
import { PendingChange, getStatus } from './commands/status';
import { checkin, CheckinResult } from './commands/checkin';
import { checkout } from './commands/checkout';
import { getLatest, SyncResult } from './commands/get';
import { undo, undoAll } from './commands/undo';
import { add } from './commands/add';
import { deleteFiles } from './commands/delete';
import { shelve, unshelve, listShelvesets, ShelvesetInfo } from './commands/shelve';
import { history, HistoryEntry } from './commands/history';
import { print } from './commands/diff';
import { logError } from './outputChannel';

export class TfvcRepository implements vscode.Disposable {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    private _pendingChanges: PendingChange[] = [];
    private _excludedPaths = new Set<string>();

    private refreshTimer: ReturnType<typeof setInterval> | undefined;
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private isRefreshing = false;

    constructor(private cli: TfvcCli) {}

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
            this._pendingChanges = await getStatus(this.cli);
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
            // Clear stale data so UI doesn't show outdated state
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
        const result = await checkin(this.cli, files, comment, workItems);
        await this.refresh();
        return result;
    }

    async checkout(files: string[]): Promise<void> {
        await checkout(this.cli, files);
        await this.refresh();
    }

    async getLatest(paths?: string[]): Promise<SyncResult[]> {
        const result = await getLatest(this.cli, paths);
        await this.refresh();
        return result;
    }

    async undo(files: string[]): Promise<void> {
        await undo(this.cli, files);
        await this.refresh();
    }

    async undoAll(): Promise<void> {
        await undoAll(this.cli);
        this._excludedPaths.clear();
        await this.refresh();
    }

    async add(files: string[]): Promise<void> {
        await add(this.cli, files);
        await this.refresh();
    }

    async delete(files: string[]): Promise<void> {
        await deleteFiles(this.cli, files);
        await this.refresh();
    }

    async shelve(name: string, comment?: string): Promise<void> {
        await shelve(this.cli, name, comment);
    }

    async unshelve(name: string): Promise<void> {
        await unshelve(this.cli, name);
        await this.refresh();
    }

    async listShelvesets(owner?: string): Promise<ShelvesetInfo[]> {
        return listShelvesets(this.cli, owner);
    }

    async deleteShelve(name: string): Promise<void> {
        await this.cli.executeOrThrow(['shelve', '-delete', name]);
    }

    async history(filePath: string, count?: number): Promise<HistoryEntry[]> {
        return history(this.cli, filePath, count);
    }

    async getServerContent(serverPath: string, version?: string): Promise<string> {
        return print(this.cli, serverPath, version);
    }

    dispose(): void {
        this.stopAutoRefresh();
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this._onDidChange.dispose();
    }
}
