import { TfvcCli } from '../tfvcCli';

export interface ShelvesetInfo {
    name: string;
    owner: string;
    date: string;
    comment: string;
}

/**
 * Shelve pending changes.
 *
 * `tf shelve <name> [-comment:"msg"] -noprompt`
 */
export async function shelve(
    cli: TfvcCli,
    name: string,
    comment?: string
): Promise<void> {
    const args = ['shelve', name];
    if (comment) {
        args.push(`-comment:${comment}`);
    }
    args.push('-replace'); // overwrite if shelveset with same name exists
    await cli.executeOrThrow(args);
}

/**
 * Unshelve a shelveset.
 *
 * `tf unshelve <name> -noprompt`
 */
export async function unshelve(cli: TfvcCli, name: string): Promise<void> {
    await cli.executeOrThrow(['unshelve', name]);
}

/**
 * List shelvesets from the server.
 *
 * `tf shelvesets [-owner:<owner>] -format:xml -noprompt`
 */
export async function listShelvesets(
    cli: TfvcCli,
    owner?: string
): Promise<ShelvesetInfo[]> {
    const args = ['shelvesets', '-format:xml'];
    if (owner) {
        args.push(`-owner:${owner}`);
    }

    const result = await cli.execute(args);

    if (result.exitCode !== 0 || !result.stdout.trim()) {
        return [];
    }

    const stdout = result.stdout.trim();
    if (stdout.startsWith('<?xml') || stdout.includes('<shelvesets')) {
        return parseShelvesetsXml(stdout);
    }
    return parseShelvesetsText(stdout);
}

function parseShelvesetsXml(xml: string): ShelvesetInfo[] {
    const shelvesets: ShelvesetInfo[] = [];

    const regex = /<shelveset\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/shelveset>)/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(xml)) !== null) {
        const attrs = match[1];
        const body = match[2] || '';

        const name = extractAttr(attrs, 'name') || '';
        const owner = extractAttr(attrs, 'owner') || '';
        const date = extractAttr(attrs, 'date') || '';

        let comment = extractAttr(attrs, 'comment') || '';
        if (!comment) {
            const commentMatch = /<comment>([\s\S]*?)<\/comment>/.exec(body);
            if (commentMatch) {
                comment = commentMatch[1].trim();
            }
        }

        if (name) {
            shelvesets.push({ name, owner, date, comment });
        }
    }

    return shelvesets;
}

function parseShelvesetsText(text: string): ShelvesetInfo[] {
    const shelvesets: ShelvesetInfo[] = [];
    const lines = text.split('\n').map(l => l.trimEnd());

    // Skip header/separator lines, parse "name;owner" or tabular format
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('-') || /^shelveset/i.test(trimmed) || /^name/i.test(trimmed)) {
            continue;
        }

        // Try "name;owner  date  comment" or split on multiple spaces
        const parts = trimmed.split(/\s{2,}/);
        if (parts.length >= 1) {
            const nameOwner = parts[0].split(';');
            shelvesets.push({
                name: nameOwner[0].trim(),
                owner: nameOwner[1]?.trim() || '',
                date: parts[1]?.trim() || '',
                comment: parts.slice(2).join(' ').trim(),
            });
        }
    }

    return shelvesets;
}

function extractAttr(attrs: string, name: string): string | undefined {
    const regex = new RegExp(`${name}="([^"]*)"`, 'i');
    const match = regex.exec(attrs);
    return match ? match[1] : undefined;
}
