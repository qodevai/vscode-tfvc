/**
 * TreeDataProvider for browsing TFVC Code Review Requests in the sidebar.
 *
 * Shows: Code Review Request → list of changed files in the shelveset.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { AdoRestClient } from '../ado/restClient';
import { CodeReviewRequest, ShelvesetChange } from '../ado/types';
import { normalizeChangeLabel } from '../changeType';
import { logError } from '../outputChannel';

type ReviewTreeItem = ReviewRequestItem | ReviewFileItem;

export class ReviewRequestItem extends vscode.TreeItem {
    constructor(public readonly review: CodeReviewRequest) {
        super(`CR ${review.id}: ${review.title}`, vscode.TreeItemCollapsibleState.Collapsed);
        const typeLabel = review.contextType === 'Shelveset' ? 'Shelveset' : 'Changeset';
        this.description = `${typeLabel} · ${review.createdBy}`;
        this.tooltip = `${typeLabel}: ${review.shelvesetName} by ${review.shelvesetOwner}\n${review.createdDate}`;
        this.iconPath = new vscode.ThemeIcon(review.contextType === 'Shelveset' ? 'archive' : 'git-commit');
        this.contextValue = 'reviewRequest';
    }
}

export class ReviewFileItem extends vscode.TreeItem {
    constructor(
        public readonly review: CodeReviewRequest,
        public readonly change: ShelvesetChange
    ) {
        const fileName = path.basename(change.path);
        super(fileName, vscode.TreeItemCollapsibleState.None);

        const changeLabel = normalizeChangeLabel(change.changeType);
        this.description = change.path;
        this.tooltip = `${change.changeType}: ${change.path}`;
        this.contextValue = 'reviewFile';

        if (changeLabel === 'add') {
            this.iconPath = new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
        } else if (changeLabel === 'delete') {
            this.iconPath = new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
        } else {
            this.iconPath = new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
        }

        // Click opens diff
        this.command = {
            command: 'tfvc.openReviewFileDiff',
            title: 'Open Diff',
            arguments: [this],
        };
    }
}

export class ReviewTreeProvider implements vscode.TreeDataProvider<ReviewTreeItem>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<ReviewTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private reviews: CodeReviewRequest[] = [];
    private fileCache = new Map<number, ShelvesetChange[]>();
    private disposables: vscode.Disposable[] = [];

    constructor(private restClient: AdoRestClient | undefined) {}

    setRestClient(client: AdoRestClient | undefined): void {
        this.restClient = client;
        this.refresh();
    }

    refresh(): void {
        this.fileCache.clear();
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: ReviewTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ReviewTreeItem): Promise<ReviewTreeItem[]> {
        if (!this.restClient) {
            return [];
        }

        if (!element) {
            // Root: list open code review requests
            try {
                this.reviews = await this.restClient.queryOpenReviews();
            } catch (err) {
                logError(`Failed to query code reviews: ${err}`);
                this.reviews = [];
            }

            if (this.reviews.length === 0) {
                return [];
            }

            return this.reviews.map(r => new ReviewRequestItem(r));
        }

        if (element instanceof ReviewRequestItem) {
            const review = element.review;
            try {
                let changes = this.fileCache.get(review.id);
                if (!changes) {
                    if (review.contextType === 'Shelveset') {
                        changes = await this.restClient.listShelvesetChanges(
                            review.shelvesetName,
                            review.shelvesetOwner
                        );
                    } else {
                        // Changeset review — context is the changeset ID
                        const csId = parseInt(review.shelvesetName, 10);
                        changes = csId ? await this.restClient.listChangesetChanges(csId) : [];
                    }
                    this.fileCache.set(review.id, changes);
                }
                return changes.map(c => new ReviewFileItem(review, c));
            } catch (err) {
                logError(`Failed to list changes for CR ${review.id}: ${err}`);
                return [];
            }
        }

        return [];
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
