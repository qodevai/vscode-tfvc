import * as vscode from 'vscode';
import * as path from 'path';
import { TfvcCli } from './tfvcCli';
import { TfvcRepository } from './tfvcRepository';
import { TfvcSCMProvider } from './tfvcProvider';
import { TfvcDecorationProvider } from './decorationProvider';
import { TfvcQuickDiffProvider } from './quickDiffProvider';
import { AutoCheckoutHandler } from './autoCheckout';
import { AdoRestClient } from './ado/restClient';
import { AdoSoapClient } from './ado/soapClient';
import { ReviewTreeProvider, ReviewRequestItem, ReviewFileItem } from './providers/reviewTree';
import { ReviewFileContentProvider, REVIEW_SCHEME } from './providers/fileContent';
import { ReviewVerdict } from './ado/types';
import { ReviewCommentController } from './providers/comments';
import { getOutputChannel, logError } from './outputChannel';

let disposables: vscode.Disposable[] = [];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const outputChannel = getOutputChannel();
    outputChannel.appendLine('TFVC extension activating...');

    const config = vscode.workspace.getConfiguration('tfvc');

    // Find workspace root
    const workspaceRoot = findTfvcWorkspaceRoot();
    if (!workspaceRoot) {
        outputChannel.appendLine('No TFVC workspace detected (.tf/ folder not found). Extension inactive.');
        return;
    }
    outputChannel.appendLine(`TFVC workspace root: ${workspaceRoot}`);

    // ── TEE-CLC layer (optional — for local workspace operations) ────

    let repo: TfvcRepository | undefined;
    const tfPath = TfvcCli.resolve();
    outputChannel.appendLine(`Using tf executable: ${tfPath}`);

    const cli = new TfvcCli(tfPath, workspaceRoot);
    try {
        const checkResult = await cli.execute(['help'], 10_000);
        outputChannel.appendLine(`tf check output: ${checkResult.stdout.split('\n')[0]}`);
        repo = new TfvcRepository(cli);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`tf CLI not available (${msg}). Local workspace operations disabled.`);
        outputChannel.appendLine('Shelvesets and code reviews still work via REST API if PAT is configured.');
    }

    // Wire SCM provider if CLI is available
    if (repo) {
        const provider = new TfvcSCMProvider(repo, context, workspaceRoot);
        const decorations = new TfvcDecorationProvider(repo);
        const quickDiff = new TfvcQuickDiffProvider(repo);
        const autoCheckout = new AutoCheckoutHandler(repo, workspaceRoot);
        disposables.push(repo, provider, decorations, quickDiff, autoCheckout);

        // File watcher for .tf/ metadata changes
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceRoot, '.tf/**')
        );
        watcher.onDidChange(() => repo!.debouncedRefresh());
        watcher.onDidCreate(() => repo!.debouncedRefresh());
        watcher.onDidDelete(() => repo!.debouncedRefresh());
        disposables.push(watcher);

        // Auto-refresh interval
        const refreshInterval = config.get<number>('autoRefreshInterval', 0);
        repo.startAutoRefresh(refreshInterval);
    }

    // ── ADO REST layer (for shelvesets, reviews, file content) ───────

    const reviewTree = new ReviewTreeProvider(undefined);
    const reviewContent = new ReviewFileContentProvider(undefined);
    const reviewComments = new ReviewCommentController(undefined);
    disposables.push(reviewTree, reviewContent, reviewComments);

    // Register the tree view
    const treeView = vscode.window.createTreeView('tfvcReviews', {
        treeDataProvider: reviewTree,
        showCollapseAll: true,
    });
    disposables.push(treeView);

    let restClient: AdoRestClient | undefined;
    let soapClient: AdoSoapClient | undefined;

    function initRestClient(): void {
        const cfg = vscode.workspace.getConfiguration('tfvc');
        const pat = cfg.get<string>('pat', '');
        const org = cfg.get<string>('adoOrg', '');
        const project = cfg.get<string>('adoProject', '');
        const baseUrl = cfg.get<string>('adoBaseUrl', '');
        const collectionPath = cfg.get<string>('adoCollectionPath', '');

        if (!pat || !project || (!org && !baseUrl)) {
            restClient = undefined;
            soapClient = undefined;
            return;
        }

        restClient = new AdoRestClient(org, pat, project, baseUrl, collectionPath);
        reviewTree.setRestClient(restClient);
        reviewContent.setRestClient(restClient);

        const soapBase = baseUrl
            ? `${baseUrl.replace(/\/+$/, '')}${collectionPath}`
            : `https://dev.azure.com/${org}`;
        soapClient = new AdoSoapClient(soapBase, pat);
        reviewComments.setSoapClient(soapClient);

        outputChannel.appendLine(`ADO REST client initialized for ${baseUrl || `dev.azure.com/${org}`}/${project}`);
    }

    initRestClient();

    // Re-init REST client when config changes
    disposables.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (
                e.affectsConfiguration('tfvc.pat') ||
                e.affectsConfiguration('tfvc.adoOrg') ||
                e.affectsConfiguration('tfvc.adoProject') ||
                e.affectsConfiguration('tfvc.adoBaseUrl') ||
                e.affectsConfiguration('tfvc.adoCollectionPath')
            ) {
                initRestClient();
            }
            if (e.affectsConfiguration('tfvc.autoRefreshInterval') && repo) {
                const interval = vscode.workspace.getConfiguration('tfvc').get<number>('autoRefreshInterval', 0);
                repo.startAutoRefresh(interval);
            }
        })
    );

    // ── Review commands ──────────────────────────────────────────────

    disposables.push(
        vscode.commands.registerCommand('tfvc.refreshReviews', () => {
            reviewTree.refresh();
        }),

        vscode.commands.registerCommand('tfvc.openReviewFileDiff', async (item: ReviewFileItem) => {
            if (!item || !restClient) { return; }

            const review = item.review;
            const change = item.change;
            const changeLabel = change.changeType.split(',')[0].trim().toLowerCase();
            const fileName = path.basename(change.path);

            const shelvedQuery = `shelveset=${encodeURIComponent(review.shelvesetName)}&owner=${encodeURIComponent(review.shelvesetOwner)}`;

            if (changeLabel.includes('add')) {
                // New file — diff empty vs shelved content
                const baseUri = vscode.Uri.parse(`${REVIEW_SCHEME}://base/${change.path}`);
                const shelvedUri = vscode.Uri.parse(`${REVIEW_SCHEME}://shelved/${change.path}?${shelvedQuery}`);
                await vscode.commands.executeCommand(
                    'vscode.diff', baseUri, shelvedUri, `${fileName} (Added)`
                );
            } else if (changeLabel.includes('delete')) {
                // Deleted file — show base content only
                const baseUri = vscode.Uri.parse(`${REVIEW_SCHEME}://base/${change.path}`);
                await vscode.commands.executeCommand('vscode.open', baseUri);
            } else {
                // Edit — diff base vs shelved
                const baseUri = vscode.Uri.parse(`${REVIEW_SCHEME}://base/${change.path}`);
                const shelvedUri = vscode.Uri.parse(`${REVIEW_SCHEME}://shelved/${change.path}?${shelvedQuery}`);
                await vscode.commands.executeCommand(
                    'vscode.diff', baseUri, shelvedUri, `${fileName} (Server ↔ Shelveset)`
                );
            }

            // Load inline comments for this review (pass query so URIs match the diff view)
            await reviewComments.loadComments(review.id, shelvedQuery);
        }),

        vscode.commands.registerCommand('tfvc.submitVerdict', async (item: ReviewRequestItem) => {
            if (!restClient) {
                vscode.window.showErrorMessage('TFVC: Configure tfvc.pat and tfvc.adoOrg to submit verdicts.');
                return;
            }

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
                await restClient.createCodeReviewResponse(
                    title,
                    review.id,
                    identity.displayName,
                    picked.verdict,
                    summary || ''
                );
                vscode.window.showInformationMessage(`TFVC: Review verdict "${picked.label}" submitted for CR ${review.id}.`);
                reviewTree.refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`TFVC: Failed to submit verdict: ${err}`);
            }
        }),

        vscode.commands.registerCommand('tfvc.postComment', async () => {
            if (!restClient || !soapClient) {
                vscode.window.showErrorMessage('TFVC: Configure tfvc.pat and tfvc.adoOrg to post comments.');
                return;
            }
            vscode.window.showInformationMessage('TFVC: Use the Comments API in a review diff to post inline comments.');
        }),
    );

    disposables.push(outputChannel);

    // Store disposables in context
    context.subscriptions.push(...disposables);

    // Initial refresh
    if (repo) {
        await repo.refresh();
    }

    outputChannel.appendLine('TFVC extension activated.');
}

export function deactivate(): void {
    for (const d of disposables) {
        d.dispose();
    }
    disposables = [];
}

/**
 * Find the workspace root containing a .tf/ folder (TFVC workspace metadata).
 */
function findTfvcWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return undefined; }

    const fs = require('fs');
    for (const folder of folders) {
        for (const dir of ['.tf', '$tf']) {
            const tfDir = vscode.Uri.joinPath(folder.uri, dir);
            try {
                if (fs.existsSync(tfDir.fsPath)) {
                    return folder.uri.fsPath;
                }
            } catch {
                // Continue
            }
        }
    }

    return undefined;
}
