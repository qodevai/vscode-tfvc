import { TfvcCli } from '../tfvcCli';

/**
 * Get the server version of a file for diff purposes.
 *
 * `tf print <serverPath> [-version:<version>] -noprompt`
 *
 * Returns the file content as a string.
 */
export async function print(
    cli: TfvcCli,
    serverPath: string,
    version?: string
): Promise<string> {
    const args = ['print', serverPath];
    if (version) {
        args.push(`-version:${version}`);
    }

    const result = await cli.executeOrThrow(args);
    return result.stdout;
}

/**
 * Get diff output for a file (informational).
 *
 * `tf diff <path> -noprompt`
 */
export async function diff(cli: TfvcCli, filePath: string): Promise<string> {
    const result = await cli.execute(['diff', filePath]);
    return result.stdout;
}
