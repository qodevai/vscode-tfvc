/** Shared XML parsing utilities for TEE-CLC output and SOAP responses. */

export function extractAttr(attrs: string, name: string): string | undefined {
    const regex = new RegExp(`${name}="([^"]*)"`, 'i');
    const match = regex.exec(attrs);
    return match ? match[1] : undefined;
}

const NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
};

/**
 * Decode XML entities in a string. Handles the five standard named entities
 * plus arbitrary numeric entities (`&#NN;` decimal and `&#xHH;` hex).
 *
 * Runs in a single regex pass so `&amp;` isn't double-decoded: previously we
 * chained `.replace` calls starting with `&amp;` → `&`, which meant
 * `&amp;lt;` (an encoded literal `&lt;`) was turned into `<` on the next
 * chained replace. A single pass leaves already-decoded content alone.
 */
export function decodeXmlEntities(s: string): string {
    return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
        if (entity[0] === '#') {
            const isHex = entity[1] === 'x' || entity[1] === 'X';
            const code = isHex
                ? parseInt(entity.slice(2), 16)
                : parseInt(entity.slice(1), 10);
            if (Number.isNaN(code) || code < 0 || code > 0x10FFFF) { return match; }
            try { return String.fromCodePoint(code); } catch { return match; }
        }
        const mapped = NAMED_ENTITIES[entity];
        return mapped ?? match;
    });
}

export function escapeXmlAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
