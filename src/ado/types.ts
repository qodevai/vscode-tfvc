/** Azure DevOps TFVC API response types. */

export interface TfvcItem {
    path: string;
    url: string;
    contentUrl?: string;
    isFolder?: boolean;
    version?: number;
}

export interface ShelvesetChange {
    path: string;
    changeType: string; // "add", "edit", "delete", "add, edit, encoding", …
    downloadUrl: string;
}

export interface ShelvesetInfo {
    name: string;
    owner: string;
    ownerUniqueName: string;
    createdDate: string;
    comment: string;
}

export interface WorkItem {
    id: number;
    fields: Record<string, any>;
    relations?: WorkItemRelation[];
}

export interface WorkItemRelation {
    rel: string;
    url: string;
    attributes?: Record<string, any>;
}

export interface CodeReviewRequest {
    id: number;
    title: string;
    state: string;
    createdDate: string;
    createdBy: string;
    shelvesetName: string;
    shelvesetOwner: string;
    contextType: string;
}

export enum ReviewVerdict {
    LooksGood = 'Looks Good',
    WithComments = 'With Comments',
    NeedsWork = 'Needs Work',
    Declined = 'Declined',
}

export const VERDICT_STATUS_CODE: Record<ReviewVerdict, number> = {
    [ReviewVerdict.LooksGood]: 1,
    [ReviewVerdict.WithComments]: 2,
    [ReviewVerdict.NeedsWork]: 3,
    [ReviewVerdict.Declined]: 4,
};

export interface WiqlResult {
    workItems: Array<{ id: number; url: string }>;
}

// ── Changeset creation types ──────────────────────────────────────────

export interface TfvcChangePayload {
    changeType: string;  // 'edit' | 'add' | 'delete'
    item: {
        path: string;
        version?: number;
    };
    newContent?: {
        content: string;
        contentType: 'rawText' | 'base64Encoded';
    };
}

export interface CreateChangesetRequest {
    comment: string;
    changes: TfvcChangePayload[];
    workItems?: Array<{ id: number }>;
}

export interface ChangesetResponse {
    changesetId: number;
    url: string;
    comment?: string;
    createdDate?: string;
}

export interface ChangesetInfo {
    changesetId: number;
    author: string;
    createdDate: string;
    comment: string;
}

export interface TfvcItemFull {
    path: string;
    url: string;
    contentUrl?: string;
    isFolder: boolean;
    version: number;
    hashValue?: string;
    size?: number;
}

// ── Raw ADO API response shapes ───────────────────────────────────────
// These describe the ADO REST payloads we actually consume — partial by
// design, since ADO returns many fields we don't use.

export interface AdoIdentityRef {
    id?: string;
    displayName?: string;
    uniqueName?: string;
}

export interface AdoShelvesetResponse {
    name?: string;
    owner?: AdoIdentityRef;
    createdDate?: string;
    comment?: string;
}

export interface AdoItemRef {
    path?: string;
    url?: string;
    version?: number;
}

export interface AdoChangeResponse {
    changeType?: string;
    item?: AdoItemRef;
}

export interface AdoChangesetResponse {
    changesetId?: number;
    createdDate?: string;
    comment?: string;
    author?: AdoIdentityRef;
    checkedInBy?: AdoIdentityRef;
}

export interface AdoWorkItemResponse {
    id: number;
    fields?: Record<string, unknown>;
    relations?: WorkItemRelation[];
}
