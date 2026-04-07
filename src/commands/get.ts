import { TfvcCli } from '../tfvcCli';

export interface SyncResult {
    path: string;
    action: 'getting' | 'replacing' | 'deleting' | 'conflict';
}

/**
 * Get latest version from server.
 *
 * `tf get [-recursive] [paths...] -noprompt`
 */
export async function getLatest(
    cli: TfvcCli,
    paths?: string[]
): Promise<SyncResult[]> {
    const args = ['get', '-recursive'];
    if (paths && paths.length > 0) {
        args.push(...paths);
    }

    const result = await cli.executeOrThrow(args, 120_000); // sync can be slow

    return parseSyncOutput(result.stdout);
}

function parseSyncOutput(stdout: string): SyncResult[] {
    const results: SyncResult[] = [];

    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }

        // TEE-CLC output: "Getting /local/path" or "Replacing /local/path"
        const match = /^(Getting|Replacing|Deleting|Conflict)\s+(.+)/i.exec(trimmed);
        if (match) {
            const actionMap: Record<string, SyncResult['action']> = {
                'getting': 'getting',
                'replacing': 'replacing',
                'deleting': 'deleting',
                'conflict': 'conflict',
            };
            results.push({
                path: match[2].trim(),
                action: actionMap[match[1].toLowerCase()] || 'getting',
            });
        }
    }

    return results;
}
