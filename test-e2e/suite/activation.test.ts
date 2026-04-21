/**
 * Regression tests for the v0.3.3 "command not found" bug.
 *
 * Pre-v0.3.3, most tfvc.* commands were registered inside
 * TfvcSCMProvider which was only instantiated after the ADO REST client
 * built successfully. Users without full configuration got
 * `command tfvc.shelvesets not found` from the palette. These tests
 * assert the opposite contract: every command listed in the extension
 * manifest is registered immediately at activation, regardless of
 * configuration state.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

const EXTENSION_ID = 'qodev.tfvc';

interface Manifest {
    contributes: {
        commands: Array<{ command: string }>;
    };
}

function readManifest(): Manifest {
    // __dirname at runtime is out-e2e/suite/; package.json sits two levels up
    // at the repo root.
    const repoRoot = path.resolve(__dirname, '..', '..');
    const raw = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
    return JSON.parse(raw) as Manifest;
}

suite('Activation', () => {
    test('extension resolves and activates', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} not found`);
        // Trigger activation via one of the always-registered commands.
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await ext!.activate();
        assert.strictEqual(ext!.isActive, true);
    });

    test('every contributed tfvc.* command is registered at activation (v0.3.3 regression)', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        if (!ext!.isActive) { await ext!.activate(); }

        const manifest = readManifest();
        const contributed = manifest.contributes.commands
            .map(c => c.command)
            .filter(id => id.startsWith('tfvc.'));
        assert.ok(contributed.length > 0, 'expected at least one tfvc.* command in manifest');

        const registered = new Set(await vscode.commands.getCommands(/*filterInternal=*/ true));
        const missing = contributed.filter(id => !registered.has(id));
        assert.deepStrictEqual(
            missing,
            [],
            `commands missing after activation — will report "command not found" to users: ${missing.join(', ')}`,
        );
    });
});
