/**
 * "Not configured" contract: when the user invokes a TFVC command before
 * adoOrg/adoProject/PAT are all set, they should get a helpful error
 * message rather than a silent no-op or VS Code's generic "command not
 * found".
 *
 * This catches the v0.3.3 regression class at the UX layer: every
 * user-facing SCM command is registered *and* surfaces the right
 * guidance. We stub vscode.window.showErrorMessage to capture what the
 * user would have seen without popping a modal.
 *
 * Excluded from this table:
 *   - tfvc.setPat         — always available; doesn't need a repo.
 *   - tfvc.initWorkspace  — has its own "not configured" path via notConfigured().
 *   - tfvc.refreshReviews — review tree has its own unconfigured UI
 *                           (shows "ADO REST client not configured" placeholder).
 *   - tfvc.include/exclude/openDiff/openFile/openReviewFileDiff —
 *     these are context-menu only (hidden from the palette via
 *     "commandPalette": [{ "when": "false" }]), so a user can't
 *     invoke them before configuration.
 *   - tfvc.submitVerdict  — same, context-menu on the review tree which
 *                           itself doesn't appear unconfigured.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'qodev.tfvc';

/**
 * All palette-invokable SCM commands that require a configured repo.
 * Each should route through wrapSCM → notConfigured() when the user
 * fires them without adoOrg/adoProject/PAT.
 */
const WRAP_SCM_COMMANDS = [
    'tfvc.refresh',
    'tfvc.checkin',
    'tfvc.sync',
    'tfvc.checkout',
    'tfvc.undo',
    'tfvc.undoAll',
    'tfvc.add',
    'tfvc.delete',
    'tfvc.shelve',
    'tfvc.unshelve',
    'tfvc.shelvesets',
    'tfvc.history',
] as const;

async function clearConfig(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('tfvc');
    await cfg.update('adoOrg', undefined, vscode.ConfigurationTarget.Global);
    await cfg.update('adoProject', undefined, vscode.ConfigurationTarget.Global);
    await cfg.update('adoBaseUrl', undefined, vscode.ConfigurationTarget.Global);
}

async function withErrorMessageRecorder(
    body: () => Promise<void>,
): Promise<string[]> {
    const seen: string[] = [];
    const original = vscode.window.showErrorMessage;
    (vscode.window as unknown as { showErrorMessage: typeof vscode.window.showErrorMessage })
        .showErrorMessage = ((message: string) => {
            seen.push(message);
            return Promise.resolve(undefined);
        }) as typeof vscode.window.showErrorMessage;
    try {
        await body();
    } finally {
        (vscode.window as unknown as { showErrorMessage: typeof vscode.window.showErrorMessage })
            .showErrorMessage = original;
    }
    return seen;
}

suite('Not-configured error surface', () => {
    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        if (!ext!.isActive) { await ext!.activate(); }
        await clearConfig();
    });

    for (const commandId of WRAP_SCM_COMMANDS) {
        test(`${commandId} without config shows the "configure settings" error`, async () => {
            const seen = await withErrorMessageRecorder(async () => {
                await vscode.commands.executeCommand(commandId);
            });

            assert.strictEqual(
                seen.length, 1,
                `${commandId}: expected one error toast, got: ${JSON.stringify(seen)}`,
            );
            const msg = seen[0];
            // Don't snapshot the whole string — assert the load-bearing parts
            // so the copy can be rewritten without breaking the test.
            assert.match(msg, /not configured/i, `${commandId}: expected "not configured" in: ${msg}`);
            assert.match(msg, /set pat/i, `${commandId}: expected "Set PAT" mention in: ${msg}`);
            assert.match(msg, /adoproject/i, `${commandId}: expected adoProject mention in: ${msg}`);
        });
    }

    test('tfvc.initWorkspace without config shows the "configure settings" error', async () => {
        // initWorkspace is wired differently from wrapSCM — it guards on
        // `repo` directly — so covered explicitly to catch divergence.
        const seen = await withErrorMessageRecorder(async () => {
            await vscode.commands.executeCommand('tfvc.initWorkspace');
        });
        assert.strictEqual(seen.length, 1, `expected one error toast, got: ${JSON.stringify(seen)}`);
        assert.match(seen[0], /not configured/i);
    });

    test('tfvc.setPat does NOT show "not configured" (always available)', async () => {
        // Set PAT is the one command users can run before configuring.
        // Prove it by invoking it and verifying no error toast fires.
        // Also stub showInputBox so we don't block on a real prompt.
        const seenErrors = await withErrorMessageRecorder(async () => {
            const originalInput = vscode.window.showInputBox;
            (vscode.window as unknown as { showInputBox: typeof vscode.window.showInputBox })
                .showInputBox = (() => Promise.resolve(undefined)) as typeof vscode.window.showInputBox;
            try {
                await vscode.commands.executeCommand('tfvc.setPat');
            } finally {
                (vscode.window as unknown as { showInputBox: typeof vscode.window.showInputBox })
                    .showInputBox = originalInput;
            }
        });
        assert.deepStrictEqual(seenErrors, [], 'setPat should not show an error toast');
    });
});
