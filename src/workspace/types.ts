/** Types for the local workspace state manager. */

export type ChangeType = 'edit' | 'add' | 'delete' | 'rename' | 'branch' | 'merge' | 'lock' | 'undelete';

export interface PendingChange {
    localPath: string;
    serverPath: string;
    changeType: ChangeType;
    /** For renames: the original server path */
    sourceServerPath?: string;
}

export interface CheckinResult {
    changeset: number;
}

export interface SyncResult {
    path: string;
    action: 'getting' | 'replacing' | 'deleting';
}

export interface HistoryEntry {
    changeset: number;
    user: string;
    date: string;
    comment: string;
}

/** Single item in the baseline snapshot. */
export interface BaselineItem {
    serverPath: string;
    localPath: string;
    version: number;
    /** Base64-encoded MD5 hash of the file content at baseline. */
    hash: string;
    /** File mtime at the time the baseline was captured (ms since epoch). */
    mtime: number;
    isFolder: boolean;
}

/** Full baseline state persisted to .vscode-tfvc/baseline.json */
export interface BaselineState {
    scope: string;
    root: string;
    version: number;
    items: BaselineItem[];
}

/** Explicit pending operations (adds, deletes, checkouts). Edits are auto-detected. */
export interface PendingState {
    adds: string[];       // local paths explicitly added
    deletes: string[];    // server paths explicitly deleted
    checkouts: string[];  // local paths explicitly checked out (made writable)
}
