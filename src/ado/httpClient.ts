/** Shared HTTP client for ADO REST and SOAP requests. */

import * as https from 'https';
import * as http from 'http';

export interface HttpResponse {
    status: number;
    body: string;
}

export interface HttpRequestOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function httpRequest(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    const method = options.method || 'GET';
    const headers: Record<string, string> = { ...options.headers };

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
                timeout: options.timeout || DEFAULT_TIMEOUT_MS,
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
