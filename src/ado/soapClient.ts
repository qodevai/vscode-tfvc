/**
 * SOAP client for Azure DevOps DiscussionWebService.
 *
 * ADO has no REST API for writing inline code review discussions —
 * only SOAP via DiscussionWebService.asmx.
 */

import { SoapClientBase } from './soapClientBase';
import { extractAttr, decodeXmlEntities, escapeXmlAttr } from '../xmlUtils';

const NS_DISC = 'http://schemas.microsoft.com/TeamFoundation/2012/Discussion';
const ENDPOINT = '/Discussion/V1.0/DiscussionWebService.asmx';

export interface InlineCommentParams {
    witId: number;
    versionUri: string;
    itemPath: string;
    startLine: number;
    endLine: number;
    content: string;
    authorGuid: string;
    startColumn?: number;
    endColumn?: number;
}

export interface DiscussionThread {
    discussionId: number;
    workItemId: number;
    itemPath: string;
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
    publishedDate: string;
    comments: DiscussionComment[];
}

export interface DiscussionComment {
    commentId: number;
    parentCommentId: number;
    discussionId: number;
    authorGuid: string;
    authorName: string;
    content: string;
    publishedDate: string;
    isDeleted: boolean;
}

export class AdoSoapClient extends SoapClientBase {
    constructor(base: string, pat: string) {
        super(base, pat, ENDPOINT, NS_DISC);
    }

    async postInlineComment(params: InlineCommentParams): Promise<number> {
        const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        const startCol = params.startColumn ?? 1;
        const endCol = params.endColumn ?? 120;

        const body = [
            '<t:discussions>',
            `<t:Discussion`,
            ` DiscussionId="0"`,
            ` Status="1"`,
            ` Severity="0"`,
            ` WorkItemId="${params.witId}"`,
            ` VersionUri="${escapeXmlAttr(params.versionUri)}"`,
            ` ItemPath="${escapeXmlAttr(params.itemPath)}"`,
            ` PublishedDate="${now}"`,
            ` LastUpdatedDate="${now}"`,
            ` Revision="0"`,
            ` IsDirty="false">`,
            `<t:Position`,
            ` StartLine="${params.startLine}"`,
            ` EndLine="${params.endLine}"`,
            ` StartColumn="${startCol}"`,
            ` EndColumn="${endCol}"`,
            ` StartCharPosition="0"`,
            ` EndCharPosition="${endCol}"`,
            ` PositionContext="after" />`,
            '</t:Discussion>',
            '</t:discussions>',
            '<t:comments>',
            `<t:Comment`,
            ` CommentId="0"`,
            ` ParentCommentId="0"`,
            ` DiscussionId="0"`,
            ` Author="${escapeXmlAttr(params.authorGuid)}"`,
            ` CommentType="1"`,
            ` Content="${escapeXmlAttr(params.content)}"`,
            ` PublishedDate="${now}"`,
            ` IsDeleted="false" />`,
            '</t:comments>',
        ].join('\n');

        const response = await this.post(this.envelope('PublishDiscussions', body), 'PublishDiscussions');

        const intMatch = /<int[^>]*>(\d+)<\/int>/i.exec(response);
        if (!intMatch) {
            throw new Error(`PublishDiscussions: unexpected response: ${response.slice(0, 300)}`);
        }
        return parseInt(intMatch[1], 10);
    }

    async queryDiscussions(workItemId: number): Promise<DiscussionThread[]> {
        const body = `<t:workItemId>${workItemId}</t:workItemId>`;
        const response = await this.post(
            this.envelope('QueryDiscussionsByCodeReviewRequest', body),
            'QueryDiscussionsByCodeReviewRequest',
        );
        return parseDiscussionsResponse(response);
    }
}

function parseDiscussionsResponse(xml: string): DiscussionThread[] {
    // Build author GUID → display name map
    const authorMap = new Map<string, string>();
    const authorRegex = /<TeamFoundationIdentity[^>]*TeamFoundationId="([^"]*)"[^>]*>/g;
    const displayNameRegex = /DisplayName="([^"]*)"/;
    let authorMatch: RegExpExecArray | null;
    while ((authorMatch = authorRegex.exec(xml)) !== null) {
        const guid = authorMatch[1].toLowerCase();
        const dnMatch = displayNameRegex.exec(authorMatch[0]);
        if (dnMatch) {
            authorMap.set(guid, decodeXmlEntities(dnMatch[1]));
        }
    }

    // Parse Discussion elements
    const threads = new Map<number, DiscussionThread>();
    const discRegex = /<Discussion\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/Discussion>)/g;
    let discMatch: RegExpExecArray | null;
    while ((discMatch = discRegex.exec(xml)) !== null) {
        const attrs = discMatch[1];
        const body = discMatch[2] || '';
        const id = parseInt(extractAttr(attrs, 'DiscussionId') || '0', 10);
        const witId = parseInt(extractAttr(attrs, 'WorkItemId') || '0', 10);
        const itemPath = decodeXmlEntities(extractAttr(attrs, 'ItemPath') || '');
        const published = extractAttr(attrs, 'PublishedDate') || '';

        const posMatch = /<Position\s+([^/]*?)\//i.exec(body);
        let startLine = 1, endLine = 1, startCol = 1, endCol = 120;
        if (posMatch) {
            startLine = parseInt(extractAttr(posMatch[1], 'StartLine') || '1', 10);
            endLine = parseInt(extractAttr(posMatch[1], 'EndLine') || '1', 10);
            startCol = parseInt(extractAttr(posMatch[1], 'StartColumn') || '1', 10);
            endCol = parseInt(extractAttr(posMatch[1], 'EndColumn') || '120', 10);
        }

        threads.set(id, {
            discussionId: id,
            workItemId: witId,
            itemPath,
            startLine,
            endLine,
            startColumn: startCol,
            endColumn: endCol,
            publishedDate: published,
            comments: [],
        });
    }

    // Parse Comment elements
    const commentRegex = /<Comment\s+([^/]*?)\//g;
    let commentMatch: RegExpExecArray | null;
    while ((commentMatch = commentRegex.exec(xml)) !== null) {
        const attrs = commentMatch[1];
        const discId = parseInt(extractAttr(attrs, 'DiscussionId') || '0', 10);
        const thread = threads.get(discId);
        if (!thread) { continue; }

        const authorGuid = (extractAttr(attrs, 'Author') || '').toLowerCase();
        thread.comments.push({
            commentId: parseInt(extractAttr(attrs, 'CommentId') || '0', 10),
            parentCommentId: parseInt(extractAttr(attrs, 'ParentCommentId') || '0', 10),
            discussionId: discId,
            authorGuid,
            authorName: authorMap.get(authorGuid) || authorGuid,
            content: decodeXmlEntities(extractAttr(attrs, 'Content') || ''),
            publishedDate: extractAttr(attrs, 'PublishedDate') || '',
            isDeleted: extractAttr(attrs, 'IsDeleted') === 'true',
        });
    }

    return Array.from(threads.values()).filter(t => t.comments.length > 0);
}
