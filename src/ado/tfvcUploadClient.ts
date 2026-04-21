/**
 * Multipart file-content uploader for the TFVC upload service. TEE uploads
 * file bytes to `{collection}/VersionControl/v1.0/upload.ashx` before calling
 * `PendChanges`, which references the uploaded content by download id.
 *
 * Field layout ported from TEE's CheckinWorker.java (lines 243-260) and the
 * constant names in VersionControlConstants.java (lines 122-128) in
 * microsoft/team-explorer-everywhere (MIT-licensed).
 *
 * Simplifications vs TEE:
 *   - Single-chunk upload only. TEE supports chunked upload with retry; we
 *     fail loud on files >5 MB for now. Revisit when a real user hits the
 *     cap. The `range` field carries the full byte range as if chunks = 1.
 *   - No gzip compression. TEE compares compressed vs uncompressed sizes
 *     and picks the smaller; we always send raw bytes. Unshelve downloads
 *     accept raw content too, so the round-trip works.
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { md5Base64 } from '../workspace/hashing';
import { buildBasicAuthHeader, HttpResponse } from './httpClient';
import { classifyHttpError, TfvcError } from '../errors';

const MAX_SINGLE_CHUNK_BYTES = 5 * 1024 * 1024;

// TEE uses the literal string "application/octet-stream" for uncompressed
// content; ref CheckinWorker.java UNCOMPRESSED constant.
const UNCOMPRESSED_CONTENT_TYPE = 'application/octet-stream';

export interface UploadRequest {
    /** Server path, e.g. `$/Project/src/foo.ts`. */
    serverPath: string;
    workspaceName: string;
    workspaceOwner: string;
    /** Raw uncompressed file bytes. */
    content: Buffer;
}

export interface UploadResult {
    /** The download id server-assigned to this upload. Pass to `pendChanges` as `did`. */
    downloadId: number;
    /** Base64 MD5 hash the server confirmed. */
    hash: string;
}

export class TfvcUploadClient {
    private readonly endpoint: string;
    private readonly authHeader: string;
    private readonly strictSSL: () => boolean;

    /**
     * @param collectionBase same base URL the SOAP client uses
     *                       (`.../<collection>` or `https://dev.azure.com/<org>`).
     * @param strictSSL      called per request so live config changes apply
     *                       without reconstructing this client.
     */
    constructor(collectionBase: string, pat: string, strictSSL: () => boolean = () => true) {
        this.endpoint = `${collectionBase}/VersionControl/v1.0/upload.ashx`;
        this.authHeader = buildBasicAuthHeader(pat);
        this.strictSSL = strictSSL;
    }

    async uploadFile(req: UploadRequest): Promise<UploadResult> {
        if (req.content.length > MAX_SINGLE_CHUNK_BYTES) {
            throw new TfvcError(
                `TfvcUploadClient: file ${req.serverPath} is ${req.content.length} bytes, ` +
                `exceeds the ${MAX_SINGLE_CHUNK_BYTES}-byte single-chunk cap. ` +
                `Chunked upload is not implemented yet.`
            );
        }

        const hash = md5Base64(req.content);
        const body = buildMultipart(req, hash);
        const res = await this.postMultipart(body.buffer, body.boundary);

        if (res.status >= 400) {
            const detail = res.body.slice(0, 800);
            const err = classifyHttpError(res.status, detail, `TFVC upload failed for ${req.serverPath}`);
            if (detail && !err.message.includes(detail)) {
                throw new TfvcError(
                    `${err.message} (upload ${req.serverPath}: ${detail})`,
                    err.statusCode,
                    detail,
                );
            }
            throw err;
        }

        // The server replies with a small XML fragment carrying the download
        // id: <ArrayOfInt><int>DID</int></ArrayOfInt> or equivalent. Accept
        // any numeric result; we tolerate an empty body as "no id, content
        // queued by hash" (legacy behaviour) and synthesize 0 which the
        // caller passes through to pendChanges unchanged.
        const idMatch = /<int[^>]*>(\d+)<\/int>/i.exec(res.body);
        const downloadId = idMatch ? parseInt(idMatch[1], 10) : 0;
        return { downloadId, hash };
    }

    private postMultipart(body: Buffer, boundary: string): Promise<HttpResponse> {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(this.endpoint);
            const transport = parsedUrl.protocol === 'https:' ? https : http;
            const options: https.RequestOptions = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port,
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'POST',
                headers: {
                    'Authorization': this.authHeader,
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': String(body.length),
                },
                timeout: 30_000,
            };
            if (parsedUrl.protocol === 'https:' && !this.strictSSL()) {
                options.rejectUnauthorized = false;
            }
            const req = transport.request(options, res => {
                const chunks: Buffer[] = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve({
                    status: res.statusCode || 0,
                    body: Buffer.concat(chunks).toString('utf8'),
                }));
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error(`Upload timed out: ${this.endpoint}`)); });
            req.write(body);
            req.end();
        });
    }
}

/**
 * Build the multipart body TFVC expects. The order of fields matches TEE's
 * CheckinWorker so diffs are easy to audit when debugging failures.
 */
function buildMultipart(req: UploadRequest, hash: string): { buffer: Buffer; boundary: string } {
    const boundary = `----tfvc-upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const dash = '--';
    const crlf = '\r\n';

    const stringParts: Array<[string, string]> = [
        ['item', req.serverPath],
        ['wsname', req.workspaceName],
        ['wsowner', req.workspaceOwner],
        ['filelength', String(req.content.length)],
        ['hash', hash],
        // Single-chunk upload: full range in one go.
        ['range', `bytes=0-${req.content.length - 1}/${req.content.length}`],
    ];

    const chunks: Buffer[] = [];
    for (const [name, value] of stringParts) {
        chunks.push(Buffer.from(
            dash + boundary + crlf +
            `Content-Disposition: form-data; name="${name}"` + crlf +
            'Content-Type: text/plain; charset=utf-8' + crlf + crlf +
            value + crlf,
            'utf8',
        ));
    }

    // The content part — file bytes, not text-escaped. TEE uses filename="item".
    chunks.push(Buffer.from(
        dash + boundary + crlf +
        'Content-Disposition: form-data; name="content"; filename="item"' + crlf +
        `Content-Type: ${UNCOMPRESSED_CONTENT_TYPE}` + crlf + crlf,
        'utf8',
    ));
    chunks.push(req.content);
    chunks.push(Buffer.from(crlf, 'utf8'));

    // Closing boundary.
    chunks.push(Buffer.from(dash + boundary + dash + crlf, 'utf8'));

    return { buffer: Buffer.concat(chunks), boundary };
}
