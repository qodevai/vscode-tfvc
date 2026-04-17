/**
 * CommentController for displaying TFVC code review inline comments.
 *
 * Uses VS Code's Comments API to show discussion threads in the gutter
 * of review diff views.
 */

import * as vscode from 'vscode';
import { AdoSoapClient, DiscussionThread } from '../ado/soapClient';
import { REVIEW_SCHEME } from './fileContent';
import { logError } from '../outputChannel';

export class ReviewCommentController implements vscode.Disposable {
    private controller: vscode.CommentController;
    private threads: vscode.CommentThread[] = [];
    private disposables: vscode.Disposable[] = [];

    constructor(private soapClient: AdoSoapClient | undefined) {
        this.controller = vscode.comments.createCommentController('tfvc-reviews', 'TFVC Reviews');
        this.controller.commentingRangeProvider = undefined; // read-only for now
        this.disposables.push(this.controller);
    }

    setSoapClient(client: AdoSoapClient | undefined): void {
        this.soapClient = client;
    }

    /**
     * Load and display inline comments for a code review request.
     * The shelvedQuery must match the query string used in the diff view URIs
     * so that VS Code can match comment threads to the correct editor.
     */
    async loadComments(workItemId: number, shelvedQuery: string): Promise<void> {
        if (!this.soapClient) { return; }

        // Clear previous threads
        this.clearThreads();

        let discussions: DiscussionThread[];
        try {
            discussions = await this.soapClient.queryDiscussions(workItemId);
        } catch (err) {
            logError(`Failed to load review comments for WIT ${workItemId}: ${err}`);
            return;
        }

        for (const disc of discussions) {
            // URI must match what the diff view uses (including query params)
            const uri = vscode.Uri.parse(`${REVIEW_SCHEME}://shelved/${disc.itemPath}?${shelvedQuery}`);

            const range = new vscode.Range(
                Math.max(0, disc.startLine - 1), 0,
                Math.max(0, disc.endLine - 1), 0
            );

            const comments: vscode.Comment[] = disc.comments
                .filter(c => !c.isDeleted)
                .map(c => ({
                    body: new vscode.MarkdownString(c.content),
                    mode: vscode.CommentMode.Preview,
                    author: { name: c.authorName },
                    timestamp: new Date(c.publishedDate),
                }));

            if (comments.length === 0) { continue; }

            const thread = this.controller.createCommentThread(uri, range, comments);
            thread.canReply = false;
            thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
            thread.label = `Discussion #${disc.discussionId}`;
            this.threads.push(thread);
        }
    }

    clearThreads(): void {
        for (const t of this.threads) {
            t.dispose();
        }
        this.threads = [];
    }

    dispose(): void {
        this.clearThreads();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
