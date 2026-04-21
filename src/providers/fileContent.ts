/**
 * TextDocumentContentProvider for TFVC review file content.
 *
 * URI scheme: tfvc-review://base/{serverPath}  — latest committed version
 *             tfvc-review://shelved/{serverPath}?shelveset={name}&owner={owner}  — shelved version
 */

import * as vscode from 'vscode';
import { AdoRestClient } from '../ado/restClient';
import { TfvcError } from '../errors';
import { logError } from '../outputChannel';

export const REVIEW_SCHEME = 'tfvc-review';

export class ReviewFileContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    private static readonly MAX_CACHE_ENTRIES = 100;
    private contentCache = new Map<string, string>();
    private disposables: vscode.Disposable[] = [];

    constructor(private restClient: AdoRestClient | undefined) {
        this.disposables.push(
            vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, this),
        );
    }

    setRestClient(client: AdoRestClient | undefined): void {
        this.restClient = client;
    }

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        if (!this.restClient) {
            return '// ADO REST client not configured. Set tfvc.pat and tfvc.adoOrg in settings.';
        }

        const cacheKey = uri.toString();
        const cached = this.contentCache.get(cacheKey);
        if (cached !== undefined) { return cached; }

        try {
            let content: string;
            // Strip leading / from path to get TFVC server path ($/Project/...)
            const serverPath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;

            if (uri.authority === 'shelved') {
                // Fetch shelved version directly via items API with version params
                const params = new URLSearchParams(uri.query);
                const shelvesetName = params.get('shelveset') || '';
                const owner = params.get('owner') || '';
                content = await this.restClient.fetchShelvedContent(serverPath, shelvesetName, owner);
            } else {
                // Fetch base (latest committed) version. A 404 means the file
                // doesn't exist on the server yet (new adds in the shelveset);
                // return empty so the diff view shows "added" cleanly. Any
                // other error — auth, 500, network — propagates so the user
                // sees the real cause instead of an empty-looking file.
                try {
                    content = await this.restClient.fetchItemContent(serverPath);
                } catch (err) {
                    if (err instanceof TfvcError && err.statusCode === 404) {
                        content = '';
                    } else {
                        throw err;
                    }
                }
            }

            if (this.contentCache.size >= ReviewFileContentProvider.MAX_CACHE_ENTRIES) {
                // Evict oldest entry (first inserted)
                const oldest = this.contentCache.keys().next().value;
                if (oldest !== undefined) { this.contentCache.delete(oldest); }
            }
            this.contentCache.set(cacheKey, content);
            return content;
        } catch (err) {
            logError(`Failed to fetch review file content: ${err}`);
            throw new Error(`Failed to fetch file content: ${err}`);
        }
    }

    clearCache(): void {
        this.contentCache.clear();
    }

    dispose(): void {
        this._onDidChange.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
