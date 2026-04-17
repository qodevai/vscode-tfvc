import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel('TFVC');
    }
    return channel;
}

export function logError(message: string): void {
    const ch = getOutputChannel();
    ch.appendLine(`[ERROR] ${message}`);
}
