import { TfvcCli } from '../tfvcCli';

/**
 * Undo pending changes.
 *
 * `tf undo [files...] -noprompt`
 * `tf undo . -recursive -noprompt`  (undo all)
 */
export async function undo(cli: TfvcCli, files: string[]): Promise<void> {
    if (files.length === 0) { return; }
    await cli.executeOrThrow(['undo', ...files]);
}

export async function undoAll(cli: TfvcCli): Promise<void> {
    await cli.executeOrThrow(['undo', '.', '-recursive']);
}
