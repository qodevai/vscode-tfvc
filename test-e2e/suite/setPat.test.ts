/**
 * `tfvc.setPat` command contract:
 *   - User cancels prompt (undefined)   → no-op, no toast.
 *   - User submits empty string         → secret cleared, "removed" toast.
 *   - User submits a value              → secret stored, "stored" toast.
 *
 * Can't read the secret store directly — it belongs to the extension's
 * ExtensionContext, which tests don't have a handle to. Instead we
 * verify user-visible behaviour (which toast fires) and document the
 * three branches so a refactor that conflates them shows up as a
 * failing assertion.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'qodev.tfvc';

interface StubbedPrompts {
    /** Value returned by `showInputBox` on next call. */
    nextInputBoxValue: string | undefined;
    /** Info toasts captured in order. */
    infoToasts: string[];
    /** Error toasts captured in order. */
    errorToasts: string[];
    /** Restore the original vscode.window functions. */
    restore(): void;
}

function stubPrompts(value: string | undefined): StubbedPrompts {
    const infoToasts: string[] = [];
    const errorToasts: string[] = [];

    const originalInput = vscode.window.showInputBox;
    const originalInfo = vscode.window.showInformationMessage;
    const originalError = vscode.window.showErrorMessage;

    (vscode.window as unknown as { showInputBox: typeof vscode.window.showInputBox })
        .showInputBox = (() => Promise.resolve(value)) as typeof vscode.window.showInputBox;

    (vscode.window as unknown as { showInformationMessage: typeof vscode.window.showInformationMessage })
        .showInformationMessage = ((msg: string) => {
            infoToasts.push(msg);
            return Promise.resolve(undefined);
        }) as typeof vscode.window.showInformationMessage;

    (vscode.window as unknown as { showErrorMessage: typeof vscode.window.showErrorMessage })
        .showErrorMessage = ((msg: string) => {
            errorToasts.push(msg);
            return Promise.resolve(undefined);
        }) as typeof vscode.window.showErrorMessage;

    return {
        nextInputBoxValue: value,
        infoToasts,
        errorToasts,
        restore() {
            (vscode.window as unknown as { showInputBox: typeof vscode.window.showInputBox })
                .showInputBox = originalInput;
            (vscode.window as unknown as { showInformationMessage: typeof vscode.window.showInformationMessage })
                .showInformationMessage = originalInfo;
            (vscode.window as unknown as { showErrorMessage: typeof vscode.window.showErrorMessage })
                .showErrorMessage = originalError;
        },
    };
}

suite('tfvc.setPat', () => {
    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        if (!ext!.isActive) { await ext!.activate(); }
    });

    suiteTeardown(async () => {
        // Leave the secret store empty so subsequent tests (or the next
        // CI run) don't inherit a stored PAT.
        const stub = stubPrompts('');
        try {
            await vscode.commands.executeCommand('tfvc.setPat');
        } finally {
            stub.restore();
        }
    });

    test('cancel (undefined input) is a no-op — no toasts, no error', async () => {
        const stub = stubPrompts(undefined);
        try {
            await vscode.commands.executeCommand('tfvc.setPat');
        } finally {
            stub.restore();
        }
        assert.deepStrictEqual(stub.infoToasts, [], 'cancel must not show info toast');
        assert.deepStrictEqual(stub.errorToasts, [], 'cancel must not show error toast');
    });

    test('submitting a value shows the "stored" info toast', async () => {
        const stub = stubPrompts('fake-pat-value');
        try {
            await vscode.commands.executeCommand('tfvc.setPat');
        } finally {
            stub.restore();
        }
        assert.strictEqual(stub.infoToasts.length, 1, `expected one info toast, got: ${JSON.stringify(stub.infoToasts)}`);
        assert.match(stub.infoToasts[0], /stored/i, `expected "stored" in: ${stub.infoToasts[0]}`);
        assert.deepStrictEqual(stub.errorToasts, []);
    });

    test('submitting empty string shows the "removed" info toast', async () => {
        const stub = stubPrompts('');
        try {
            await vscode.commands.executeCommand('tfvc.setPat');
        } finally {
            stub.restore();
        }
        assert.strictEqual(stub.infoToasts.length, 1, `expected one info toast, got: ${JSON.stringify(stub.infoToasts)}`);
        assert.match(stub.infoToasts[0], /removed/i, `expected "removed" in: ${stub.infoToasts[0]}`);
        assert.deepStrictEqual(stub.errorToasts, []);
    });

    test('the three branches produce distinct messages (stored vs removed)', async () => {
        // Regression guard against a refactor that conflates the two paths.
        const store = stubPrompts('x');
        try {
            await vscode.commands.executeCommand('tfvc.setPat');
        } finally {
            store.restore();
        }
        const clear = stubPrompts('');
        try {
            await vscode.commands.executeCommand('tfvc.setPat');
        } finally {
            clear.restore();
        }
        assert.notStrictEqual(
            store.infoToasts[0], clear.infoToasts[0],
            'stored/removed toasts must differ so users know what actually happened',
        );
    });
});
