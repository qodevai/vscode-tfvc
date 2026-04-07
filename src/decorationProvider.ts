import * as vscode from 'vscode';
import { TfvcRepository } from './tfvcRepository';

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
        const change = this.repo.pendingChanges.find(c => c.localPath === uri.fsPath);
        if (!change) {
            return undefined;
        }

        switch (change.changeType) {
            case 'edit':
                return {
                    badge: 'M',
                    color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
                    tooltip: 'Modified (TFVC)',
                };
            case 'add':
                return {
                    badge: 'A',
                    color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
                    tooltip: 'Added (TFVC)',
                };
            case 'delete':
                return {
                    badge: 'D',
                    color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
                    tooltip: 'Deleted (TFVC)',
                };
            case 'rename':
                return {
                    badge: 'R',
                    color: new vscode.ThemeColor('gitDecoration.renamedResourceForeground'),
                    tooltip: 'Renamed (TFVC)',
                };
            case 'merge':
                return {
                    badge: 'C',
                    color: new vscode.ThemeColor('gitDecoration.conflictingResourceForeground'),
                    tooltip: 'Conflict (TFVC)',
                };
            default:
                return {
                    badge: 'M',
                    color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
                    tooltip: `${change.changeType} (TFVC)`,
                };
        }
    }

    dispose(): void {
        this._onDidChangeFileDecorations.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
