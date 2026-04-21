/**
 * The `vscode` module is only available when this extension runs inside
 * VS Code's extension host. To let unit tests import modules that call
 * `logError` without pulling vscode in, we lazy-load it and fall back to
 * `console.error` when the runtime isn't present. `getOutputChannel()` is
 * still exposed for `extension.ts` to register the full `OutputChannel` as
 * a disposable.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let channel: any;
let loadFailed = false;

interface AppendLineChannel {
    appendLine(message: string): void;
}

function loadVscodeChannel(): AppendLineChannel | undefined {
    if (channel) { return channel; }
    if (loadFailed) { return undefined; }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vscode = require('vscode');
        channel = vscode.window.createOutputChannel('TFVC');
        return channel;
    } catch {
        loadFailed = true;
        return undefined;
    }
}

// Re-export as `any` so callers in extension.ts that pass the channel to
// `context.subscriptions.push(...)` still see the full `vscode.OutputChannel`
// interface (dispose, show, etc.) at the call site. In unit tests this
// never runs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getOutputChannel(): any {
    return loadVscodeChannel();
}

export function logError(message: string): void {
    const ch = loadVscodeChannel();
    if (ch) {
        ch.appendLine(`[ERROR] ${message}`);
    } else {
        // eslint-disable-next-line no-console
        console.error(`[TFVC] ${message}`);
    }
}
