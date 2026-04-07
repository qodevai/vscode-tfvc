import { TfvcCli } from '../tfvcCli';

/**
 * Add files to version control.
 *
 * `tf add [files...] -noprompt`
 */
export async function add(cli: TfvcCli, files: string[]): Promise<void> {
    if (files.length === 0) { return; }
    await cli.executeOrThrow(['add', ...files]);
}
