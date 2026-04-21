import * as assert from 'assert';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as os from 'os';
import { describe, it, before, after } from 'node:test';
import { httpRequest, setStrictSSL, getStrictSSL, setProxyUrl, resolveProxyUrl } from '../src/ado/httpClient';

/**
 * Exercises the rejectUnauthorized plumbing against a real HTTPS server
 * using a self-signed certificate. With strictSSL=true the request fails
 * with a cert error; with strictSSL=false the same request succeeds.
 */

let server: https.Server;
let port: number;
let tmpdir: string;

function generateSelfSignedCert(): { keyPath: string; certPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfvc-ssl-'));
    const keyPath = path.join(dir, 'key.pem');
    const certPath = path.join(dir, 'cert.pem');
    execSync(
        `openssl req -x509 -nodes -newkey rsa:2048 ` +
        `-keyout "${keyPath}" -out "${certPath}" ` +
        `-days 1 -subj "/CN=localhost" ` +
        `-addext "subjectAltName=IP:127.0.0.1"`,
        { stdio: 'ignore' }
    );
    tmpdir = dir;
    return { keyPath, certPath };
}

before(async () => {
    const { keyPath, certPath } = generateSelfSignedCert();
    server = https.createServer({
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
    }, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('hello');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
});

after(() => {
    server?.close();
    if (tmpdir) {
        try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

describe('httpClient strictSSL (v0.3.5)', () => {
    it('defaults to strict cert validation (rejects self-signed)', async () => {
        setStrictSSL(true);
        assert.strictEqual(getStrictSSL(), true);
        await assert.rejects(
            () => httpRequest(`https://127.0.0.1:${port}/`),
            (err: Error & { code?: string }) => {
                // Node reports DEPTH_ZERO_SELF_SIGNED_CERT or SELF_SIGNED_CERT_IN_CHAIN
                return /self.signed|self_signed/i.test(err.message) || /self.signed/i.test(err.code || '');
            },
            'strict mode must reject the self-signed server',
        );
    });

    it('accepts self-signed certs when strictSSL is false', async () => {
        setStrictSSL(false);
        try {
            const res = await httpRequest(`https://127.0.0.1:${port}/`);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body, 'hello');
        } finally {
            setStrictSSL(true); // restore default so later tests don't inherit
        }
    });

    it('leaves rejectUnauthorized at its default for plain http', async () => {
        // http:// URLs never touch the flag — this is a smoke check that
        // toggling strictSSL doesn't accidentally break non-TLS traffic.
        setStrictSSL(false);
        try {
            // No server on this port; expect a connection error, not a TLS error.
            await assert.rejects(
                () => httpRequest('http://127.0.0.1:1/'),
                (err: Error & { code?: string }) => err.code === 'ECONNREFUSED',
            );
        } finally {
            setStrictSSL(true);
        }
    });
});

describe('httpClient resolveProxyUrl (v0.3.5)', () => {
    it('prefers explicit config over environment', () => {
        const saved = {
            https: process.env.HTTPS_PROXY,
            http: process.env.HTTP_PROXY,
        };
        process.env.HTTPS_PROXY = 'http://env.example:1';
        try {
            assert.strictEqual(
                resolveProxyUrl('http://config.example:2'),
                'http://config.example:2',
            );
        } finally {
            process.env.HTTPS_PROXY = saved.https;
            process.env.HTTP_PROXY = saved.http;
        }
    });

    it('falls back to HTTPS_PROXY env var when config is empty', () => {
        const saved = process.env.HTTPS_PROXY;
        process.env.HTTPS_PROXY = 'http://fallback.example:3';
        try {
            assert.strictEqual(resolveProxyUrl(''), 'http://fallback.example:3');
            assert.strictEqual(resolveProxyUrl(undefined), 'http://fallback.example:3');
        } finally {
            if (saved === undefined) { delete process.env.HTTPS_PROXY; }
            else { process.env.HTTPS_PROXY = saved; }
        }
    });

    it('returns undefined when neither config nor env is set', () => {
        const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;
        const saved = keys.map(k => [k, process.env[k]] as const);
        for (const k of keys) { delete process.env[k]; }
        try {
            assert.strictEqual(resolveProxyUrl(''), undefined);
            assert.strictEqual(resolveProxyUrl(undefined), undefined);
        } finally {
            for (const [k, v] of saved) {
                if (v === undefined) { delete process.env[k]; }
                else { process.env[k] = v; }
            }
        }
    });
});

/**
 * Minimal HTTP forward + CONNECT proxy used for integration tests.
 * Records every CONNECT/http request so tests can assert the proxy was
 * actually involved in the round-trip.
 */
interface ProxyLog {
    connects: Array<{ host: string; authHeader?: string }>;
    httpRequests: Array<{ method: string; url: string; authHeader?: string }>;
}

function startTestProxy(): Promise<{ server: http.Server; port: number; log: ProxyLog; close: () => void }> {
    const log: ProxyLog = { connects: [], httpRequests: [] };
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            // HTTP forward path: the client sent an absolute URL
            log.httpRequests.push({
                method: req.method || 'GET',
                url: req.url || '',
                authHeader: (req.headers['proxy-authorization'] as string) || undefined,
            });
            const target = new URL(req.url || '', 'http://localhost');
            const forwardHeaders = { ...req.headers };
            delete forwardHeaders['proxy-authorization'];
            const forward = http.request(
                {
                    hostname: target.hostname,
                    port: target.port,
                    path: target.pathname + target.search,
                    method: req.method,
                    headers: forwardHeaders,
                },
                proxyRes => {
                    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
                    proxyRes.pipe(res);
                },
            );
            forward.on('error', () => { res.writeHead(502); res.end('proxy forward failed'); });
            req.pipe(forward);
        });

        // CONNECT path — used when the target is https.
        server.on('connect', (req, clientSock, head) => {
            const authHeader = (req.headers['proxy-authorization'] as string) || undefined;
            log.connects.push({ host: req.url || '', authHeader });
            const [host, portStr] = (req.url || '').split(':');
            const upstream = net.connect(Number(portStr) || 443, host, () => {
                clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                upstream.write(head);
                upstream.pipe(clientSock);
                clientSock.pipe(upstream);
            });
            upstream.on('error', () => clientSock.end());
            clientSock.on('error', () => upstream.destroy());
        });

        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as { port: number }).port;
            resolve({
                server,
                port,
                log,
                close: () => server.close(),
            });
        });
    });
}

describe('httpClient proxy (v0.3.5)', () => {
    it('routes https traffic through the proxy via CONNECT', async () => {
        // Reuse the self-signed HTTPS server set up at module start.
        const proxy = await startTestProxy();
        setProxyUrl(`http://127.0.0.1:${proxy.port}`);
        setStrictSSL(false);
        try {
            const res = await httpRequest(`https://127.0.0.1:${port}/hello`);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body, 'hello');
            assert.strictEqual(proxy.log.connects.length, 1, 'proxy should have seen one CONNECT');
            assert.strictEqual(proxy.log.connects[0].host, `127.0.0.1:${port}`);
        } finally {
            setProxyUrl(undefined);
            setStrictSSL(true);
            proxy.close();
        }
    });

    it('forwards http traffic to the proxy as absolute URLs', async () => {
        const target = http.createServer((_req, res) => {
            res.writeHead(200);
            res.end('via-proxy');
        });
        await new Promise<void>(r => target.listen(0, '127.0.0.1', r));
        const targetPort = (target.address() as { port: number }).port;
        const proxy = await startTestProxy();
        setProxyUrl(`http://127.0.0.1:${proxy.port}`);
        try {
            const res = await httpRequest(`http://127.0.0.1:${targetPort}/hello`);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body, 'via-proxy');
            assert.strictEqual(proxy.log.httpRequests.length, 1, 'proxy should have seen the http request');
            assert.strictEqual(
                proxy.log.httpRequests[0].url,
                `http://127.0.0.1:${targetPort}/hello`,
                'request-line must carry the absolute URL',
            );
        } finally {
            setProxyUrl(undefined);
            proxy.close();
            target.close();
        }
    });

    it('sends Proxy-Authorization when the proxy URL embeds credentials', async () => {
        const proxy = await startTestProxy();
        // URL-encode a colon in the password just to verify decoding.
        setProxyUrl(`http://alice:p%40ss@127.0.0.1:${proxy.port}`);
        setStrictSSL(false);
        try {
            await httpRequest(`https://127.0.0.1:${port}/`);
            assert.strictEqual(proxy.log.connects.length, 1);
            const expected = 'Basic ' + Buffer.from('alice:p@ss').toString('base64');
            assert.strictEqual(proxy.log.connects[0].authHeader, expected);
        } finally {
            setProxyUrl(undefined);
            setStrictSSL(true);
            proxy.close();
        }
    });

    it('rejects when the proxy refuses the CONNECT (407, 502, …)', async () => {
        // Mini-proxy that rejects every CONNECT.
        const rejecting = http.createServer();
        rejecting.on('connect', (_req, clientSock) => {
            clientSock.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
            clientSock.end();
        });
        await new Promise<void>(r => rejecting.listen(0, '127.0.0.1', r));
        const rejPort = (rejecting.address() as { port: number }).port;
        setProxyUrl(`http://127.0.0.1:${rejPort}`);
        setStrictSSL(false);
        try {
            await assert.rejects(
                () => httpRequest(`https://127.0.0.1:${port}/`),
                (err: Error) => /Proxy CONNECT refused/.test(err.message) || /407/.test(err.message),
            );
        } finally {
            setProxyUrl(undefined);
            setStrictSSL(true);
            rejecting.close();
        }
    });
});
