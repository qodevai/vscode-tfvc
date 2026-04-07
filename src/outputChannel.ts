import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel('TFVC');
    }
    return channel;
}

export function logCommand(args: string[]): void {
    const ch = getOutputChannel();
    ch.appendLine(`[${new Date().toISOString()}] tf ${args.join(' ')}`);
}

export function logOutput(stdout: string, stderr: string): void {
    const ch = getOutputChannel();
    if (stdout.trim()) {
        ch.appendLine(stdout);
    }
    if (stderr.trim()) {
        ch.appendLine(`[stderr] ${stderr}`);
    }
    ch.appendLine('');
}

export function logError(message: string): void {
    const ch = getOutputChannel();
    ch.appendLine(`[ERROR] ${message}`);
}

export function showOutputOnError(): void {
    const config = vscode.workspace.getConfiguration('tfvc');
    if (config.get<boolean>('showOutputOnError', true)) {
        getOutputChannel().show(true);
    }
}
