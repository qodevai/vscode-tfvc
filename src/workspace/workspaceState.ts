/**
 * Local workspace state manager.
 *
 * Replaces TEE-CLC's `.tf/` metadata with `.vscode-tfvc/` containing:
 *  - baseline.json  — server file list with versions and hashes
 *  - pending.json   — explicit adds, deletes, and checkouts
 *
 * Edits are auto-detected by comparing local file hashes against baseline.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    BaselineState,
    BaselineItem,
    PendingState,
    PendingChange,
    SyncResult,
} from './types';
import { computeFileHash } from './hashing';
import { serverToLocal, localToServer } from './pathMapping';
import { AdoRestClient } from '../ado/restClient';
import { TfvcItemFull } from '../ado/types';
import { TfvcError } from '../errors';

/** Logger function — defaults to console.error, overridden at construction. */
type LogFn = (message: string) => void;

const STATE_DIR = '.vscode-tfvc';
const BASELINE_FILE = 'baseline.json';
const PENDING_FILE = 'pending.json';
const SHELVES_DIR = 'shelves';

export class WorkspaceState {
    private baseline: BaselineState;
    private pending: PendingState;
    private readonly stateDir: string;
    private readonly log: LogFn;

    constructor(
        private readonly root: string,
        private readonly scope: string,
        logger?: LogFn
    ) {
        this.stateDir = path.join(root, STATE_DIR);
        this.log = logger || console.error;
        this.baseline = { scope, root, version: 0, items: [] };
        this.pending = { adds: [], deletes: [], checkouts: [] };
        this.load();
    }

    /** Whether the state directory exists (workspace has been initialized). */
    get isInitialized(): boolean {
        return fs.existsSync(this.stateDir);
    }

    // ── Persistence ───────────────────────────────────────────────────

    private load(): void {
        try {
            const baselinePath = path.join(this.stateDir, BASELINE_FILE);
            if (fs.existsSync(baselinePath)) {
                this.baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
            }
        } catch (err) {
            this.log(`Failed to load baseline: ${err}`);
        }

        try {
            const pendingPath = path.join(this.stateDir, PENDING_FILE);
            if (fs.existsSync(pendingPath)) {
                this.pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
            }
        } catch (err) {
            this.log(`Failed to load pending state: ${err}`);
        }
    }

    private saveBaseline(): void {
        fs.mkdirSync(this.stateDir, { recursive: true });
        fs.writeFileSync(
            path.join(this.stateDir, BASELINE_FILE),
            JSON.stringify(this.baseline, null, 2)
        );
    }

    private savePending(): void {
        fs.mkdirSync(this.stateDir, { recursive: true });
        fs.writeFileSync(
            path.join(this.stateDir, PENDING_FILE),
            JSON.stringify(this.pending, null, 2)
        );
    }

    // ── Initialize / sync baseline ────────────────────────────────────

    /**
     * Initialize workspace: fetch server file list and download all files.
     * Creates .vscode-tfvc/ and baseline.json.
     */
    async initialize(
        restClient: AdoRestClient,
        onProgress?: (message: string) => void
    ): Promise<void> {
        onProgress?.('Fetching file list from server...');
        const items = await restClient.listItems(this.scope);

        const fileItems = items.filter(i => !i.isFolder);
        const newBaseline: BaselineItem[] = [];

        for (let i = 0; i < fileItems.length; i++) {
            const item = fileItems[i];
            const localPath = serverToLocal(item.path, this.scope, this.root);

            onProgress?.(`Downloading (${i + 1}/${fileItems.length}): ${path.basename(localPath)}`);

            // Ensure directory exists
            fs.mkdirSync(path.dirname(localPath), { recursive: true });

            // Download file content
            const content = await restClient.downloadItemBuffer(item.path);
            fs.writeFileSync(localPath, content);

            // Make read-only (TFVC convention)
            fs.chmodSync(localPath, 0o444);

            const hash = await computeFileHash(localPath);
            const stat = fs.statSync(localPath);

            newBaseline.push({
                serverPath: item.path,
                localPath,
                version: item.version,
                hash,
                mtime: stat.mtimeMs,
                isFolder: false,
            });
        }

        // Also record folders for completeness
        for (const item of items.filter(i => i.isFolder)) {
            const localPath = serverToLocal(item.path, this.scope, this.root);
            fs.mkdirSync(localPath, { recursive: true });
        }

        this.baseline = {
            scope: this.scope,
            root: this.root,
            version: Math.max(0, ...fileItems.map(i => i.version)),
            items: newBaseline,
        };

        this.pending = { adds: [], deletes: [], checkouts: [] };

        this.saveBaseline();
        this.savePending();
    }

    /**
     * Incremental sync: get latest for specific paths or all files.
     * Downloads changed files, updates baseline.
     */
    async syncBaseline(
        restClient: AdoRestClient,
        paths?: string[],
        onProgress?: (message: string) => void
    ): Promise<SyncResult[]> {
        const results: SyncResult[] = [];

        // Fetch current server state
        const scopePath = paths && paths.length === 1
            ? localToServer(paths[0], this.scope, this.root)
            : this.scope;
        const items = await restClient.listItems(scopePath);
        const fileItems = items.filter(i => !i.isFolder);

        // Build lookup of current baseline by server path
        const baselineMap = new Map<string, BaselineItem>();
        for (const item of this.baseline.items) {
            baselineMap.set(item.serverPath, item);
        }

        // Filter to requested paths if specified
        const pathSet = paths ? new Set(paths.map(p => localToServer(p, this.scope, this.root))) : null;
        const relevantItems = pathSet
            ? fileItems.filter(i => pathSet.has(i.path))
            : fileItems;

        for (let i = 0; i < relevantItems.length; i++) {
            const item = relevantItems[i];
            const existing = baselineMap.get(item.path);
            const localPath = serverToLocal(item.path, this.scope, this.root);

            // Skip if version hasn't changed
            if (existing && existing.version === item.version) {
                continue;
            }

            onProgress?.(`Downloading (${i + 1}/${relevantItems.length}): ${path.basename(localPath)}`);

            // Check if file has local edits — report as conflict instead of overwriting.
            const hasLocalEdit = this.pending.checkouts.includes(localPath) || this.pending.adds.includes(localPath);
            if (hasLocalEdit) {
                results.push({ path: localPath, action: 'conflict' });
                continue;
            }
            if (fs.existsSync(localPath)) {
                if (!existing) {
                    // New server file colliding with an untracked local file.
                    // Don't silently overwrite — the local copy might be the user's work.
                    results.push({ path: localPath, action: 'conflict' });
                    continue;
                }
                try {
                    const currentHash = await computeFileHash(localPath);
                    if (currentHash !== existing.hash) {
                        // Locally modified but not explicitly checked out
                        results.push({ path: localPath, action: 'conflict' });
                        continue;
                    }
                } catch (err) {
                    // Fail loud: an unreadable file is suspicious, don't overwrite blindly.
                    this.log(`Could not hash ${localPath} during sync: ${err}`);
                    results.push({ path: localPath, action: 'conflict' });
                    continue;
                }
            }

            fs.mkdirSync(path.dirname(localPath), { recursive: true });
            const content = await restClient.downloadItemBuffer(item.path);
            fs.writeFileSync(localPath, content);
            fs.chmodSync(localPath, 0o444);

            const hash = await computeFileHash(localPath);
            const stat = fs.statSync(localPath);

            const action = existing ? 'replacing' as const : 'getting' as const;
            results.push({ path: localPath, action });

            // Update baseline entry
            const newEntry: BaselineItem = {
                serverPath: item.path,
                localPath,
                version: item.version,
                hash,
                mtime: stat.mtimeMs,
                isFolder: false,
            };

            if (existing) {
                const idx = this.baseline.items.indexOf(existing);
                this.baseline.items[idx] = newEntry;
            } else {
                this.baseline.items.push(newEntry);
            }
        }

        // Handle server deletions: files in baseline but not on server.
        // Safety guard: an empty server response for a full (unscoped) sync is
        // almost certainly a transient API issue, not "everything was deleted".
        // Refuse to wipe the entire baseline in that case — require an explicit
        // path scope if the user really wants to process removals.
        const baselineInScope = pathSet
            ? this.baseline.items.filter(i => pathSet.has(i.serverPath))
            : this.baseline.items;
        if (fileItems.length === 0 && baselineInScope.length > 0 && !pathSet) {
            throw new TfvcError(
                `Server returned no items for ${scopePath}, but ${baselineInScope.length} files are tracked locally. ` +
                `Refusing to delete — this is likely a transient server issue. Retry the sync.`
            );
        }

        const serverPaths = new Set(fileItems.map(i => i.path));
        const toRemove: BaselineItem[] = [];
        for (const item of this.baseline.items) {
            if (pathSet && !pathSet.has(item.serverPath)) { continue; }
            if (!serverPaths.has(item.serverPath)) {
                // File deleted on server
                try {
                    if (fs.existsSync(item.localPath)) {
                        fs.chmodSync(item.localPath, 0o644);
                        fs.unlinkSync(item.localPath);
                    }
                } catch { /* ignore */ }
                results.push({ path: item.localPath, action: 'deleting' });
                toRemove.push(item);
            }
        }

        if (toRemove.length > 0) {
            const removeSet = new Set(toRemove);
            this.baseline.items = this.baseline.items.filter(i => !removeSet.has(i));
        }

        // Update baseline version
        if (fileItems.length > 0) {
            this.baseline.version = Math.max(this.baseline.version, ...fileItems.map(i => i.version));
        }

        this.saveBaseline();
        return results;
    }

    // ── Pending change detection ──────────────────────────────────────

    /** Compute pending changes by comparing local files against baseline + explicit adds/deletes. */
    async getPendingChanges(): Promise<PendingChange[]> {
        const changes: PendingChange[] = [];

        // 1. Explicit adds
        for (const localPath of this.pending.adds) {
            if (fs.existsSync(localPath)) {
                changes.push({
                    localPath,
                    serverPath: localToServer(localPath, this.scope, this.root),
                    changeType: 'add',
                });
            }
        }

        // 2. Explicit deletes
        for (const serverPath of this.pending.deletes) {
            const localPath = serverToLocal(serverPath, this.scope, this.root);
            changes.push({
                localPath,
                serverPath,
                changeType: 'delete',
            });
        }

        // 3. Auto-detect edits by comparing hashes
        const deletedServerPaths = new Set(this.pending.deletes);
        for (const item of this.baseline.items) {
            if (item.isFolder) { continue; }
            if (deletedServerPaths.has(item.serverPath)) { continue; }
            if (!fs.existsSync(item.localPath)) { continue; }

            try {
                const stat = fs.statSync(item.localPath);

                // Fast path: if mtime hasn't changed, skip hashing
                if (Math.abs(stat.mtimeMs - item.mtime) < 1) {
                    continue;
                }

                const currentHash = await computeFileHash(item.localPath);
                if (currentHash !== item.hash) {
                    changes.push({
                        localPath: item.localPath,
                        serverPath: item.serverPath,
                        changeType: 'edit',
                    });
                }
            } catch {
                // File may have been deleted externally — skip
            }
        }

        return changes;
    }

    // ── Explicit state mutations ──────────────────────────────────────

    markAdd(localPaths: string[]): void {
        for (const p of localPaths) {
            if (!this.pending.adds.includes(p)) {
                this.pending.adds.push(p);
            }
        }
        this.savePending();
    }

    markDelete(localPaths: string[]): void {
        for (const p of localPaths) {
            const serverPath = localToServer(p, this.scope, this.root);
            if (!this.pending.deletes.includes(serverPath)) {
                this.pending.deletes.push(serverPath);
            }
        }
        this.savePending();
    }

    markCheckout(localPaths: string[]): void {
        for (const p of localPaths) {
            if (!this.pending.checkouts.includes(p)) {
                this.pending.checkouts.push(p);
            }
        }
        this.savePending();
    }

    /** Remove specific paths from all pending lists. */
    clearPending(localPaths: string[]): void {
        const pathSet = new Set(localPaths);
        const serverPathSet = new Set(localPaths.map(p => {
            try { return localToServer(p, this.scope, this.root); }
            catch { return ''; }
        }));

        this.pending.adds = this.pending.adds.filter(p => !pathSet.has(p));
        this.pending.deletes = this.pending.deletes.filter(p => !serverPathSet.has(p));
        this.pending.checkouts = this.pending.checkouts.filter(p => !pathSet.has(p));
        this.savePending();
    }

    /** Clear all pending state. */
    clearAll(): void {
        this.pending = { adds: [], deletes: [], checkouts: [] };
        this.savePending();
    }

    /**
     * After a successful checkin, update baseline entries for the changed files.
     * For adds: create new baseline entry. For deletes: remove entry. For edits: update hash.
     */
    async updateBaselineAfterCheckin(changes: PendingChange[], newVersion: number): Promise<void> {
        for (const change of changes) {
            if (change.changeType === 'add' || change.changeType === 'edit') {
                // Update or create baseline entry
                const existing = this.baseline.items.find(i => i.serverPath === change.serverPath);
                const hash = await computeFileHash(change.localPath);
                const stat = fs.statSync(change.localPath);

                // Make read-only again after checkin
                fs.chmodSync(change.localPath, 0o444);

                const entry: BaselineItem = {
                    serverPath: change.serverPath,
                    localPath: change.localPath,
                    version: newVersion,
                    hash,
                    mtime: fs.statSync(change.localPath).mtimeMs,
                    isFolder: false,
                };

                if (existing) {
                    const idx = this.baseline.items.indexOf(existing);
                    this.baseline.items[idx] = entry;
                } else {
                    this.baseline.items.push(entry);
                }
            } else if (change.changeType === 'delete') {
                this.baseline.items = this.baseline.items.filter(i => i.serverPath !== change.serverPath);
            }
        }

        this.baseline.version = newVersion;
        this.saveBaseline();
    }

    /**
     * Undo pending changes: re-download from baseline and restore read-only.
     */
    async undoChanges(restClient: AdoRestClient, localPaths: string[]): Promise<void> {
        const pathSet = new Set(localPaths);
        const serverPathSet = new Set(localPaths.map(p => {
            try { return localToServer(p, this.scope, this.root); }
            catch { return ''; }
        }));

        // Undo edits/checkouts: re-download server version
        for (const item of this.baseline.items) {
            if (!pathSet.has(item.localPath)) { continue; }

            const content = await restClient.downloadItemBuffer(item.serverPath, item.version);
            // The parent directory may have been removed (e.g., user deleted it
            // along with the file and then asked to undo). Recreate it before
            // writing.
            fs.mkdirSync(path.dirname(item.localPath), { recursive: true });
            fs.writeFileSync(item.localPath, content);
            fs.chmodSync(item.localPath, 0o444);

            // Update baseline hash/mtime
            item.hash = await computeFileHash(item.localPath);
            item.mtime = fs.statSync(item.localPath).mtimeMs;
        }

        // Undo adds: just remove from pending (don't delete local file)
        this.pending.adds = this.pending.adds.filter(p => !pathSet.has(p));

        // Undo deletes: re-download and add back to baseline
        const deletesToUndo = this.pending.deletes.filter(sp => serverPathSet.has(sp));
        for (const serverPath of deletesToUndo) {
            const localPath = serverToLocal(serverPath, this.scope, this.root);
            try {
                const content = await restClient.downloadItemBuffer(serverPath);
                fs.mkdirSync(path.dirname(localPath), { recursive: true });
                fs.writeFileSync(localPath, content);
                fs.chmodSync(localPath, 0o444);
            } catch (err) {
                this.log(`Failed to restore ${serverPath}: ${err}`);
            }
        }
        this.pending.deletes = this.pending.deletes.filter(p => !serverPathSet.has(p));
        this.pending.checkouts = this.pending.checkouts.filter(p => !pathSet.has(p));

        this.saveBaseline();
        this.savePending();
    }

    // ── Local shelving ────────────────────────────────────────────────

    /** Save pending changes to a local shelf (fallback when REST shelving isn't available). */
    async saveLocalShelf(name: string, comment?: string): Promise<void> {
        const changes = await this.getPendingChanges();
        const shelfDir = path.join(this.stateDir, SHELVES_DIR);
        fs.mkdirSync(shelfDir, { recursive: true });

        const shelfData: {
            name: string;
            comment: string;
            createdDate: string;
            changes: Array<{ serverPath: string; localPath: string; changeType: string; content?: string }>;
        } = {
            name,
            comment: comment || '',
            createdDate: new Date().toISOString(),
            changes: [],
        };

        for (const change of changes) {
            const entry: typeof shelfData.changes[0] = {
                serverPath: change.serverPath,
                localPath: change.localPath,
                changeType: change.changeType,
            };

            if (change.changeType !== 'delete' && fs.existsSync(change.localPath)) {
                entry.content = fs.readFileSync(change.localPath).toString('base64');
            }

            shelfData.changes.push(entry);
        }

        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
        fs.writeFileSync(
            path.join(shelfDir, `${safeName}.json`),
            JSON.stringify(shelfData, null, 2)
        );
    }

    /** List locally saved shelves. */
    listLocalShelves(): Array<{ name: string; comment: string; date: string }> {
        const shelfDir = path.join(this.stateDir, SHELVES_DIR);
        if (!fs.existsSync(shelfDir)) { return []; }

        const results: Array<{ name: string; comment: string; date: string }> = [];
        for (const file of fs.readdirSync(shelfDir)) {
            if (!file.endsWith('.json')) { continue; }
            try {
                const data = JSON.parse(fs.readFileSync(path.join(shelfDir, file), 'utf8'));
                results.push({
                    name: data.name || file.replace('.json', ''),
                    comment: data.comment || '',
                    date: data.createdDate || '',
                });
            } catch { /* skip corrupt shelf files */ }
        }
        return results;
    }

    /** Apply a locally saved shelf. */
    async applyLocalShelf(name: string): Promise<void> {
        const shelfDir = path.join(this.stateDir, SHELVES_DIR);
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const shelfPath = path.join(shelfDir, `${safeName}.json`);

        if (!fs.existsSync(shelfPath)) {
            throw new Error(`Local shelf "${name}" not found`);
        }

        const data = JSON.parse(fs.readFileSync(shelfPath, 'utf8'));

        for (const change of data.changes || []) {
            if (change.changeType === 'delete') {
                this.pending.deletes.push(change.serverPath);
            } else if (change.changeType === 'add') {
                if (change.content) {
                    fs.mkdirSync(path.dirname(change.localPath), { recursive: true });
                    fs.writeFileSync(change.localPath, Buffer.from(change.content, 'base64'));
                }
                this.pending.adds.push(change.localPath);
            } else {
                // edit — write content and make writable
                if (change.content) {
                    fs.chmodSync(change.localPath, 0o644);
                    fs.writeFileSync(change.localPath, Buffer.from(change.content, 'base64'));
                }
                this.pending.checkouts.push(change.localPath);
            }
        }

        this.savePending();
    }

    /** Delete a locally saved shelf. */
    deleteLocalShelf(name: string): void {
        const shelfDir = path.join(this.stateDir, SHELVES_DIR);
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const shelfPath = path.join(shelfDir, `${safeName}.json`);
        if (fs.existsSync(shelfPath)) {
            fs.unlinkSync(shelfPath);
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────

    /** Find baseline entry for a local path. */
    getBaselineItem(localPath: string): BaselineItem | undefined {
        return this.baseline.items.find(i => i.localPath === localPath);
    }

    /** Find baseline entry for a server path. */
    getBaselineItemByServer(serverPath: string): BaselineItem | undefined {
        return this.baseline.items.find(i => i.serverPath === serverPath);
    }

    /** Get the scope (e.g. $/Project). */
    getScope(): string {
        return this.scope;
    }

    /** Get the workspace root directory. */
    getRoot(): string {
        return this.root;
    }
}
