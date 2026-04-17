/**
 * Encode file bytes for the ADO checkin/shelve API payload.
 *
 * Always uses base64 so text files in any encoding (UTF-16, latin1, Shift-JIS …)
 * and binary files round-trip byte-exact. The earlier "sniff for a null byte
 * then send as rawText/UTF-8" heuristic corrupted any file whose bytes weren't
 * already valid UTF-8 (for example, UTF-16 text files legitimately contain
 * null bytes and would decode to mojibake).
 */
export function encodeFileContent(content: Buffer): { content: string; contentType: 'base64Encoded' } {
    return {
        content: content.toString('base64'),
        contentType: 'base64Encoded',
    };
}
