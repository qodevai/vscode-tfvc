/**
 * Azure DevOps TFVC REST client — ported from reviewer backend TfvcClient.
 *
 * All operations use REST APIs (no TEE-CLC dependency).
 * Supports both cloud (dev.azure.com) and on-prem (custom base_url).
 */

import {
    TfvcItem,
    TfvcItemFull,
    ShelvesetChange,
    ShelvesetInfo,
    WorkItem,
    CodeReviewRequest,
    ReviewVerdict,
    VERDICT_STATUS_CODE,
    WiqlResult,
    CreateChangesetRequest,
    ChangesetResponse,
    ChangesetInfo,
    AdoShelvesetResponse,
    AdoChangeResponse,
    AdoChangesetResponse,
    AdoWorkItemResponse,
    AdoWorkItemTypeCategory,
} from './types';
import { httpRequest, httpRequestBuffer, HttpResponse, HttpBufferResponse, buildBasicAuthHeader } from './httpClient';
import { classifyHttpError, TfvcError } from '../errors';

const MAX_BATCH_SIZE = 200;

/** Language-neutral category reference names — constant across all TFS/ADO locales. */
export const CATEGORY_CODE_REVIEW_REQUEST = 'Microsoft.CodeReviewRequestCategory';
export const CATEGORY_CODE_REVIEW_RESPONSE = 'Microsoft.CodeReviewResponseCategory';

/**
 * Join an on-prem base URL and collection path robustly. The user-facing
 * settings let people type `/tfs/DefaultCollection`, `tfs/DefaultCollection`,
 * or `/tfs/DefaultCollection/` — all should produce the same result.
 * Exported for reuse by the SOAP client base URL.
 */
export function buildOnPremBase(baseUrl: string, collectionPath: string): string {
    const cleanBase = baseUrl.replace(/\/+$/, '');
    const cleanPath = collectionPath.replace(/^\/+/, '').replace(/\/+$/, '');
    return cleanPath ? `${cleanBase}/${cleanPath}` : cleanBase;
}

interface AdoListResponse<T> {
    value: T[];
    count?: number;
}

interface ConnectionData {
    authenticatedUser: {
        id: string;
        providerDisplayName?: string;
        displayName?: string;
    };
}

export class AdoRestClient {
    private readonly base: string;
    private readonly apiVersion: string;
    private readonly authHeader: string;
    private readonly project: string;
    readonly scope: string;

    private identityCache: { id: string; displayName: string } | undefined;
    private readonly categoryCache = new Map<string, string>();

    constructor(
        org: string,
        pat: string,
        project: string,
        baseUrl = '',
        collectionPath = ''
    ) {
        // Validate inputs at the boundary so callers get a clear error instead
        // of later HTTP failures against a bogus URL like
        // "https://dev.azure.com//_apis/...".
        if (!pat) {
            throw new TfvcError('AdoRestClient: PAT is required');
        }
        if (!project) {
            throw new TfvcError('AdoRestClient: project is required');
        }
        if (!baseUrl && !org) {
            throw new TfvcError('AdoRestClient: either org (cloud) or baseUrl (on-prem) must be provided');
        }
        if (baseUrl) {
            if (!/^https?:\/\//i.test(baseUrl)) {
                throw new TfvcError(`AdoRestClient: baseUrl must start with http(s):// (got "${baseUrl}")`);
            }
            this.base = buildOnPremBase(baseUrl, collectionPath);
            this.apiVersion = '6.0';
        } else {
            this.base = `https://dev.azure.com/${encodeURIComponent(org)}`;
            this.apiVersion = '7.1';
        }
        this.project = project;
        this.scope = `$/${project}`;
        this.authHeader = buildBasicAuthHeader(pat);
    }

    // ── HTTP helpers ─────────────────────────────────────────────────────

    private async request(url: string, method = 'GET', headers?: Record<string, string>, body?: string): Promise<HttpResponse> {
        return httpRequest(url, {
            method,
            headers: { 'Authorization': this.authHeader, ...headers },
            body,
        });
    }

    /** URL-encoded project name for use in API paths. */
    private get encodedProject(): string {
        return encodeURIComponent(this.project);
    }

    private buildUrl(path: string, params: Record<string, string> = {}): string {
        const allParams = { ...params, 'api-version': this.apiVersion };
        const qs = new URLSearchParams(allParams).toString();
        return `${this.base}${path}${qs ? '?' + qs : ''}`;
    }

    private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
        const url = this.buildUrl(path, params);
        const res = await this.request(url);
        if (res.status >= 400) {
            throw classifyHttpError(res.status, res.body, 'ADO API error');
        }
        return JSON.parse(res.body) as T;
    }

    private async post<T>(path: string, body: unknown, params: Record<string, string> = {}, contentType = 'application/json'): Promise<T> {
        const url = this.buildUrl(path, params);
        const res = await this.request(url, 'POST', { 'Content-Type': contentType }, typeof body === 'string' ? body : JSON.stringify(body));
        if (res.status >= 400) {
            throw classifyHttpError(res.status, res.body, 'ADO API error');
        }
        return JSON.parse(res.body) as T;
    }

    private async patch<T>(path: string, body: unknown, params: Record<string, string> = {}): Promise<T> {
        const url = this.buildUrl(path, params);
        const res = await this.request(url, 'PATCH', { 'Content-Type': 'application/json-patch+json' }, JSON.stringify(body));
        if (res.status >= 400) {
            throw classifyHttpError(res.status, res.body, 'ADO API error');
        }
        return JSON.parse(res.body) as T;
    }

    private async getRaw(url: string): Promise<string> {
        const res = await this.request(url);
        if (res.status >= 400) {
            throw classifyHttpError(res.status, res.body, 'ADO download error');
        }
        return res.body;
    }

    private async requestBuffer(url: string, method = 'GET', headers?: Record<string, string>): Promise<HttpBufferResponse> {
        return httpRequestBuffer(url, {
            method,
            headers: { 'Authorization': this.authHeader, ...headers },
        });
    }

    private async getBuffer(url: string): Promise<Buffer> {
        const res = await this.requestBuffer(url);
        if (res.status >= 400) {
            throw classifyHttpError(res.status, res.body.toString('utf8'), 'ADO download error');
        }
        return res.body;
    }

    private async del(path: string, params: Record<string, string> = {}): Promise<void> {
        const url = this.buildUrl(path, params);
        const res = await this.request(url, 'DELETE');
        if (res.status >= 400) {
            throw classifyHttpError(res.status, res.body, 'ADO API error');
        }
    }

    // ── Shelvesets ───────────────────────────────────────────────────────

    async listShelvesets(owner?: string): Promise<ShelvesetInfo[]> {
        const params: Record<string, string> = {};
        if (owner) { params['owner'] = owner; }

        const data = await this.get<AdoListResponse<AdoShelvesetResponse>>('/_apis/tfvc/shelvesets', params);
        return (data.value || []).map((s) => ({
            name: s.name || '',
            owner: s.owner?.displayName || '',
            ownerUniqueName: s.owner?.uniqueName || '',
            createdDate: s.createdDate || '',
            comment: s.comment || '',
        }));
    }

    async listShelvesetChanges(shelvesetName: string, shelvesetOwner: string): Promise<ShelvesetChange[]> {
        const shelveId = encodeURIComponent(`${shelvesetName};${shelvesetOwner}`);
        const data = await this.get<AdoListResponse<AdoChangeResponse>>(`/_apis/tfvc/shelvesets/${shelveId}/changes`);
        return (data.value || []).map((change) => ({
            path: change.item?.path || '',
            changeType: change.changeType || '',
            downloadUrl: change.item?.url || '',
        }));
    }

    async listChangesetChanges(changesetId: number): Promise<ShelvesetChange[]> {
        const data = await this.get<AdoListResponse<AdoChangeResponse>>(`/_apis/tfvc/changesets/${changesetId}/changes`);
        return (data.value || []).map((change) => ({
            path: change.item?.path || '',
            changeType: change.changeType || '',
            downloadUrl: change.item?.url || '',
        }));
    }

    // ── Items (workspace operations) ──────────────────────────────────

    /** List items under a scope path (Full recursion by default). */
    async listItems(scopePath?: string, recursionLevel = 'Full'): Promise<TfvcItemFull[]> {
        const params: Record<string, string> = {
            recursionLevel,
        };
        if (scopePath) {
            params['scopePath'] = scopePath;
        }
        const data = await this.get<{ value: TfvcItemFull[]; count?: number }>('/_apis/tfvc/items', params);
        return (data.value || []);
    }

    /** Download a file's content as a Buffer (for binary-safe downloads). */
    async downloadItemBuffer(tfvcPath: string, version?: number): Promise<Buffer> {
        const params: Record<string, string> = {
            path: tfvcPath,
            'api-version': this.apiVersion,
        };
        if (version !== undefined) {
            params['versionType'] = 'Changeset';
            params['version'] = String(version);
        }
        const url = this.buildUrl('/_apis/tfvc/items', params);
        return this.getBuffer(url);
    }

    // ── Changesets ────────────────────────────────────────────────────

    /** Create a new changeset (checkin). Returns the created changeset. */
    async createChangeset(request: CreateChangesetRequest): Promise<ChangesetResponse> {
        return this.post<ChangesetResponse>('/_apis/tfvc/changesets', request);
    }

    /** Get changeset history for a path. */
    async getChangesets(options: { itemPath?: string; top?: number; skip?: number } = {}): Promise<ChangesetInfo[]> {
        const params: Record<string, string> = {};
        if (options.itemPath) {
            params['searchCriteria.itemPath'] = options.itemPath;
        }
        if (options.top !== undefined) {
            params['$top'] = String(options.top);
        }
        if (options.skip !== undefined) {
            params['$skip'] = String(options.skip);
        }
        const data = await this.get<AdoListResponse<AdoChangesetResponse>>('/_apis/tfvc/changesets', params);
        return (data.value || []).map((cs) => ({
            changesetId: cs.changesetId ?? 0,
            author: cs.author?.displayName || cs.checkedInBy?.displayName || '',
            createdDate: cs.createdDate || '',
            comment: cs.comment || '',
        }));
    }

    // ── Shelveset creation / deletion ─────────────────────────────────

    /** Create a shelveset via REST. May not be available on all server versions. */
    async createShelveset(name: string, changes: CreateChangesetRequest['changes'], comment?: string): Promise<void> {
        const body = {
            name,
            comment: comment || '',
            changes,
        };
        await this.post<unknown>('/_apis/tfvc/shelvesets', body);
    }

    /** Delete a shelveset. */
    async deleteShelveset(name: string, owner: string): Promise<void> {
        const shelveId = encodeURIComponent(`${name};${owner}`);
        await this.del(`/_apis/tfvc/shelvesets/${shelveId}`);
    }

    // ── File content ────────────────────────────────────────────────────

    /**
     * Fetch a file as raw text. Passes no version parameter to get HEAD, or
     * pins to a specific changeset when `version` is provided.
     */
    async fetchItemContent(tfvcPath: string, version?: number): Promise<string> {
        const params: Record<string, string> = {
            path: tfvcPath,
            'api-version': this.apiVersion,
        };
        if (version !== undefined) {
            params.versionType = 'Changeset';
            params.version = String(version);
        }
        const qs = new URLSearchParams(params).toString();
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

    // ── Work items & code reviews ────────────────────────────────────────

    async getWorkItem(witId: number, expandRelations = false): Promise<WorkItem> {
        const params: Record<string, string> = {};
        if (expandRelations) { params['$expand'] = 'relations'; }
        return this.get<WorkItem>(`/_apis/wit/workitems/${witId}`, params);
    }

    async queryOpenReviews(openState = 'Requested'): Promise<CodeReviewRequest[]> {
        // WIQL uses `IN GROUP '<category-ref-name>'` — language-neutral — rather
        // than the work-item-type display name, which is localized per server
        // (e.g. `Codereviewanforderung` on a German TFS).
        //
        // State values are still localized and not queryable by category, so
        // the caller must pass the project-specific display name.
        const safeProject = this.project.replace(/'/g, "''");
        const safeState = openState.replace(/'/g, "''");
        const wiql = {
            query: `SELECT [System.Id], [System.Title], [System.CreatedDate], [System.CreatedBy], [System.State]
                    FROM WorkItems
                    WHERE [System.WorkItemType] IN GROUP '${CATEGORY_CODE_REVIEW_REQUEST}'
                      AND [System.State] = '${safeState}'
                      AND [System.TeamProject] = '${safeProject}'
                    ORDER BY [System.CreatedDate] DESC`,
        };

        const result = await this.post<WiqlResult>(`/${this.encodedProject}/_apis/wit/wiql`, wiql);
        if (!result.workItems || result.workItems.length === 0) {
            return [];
        }

        const allIds = result.workItems.map(w => w.id);
        const fields = [
            'System.Id', 'System.Title', 'System.State',
            'System.CreatedDate', 'System.CreatedBy',
            'Microsoft.VSTS.CodeReview.Context',
            'Microsoft.VSTS.CodeReview.ContextOwner',
            'Microsoft.VSTS.CodeReview.ContextType',
        ].join(',');

        // The workitems endpoint caps `ids` at 200 per request, so paginate
        // instead of silently truncating large review backlogs.
        const reviews: CodeReviewRequest[] = [];
        for (let i = 0; i < allIds.length; i += MAX_BATCH_SIZE) {
            const batch = allIds.slice(i, i + MAX_BATCH_SIZE);
            const items = await this.get<AdoListResponse<AdoWorkItemResponse>>('/_apis/wit/workitems', {
                ids: batch.join(','),
                fields,
            });
            for (const wit of items.value || []) {
                const f = wit.fields || {};
                const createdBy = f['System.CreatedBy'] as { displayName?: string } | string | undefined;
                reviews.push({
                    id: wit.id,
                    title: (f['System.Title'] as string) || '',
                    state: (f['System.State'] as string) || '',
                    createdDate: (f['System.CreatedDate'] as string) || '',
                    createdBy: typeof createdBy === 'string' ? createdBy : (createdBy?.displayName || ''),
                    shelvesetName: (f['Microsoft.VSTS.CodeReview.Context'] as string) || '',
                    shelvesetOwner: (f['Microsoft.VSTS.CodeReview.ContextOwner'] as string) || '',
                    contextType: (f['Microsoft.VSTS.CodeReview.ContextType'] as string) || '',
                });
            }
        }
        return reviews;
    }

    async createCodeReviewResponse(
        title: string,
        requestWitId: number,
        assignedTo: string,
        verdict: ReviewVerdict,
        closingComment = '',
        closedState = 'Closed'
    ): Promise<number> {
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

        // The workitems-by-type endpoint requires the work item type's
        // localized display name (e.g. `Codereviewantwort` in German), so we
        // resolve it from the stable category reference name.
        const responseTypeName = await this.getWorkItemTypeByCategory(CATEGORY_CODE_REVIEW_RESPONSE);
        const created = await this.patch<{ id: number }>(
            `/${this.encodedProject}/_apis/wit/workitems/$${encodeURIComponent(responseTypeName)}`,
            createOps
        );
        const responseWitId = created.id;

        await this.closeReviewResponse(responseWitId, verdict, closedState, closingComment);
        return responseWitId;
    }

    async closeReviewResponse(
        responseWitId: number,
        verdict: ReviewVerdict,
        closedState: string,
        closingComment = ''
    ): Promise<void> {
        const statusCode = VERDICT_STATUS_CODE[verdict] || 0;
        const ops: Array<{ op: string; path: string; value: string | number }> = [
            { op: 'add', path: '/fields/System.State', value: closedState },
            { op: 'add', path: '/fields/Microsoft.VSTS.CodeReview.ClosedStatus', value: String(verdict) },
            { op: 'add', path: '/fields/Microsoft.VSTS.CodeReview.ClosedStatusCode', value: statusCode },
        ];
        if (closingComment) {
            ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.CodeReview.ClosingComment', value: closingComment });
        }
        await this.patch<unknown>(`/_apis/wit/workitems/${responseWitId}`, ops);
    }

    // ── Work item type categories ───────────────────────────────────────

    /**
     * Resolve a work-item-type category reference name (e.g.
     * `Microsoft.CodeReviewResponseCategory`) to the project's localized type
     * display name — required for URLs like `/_apis/wit/workitems/$<Type>`,
     * which don't accept the reference name.
     *
     * On a German server `Microsoft.CodeReviewResponseCategory` resolves to
     * `Codereviewantwort`; on an English server it's `Code Review Response`.
     * Cached per process because the mapping is static per project.
     */
    async getWorkItemTypeByCategory(categoryReferenceName: string): Promise<string> {
        const cached = this.categoryCache.get(categoryReferenceName);
        if (cached) { return cached; }

        const data = await this.get<AdoWorkItemTypeCategory>(
            `/${this.encodedProject}/_apis/wit/workitemtypecategories/${encodeURIComponent(categoryReferenceName)}`
        );
        const name = data.defaultWorkItemType?.name
            || data.workItemTypes?.[0]?.name;
        if (!name) {
            throw new TfvcError(
                `Work item type category "${categoryReferenceName}" has no work item types. ` +
                `This usually means the project's process template does not include code review support.`
            );
        }
        this.categoryCache.set(categoryReferenceName, name);
        return name;
    }

    // ── Identity ────────────────────────────────────────────────────────

    async getBotIdentity(): Promise<{ id: string; displayName: string }> {
        if (this.identityCache) { return this.identityCache; }
        const data = await this.get<ConnectionData>('/_apis/connectionData');
        const user = data.authenticatedUser;
        this.identityCache = {
            id: String(user.id),
            displayName: String(user.providerDisplayName || user.displayName || ''),
        };
        return this.identityCache;
    }
}
