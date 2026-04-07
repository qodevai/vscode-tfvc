/**
 * SOAP client for Azure DevOps DiscussionWebService.
 *
 * Ported from reviewer backend TfvcClient.post_inline_comment().
 * ADO has no REST API for writing inline code review discussions —
 * only SOAP via DiscussionWebService.asmx.
 */

import * as https from 'https';
import * as http from 'http';

const NS_SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const NS_DISC = 'http://schemas.microsoft.com/TeamFoundation/2012/Discussion';

export interface InlineCommentParams {
    witId: number;
    versionUri: string;
    itemPath: string;        // TFVC server path (e.g. $/Project/foo.ts)
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

export class AdoSoapClient {
    private readonly base: string;
    private readonly authHeader: string;

    constructor(base: string, pat: string) {
        this.base = base;
        this.authHeader = 'Basic ' + Buffer.from(`:${pat}`).toString('base64');
    }

    /**
     * Post an inline line-anchored code review comment via SOAP.
     * Returns the assigned DiscussionId.
     */
    async postInlineComment(params: InlineCommentParams): Promise<number> {
        const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        const startCol = params.startColumn ?? 1;
        const endCol = params.endColumn ?? 120;

        // Build SOAP XML envelope (matching Python TfvcClient exactly)
        const xml = [
            '<?xml version="1.0" encoding="utf-8"?>',
            `<soap:Envelope xmlns:soap="${NS_SOAP}" xmlns:t="${NS_DISC}">`,
            '<soap:Body>',
            '<t:PublishDiscussions>',
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
            '</t:PublishDiscussions>',
            '</soap:Body>',
            '</soap:Envelope>',
        ].join('\n');

        const url = `${this.base}/Discussion/V1.0/DiscussionWebService.asmx`;

        const response = await this.postSoap(url, xml, `${NS_DISC}/PublishDiscussions`);

        // Parse response XML for DiscussionId (<int>123</int>)
        const intMatch = /<int[^>]*>(\d+)<\/int>/i.exec(response);
        if (!intMatch) {
            throw new Error(`PublishDiscussions: unexpected response: ${response.slice(0, 300)}`);
        }
        return parseInt(intMatch[1], 10);
    }

    /**
     * Query all inline discussions for a Code Review Request work item.
     * Uses SOAP QueryDiscussionsByCodeReviewRequest.
     */
    async queryDiscussions(workItemId: number): Promise<DiscussionThread[]> {
        const xml = [
            '<?xml version="1.0" encoding="utf-8"?>',
            `<soap:Envelope xmlns:soap="${NS_SOAP}" xmlns:t="${NS_DISC}">`,
            '<soap:Body>',
            '<t:QueryDiscussionsByCodeReviewRequest>',
            `<t:workItemId>${workItemId}</t:workItemId>`,
            '</t:QueryDiscussionsByCodeReviewRequest>',
            '</soap:Body>',
            '</soap:Envelope>',
        ].join('\n');

        const url = `${this.base}/Discussion/V1.0/DiscussionWebService.asmx`;
        const response = await this.postSoap(url, xml, `${NS_DISC}/QueryDiscussionsByCodeReviewRequest`);

        return parseDiscussionsResponse(response);
    }

    private async postSoap(url: string, xml: string, soapAction: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url);
            const transport = parsedUrl.protocol === 'https:' ? https : http;
            const req = transport.request(
                {
                    hostname: parsedUrl.hostname,
                    port: parsedUrl.port,
                    path: parsedUrl.pathname,
                    method: 'POST',
                    headers: {
                        'Authorization': this.authHeader,
                        'Content-Type': 'text/xml; charset=utf-8',
                        'SOAPAction': soapAction,
                    },
                    timeout: 30000,
                },
                (res) => {
                    let data = '';
                    res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                    res.on('end', () => {
                        if ((res.statusCode || 0) >= 400) {
                            reject(new Error(`SOAP error ${res.statusCode}: ${data.slice(0, 300)}`));
                        } else {
                            resolve(data);
                        }
                    });
                }
            );
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('SOAP request timed out'));
            });
            req.write(xml);
            req.end();
        });
    }
}

function escapeXmlAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
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

        // Parse Position
        const posMatch = /<Position\s+([^/]*?)\/>/i.exec(body);
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
    const commentRegex = /<Comment\s+([^/]*?)\/>/g;
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

function extractAttr(attrs: string, name: string): string | undefined {
    const regex = new RegExp(`${name}="([^"]*)"`, 'i');
    const match = regex.exec(attrs);
    return match ? match[1] : undefined;
}

function decodeXmlEntities(s: string): string {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#xA;/g, '\n')
        .replace(/&#xD;/g, '\r');
}
