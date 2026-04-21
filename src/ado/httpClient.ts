/** Shared HTTP client for ADO REST and SOAP requests. */

import * as https from 'https';
import * as http from 'http';

/**
 * Build the Basic auth header ADO expects for PAT authentication:
 * empty username + PAT as password, base64-encoded.
 */
export function buildBasicAuthHeader(pat: string): string {
    return 'Basic ' + Buffer.from(`:${pat}`).toString('base64');
}

export interface HttpResponse {
    status: number;
    body: string;
}

export interface HttpBufferResponse {
    status: number;
    body: Buffer;
}

export interface HttpRequestOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// Module-level TLS toggle. On-prem TFS servers often use self-signed or
// internal-CA certificates that Node's default https agent rejects. The
// extension flips this from `tfvc.strictSSL` at activation and on config
// change; all HTTP(S) requests originate here so one setter covers both
// REST and SOAP paths. Defaults to `true` so nothing weakens unless the
// user explicitly opts in.
let globalStrictSSL = true;

export function setStrictSSL(strict: boolean): void {
    globalStrictSSL = strict;
}

/** @internal test hook */
export function getStrictSSL(): boolean {
    return globalStrictSSL;
}

function buildRequestOptions(url: string, options: HttpRequestOptions): https.RequestOptions {
    const parsedUrl = new URL(url);
    const base: https.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: options.headers,
        timeout: options.timeout || DEFAULT_TIMEOUT_MS,
    };
    if (parsedUrl.protocol === 'https:' && !globalStrictSSL) {
        base.rejectUnauthorized = false;
    }
    return base;
}

export function httpRequest(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    const method = options.method || 'GET';
    const headers: Record<string, string> = { ...options.headers };
    const reqOptions = buildRequestOptions(url, { ...options, headers });

    return new Promise((resolve, reject) => {
        const transport = new URL(url).protocol === 'https:' ? https : http;
        const req = transport.request(
            reqOptions,
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

/** Same as httpRequest but collects the response body as a raw Buffer (for binary downloads). */
export function httpRequestBuffer(url: string, options: HttpRequestOptions = {}): Promise<HttpBufferResponse> {
    const method = options.method || 'GET';
    const headers: Record<string, string> = { ...options.headers };
    const reqOptions = buildRequestOptions(url, { ...options, headers });

    return new Promise((resolve, reject) => {
        const transport = new URL(url).protocol === 'https:' ? https : http;
        const req = transport.request(
            reqOptions,
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
                res.on('end', () => {
                    resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) });
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
