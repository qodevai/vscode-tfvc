/**
 * Azure DevOps TFVC REST client — ported from reviewer backend TfvcClient.
 *
 * All operations use REST APIs (no TEE-CLC dependency).
 * Supports both cloud (dev.azure.com) and on-prem (custom base_url).
 */

import * as https from 'https';
import * as http from 'http';
import {
    TfvcItem,
    ShelvesetChange,
    ShelvesetInfo,
    WorkItem,
    CodeReviewRequest,
    ReviewVerdict,
    VERDICT_STATUS_CODE,
    WiqlResult,
} from './types';
import { logError } from '../outputChannel';

interface RequestOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
}

export class AdoRestClient {
    private readonly base: string;
    private readonly apiVersion: string;
    private readonly authHeader: string;
    private readonly project: string;
    readonly scope: string;

    private identityCache: { id: string; displayName: string } | undefined;

    constructor(
        org: string,
        pat: string,
        project: string,
        baseUrl = '',
        collectionPath = ''
    ) {
        if (baseUrl) {
            this.base = `${baseUrl.replace(/\/+$/, '')}${collectionPath}`;
            this.apiVersion = '6.0';
        } else {
            this.base = `https://dev.azure.com/${org}`;
            this.apiVersion = '7.1';
        }
        this.project = project;
        this.scope = `$/${project}`;
        this.authHeader = 'Basic ' + Buffer.from(`:${pat}`).toString('base64');
    }

    // ── HTTP helpers ─────────────────────────────────────────────────────

    private async request(url: string, options: RequestOptions = {}): Promise<{ status: number; body: string }> {
        const method = options.method || 'GET';
        const headers: Record<string, string> = {
            'Authorization': this.authHeader,
            ...options.headers,
        };

        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url);
            const transport = parsedUrl.protocol === 'https:' ? https : http;
            const req = transport.request(
                {
                    hostname: parsedUrl.hostname,
                    port: parsedUrl.port,
                    path: parsedUrl.pathname + parsedUrl.search,
                    method,
                    headers,
                    timeout: options.timeout || 30000,
                },
                (res) => {
                    let data = '';
                    res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                    res.on('end', () => {
                        resolve({ status: res.statusCode || 0, body: data });
                    });
                }
            );
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error(`Request timed out: ${method} ${url}`));
            });
            if (options.body) {
                req.write(options.body);
            }
            req.end();
        });
    }

    /** URL-encoded project name for use in API paths. */
    private get encodedProject(): string {
        return encodeURIComponent(this.project);
    }

    private buildUrl(path: string, params: Record<string, string>): string {
        params['api-version'] = this.apiVersion;
        const qs = new URLSearchParams(params).toString();
        return `${this.base}${path}${qs ? '?' + qs : ''}`;
    }

    private async get(path: string, params: Record<string, string> = {}): Promise<any> {
        const url = this.buildUrl(path, params);
        const res = await this.request(url);
        if (res.status >= 400) {
            throw new Error(`ADO API error ${res.status}: ${res.body.slice(0, 500)}`);
        }
        return JSON.parse(res.body);
    }

    private async post(path: string, body: any, params: Record<string, string> = {}, contentType = 'application/json'): Promise<any> {
        const url = this.buildUrl(path, params);
        const res = await this.request(url, {
            method: 'POST',
            headers: { 'Content-Type': contentType },
            body: typeof body === 'string' ? body : JSON.stringify(body),
        });
        if (res.status >= 400) {
            throw new Error(`ADO API error ${res.status}: ${res.body.slice(0, 500)}`);
        }
        return JSON.parse(res.body);
    }

    private async patch(path: string, body: any, params: Record<string, string> = {}): Promise<any> {
        const url = this.buildUrl(path, params);
        const res = await this.request(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json-patch+json' },
            body: JSON.stringify(body),
        });
        if (res.status >= 400) {
            throw new Error(`ADO API error ${res.status}: ${res.body.slice(0, 500)}`);
        }
        return JSON.parse(res.body);
    }

    async getRaw(url: string): Promise<string> {
        const res = await this.request(url);
        if (res.status >= 400) {
            throw new Error(`ADO download error ${res.status}: ${res.body.slice(0, 200)}`);
        }
        return res.body;
    }

    // ── Shelvesets ───────────────────────────────────────────────────────

    async listShelvesets(owner?: string): Promise<ShelvesetInfo[]> {
        const params: Record<string, string> = {};
        if (owner) { params['owner'] = owner; }

        const data = await this.get('/_apis/tfvc/shelvesets', params);
        return (data.value || []).map((s: any) => ({
            name: s.name || '',
            owner: s.owner?.displayName || '',
            ownerUniqueName: s.owner?.uniqueName || '',
            createdDate: s.createdDate || '',
            comment: s.comment || '',
        }));
    }

    async listShelvesetChanges(shelvesetName: string, shelvesetOwner: string): Promise<ShelvesetChange[]> {
        const shelveId = encodeURIComponent(`${shelvesetName};${shelvesetOwner}`);
        const data = await this.get(`/_apis/tfvc/shelvesets/${shelveId}/changes`);
        return (data.value || []).map((change: any) => ({
            path: change.item?.path || '',
            changeType: change.changeType || '',
            downloadUrl: change.item?.url || '',
        }));
    }

    async listChangesetChanges(changesetId: number): Promise<ShelvesetChange[]> {
        const data = await this.get(`/_apis/tfvc/changesets/${changesetId}/changes`);
        return (data.value || []).map((change: any) => ({
            path: change.item?.path || '',
            changeType: change.changeType || '',
            downloadUrl: change.item?.url || '',
        }));
    }

    async deleteShelvesetRest(shelvesetName: string, shelvesetOwner: string): Promise<void> {
        const shelveId = encodeURIComponent(`${shelvesetName};${shelvesetOwner}`);
        const params: Record<string, string> = { 'api-version': this.apiVersion };
        const qs = new URLSearchParams(params).toString();
        const url = `${this.base}/_apis/tfvc/shelvesets/${shelveId}?${qs}`;
        const res = await this.request(url, { method: 'DELETE' });
        if (res.status >= 400) {
            throw new Error(`Failed to delete shelveset: ${res.status} ${res.body.slice(0, 200)}`);
        }
    }

    // ── File content ────────────────────────────────────────────────────

    /** Fetch the latest committed version of a file as raw text. */
    async fetchItemContent(tfvcPath: string): Promise<string> {
        const qs = new URLSearchParams({
            path: tfvcPath,
            'api-version': this.apiVersion,
        }).toString();
        const url = `${this.base}/_apis/tfvc/items?${qs}`;
        return this.getRaw(url);
    }

    /** Fetch the shelved version of a file as raw text. */
    async fetchShelvedContent(tfvcPath: string, shelvesetName: string, owner: string): Promise<string> {
        const qs = new URLSearchParams({
            path: tfvcPath,
            versionType: 'Shelveset',
            version: `${shelvesetName};${owner}`,
            'api-version': this.apiVersion,
        }).toString();
        const url = `${this.base}/_apis/tfvc/items?${qs}`;
        return this.getRaw(url);
    }

    async listLatestFiles(): Promise<Map<string, TfvcItem>> {
        const data = await this.get('/_apis/tfvc/items', {
            scopePath: this.scope,
            recursionLevel: 'Full',
        });
        const result = new Map<string, TfvcItem>();
        for (const item of (data.value || [])) {
            if (!item.isFolder) {
                result.set(item.path, item);
            }
        }
        return result;
    }

    // ── Work items & code reviews ────────────────────────────────────────

    async getWorkItem(witId: number, expandRelations = false): Promise<WorkItem> {
        const params: Record<string, string> = {};
        if (expandRelations) { params['$expand'] = 'relations'; }
        return this.get(`/_apis/wit/workitems/${witId}`, params);
    }

    async queryOpenReviews(): Promise<CodeReviewRequest[]> {
        const wiql = {
            query: `SELECT [System.Id], [System.Title], [System.CreatedDate], [System.CreatedBy], [System.State]
                    FROM WorkItems
                    WHERE [System.WorkItemType] = 'Code Review Request'
                      AND [System.State] = 'Requested'
                      AND [System.TeamProject] = '${this.project}'
                    ORDER BY [System.CreatedDate] DESC`,
        };

        const result: WiqlResult = await this.post(`/${this.encodedProject}/_apis/wit/wiql`, wiql);
        if (!result.workItems || result.workItems.length === 0) {
            return [];
        }

        // Batch-fetch the work items (max 200)
        const ids = result.workItems.slice(0, 200).map(w => w.id);
        const fields = [
            'System.Id', 'System.Title', 'System.State',
            'System.CreatedDate', 'System.CreatedBy',
            'Microsoft.VSTS.CodeReview.Context',
            'Microsoft.VSTS.CodeReview.ContextOwner',
            'Microsoft.VSTS.CodeReview.ContextType',
        ].join(',');

        const items = await this.get('/_apis/wit/workitems', {
            ids: ids.join(','),
            fields,
        });

        return (items.value || []).map((wit: any) => {
            const f = wit.fields || {};
            return {
                id: wit.id,
                title: f['System.Title'] || '',
                state: f['System.State'] || '',
                createdDate: f['System.CreatedDate'] || '',
                createdBy: f['System.CreatedBy']?.displayName || f['System.CreatedBy'] || '',
                shelvesetName: f['Microsoft.VSTS.CodeReview.Context'] || '',
                shelvesetOwner: f['Microsoft.VSTS.CodeReview.ContextOwner'] || '',
                contextType: f['Microsoft.VSTS.CodeReview.ContextType'] || '',
            };
        });
    }

    async createCodeReviewResponse(
        title: string,
        requestWitId: number,
        assignedTo: string,
        verdict: ReviewVerdict,
        closingComment = ''
    ): Promise<number> {
        // Step 1: create with minimal fields
        const createOps = [
            { op: 'add', path: '/fields/System.Title', value: title },
            { op: 'add', path: '/fields/System.AssignedTo', value: assignedTo },
            {
                op: 'add',
                path: '/relations/-',
                value: {
                    rel: 'System.LinkTypes.Hierarchy-Reverse',
                    url: `${this.base}/_apis/wit/workitems/${requestWitId}`,
                },
            },
        ];

        const created = await this.patch(
            `/${this.encodedProject}/_apis/wit/workitems/$Code%20Review%20Response`,
            createOps
        );
        const responseWitId = created.id;

        // Step 2: close with verdict
        await this.closeReviewResponse(responseWitId, verdict, 'Closed', closingComment);
        return responseWitId;
    }

    async closeReviewResponse(
        responseWitId: number,
        verdict: ReviewVerdict,
        closedState: string,
        closingComment = ''
    ): Promise<void> {
        const statusCode = VERDICT_STATUS_CODE[verdict] || 0;
        const ops: any[] = [
            { op: 'add', path: '/fields/System.State', value: closedState },
            { op: 'add', path: '/fields/Microsoft.VSTS.CodeReview.ClosedStatus', value: String(verdict) },
            { op: 'add', path: '/fields/Microsoft.VSTS.CodeReview.ClosedStatusCode', value: statusCode },
        ];
        if (closingComment) {
            ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.CodeReview.ClosingComment', value: closingComment });
        }
        await this.patch(`/_apis/wit/workitems/${responseWitId}`, ops);
    }

    // ── Identity ────────────────────────────────────────────────────────

    async getBotIdentity(): Promise<{ id: string; displayName: string }> {
        if (this.identityCache) { return this.identityCache; }
        const data = await this.get('/_apis/connectionData');
        const user = data.authenticatedUser;
        this.identityCache = {
            id: String(user.id),
            displayName: String(user.providerDisplayName || user.displayName || ''),
        };
        return this.identityCache;
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    shelvesetVersionUri(witId: number): string {
        return `vstfs:///WorkItemTracking/WorkItem/${witId}`;
    }

    changesetVersionUri(changesetId: number): string {
        return `vstfs:///VersionControl/Changeset/${changesetId}`;
    }
}
