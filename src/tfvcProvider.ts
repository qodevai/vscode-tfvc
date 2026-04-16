import * as vscode from 'vscode';
import * as path from 'path';
import { TfvcRepository, PendingChange, ChangeType } from './tfvcRepository';
import { TfvcError } from './errors';
import { parseWorkItemIds } from './workItemParsing';

const TFVC_SCHEME = 'tfvc';

export class TfvcSCMProvider implements vscode.Disposable {
    private scm: vscode.SourceControl;
    private includedGroup: vscode.SourceControlResourceGroup;
    private excludedGroup: vscode.SourceControlResourceGroup;
    private conflictsGroup: vscode.SourceControlResourceGroup;
    private disposables: vscode.Disposable[] = [];

    constructor(
        private repo: TfvcRepository,
        _context: vscode.ExtensionContext,
        workspaceRoot: string
    ) {
        this.scm = vscode.scm.createSourceControl('tfvc', 'TFVC', vscode.Uri.file(workspaceRoot));
        this.scm.acceptInputCommand = {
            command: 'tfvc.checkin',
            title: 'Check In',
        };
        this.scm.inputBox.placeholder = 'Checkin comment (Ctrl+Enter to check in)';

        this.conflictsGroup = this.scm.createResourceGroup('conflicts', 'Conflicts');
        this.includedGroup = this.scm.createResourceGroup('included', 'Included Changes');
        this.excludedGroup = this.scm.createResourceGroup('excluded', 'Excluded Changes');

        this.conflictsGroup.hideWhenEmpty = true;
        this.excludedGroup.hideWhenEmpty = true;

        this.disposables.push(
            this.scm,
            this.repo.onDidChange(() => this.updateResourceGroups()),
        );

        this.registerCommands();
    }

    private registerCommands(): void {
        const register = (id: string, handler: (...args: any[]) => Promise<void>) => {
            this.disposables.push(
                vscode.commands.registerCommand(id, async (...args: any[]) => {
                    try {
                        await handler(...args);
                    } catch (err) {
                        if (err instanceof TfvcError) {
                            vscode.window.showErrorMessage(`TFVC: ${err.message}`);
                        } else {
                            vscode.window.showErrorMessage(`TFVC: ${err}`);
                        }
                    }
                })
            );
        };

        register('tfvc.refresh', () => this.repo.refresh());

        register('tfvc.checkin', () => this.handleCheckin());

        register('tfvc.sync', () => this.handleSync());

        register('tfvc.checkout', (...args) => this.handleCheckout(args));

        register('tfvc.undo', (...args) => this.handleUndo(args));

        register('tfvc.undoAll', () => this.handleUndoAll());

        register('tfvc.add', (...args) => this.handleAdd(args));

        register('tfvc.delete', (...args) => this.handleDelete(args));

        register('tfvc.include', (...args) => this.handleInclude(args));

        register('tfvc.exclude', (...args) => this.handleExclude(args));

        register('tfvc.openDiff', (...args) => this.handleOpenDiff(args));

        register('tfvc.openFile', (...args) => this.handleOpenFile(args));

        register('tfvc.shelve', () => this.handleShelve());

        register('tfvc.unshelve', () => this.handleUnshelve());

        register('tfvc.shelvesets', () => this.handleListShelvesets());

        register('tfvc.history', () => this.handleHistory());
    }

    private updateResourceGroups(): void {
        this.conflictsGroup.resourceStates = this.repo.conflicts.map(c => this.toResourceState(c));
        this.includedGroup.resourceStates = this.repo.includedChanges
            .filter(c => c.changeType !== 'merge')
            .map(c => this.toResourceState(c));
        this.excludedGroup.resourceStates = this.repo.excludedChanges
            .filter(c => c.changeType !== 'merge')
            .map(c => this.toResourceState(c));

        this.scm.count = this.repo.pendingChanges.length;
    }

    private toResourceState(change: PendingChange): vscode.SourceControlResourceState {
        const uri = vscode.Uri.file(change.localPath);
        return {
            resourceUri: uri,
            decorations: this.getDecorations(change),
            command: {
                command: 'tfvc.openDiff',
                title: 'Open Diff',
                arguments: [{ resourceUri: uri }],
            },
        };
    }

    private getDecorations(change: PendingChange): vscode.SourceControlResourceDecorations {
        switch (change.changeType) {
            case 'add':
                return {
                    iconPath: new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground')),
                    tooltip: 'Added',
                };
            case 'delete':
                return {
                    iconPath: new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('gitDecoration.deletedResourceForeground')),
                    tooltip: 'Deleted',
                    strikeThrough: true,
                };
            case 'edit':
                return {
                    iconPath: new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')),
                    tooltip: 'Edited',
                };
            case 'rename':
                return {
                    iconPath: new vscode.ThemeIcon('diff-renamed', new vscode.ThemeColor('gitDecoration.renamedResourceForeground')),
                    tooltip: 'Renamed',
                };
            case 'merge':
                return {
                    iconPath: new vscode.ThemeIcon('warning', new vscode.ThemeColor('gitDecoration.conflictingResourceForeground')),
                    tooltip: 'Conflict',
                };
            default:
                return {
                    iconPath: new vscode.ThemeIcon('diff-modified'),
                    tooltip: change.changeType,
                };
        }
    }

    // --- Command handlers ---

    private async handleCheckin(): Promise<void> {
        const comment = this.scm.inputBox.value.trim();
        if (!comment) {
            vscode.window.showWarningMessage('TFVC: Please enter a checkin comment.');
            return;
        }

        const included = this.repo.includedChanges;
        if (included.length === 0) {
            vscode.window.showWarningMessage('TFVC: No included changes to check in.');
            return;
        }

        // Parse work item IDs from comment: "#1234" or "WI:1234". Dedupe so
        // mentioning the same ID twice ("#1234 fixes #1234") doesn't send it
        // twice to ADO (which rejects duplicate links).
        const workItems = parseWorkItemIds(comment);

        const files = included.map(c => c.localPath);
        const result = await this.repo.checkin(files, comment, workItems.length > 0 ? workItems : undefined);

        this.scm.inputBox.value = '';
        vscode.window.showInformationMessage(`TFVC: Changeset #${result.changeset} checked in.`);
    }

    private async handleSync(): Promise<void> {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.SourceControl, title: 'TFVC: Getting latest...' },
            async () => {
                const results = await this.repo.getLatest();
                const conflicts = results.filter(r => r.action === 'conflict');
                const synced = results.filter(r => r.action !== 'conflict');
                if (conflicts.length > 0) {
                    vscode.window.showWarningMessage(
                        `TFVC: Synced ${synced.length} file(s), ${conflicts.length} conflict(s) skipped (local edits).`
                    );
                } else {
                    vscode.window.showInformationMessage(`TFVC: Synced ${synced.length} file(s).`);
                }
            }
        );
    }

    private async handleCheckout(args: any[]): Promise<void> {
        const uris = this.resolveUris(args);
        if (uris.length === 0) {
            // Checkout active editor file
            const active = vscode.window.activeTextEditor?.document.uri;
            if (active) { uris.push(active); }
        }
        if (uris.length === 0) { return; }
        await this.repo.checkout(uris.map(u => u.fsPath));
    }

    private async handleUndo(args: any[]): Promise<void> {
        const uris = this.resolveUris(args);
        if (uris.length === 0) { return; }

        const confirm = await vscode.window.showWarningMessage(
            `Undo changes to ${uris.length} file(s)?`,
            { modal: true },
            'Undo'
        );
        if (confirm !== 'Undo') { return; }

        await this.repo.undo(uris.map(u => u.fsPath));
    }

    private async handleUndoAll(): Promise<void> {
        const count = this.repo.pendingChanges.length;
        if (count === 0) { return; }

        const confirm = await vscode.window.showWarningMessage(
            `Undo all ${count} pending change(s)?`,
            { modal: true },
            'Undo All'
        );
        if (confirm !== 'Undo All') { return; }

        await this.repo.undoAll();
    }

    private async handleAdd(args: any[]): Promise<void> {
        const uris = this.resolveUris(args);
        if (uris.length === 0) { return; }
        await this.repo.add(uris.map(u => u.fsPath));
    }

    private async handleDelete(args: any[]): Promise<void> {
        const uris = this.resolveUris(args);
        if (uris.length === 0) { return; }

        const confirm = await vscode.window.showWarningMessage(
            `Delete ${uris.length} file(s) from TFVC?`,
            { modal: true },
            'Delete'
        );
        if (confirm !== 'Delete') { return; }

        await this.repo.delete(uris.map(u => u.fsPath));
    }

    private async handleInclude(args: any[]): Promise<void> {
        const uris = this.resolveUris(args);
        for (const uri of uris) {
            this.repo.include(uri.fsPath);
        }
    }

    private async handleExclude(args: any[]): Promise<void> {
        const uris = this.resolveUris(args);
        for (const uri of uris) {
            this.repo.exclude(uri.fsPath);
        }
    }

    private async handleOpenDiff(args: any[]): Promise<void> {
        const uris = this.resolveUris(args);
        if (uris.length === 0) { return; }

        const uri = uris[0];
        const change = this.repo.pendingChanges.find(c => c.localPath === uri.fsPath);

        if (!change || change.changeType === 'add') {
            // New file — no server version to diff against
            await vscode.commands.executeCommand('vscode.open', uri);
            return;
        }

        if (change.changeType === 'delete') {
            // Deleted file — show the server version
            const serverUri = vscode.Uri.parse(`${TFVC_SCHEME}:${change.serverPath}`);
            await vscode.commands.executeCommand('vscode.open', serverUri);
            return;
        }

        // Diff: server version vs local
        const serverUri = vscode.Uri.parse(`${TFVC_SCHEME}:${change.serverPath}`);
        const fileName = path.basename(change.localPath);
        await vscode.commands.executeCommand(
            'vscode.diff',
            serverUri,
            uri,
            `${fileName} (Server ↔ Local)`
        );
    }

    private async handleOpenFile(args: any[]): Promise<void> {
        const uris = this.resolveUris(args);
        if (uris.length === 0) { return; }
        await vscode.commands.executeCommand('vscode.open', uris[0]);
    }

    private async handleShelve(): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: 'Shelveset name',
            placeHolder: 'my-changes',
            validateInput: validateShelvesetName,
        });
        if (!name) { return; }

        const comment = await vscode.window.showInputBox({
            prompt: 'Comment (optional)',
        });

        const result = await this.repo.shelve(name, comment || undefined);
        if (result.location === 'server') {
            vscode.window.showInformationMessage(`TFVC: Shelved as "${name}" on the server.`);
        } else {
            vscode.window.showWarningMessage(
                `TFVC: Server shelve failed — changes saved to a local shelf on this machine only. ` +
                `See the TFVC output channel for details.`
            );
        }
    }

    private async handleUnshelve(): Promise<void> {
        const picked = await this.pickShelveset('Select shelveset to unshelve');
        if (!picked) { return; }

        const result = await this.repo.unshelve(picked);
        if (result.location === 'server') {
            vscode.window.showInformationMessage(`TFVC: Unshelved "${picked}" from the server.`);
        } else {
            vscode.window.showWarningMessage(
                `TFVC: Server unshelve failed — applied local shelf "${picked}" instead. ` +
                `See the TFVC output channel for details.`
            );
        }
    }

    private async handleListShelvesets(): Promise<void> {
        const picked = await this.pickShelveset('Shelvesets');
        if (!picked) { return; }

        const action = await vscode.window.showQuickPick(
            ['Unshelve', 'Delete Shelveset'],
            { placeHolder: `Action for "${picked}"` }
        );

        if (action === 'Unshelve') {
            const result = await this.repo.unshelve(picked);
            if (result.location === 'server') {
                vscode.window.showInformationMessage(`TFVC: Unshelved "${picked}" from the server.`);
            } else {
                vscode.window.showWarningMessage(
                    `TFVC: Server unshelve failed — applied local shelf "${picked}" instead. ` +
                    `See the TFVC output channel for details.`
                );
            }
        } else if (action === 'Delete Shelveset') {
            const confirm = await vscode.window.showWarningMessage(
                `Delete shelveset "${picked}"?`,
                { modal: true },
                'Delete'
            );
            if (confirm === 'Delete') {
                const result = await this.repo.deleteShelve(picked);
                if (result.location === 'server') {
                    vscode.window.showInformationMessage(`TFVC: Deleted shelveset "${picked}" on the server.`);
                } else {
                    vscode.window.showWarningMessage(
                        `TFVC: Server delete failed — removed local shelf "${picked}" instead. ` +
                        `See the TFVC output channel for details.`
                    );
                }
            }
        }
    }

    private async pickShelveset(placeHolder: string): Promise<string | undefined> {
        const shelvesets = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'TFVC: Loading shelvesets...' },
            () => this.repo.listShelvesets()
        );

        if (shelvesets.length === 0) {
            vscode.window.showInformationMessage('TFVC: No shelvesets found.');
            return undefined;
        }

        const items = shelvesets.map(s => ({
            label: s.name,
            description: s.owner,
            detail: [s.date, s.comment].filter(Boolean).join(' — '),
            name: s.name,
        }));

        const picked = await vscode.window.showQuickPick(items, { placeHolder });
        return picked?.name;
    }

    private async handleHistory(): Promise<void> {
        const active = vscode.window.activeTextEditor?.document.uri;
        if (!active) {
            vscode.window.showWarningMessage('TFVC: Open a file to view its history.');
            return;
        }

        const entries = await this.repo.history(active.fsPath);
        if (entries.length === 0) {
            vscode.window.showInformationMessage('TFVC: No history found.');
            return;
        }

        const items = entries.map(e => ({
            label: `C${e.changeset}`,
            description: e.user,
            detail: `${e.date} — ${e.comment}`,
        }));

        await vscode.window.showQuickPick(items, {
            placeHolder: 'File history',
        });
    }

    /** Extract URIs from SCM command arguments (handles both resource state and direct URI args). */
    private resolveUris(args: any[]): vscode.Uri[] {
        const uris: vscode.Uri[] = [];

        for (const arg of args) {
            if (!arg) { continue; }

            // SourceControlResourceState — has a resourceUri property
            if (arg.resourceUri) {
                uris.push(arg.resourceUri);
            }
            // Array of resource states (multi-select)
            else if (Array.isArray(arg)) {
                for (const item of arg) {
                    if (item.resourceUri) {
                        uris.push(item.resourceUri);
                    } else if (item instanceof vscode.Uri) {
                        uris.push(item);
                    }
                }
            }
            // Direct URI
            else if (arg instanceof vscode.Uri) {
                uris.push(arg);
            }
        }

        return uris;
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}

function validateShelvesetName(value: string): string | undefined {
    if (!value.trim()) { return 'Name cannot be empty'; }
    if (value.startsWith('-')) { return 'Name cannot start with a dash'; }
    if (/[;$<>|&]/.test(value)) { return 'Name contains invalid characters'; }
    return undefined;
}
