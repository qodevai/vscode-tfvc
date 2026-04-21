import * as vscode from 'vscode';
import { TfvcRepository } from './tfvcRepository';
import { samePath } from './workspace/pathMapping';
import { TtlCache } from './ttlCache';
import { logError } from './outputChannel';

const TFVC_SCHEME = 'tfvc';
const QUICKDIFF_CACHE_TTL_MS = 30_000;

/**
 * Provides the original (server) version of files for VS Code's QuickDiff
 * gutter decorations and inline diff.
 *
 * Also acts as a TextDocumentContentProvider so that `tfvc:$/Project/path`
 * URIs can be resolved to file content from the server.
 */
export class TfvcQuickDiffProvider implements vscode.QuickDiffProvider, vscode.TextDocumentContentProvider, vscode.Disposable {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    private readonly contentCache = new TtlCache<string, string>(QUICKDIFF_CACHE_TTL_MS);

    private disposables: vscode.Disposable[] = [];

    constructor(private repo: TfvcRepository) {
        this.disposables.push(
            vscode.workspace.registerTextDocumentContentProvider(TFVC_SCHEME, this),
        );

        // Invalidate cache on repository changes
        this.disposables.push(
            repo.onDidChange(() => this.contentCache.clear()),
        );
    }

    /**
     * QuickDiffProvider — returns the URI of the original (server) resource
     * for a given local file.
     */
    provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
        const change = this.repo.pendingChanges.find(c => samePath(c.localPath, uri.fsPath));
        if (!change || !change.serverPath) {
            return undefined;
        }

        // For added files there's no server version
        if (change.changeType === 'add') {
            return undefined;
        }

        return vscode.Uri.parse(`${TFVC_SCHEME}:${change.serverPath}`);
    }

    /**
     * TextDocumentContentProvider — fetches file content from the TFVC server
     * for `tfvc:$/Project/path` URIs.
     */
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const serverPath = uri.path;

        const cached = this.contentCache.get(serverPath);
        if (cached !== undefined) { return cached; }

        try {
            // Diff against the baseline version the user last synced, not HEAD —
            // otherwise newer server-side changes show up mixed with local edits.
            const content = await this.repo.getBaselineServerContent(serverPath);
            this.contentCache.set(serverPath, content);
            return content;
        } catch (err) {
            logError(`Failed to get server content for ${serverPath}: ${err}`);
            throw new Error(`Failed to fetch server version of ${serverPath}: ${err}`);
        }
    }

    /** Force refresh of diff decorations for a file. */
    invalidate(uri: vscode.Uri): void {
        const change = this.repo.pendingChanges.find(c => samePath(c.localPath, uri.fsPath));
        if (change?.serverPath) {
            const serverUri = vscode.Uri.parse(`${TFVC_SCHEME}:${change.serverPath}`);
            this.contentCache.delete(change.serverPath);
            this._onDidChange.fire(serverUri);
        }
    }

    dispose(): void {
        this.contentCache.clear();
        this._onDidChange.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
