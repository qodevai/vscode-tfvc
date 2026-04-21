/**
 * "Not configured" contract: when the user invokes a TFVC command before
 * adoOrg/adoProject/PAT are all set, they should get a helpful error
 * message rather than a silent no-op or VS Code's generic "command not
 * found".
 *
 * This catches the v0.3.3 regression class at the UX layer: the command
 * is registered *and* surfaces the right guidance. We stub the
 * vscode.window.showErrorMessage thenable so the test captures what the
 * user would have seen without actually popping a modal.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'qodev.tfvc';

suite('Not-configured error surface', () => {
    test('tfvc.shelvesets without config shows the "configure settings" error', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        if (!ext!.isActive) { await ext!.activate(); }

        // Clear any leftover config so the extension genuinely runs
        // unconfigured. These calls noop if not already set.
        const cfg = vscode.workspace.getConfiguration('tfvc');
        await cfg.update('adoOrg', undefined, vscode.ConfigurationTarget.Global);
        await cfg.update('adoProject', undefined, vscode.ConfigurationTarget.Global);
        await cfg.update('adoBaseUrl', undefined, vscode.ConfigurationTarget.Global);

        const seen: string[] = [];
        const original = vscode.window.showErrorMessage;
        // Replace with a recorder that resolves immediately (no user click).
        (vscode.window as unknown as { showErrorMessage: typeof vscode.window.showErrorMessage })
            .showErrorMessage = ((message: string) => {
                seen.push(message);
                return Promise.resolve(undefined);
            }) as typeof vscode.window.showErrorMessage;

        try {
            await vscode.commands.executeCommand('tfvc.shelvesets');
        } finally {
            (vscode.window as unknown as { showErrorMessage: typeof vscode.window.showErrorMessage })
                .showErrorMessage = original;
        }

        assert.strictEqual(seen.length, 1, `expected one error message, got: ${JSON.stringify(seen)}`);
        const msg = seen[0];
        // Don't snapshot the whole string — assert the signal load-bearing
        // parts so the message can be rewritten without breaking the test.
        assert.match(msg, /not configured/i, `expected "not configured" in: ${msg}`);
        assert.match(msg, /set pat/i, `expected "Set PAT" mention in: ${msg}`);
        assert.match(msg, /adoproject/i, `expected adoProject mention in: ${msg}`);
    });
});
