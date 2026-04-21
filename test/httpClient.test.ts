import * as assert from 'assert';
import * as https from 'https';
import * as tls from 'tls';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as os from 'os';
import { describe, it, before, after } from 'node:test';
import { httpRequest, setStrictSSL, getStrictSSL } from '../src/ado/httpClient';

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
