import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TfvcRepository } from './tfvcRepository';
import { logError } from './outputChannel';

/**
 * Auto-checkout handler.
 *
 * When a file is saved or edited, checks if it's read-only and within the
 * TFVC workspace. If so, runs `tf checkout` to make it writable.
 */
export class AutoCheckoutHandler implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private pendingCheckouts = new Set<string>();
    /** Files we've already warned about this session (dedupe toast spam). */
    private reportedFailures = new Set<string>();

    constructor(
        private repo: TfvcRepository,
        private workspaceRoot: string
    ) {
        this.updateListeners();

        // Re-register listeners when config changes
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('tfvc.autoCheckout')) {
                    this.updateListeners();
                }
            })
        );
    }

    private updateListeners(): void {
        // Remove old listeners (keep config watcher at index 0)
        while (this.disposables.length > 1) {
            this.disposables.pop()!.dispose();
        }

        const mode = vscode.workspace.getConfiguration('tfvc').get<string>('autoCheckout', 'onSave');

        if (mode === 'onSave') {
            this.disposables.push(
                vscode.workspace.onWillSaveTextDocument(e => {
                    e.waitUntil(this.onWillSave(e.document));
                })
            );
        } else if (mode === 'onEdit') {
            this.disposables.push(
                vscode.workspace.onDidChangeTextDocument(e => {
                    if (e.contentChanges.length > 0) {
                        this.onEdit(e.document);
                    }
                })
            );
        }
    }

    private async onWillSave(document: vscode.TextDocument): Promise<void> {
        await this.tryCheckout(document.uri);
    }

    private onEdit(document: vscode.TextDocument): void {
        // Fire-and-forget — don't block typing
        this.tryCheckout(document.uri).catch(() => {});
    }

    private async tryCheckout(uri: vscode.Uri): Promise<void> {
        if (uri.scheme !== 'file') { return; }

        const fsPath = uri.fsPath;

        // Must be within workspace (case-insensitive for macOS/Windows)
        const rel = path.relative(this.workspaceRoot, fsPath);
        if (!rel || rel.startsWith('..')) { return; }

        // Avoid duplicate concurrent checkouts for the same file
        if (this.pendingCheckouts.has(fsPath)) { return; }

        // Already checked out (writable) — no action needed
        if (!this.isReadOnly(fsPath)) { return; }

        // Already has a pending change — no checkout needed
        const existing = this.repo.pendingChanges.find(c => c.localPath === fsPath);
        if (existing) { return; }

        this.pendingCheckouts.add(fsPath);
        try {
            await this.repo.checkout([fsPath]);
            // Clear any prior failure flag so future failures re-surface.
            this.reportedFailures.delete(fsPath);
        } catch (err) {
            logError(`Auto-checkout failed for ${fsPath}: ${err}`);
            this.notifyFailure(fsPath, err);
        } finally {
            this.pendingCheckouts.delete(fsPath);
        }
    }

    private notifyFailure(fsPath: string, err: unknown): void {
        // Dedupe: only warn once per file per session so rapid edits/saves
        // don't spam the user with identical toasts.
        if (this.reportedFailures.has(fsPath)) { return; }
        this.reportedFailures.add(fsPath);

        const msg = err instanceof Error ? err.message : String(err);
        const fileName = fsPath.split(/[\\/]/).pop() || fsPath;
        vscode.window.showWarningMessage(
            `TFVC auto-checkout failed for ${fileName}: ${msg}. The file remains read-only — run TFVC: Check Out manually if needed.`
        );
    }

    private isReadOnly(fsPath: string): boolean {
        try {
            const stat = fs.statSync(fsPath);
            // Check write permission for owner
            return (stat.mode & 0o200) === 0;
        } catch {
            return false;
        }
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
