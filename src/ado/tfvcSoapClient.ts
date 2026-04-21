/**
 * SOAP client for the TFVC repository service — covers the write operations
 * Azure DevOps's REST API doesn't expose: workspace create/delete, pending
 * change registration, shelve, and shelveset delete.
 *
 * Envelope shapes ported from the TEE-generated `_RepositorySoap12Service`
 * under `source/com.microsoft.tfs.core.ws/generated-src/ms/tfs/versioncontrol/
 * clientservices/_03/` in microsoft/team-explorer-everywhere (MIT-licensed).
 * TEE uses SOAP 1.2 but the service accepts SOAP 1.1; we use 1.1 here to
 * stay consistent with `AdoSoapClient` (discussions).
 *
 * Endpoint path: `{collectionBase}/VersionControl/v1.0/Repository.asmx`.
 * The collection base carries the on-prem `/tfs/<Collection>` suffix or, on
 * cloud, resolves to `https://dev.azure.com/<org>` (no collection path).
 */

import { httpRequest, buildBasicAuthHeader } from './httpClient';
import { extractAttr, decodeXmlEntities, escapeXmlAttr } from '../xmlUtils';
import { classifyHttpError, TfvcError } from '../errors';

const NS_SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const NS_TFVC = 'http://schemas.microsoft.com/TeamFoundation/2005/06/VersionControl/ClientServices/03';

/** Matches _ChangeRequest and related enums in TEE. */
export type PendChangeType = 'Add' | 'Edit' | 'Delete' | 'Rename';

/** _ItemType enum from TEE — only File and Folder matter for our surface. */
export type PendItemType = 'File' | 'Folder';

export interface PendChangeRequest {
    /** Server path (e.g. `$/Project/src/foo.ts`). */
    serverPath: string;
    changeType: PendChangeType;
    itemType: PendItemType;
    /** The download id returned by `upload.ashx`. 0 for Delete; the upload's `did` for Add/Edit. */
    downloadId: number;
    /** Encoding flag — -2 for binary, a Windows code page for text. Use -2 unless the caller knows better. */
    encoding?: number;
    /** Rename target server path. Only for `Rename`. */
    target?: string;
}

export interface WorkspaceInfo {
    name: string;
    /**
     * Primary owner identifier. On cloud ADO this is the user's unique name
     * (e.g. `user@tenant.com`); the server validates it against the PAT's
     * identity and rejects the workspace with "OwnerName null" if it can't
     * resolve. Use `getBotIdentity().uniqueName` when constructing.
     */
    owner: string;
    /** Display name shown in TFS UI. */
    ownerDisplayName: string;
    /** Explicit unique-name hint ("owneruniq" attribute). Optional on on-prem servers that derive it from `owner`. */
    ownerUniqueName?: string;
    computer: string;
    comment?: string;
}

/**
 * A _Failure element from the server's response. Returned by Shelve
 * (non-fatal: some items couldn't shelve but others did), among others.
 */
export interface ShelveFailure {
    code: string;
    severity: string;
    item?: string;
    message?: string;
}

export class TfvcSoapClient {
    private readonly base: string;
    private readonly authHeader: string;

    constructor(base: string, pat: string) {
        this.base = base;
        this.authHeader = buildBasicAuthHeader(pat);
    }

    /** Stable endpoint path for the TFVC repository SOAP service. */
    private get endpoint(): string {
        return `${this.base}/VersionControl/v1.0/Repository.asmx`;
    }

    // ── Workspace lifecycle ────────────────────────────────────────────

    /**
     * Create a server-registered TFVC workspace. The server echoes back the
     * created workspace; caller should rely on the server-reported name/owner
     * (it may normalize them) for subsequent calls.
     */
    async createWorkspace(ws: WorkspaceInfo): Promise<WorkspaceInfo> {
        const xml = this.envelope('CreateWorkspace', [
            '<t:workspace>',
            this.workspaceElement(ws),
            '</t:workspace>',
        ].join(''));
        const response = await this.post(xml, 'CreateWorkspace');
        const wsEl = /<Workspace\s+([^>]*?)(?:\/>|>)/i.exec(response);
        if (!wsEl) {
            throw new TfvcError(`CreateWorkspace: could not parse response: ${response.slice(0, 500)}`);
        }
        return this.parseWorkspace(wsEl[1]);
    }

    /**
     * Query a workspace by name+owner. Returns undefined if it doesn't exist
     * (server returns a SOAP fault that we translate into undefined so callers
     * can recreate transparently).
     */
    async queryWorkspace(name: string, owner: string): Promise<WorkspaceInfo | undefined> {
        const xml = this.envelope('QueryWorkspace', [
            `<t:workspaceName>${escapeXmlAttr(name)}</t:workspaceName>`,
            `<t:ownerName>${escapeXmlAttr(owner)}</t:ownerName>`,
        ].join(''));
        try {
            const response = await this.post(xml, 'QueryWorkspace');
            const wsEl = /<Workspace\s+([^>]*?)(?:\/>|>)/i.exec(response);
            return wsEl ? this.parseWorkspace(wsEl[1]) : undefined;
        } catch (err) {
            // "workspace does not exist" comes back as an HTTP 500 with a SOAP
            // fault; classifyHttpError stores the parsed fault text on `detail`,
            // not `message`. Only a genuine not-found swallows here — other
            // server errors propagate untouched.
            if (err instanceof TfvcError) {
                const haystack = `${err.message} ${err.detail ?? ''}`;
                if (/WorkspaceNotFound|does not exist/i.test(haystack)) {
                    return undefined;
                }
            }
            throw err;
        }
    }

    async deleteWorkspace(name: string, owner: string): Promise<void> {
        const xml = this.envelope('DeleteWorkspace', [
            `<t:workspaceName>${escapeXmlAttr(name)}</t:workspaceName>`,
            `<t:ownerName>${escapeXmlAttr(owner)}</t:ownerName>`,
        ].join(''));
        await this.post(xml, 'DeleteWorkspace');
    }

    // ── Pending changes ────────────────────────────────────────────────

    /**
     * Register pending changes against the given workspace. Each change must
     * already have its content uploaded via `TfvcUploadClient`, with the
     * returned download id passed here as `downloadId`. Deletes pass 0.
     */
    async pendChanges(
        workspaceName: string,
        workspaceOwner: string,
        changes: PendChangeRequest[],
    ): Promise<void> {
        const body = [
            `<t:workspaceName>${escapeXmlAttr(workspaceName)}</t:workspaceName>`,
            `<t:ownerName>${escapeXmlAttr(workspaceOwner)}</t:ownerName>`,
            '<t:changes>',
            ...changes.map(c => this.changeRequestElement(c)),
            '</t:changes>',
            // Flags: 0 = none. Dev10+ recognises this field but tolerates 0.
            '<t:pendChangesOptions>0</t:pendChangesOptions>',
            '<t:supportedFeatures>0</t:supportedFeatures>',
        ].join('');
        await this.post(this.envelope('PendChanges', body), 'PendChanges');
    }

    async undoPendingChanges(
        workspaceName: string,
        workspaceOwner: string,
        serverItems: string[],
    ): Promise<void> {
        const body = [
            `<t:workspaceName>${escapeXmlAttr(workspaceName)}</t:workspaceName>`,
            `<t:ownerName>${escapeXmlAttr(workspaceOwner)}</t:ownerName>`,
            '<t:items>',
            ...serverItems.map(p =>
                `<t:ItemSpec item="${escapeXmlAttr(p)}" recurse="None" did="0"/>`
            ),
            '</t:items>',
        ].join('');
        await this.post(this.envelope('UndoPendingChanges', body), 'UndoPendingChanges');
    }

    // ── Shelveset ops ──────────────────────────────────────────────────

    /**
     * Shelve the named subset of the workspace's pending changes. Returns
     * any non-fatal failures reported per-item (server sometimes partially
     * shelves and surfaces the rest this way).
     */
    async shelve(
        workspaceName: string,
        workspaceOwner: string,
        serverItems: string[],
        shelveset: { name: string; owner: string; ownerDisplayName: string; comment?: string },
        replace: boolean,
    ): Promise<ShelveFailure[]> {
        const now = new Date().toISOString();
        const body = [
            `<t:workspaceName>${escapeXmlAttr(workspaceName)}</t:workspaceName>`,
            `<t:workspaceOwner>${escapeXmlAttr(workspaceOwner)}</t:workspaceOwner>`,
            '<t:serverItems>',
            ...serverItems.map(p => `<t:string>${escapeXmlAttr(p)}</t:string>`),
            '</t:serverItems>',
            '<t:shelveset',
            ` name="${escapeXmlAttr(shelveset.name)}"`,
            ` owner="${escapeXmlAttr(shelveset.owner)}"`,
            ` ownerdisp="${escapeXmlAttr(shelveset.ownerDisplayName)}"`,
            ` date="${now}"`,
            ' ce="false">',
            `<t:Comment>${escapeXmlAttr(shelveset.comment || '')}</t:Comment>`,
            '</t:shelveset>',
            `<t:replace>${replace ? 'true' : 'false'}</t:replace>`,
        ].join('');
        const response = await this.post(this.envelope('Shelve', body), 'Shelve');
        return parseFailures(response);
    }

    async deleteShelveset(shelvesetName: string, ownerName: string): Promise<void> {
        const body = [
            `<t:shelvesetName>${escapeXmlAttr(shelvesetName)}</t:shelvesetName>`,
            `<t:ownerName>${escapeXmlAttr(ownerName)}</t:ownerName>`,
        ].join('');
        await this.post(this.envelope('DeleteShelveset', body), 'DeleteShelveset');
    }

    // ── Internals ──────────────────────────────────────────────────────

    private envelope(operation: string, body: string): string {
        return [
            '<?xml version="1.0" encoding="utf-8"?>',
            `<soap:Envelope xmlns:soap="${NS_SOAP}" xmlns:t="${NS_TFVC}">`,
            '<soap:Body>',
            `<t:${operation}>`,
            body,
            `</t:${operation}>`,
            '</soap:Body>',
            '</soap:Envelope>',
        ].join('');
    }

    private async post(xml: string, operation: string): Promise<string> {
        const res = await httpRequest(this.endpoint, {
            method: 'POST',
            headers: {
                'Authorization': this.authHeader,
                'Content-Type': 'text/xml; charset=utf-8',
                // SOAP 1.1 requires the action as a separate header.
                'SOAPAction': `"${NS_TFVC}/${operation}"`,
            },
            body: xml,
        });
        if (res.status >= 400) {
            // Try to pull the fault string so the caller gets a useful error.
            const fault = /<faultstring>([\s\S]*?)<\/faultstring>/i.exec(res.body);
            const detail = fault ? decodeXmlEntities(fault[1]) : res.body.slice(0, 500);
            // For SOAP calls the server's faultstring is the diagnostic
            // signal — classifyHttpError's user-friendly "server error (500)"
            // hides it. Keep status + prefix but fold the detail into the
            // message so stack traces and test output show what went wrong.
            const err = classifyHttpError(res.status, detail, `TFVC SOAP ${operation} failed`);
            if (detail && !err.message.includes(detail)) {
                throw new TfvcError(
                    `${err.message} (${operation}: ${detail})`,
                    err.statusCode,
                    detail,
                );
            }
            throw err;
        }
        return res.body;
    }

    private workspaceElement(ws: WorkspaceInfo): string {
        return [
            '<t:Workspace',
            ` name="${escapeXmlAttr(ws.name)}"`,
            ` owner="${escapeXmlAttr(ws.owner)}"`,
            ` ownerdisp="${escapeXmlAttr(ws.ownerDisplayName)}"`,
            ws.ownerUniqueName ? ` owneruniq="${escapeXmlAttr(ws.ownerUniqueName)}"` : '',
            ` computer="${escapeXmlAttr(ws.computer)}"`,
            ws.comment ? ` comment="${escapeXmlAttr(ws.comment)}"` : '',
            ' islocal="false"/>',
        ].join('');
    }

    private changeRequestElement(c: PendChangeRequest): string {
        const parts = [
            '<t:ChangeRequest',
            ` req="${c.changeType}"`,
            ` did="${c.downloadId}"`,
            ` enc="${c.encoding ?? -2}"`,
            ` type="${c.itemType}"`,
            ' lock="Unchanged"',
            c.target ? ` target="${escapeXmlAttr(c.target)}"` : '',
            '>',
            `<t:item item="${escapeXmlAttr(c.serverPath)}" recurse="None" did="0"/>`,
            '</t:ChangeRequest>',
        ];
        return parts.join('');
    }

    private parseWorkspace(attrs: string): WorkspaceInfo {
        return {
            name: extractAttr(attrs, 'name') || '',
            owner: extractAttr(attrs, 'owner') || '',
            ownerDisplayName: extractAttr(attrs, 'ownerdisp') || '',
            ownerUniqueName: extractAttr(attrs, 'owneruniq'),
            computer: extractAttr(attrs, 'computer') || '',
            comment: extractAttr(attrs, 'comment'),
        };
    }
}

/**
 * Parse `<Failure ...>` elements from a SOAP response. Shelve reports
 * per-item failures this way even on HTTP 200.
 */
function parseFailures(xml: string): ShelveFailure[] {
    const failures: ShelveFailure[] = [];
    const regex = /<Failure\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/Failure>)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(xml)) !== null) {
        const attrs = match[1];
        const body = match[2] || '';
        const messageMatch = /<message[^>]*>([\s\S]*?)<\/message>/i.exec(body);
        failures.push({
            code: extractAttr(attrs, 'code') || '',
            severity: extractAttr(attrs, 'sev') || '',
            item: extractAttr(attrs, 'item'),
            message: messageMatch ? decodeXmlEntities(messageMatch[1]) : undefined,
        });
    }
    return failures;
}
