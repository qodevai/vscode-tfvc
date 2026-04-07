import { TfvcCli } from '../tfvcCli';

export interface HistoryEntry {
    changeset: number;
    user: string;
    date: string;
    comment: string;
}

/**
 * Get file/folder history.
 *
 * `tf history <path> -recursive -stopafter:<count> -format:xml -noprompt`
 */
export async function history(
    cli: TfvcCli,
    filePath: string,
    count = 25
): Promise<HistoryEntry[]> {
    const result = await cli.execute([
        'history', filePath,
        '-recursive',
        `-stopafter:${count}`,
        '-format:xml',
    ]);

    if (result.exitCode !== 0 || !result.stdout.trim()) {
        return [];
    }

    return parseHistoryXml(result.stdout);
}

function parseHistoryXml(xml: string): HistoryEntry[] {
    const entries: HistoryEntry[] = [];

    // Match <changeset ... /> or <changeset ...>...</changeset>
    const csRegex = /<changeset\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/changeset>)/g;
    let match: RegExpExecArray | null;

    while ((match = csRegex.exec(xml)) !== null) {
        const attrs = match[1];
        const body = match[2] || '';

        const id = extractAttr(attrs, 'id');
        const owner = extractAttr(attrs, 'owner') || extractAttr(attrs, 'committer') || '';
        const date = extractAttr(attrs, 'date') || '';

        // Comment may be in a <comment> child element or as an attribute
        let comment = extractAttr(attrs, 'comment') || '';
        if (!comment) {
            const commentMatch = /<comment>([\s\S]*?)<\/comment>/.exec(body);
            if (commentMatch) {
                comment = commentMatch[1].trim();
            }
        }

        if (id) {
            entries.push({
                changeset: parseInt(id, 10),
                user: owner,
                date,
                comment,
            });
        }
    }

    return entries;
}

function extractAttr(attrs: string, name: string): string | undefined {
    const regex = new RegExp(`${name}="([^"]*)"`, 'i');
    const match = regex.exec(attrs);
    return match ? match[1] : undefined;
}
