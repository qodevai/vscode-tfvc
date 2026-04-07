import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { logCommand, logOutput, logError, showOutputOnError } from './outputChannel';

export interface TfResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export class TfvcError extends Error {
    constructor(
        message: string,
        public readonly exitCode: number,
        public readonly stderr: string
    ) {
        super(message);
        this.name = 'TfvcError';
    }
}

const MAX_CONCURRENT = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

export class TfvcCli {
    private running = 0;
    private queue: Array<{ resolve: () => void }> = [];

    constructor(
        private tfPath: string,
        private cwd: string
    ) {}

    get workingDirectory(): string {
        return this.cwd;
    }

    private async acquireSlot(): Promise<void> {
        if (this.running < MAX_CONCURRENT) {
            this.running++;
            return;
        }
        return new Promise<void>(resolve => {
            this.queue.push({ resolve });
        });
    }

    private releaseSlot(): void {
        const next = this.queue.shift();
        if (next) {
            next.resolve();
        } else {
            this.running--;
        }
    }

    async execute(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<TfResult> {
        await this.acquireSlot();

        const fullArgs = [...args, '-noprompt'];
        logCommand(fullArgs);

        try {
            return await new Promise<TfResult>((resolve, reject) => {
                const proc = spawn(this.tfPath, fullArgs, {
                    cwd: this.cwd,
                    env: process.env,
                    stdio: ['pipe', 'pipe', 'pipe'],
                });

                let stdout = '';
                let stderr = '';

                proc.stdout.on('data', (data: Buffer) => {
                    stdout += data.toString();
                });

                proc.stderr.on('data', (data: Buffer) => {
                    stderr += data.toString();
                });

                const timer = setTimeout(() => {
                    proc.kill('SIGTERM');
                    reject(new TfvcError(`tf command timed out after ${timeoutMs}ms`, -1, ''));
                }, timeoutMs);

                proc.on('close', (exitCode) => {
                    clearTimeout(timer);
                    logOutput(stdout, stderr);
                    resolve({
                        exitCode: exitCode ?? 1,
                        stdout,
                        stderr,
                    });
                });

                proc.on('error', (err) => {
                    clearTimeout(timer);
                    logError(`Failed to spawn tf: ${err.message}`);
                    reject(new TfvcError(`Failed to spawn tf: ${err.message}`, -1, ''));
                });

                // Close stdin immediately — we use -noprompt
                proc.stdin.end();
            });
        } finally {
            this.releaseSlot();
        }
    }

    async executeOrThrow(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<TfResult> {
        const result = await this.execute(args, timeoutMs);
        if (result.exitCode !== 0) {
            showOutputOnError();
            throw new TfvcError(
                `tf ${args[0]} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
                result.exitCode,
                result.stderr
            );
        }
        return result;
    }

    static resolve(): string {
        const config = vscode.workspace.getConfiguration('tfvc');
        const configured = config.get<string>('tfPath', '');
        return configured || 'tf';
    }
}
