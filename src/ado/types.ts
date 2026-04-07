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
