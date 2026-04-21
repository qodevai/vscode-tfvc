/**
 * Workspace-root detection: scan all open folders for `.vscode-tfvc/`
 * metadata directories. Returns every match so `activate()` can warn
 * the user when multiple TFVC workspaces are open in one window (they
 * conflict — there's one SCM provider and one repo at a time).
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { logError } from './outputChannel';

const STATE_DIR = '.vscode-tfvc';

/** Return every workspace folder that contains a `.vscode-tfvc/` directory. */
export function findTfvcRoots(): string[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return []; }

    const roots: string[] = [];
    for (const folder of folders) {
        const stateDir = vscode.Uri.joinPath(folder.uri, STATE_DIR);
        try {
            if (fs.existsSync(stateDir.fsPath)) {
                roots.push(folder.uri.fsPath);
            }
        } catch (err) {
            // Permission or symlink issues. Don't abort the scan — other
            // folders may still succeed — but leave a trace so users can
            // diagnose "TFVC didn't detect my workspace" without guessing.
            logError(`findTfvcRoots: could not stat ${stateDir.fsPath}: ${err}`);
        }
    }

    return roots;
}
