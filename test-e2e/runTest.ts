/**
 * Entry point for the VS Code extension-host test suite.
 *
 * Downloads (or reuses) a VS Code binary, launches it with the extension
 * loaded from the workspace root, and asks it to run the compiled test
 * bootstrap at out-e2e/test-e2e/suite/index.js. All test assertions run
 * inside the extension host, where `import * as vscode` resolves to the
 * real API.
 */

import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
    try {
        // At runtime __dirname is out-e2e/ under the repo root.
        const extensionDevelopmentPath = path.resolve(__dirname, '..');
        const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');

        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            // Open an empty workspace so activation is command-triggered, not
            // workspaceContains-triggered. Lets us exercise the v0.3.3 fix
            // (commands registered unconditionally, even without a workspace).
            launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
        });
    } catch (err) {
        console.error('e2e: failed to run tests', err);
        process.exit(1);
    }
}

void main();
