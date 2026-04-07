import { TfvcCli } from '../tfvcCli';

/**
 * Check out files for editing.
 *
 * `tf checkout [files...] -noprompt`
 *
 * In TFVC, "checkout" places an edit lock on the server so others know
 * you're working on the file. It also removes the read-only attribute.
 */
export async function checkout(cli: TfvcCli, files: string[]): Promise<void> {
    if (files.length === 0) { return; }
    await cli.executeOrThrow(['checkout', ...files]);
}
