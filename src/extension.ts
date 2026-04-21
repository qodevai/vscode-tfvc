import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';
import { TfvcRepository } from './tfvcRepository';
import { TfvcSCMProvider } from './tfvcProvider';
import { TfvcDecorationProvider } from './decorationProvider';
import { TfvcQuickDiffProvider } from './quickDiffProvider';
import { AutoCheckoutHandler } from './autoCheckout';
import { WorkspaceState } from './workspace/workspaceState';
import { AdoRestClient, buildOnPremBase } from './ado/restClient';
import { AdoSoapClient } from './ado/soapClient';
import { TfvcSoapClient } from './ado/tfvcSoapClient';
import { TfvcUploadClient } from './ado/tfvcUploadClient';
import { ServerWorkspace } from './workspace/serverWorkspace';
import { getStrictSSL, setStrictSSL, setProxyUrl, resolveProxyUrl } from './ado/httpClient';
import { ReviewTreeProvider, ReviewRequestItem, ReviewFileItem } from './providers/reviewTree';
import { ReviewFileContentProvider, REVIEW_SCHEME } from './providers/fileContent';
import { ReviewVerdict } from './ado/types';
import { ReviewCommentController } from './providers/comments';
import { normalizeChangeLabel } from './changeType';
import { getOutputChannel, logError } from './outputChannel';
import { isIgnoredPath } from './workspace/watcherIgnore';
import { TfvcError } from './errors';

const STATE_DIR = '.vscode-tfvc';

let disposables: vscode.Disposable[] = [];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const outputChannel = getOutputChannel();
    outputChannel.appendLine('TFVC extension activating...');

    // State captured by command closures. Commands are registered once at
    // activation but may be invoked before initRestClient() has built the
    // repo — they guard on these and show a "not configured" message instead
    // of failing with VS Code's generic "command not found" error.
    let restClient: AdoRestClient | undefined;
    let soapClient: AdoSoapClient | undefined;
    let repo: TfvcRepository | undefined;
    let scmProvider: TfvcSCMProvider | undefined;
    let root: string | undefined;
    const repoDisposables: vscode.Disposable[] = [];

    const reviewTree = new ReviewTreeProvider(undefined);
    const reviewContent = new ReviewFileContentProvider(undefined);
    const reviewComments = new ReviewCommentController(undefined);
    disposables.push(reviewTree, reviewContent, reviewComments);

    const treeView = vscode.window.createTreeView('tfvcReviews', {
        treeDataProvider: reviewTree,
        showCollapseAll: true,
    });
    disposables.push(treeView);

    function disposeRepoScoped(): void {
        for (const d of repoDisposables.splice(0)) {
            try { d.dispose(); } catch (err) { logError(`Dispose failed: ${err}`); }
        }
        repo = undefined;
        scmProvider = undefined;
    }

    async function initRestClient(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('tfvc');
        const pat = await context.secrets.get('tfvc.pat') || '';
        const org = cfg.get<string>('adoOrg', '');
        const project = cfg.get<string>('adoProject', '');
        const baseUrl = cfg.get<string>('adoBaseUrl', '');
        const collectionPath = cfg.get<string>('adoCollectionPath', '');
        setStrictSSL(cfg.get<boolean>('strictSSL', true));
        setProxyUrl(resolveProxyUrl(cfg.get<string>('proxy', '')));

        disposeRepoScoped();

        if (!pat || !project || (!org && !baseUrl)) {
            restClient = undefined;
            soapClient = undefined;
            reviewTree.setRestClient(undefined);
            reviewContent.setRestClient(undefined);
            reviewComments.setSoapClient(undefined);
            return;
        }

        const apiVersionOverride = cfg.get<string>('adoApiVersion', '');
        restClient = new AdoRestClient(org, pat, project, baseUrl, collectionPath, apiVersionOverride);
        reviewTree.setRestClient(restClient);
        reviewContent.setRestClient(restClient);

        const soapBase = baseUrl
            ? buildOnPremBase(baseUrl, collectionPath)
            : `https://dev.azure.com/${encodeURIComponent(org)}`;
        soapClient = new AdoSoapClient(soapBase, pat);
        reviewComments.setSoapClient(soapClient);

        // TFVC SOAP + upload clients share the same collection base as the
        // discussions SOAP client; they target different endpoints under it.
        const tfvcSoap = new TfvcSoapClient(soapBase, pat);
        const tfvcUpload = new TfvcUploadClient(soapBase, pat, () => getStrictSSL());

        outputChannel.appendLine(`ADO REST client initialized for ${baseUrl || `dev.azure.com/${org}`}/${project}`);

        if (!root) {
            outputChannel.appendLine('ADO client ready but no workspace root — SCM features disabled until a TFVC workspace is opened.');
            return;
        }

        const scope = restClient.scope;
        const state = new WorkspaceState(root, scope, logError);
        const stateDir = path.join(root, STATE_DIR);
        const serverWorkspace = new ServerWorkspace(root, stateDir);
        repo = new TfvcRepository(state, restClient, tfvcSoap, tfvcUpload, serverWorkspace);

        // Best-effort delete of the server-registered TFVC workspace when the
        // extension deactivates or the config changes. The workspace is an
        // implementation detail for shelving — the user never named it and
        // shouldn't be left cleaning up after us.
        repoDisposables.push({
            dispose: () => { void serverWorkspace.tryDispose(tfvcSoap); },
        });

        scmProvider = new TfvcSCMProvider(repo, context, root);
        const decorations = new TfvcDecorationProvider(repo);
        const quickDiff = new TfvcQuickDiffProvider(repo);
        const autoCheckout = new AutoCheckoutHandler(repo, root);
        repoDisposables.push(repo, scmProvider, decorations, quickDiff, autoCheckout);

        // File watcher for .vscode-tfvc/ metadata changes
        const stateWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(root, `${STATE_DIR}/**`)
        );
        stateWatcher.onDidChange(() => repo!.debouncedRefresh());
        stateWatcher.onDidCreate(() => repo!.debouncedRefresh());
        stateWatcher.onDidDelete(() => repo!.debouncedRefresh());
        repoDisposables.push(stateWatcher);

        // File watcher for workspace files — instant edit detection
        const fileWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(root, '**/*')
        );
        fileWatcher.onDidChange(uri => { if (!isIgnoredPath(uri.fsPath, root!)) { repo!.debouncedRefresh(500); } });
        fileWatcher.onDidCreate(uri => { if (!isIgnoredPath(uri.fsPath, root!)) { repo!.debouncedRefresh(500); } });
        fileWatcher.onDidDelete(uri => { if (!isIgnoredPath(uri.fsPath, root!)) { repo!.debouncedRefresh(500); } });
        repoDisposables.push(fileWatcher);

        const refreshInterval = cfg.get<number>('autoRefreshInterval', 0);
        repo.startAutoRefresh(refreshInterval);
    }

    function notConfigured(): void {
        vscode.window.showErrorMessage(
            'TFVC: Not configured. Run "TFVC: Set PAT", configure tfvc.adoOrg and tfvc.adoProject in settings, ' +
            'then run "TFVC: Initialize Workspace".'
        );
    }

    function wrapSCM(handler: (p: TfvcSCMProvider, ...args: any[]) => Promise<void>) {
        return async (...args: any[]) => {
            if (!scmProvider) { notConfigured(); return; }
            try {
                await handler(scmProvider, ...args);
            } catch (err) {
                const msg = err instanceof TfvcError ? err.message : String(err);
                vscode.window.showErrorMessage(`TFVC: ${msg}`);
            }
        };
    }

    // ── Commands (always registered, regardless of workspace state) ──
    disposables.push(
        vscode.commands.registerCommand('tfvc.setPat', async () => {
            const pat = await vscode.window.showInputBox({
                prompt: 'Azure DevOps Personal Access Token',
                password: true,
                placeHolder: 'Paste your PAT here',
            });
            if (pat === undefined) { return; }
            if (pat === '') {
                await context.secrets.delete('tfvc.pat');
                vscode.window.showInformationMessage('TFVC: PAT removed from secure storage.');
            } else {
                await context.secrets.store('tfvc.pat', pat);
                vscode.window.showInformationMessage('TFVC: PAT stored securely.');
            }
        }),

        vscode.commands.registerCommand('tfvc.initWorkspace', async () => {
            if (!repo) { notConfigured(); return; }
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'TFVC: Initializing workspace...',
                    cancellable: false,
                },
                async (progress) => {
                    await repo!.initializeWorkspace((message) => {
                        progress.report({ message });
                    });
                    vscode.window.showInformationMessage('TFVC: Workspace initialized successfully.');
                }
            );
        }),

        vscode.commands.registerCommand('tfvc.refresh',    wrapSCM(p => p.handleRefresh())),
        vscode.commands.registerCommand('tfvc.checkin',    wrapSCM(p => p.handleCheckin())),
        vscode.commands.registerCommand('tfvc.sync',       wrapSCM(p => p.handleSync())),
        vscode.commands.registerCommand('tfvc.checkout',   wrapSCM((p, ...a) => p.handleCheckout(a))),
        vscode.commands.registerCommand('tfvc.undo',       wrapSCM((p, ...a) => p.handleUndo(a))),
        vscode.commands.registerCommand('tfvc.undoAll',    wrapSCM(p => p.handleUndoAll())),
        vscode.commands.registerCommand('tfvc.add',        wrapSCM((p, ...a) => p.handleAdd(a))),
        vscode.commands.registerCommand('tfvc.delete',     wrapSCM((p, ...a) => p.handleDelete(a))),
        vscode.commands.registerCommand('tfvc.include',    wrapSCM((p, ...a) => p.handleInclude(a))),
        vscode.commands.registerCommand('tfvc.exclude',    wrapSCM((p, ...a) => p.handleExclude(a))),
        vscode.commands.registerCommand('tfvc.openDiff',   wrapSCM((p, ...a) => p.handleOpenDiff(a))),
        vscode.commands.registerCommand('tfvc.openFile',   wrapSCM((p, ...a) => p.handleOpenFile(a))),
        vscode.commands.registerCommand('tfvc.shelve',     wrapSCM(p => p.handleShelve())),
        vscode.commands.registerCommand('tfvc.unshelve',   wrapSCM(p => p.handleUnshelve())),
        vscode.commands.registerCommand('tfvc.shelvesets', wrapSCM(p => p.handleListShelvesets())),
        vscode.commands.registerCommand('tfvc.history',    wrapSCM(p => p.handleHistory())),

        vscode.commands.registerCommand('tfvc.refreshReviews', () => {
            reviewContent.clearCache();
            reviewTree.refresh();
        }),

        vscode.commands.registerCommand('tfvc.openReviewFileDiff', async (item: ReviewFileItem) => {
            if (!item) { return; }
            if (!restClient) { notConfigured(); return; }

            const review = item.review;
            const change = item.change;
            const changeLabel = normalizeChangeLabel(change.changeType);
            const fileName = path.basename(change.path);

            const shelvedQuery = `shelveset=${encodeURIComponent(review.shelvesetName)}&owner=${encodeURIComponent(review.shelvesetOwner)}`;

            if (changeLabel === 'add') {
                const baseUri = vscode.Uri.parse(`${REVIEW_SCHEME}://base/${change.path}`);
                const shelvedUri = vscode.Uri.parse(`${REVIEW_SCHEME}://shelved/${change.path}?${shelvedQuery}`);
                await vscode.commands.executeCommand(
                    'vscode.diff', baseUri, shelvedUri, `${fileName} (Added)`
                );
            } else if (changeLabel === 'delete') {
                const baseUri = vscode.Uri.parse(`${REVIEW_SCHEME}://base/${change.path}`);
                await vscode.commands.executeCommand('vscode.open', baseUri);
            } else {
                const baseUri = vscode.Uri.parse(`${REVIEW_SCHEME}://base/${change.path}`);
                const shelvedUri = vscode.Uri.parse(`${REVIEW_SCHEME}://shelved/${change.path}?${shelvedQuery}`);
                await vscode.commands.executeCommand(
                    'vscode.diff', baseUri, shelvedUri, `${fileName} (Server ↔ Shelveset)`
                );
            }

            await reviewComments.loadComments(review.id, shelvedQuery);
        }),

        vscode.commands.registerCommand('tfvc.submitVerdict', async (item: ReviewRequestItem) => {
            if (!restClient) { notConfigured(); return; }

            const review = item?.review;
            if (!review) { return; }

            const verdictItems = [
                { label: 'Looks Good', verdict: ReviewVerdict.LooksGood },
                { label: 'With Comments', verdict: ReviewVerdict.WithComments },
                { label: 'Needs Work', verdict: ReviewVerdict.NeedsWork },
                { label: 'Declined', verdict: ReviewVerdict.Declined },
            ];

            const picked = await vscode.window.showQuickPick(verdictItems, {
                placeHolder: `Verdict for CR ${review.id}: ${review.title}`,
            });
            if (!picked) { return; }

            const summary = await vscode.window.showInputBox({
                prompt: 'Review summary (optional)',
            });

            try {
                const identity = await restClient.getBotIdentity();
                const title = `RE: ${review.title} — ${picked.label}`;
                const closedState = vscode.workspace.getConfiguration('tfvc')
                    .get<string>('reviewResponseClosedState', 'Closed');
                await restClient.createCodeReviewResponse(
                    title,
                    review.id,
                    identity.displayName,
                    picked.verdict,
                    summary || '',
                    closedState
                );
                vscode.window.showInformationMessage(`TFVC: Review verdict "${picked.label}" submitted for CR ${review.id}.`);
                reviewTree.refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`TFVC: Failed to submit verdict: ${err}`);
            }
        }),
    );

    // Client re-init runs asynchronously from config/PAT change events.
    // Failures previously only hit the output channel, so a bad URL or
    // unreachable on-prem server left the extension in a stale state with
    // no visible cue. Surface the error as a warning toast pointing the
    // user at their settings.
    function reinitOrWarn(cause: string): void {
        initRestClient().catch(err => {
            logError(`${cause} re-init failed: ${err}`);
            const detail = err instanceof Error ? err.message : String(err);
            vscode.window.showWarningMessage(
                `TFVC: Failed to reinitialize after ${cause.toLowerCase()} change — ${detail}. Check tfvc.* settings or run "TFVC: Set PAT".`
            );
        });
    }

    // Listeners are registered before the workspace-root early return so
    // an unconfigured extension can come alive once the user saves settings
    // (or sets a PAT) without requiring a VS Code reload.
    disposables.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (
                e.affectsConfiguration('tfvc.adoOrg') ||
                e.affectsConfiguration('tfvc.adoProject') ||
                e.affectsConfiguration('tfvc.adoBaseUrl') ||
                e.affectsConfiguration('tfvc.adoCollectionPath') ||
                e.affectsConfiguration('tfvc.adoApiVersion') ||
                e.affectsConfiguration('tfvc.strictSSL') ||
                e.affectsConfiguration('tfvc.proxy')
            ) {
                reinitOrWarn('Config');
            }
            if (e.affectsConfiguration('tfvc.autoRefreshInterval') && repo) {
                const interval = vscode.workspace.getConfiguration('tfvc').get<number>('autoRefreshInterval', 0);
                repo.startAutoRefresh(interval);
            }
        }),
        context.secrets.onDidChange(e => {
            if (e.key === 'tfvc.pat') {
                reinitOrWarn('PAT');
            }
        }),
    );

    disposables.push(outputChannel);
    disposables.push({ dispose: disposeRepoScoped });
    context.subscriptions.push(...disposables.splice(0));

    // ── Determine workspace root ────────────────────────────────────

    const config = vscode.workspace.getConfiguration('tfvc');
    const tfvcRoots = findTfvcRoots();
    const hasConfig = !!config.get<string>('adoProject', '');

    if (tfvcRoots.length === 0 && !hasConfig) {
        outputChannel.appendLine('No TFVC workspace detected (.vscode-tfvc/ not found, no tfvc.adoProject configured). Commands will prompt to configure when invoked.');
        return;
    }

    if (tfvcRoots.length === 1) {
        root = tfvcRoots[0];
    } else if (tfvcRoots.length > 1) {
        root = tfvcRoots[0];
        const list = tfvcRoots.map(r => `  • ${r}`).join('\n');
        outputChannel.appendLine(
            `Multiple TFVC workspaces found; using ${root}. Others:\n${list}`
        );
        vscode.window.showWarningMessage(
            `TFVC: multiple folders contain .vscode-tfvc/. Using "${root}". Close others or split into separate VS Code windows.`
        );
    } else {
        // No .vscode-tfvc/ folder found — fall back to the first workspace
        // folder, but flag the guess if there are several folders to pick from.
        const folders = vscode.workspace.workspaceFolders;
        root = folders?.[0]?.uri.fsPath;
        if (folders && folders.length > 1) {
            vscode.window.showWarningMessage(
                `TFVC: no .vscode-tfvc/ found; defaulting to "${root}". Run "TFVC: Initialize Workspace" in the correct folder to pin the workspace root.`
            );
        }
    }

    if (!root) {
        outputChannel.appendLine('No workspace folder open. Extension inactive.');
        return;
    }

    outputChannel.appendLine(`TFVC workspace root: ${root}`);

    await initRestClient();

    if (repo) {
        await repo.refresh();
    }

    outputChannel.appendLine('TFVC extension activated.');
}

export function deactivate(): void {
    // VS Code disposes context.subscriptions automatically.
    // Clear our reference to avoid double disposal.
    disposables = [];
}


/** Return every workspace folder that contains a .vscode-tfvc/ directory. */
function findTfvcRoots(): string[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return []; }

    const roots: string[] = [];
    for (const folder of folders) {
        const stateDir = vscode.Uri.joinPath(folder.uri, STATE_DIR);
        try {
            if (fs.existsSync(stateDir.fsPath)) {
                roots.push(folder.uri.fsPath);
            }
        } catch {
            // Continue
        }
    }

    return roots;
}
