import * as path from 'path';
import { TfvcCli } from '../tfvcCli';
import { extractAttr } from '../xmlUtils';

export type ChangeType = 'edit' | 'add' | 'delete' | 'rename' | 'branch' | 'merge' | 'lock' | 'undelete';

export interface PendingChange {
    localPath: string;
    serverPath: string;
    changeType: ChangeType;
    /** For renames: the original server path */
    sourceServerPath?: string;
}

/**
 * Parse `tf status -recursive -format:xml` output.
 *
 * XML format from TEE-CLC:
 * <status>
 *   <pending-changes>
 *     <pending-change computer="..." date="..." ... change-type="edit"
 *       server-item="$/Project/path" local-item="/local/path" .../>
 *   </pending-changes>
 * </status>
 *
 * Falls back to plain-text parsing if XML is unavailable.
 */
export async function getStatus(cli: TfvcCli): Promise<PendingChange[]> {
    const result = await cli.execute(['status', '-recursive', '-format:xml']);

    // Exit code 1 with empty output often means "no pending changes"
    if (result.exitCode !== 0 && !result.stdout.trim()) {
        return [];
    }

    const stdout = result.stdout.trim();
    if (!stdout) {
        return [];
    }

    // Try XML parsing first
    if (stdout.startsWith('<?xml') || stdout.startsWith('<status')) {
        return parseStatusXml(stdout);
    }

    // Fallback to plain text
    return parseStatusText(stdout, cli.workingDirectory);
}

function parseStatusXml(xml: string): PendingChange[] {
    const changes: PendingChange[] = [];

    // Simple regex-based XML parser — avoids needing an XML library.
    // Matches <pending-change ... /> elements.
    const pendingChangeRegex = /<pending-change\s+([^>]*?)\/>/g;
    let match: RegExpExecArray | null;

    while ((match = pendingChangeRegex.exec(xml)) !== null) {
        const attrs = match[1];
        const changeType = extractAttr(attrs, 'change-type');
        const serverItem = extractAttr(attrs, 'server-item');
        const localItem = extractAttr(attrs, 'local-item');
        const sourceItem = extractAttr(attrs, 'source-item');

        if (changeType && localItem) {
            changes.push({
                localPath: localItem,
                serverPath: serverItem || '',
                changeType: normalizeChangeType(changeType),
                sourceServerPath: sourceItem || undefined,
            });
        }
    }

    return changes;
}

/**
 * Plain text format (one line per change):
 *
 * $/Project/file.txt;C123
 *   Local: /Users/.../file.txt
 *   Change: edit
 *
 * Or single-line format:
 * file.txt        edit        $/Project/file.txt        Local change
 */
function parseStatusText(text: string, cwd: string): PendingChange[] {
    const changes: PendingChange[] = [];
    const lines = text.split('\n').map(l => l.trimEnd());

    // Try tabular format: columns separated by multiple spaces
    // Headers like: "File name   Change   Local path   ..."
    let headerIdx = -1;
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
        if (/file\s+name/i.test(lines[i]) || /change\s+type/i.test(lines[i])) {
            headerIdx = i;
            break;
        }
    }

    if (headerIdx >= 0) {
        // Skip header and separator lines
        const dataStart = headerIdx + 2;
        for (let i = dataStart; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line || line.startsWith('-')) { continue; }

            // Split on 2+ spaces
            const parts = line.split(/\s{2,}/);
            if (parts.length >= 3) {
                const fileName = parts[0];
                const change = parts[1];
                const localPath = parts[2] || path.join(cwd, fileName);

                changes.push({
                    localPath,
                    serverPath: parts[3] || '',
                    changeType: normalizeChangeType(change),
                });
            }
        }
        return changes;
    }

    // Multi-line block format
    let currentServer = '';
    let currentLocal = '';
    let currentChange: ChangeType = 'edit';

    for (const line of lines) {
        const changeLine = /^\s*Change:\s*(.+)/i.exec(line);
        const localLine = /^\s*Local(?:\s*item)?:\s*(.+)/i.exec(line);
        const serverLine = /^\$\/(.+)/i.exec(line);

        if (serverLine) {
            // Flush previous
            if (currentLocal) {
                changes.push({
                    localPath: currentLocal,
                    serverPath: currentServer,
                    changeType: currentChange,
                });
            }
            currentServer = '$/' + serverLine[1].split(';')[0];
            currentLocal = '';
            currentChange = 'edit';
        } else if (localLine) {
            currentLocal = localLine[1].trim();
        } else if (changeLine) {
            currentChange = normalizeChangeType(changeLine[1].trim());
        }
    }

    // Flush last
    if (currentLocal) {
        changes.push({
            localPath: currentLocal,
            serverPath: currentServer,
            changeType: currentChange,
        });
    }

    return changes;
}

function normalizeChangeType(raw: string): ChangeType {
    const lower = raw.toLowerCase().split(/[,\s]+/)[0];
    switch (lower) {
        case 'edit': return 'edit';
        case 'add': return 'add';
        case 'delete': return 'delete';
        case 'rename': return 'rename';
        case 'branch': return 'branch';
        case 'merge': return 'merge';
        case 'lock': return 'lock';
        case 'undelete': return 'undelete';
        default: return 'edit';
    }
}
