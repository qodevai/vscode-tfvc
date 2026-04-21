/**
 * Command registrations for the code-review tree view — refresh, open-diff,
 * and submit-verdict. Kept separate from the SCM command wiring because
 * they have a different dependency surface (no repo / SCM provider) and
 * because they live the entire extension lifetime rather than being
 * recreated on client reinit.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { AdoRestClient } from './ado/restClient';
import { ReviewVerdict } from './ado/types';
import { normalizeChangeLabel } from './changeType';
import { ReviewCommentController } from './providers/comments';
import { REVIEW_SCHEME, ReviewFileContentProvider } from './providers/fileContent';
import { ReviewFileItem, ReviewRequestItem, ReviewTreeProvider } from './providers/reviewTree';

export interface ReviewCommandDeps {
    /** Access the current REST client; may return undefined if not configured yet. */
    getRestClient: () => AdoRestClient | undefined;
    /** Invoked when the user runs a command without a configured client. */
    onNotConfigured: () => void;
    reviewTree: ReviewTreeProvider;
    reviewContent: ReviewFileContentProvider;
    reviewComments: ReviewCommentController;
}

/**
 * Register the three review commands. Returns disposables for `activate()`
 * to hand off to `context.subscriptions`.
 */
export function registerReviewCommands(deps: ReviewCommandDeps): vscode.Disposable[] {
    const { getRestClient, onNotConfigured, reviewTree, reviewContent, reviewComments } = deps;

    return [
        vscode.commands.registerCommand('tfvc.refreshReviews', () => {
            reviewContent.clearCache();
            reviewTree.refresh();
        }),

        vscode.commands.registerCommand('tfvc.openReviewFileDiff', async (item: ReviewFileItem) => {
            if (!item) { return; }
            const restClient = getRestClient();
            if (!restClient) { onNotConfigured(); return; }

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
            const restClient = getRestClient();
            if (!restClient) { onNotConfigured(); return; }

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
    ];
}
