/** Shared HTTP client for ADO REST and SOAP requests. */

import * as https from 'https';
import * as http from 'http';
import * as net from 'net';
import * as tls from 'tls';

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

// Module-level proxy URL. Corporate networks force HTTP(S) traffic through
// a forward proxy; Node's http/https don't honor environment variables or
// VS Code's `http.proxy` setting on their own. The extension resolves the
// URL once at activation (VS Code config → env fallback) and installs it
// here. Empty string disables. Basic auth is supported via `user:pass@host`.
let globalProxyUrl: string | undefined;

export function setProxyUrl(url: string | undefined): void {
    globalProxyUrl = url && url.length > 0 ? url : undefined;
}

/** @internal test hook */
export function getProxyUrl(): string | undefined {
    return globalProxyUrl;
}

/** Resolve the proxy URL from VS Code config (given by caller) or env vars. */
export function resolveProxyUrl(fromConfig: string | undefined): string | undefined {
    if (fromConfig && fromConfig.length > 0) { return fromConfig; }
    const env = process.env;
    return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || undefined;
}

function buildProxyAuthHeader(proxy: URL): string | undefined {
    if (!proxy.username) { return undefined; }
    const user = decodeURIComponent(proxy.username);
    const pass = decodeURIComponent(proxy.password);
    return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/**
 * Open a raw TCP tunnel to `targetHost:targetPort` through the given HTTP
 * proxy via the CONNECT method. Resolves with the established socket once
 * the proxy returns 200; rejects otherwise.
 */
function connectThroughProxy(
    proxy: URL,
    targetHost: string,
    targetPort: number,
    timeoutMs: number
): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
        const sock: net.Socket = proxy.protocol === 'https:'
            ? tls.connect({ host: proxy.hostname, port: proxyPort, rejectUnauthorized: globalStrictSSL })
            : net.connect({ host: proxy.hostname, port: proxyPort });

        let settled = false;
        const fail = (err: Error) => { if (!settled) { settled = true; sock.destroy(); reject(err); } };
        sock.setTimeout(timeoutMs, () => fail(new Error(`Proxy CONNECT timed out: ${proxy.host}`)));
        sock.once('error', fail);

        sock.once(proxy.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
            const authHeader = buildProxyAuthHeader(proxy);
            const lines = [
                `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
                `Host: ${targetHost}:${targetPort}`,
            ];
            if (authHeader) { lines.push(`Proxy-Authorization: ${authHeader}`); }
            lines.push('', '');
            sock.write(lines.join('\r\n'));

            let received = '';
            const onData = (chunk: Buffer) => {
                received += chunk.toString('latin1');
                const headerEnd = received.indexOf('\r\n\r\n');
                if (headerEnd === -1) { return; }
                sock.off('data', onData);
                const statusLine = received.slice(0, received.indexOf('\r\n'));
                const match = /^HTTP\/\d(?:\.\d)?\s+(\d+)/.exec(statusLine);
                const status = match ? parseInt(match[1], 10) : 0;
                if (status === 200) {
                    settled = true;
                    sock.setTimeout(0);
                    resolve(sock);
                } else {
                    fail(new Error(`Proxy CONNECT refused: ${statusLine}`));
                }
            };
            sock.on('data', onData);
        });
    });
}

/**
 * Create the underlying http.ClientRequest for a target URL, honoring the
 * module-level strictSSL and proxy settings. Three paths:
 *   1. No proxy: direct http/https.request.
 *   2. Proxy + http target: forward the absolute URL through the proxy.
 *   3. Proxy + https target: open a CONNECT tunnel, then TLS on top.
 */
async function createRequest(
    url: string,
    options: HttpRequestOptions,
    onResponse: (res: http.IncomingMessage) => void
): Promise<http.ClientRequest> {
    const parsedUrl = new URL(url);
    const timeout = options.timeout || DEFAULT_TIMEOUT_MS;
    const method = options.method || 'GET';
    const headers = { ...options.headers };

    if (globalProxyUrl) {
        const proxy = new URL(globalProxyUrl);
        const proxyAuth = buildProxyAuthHeader(proxy);

        if (parsedUrl.protocol === 'http:') {
            // Plain HTTP proxying: absolute URL in the request line, Host
            // header preserved, Proxy-Authorization set when the proxy URL
            // embeds credentials.
            const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
            if (proxyAuth) { headers['Proxy-Authorization'] = proxyAuth; }
            const req = http.request(
                {
                    hostname: proxy.hostname,
                    port: proxyPort,
                    path: url,
                    method,
                    headers,
                    timeout,
                },
                onResponse
            );
            return req;
        }

        // HTTPS target: CONNECT tunnel, then handshake TLS on top of the
        // resulting socket.
        const targetPort = Number(parsedUrl.port) || 443;
        const tunnel = await connectThroughProxy(proxy, parsedUrl.hostname, targetPort, timeout);
        // SNI must not be an IP literal (RFC 6066). Omit servername for IP
        // targets; Node falls back sensibly.
        const isIp = net.isIP(parsedUrl.hostname) !== 0;
        const req = https.request(
            {
                host: parsedUrl.hostname,
                port: targetPort,
                path: parsedUrl.pathname + parsedUrl.search,
                method,
                headers,
                timeout,
                createConnection: () => tls.connect({
                    socket: tunnel,
                    ...(isIp ? {} : { servername: parsedUrl.hostname }),
                    rejectUnauthorized: globalStrictSSL,
                }),
            },
            onResponse
        );
        return req;
    }

    const reqOptions: https.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers,
        timeout,
    };
    if (parsedUrl.protocol === 'https:' && !globalStrictSSL) {
        reqOptions.rejectUnauthorized = false;
    }
    const transport = parsedUrl.protocol === 'https:' ? https : http;
    return transport.request(reqOptions, onResponse);
}

export async function httpRequest(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    const method = options.method || 'GET';
    return new Promise<HttpResponse>(async (resolve, reject) => {
        try {
            const req = await createRequest(url, options, (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                    resolve({ status: res.statusCode || 0, body: data });
                });
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error(`Request timed out: ${method} ${url}`));
            });
            if (options.body) {
                req.write(options.body);
            }
            req.end();
        } catch (err) {
            reject(err as Error);
        }
    });
}

/** Same as httpRequest but collects the response body as a raw Buffer (for binary downloads). */
export async function httpRequestBuffer(url: string, options: HttpRequestOptions = {}): Promise<HttpBufferResponse> {
    const method = options.method || 'GET';
    return new Promise<HttpBufferResponse>(async (resolve, reject) => {
        try {
            const req = await createRequest(url, options, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
                res.on('end', () => {
                    resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) });
                });
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error(`Request timed out: ${method} ${url}`));
            });
            if (options.body) {
                req.write(options.body);
            }
            req.end();
        } catch (err) {
            reject(err as Error);
        }
    });
}
