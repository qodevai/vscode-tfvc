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

/**
 * Windows code page to send as item.contentMetadata.encoding on a changeset.
 *
 * The on-prem Create Changeset handler rejects a change whose content has no
 * explicit encoding, *even when newContent.contentType is base64Encoded*:
 *   "An explicit encoding value must be provided when supplying raw text
 *    content. ... Parameter name: pathActions.action.encoding"
 * (microsoft/vsts-dotnet-samples#77). Every 4.1 example in the REST docs
 * carries `item.contentMetadata.encoding`, so supply one for every change.
 *
 * Values: 65001 = UTF-8, 1200 = UTF-16 LE, 1201 = UTF-16 BE, -1 = binary.
 * The bytes themselves always travel as base64, so this only tells the server
 * how to interpret/display the file; it never re-encodes the payload.
 */
export function detectContentEncoding(content: Buffer): number {
    if (content.length >= 3 && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) {
        return 65001; // UTF-8 BOM
    }
    if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
        return 1200;  // UTF-16 LE BOM
    }
    if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) {
        return 1201;  // UTF-16 BE BOM
    }
    // A NUL byte in the first 8 KiB is the server's own binary heuristic.
    if (content.subarray(0, Math.min(content.length, 8192)).includes(0)) {
        return -1;
    }
    return 65001;
}
