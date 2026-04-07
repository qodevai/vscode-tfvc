import { TfvcCli } from '../tfvcCli';

/**
 * Mark files for deletion in TFVC.
 *
 * `tf delete [files...] -noprompt`
 */
export async function deleteFiles(cli: TfvcCli, files: string[]): Promise<void> {
    if (files.length === 0) { return; }
    await cli.executeOrThrow(['delete', ...files]);
}
