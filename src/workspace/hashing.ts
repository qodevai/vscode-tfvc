import * as crypto from 'crypto';
import * as fs from 'fs';

/**
 * Compute a base64-encoded MD5 hash of a file's contents.
 * Matches the `hashValue` field returned by the TFVC REST API items endpoint.
 */
export function computeFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('base64')));
        stream.on('error', reject);
    });
}

/**
 * Compute a base64-encoded MD5 hash of an in-memory buffer. Matches the
 * `hash` multipart field TFVC's upload.ashx endpoint expects — the server
 * recomputes on receive and rejects mismatches.
 */
export function md5Base64(content: Buffer): string {
    return crypto.createHash('md5').update(content).digest('base64');
}
