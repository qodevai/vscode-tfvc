import { TfvcCli } from '../tfvcCli';

export interface CheckinResult {
    changeset: number;
}

/**
 * Check in pending changes.
 *
 * `tf checkin -comment:"msg" [-associate:1234,5678] [files...] -noprompt`
 *
 * Returns the changeset number on success.
 */
export async function checkin(
    cli: TfvcCli,
    files: string[],
    comment: string,
    workItems?: number[]
): Promise<CheckinResult> {
    const args = ['checkin'];

    if (comment) {
        // Wrap comment in quotes for TEE-CLC to handle special characters
        args.push(`-comment:"${comment.replace(/"/g, '\\"')}"`);
    }

    if (workItems && workItems.length > 0) {
        args.push(`-associate:${workItems.join(',')}`);
    }

    if (files.length > 0) {
        args.push(...files);
    } else {
        args.push('-recursive');
    }

    const result = await cli.executeOrThrow(args);

    // Parse changeset number from output like "Changeset #12345 checked in."
    const match = /Changeset\s+#?(\d+)/i.exec(result.stdout);
    const changeset = match ? parseInt(match[1], 10) : 0;

    return { changeset };
}
