import * as vscode from 'vscode';
import { TfvcRepository } from './tfvcRepository';
import { samePath } from './workspace/pathMapping';
import { metadataFor } from './changeTypeMetadata';

/**
 * Provides file decoration badges (M/A/D/C) in the Explorer tree
 * for files with pending TFVC changes.
 */
export class TfvcDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
    private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    private disposables: vscode.Disposable[] = [];

    constructor(private repo: TfvcRepository) {
        this.disposables.push(
            vscode.window.registerFileDecorationProvider(this),
        );

        this.disposables.push(
            repo.onDidChange(() => {
                // Fire for all changed files
                this._onDidChangeFileDecorations.fire(undefined);
            }),
        );
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        const change = this.repo.pendingChanges.find(c => samePath(c.localPath, uri.fsPath));
        if (!change) { return undefined; }

        const info = metadataFor(change.changeType);
        return {
            badge: info.letter,
            color: info.themeColor ? new vscode.ThemeColor(info.themeColor) : undefined,
            tooltip: `${info.label} (TFVC)`,
        };
    }

    dispose(): void {
        this._onDidChangeFileDecorations.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
