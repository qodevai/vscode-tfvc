import * as assert from 'assert';
import { describe, it } from 'node:test';
import { decodeXmlEntities, extractAttr, escapeXmlAttr } from '../src/xmlUtils';

describe('decodeXmlEntities', () => {
    it('decodes the five standard named entities', () => {
        assert.strictEqual(
            decodeXmlEntities('Tom &amp; Jerry &lt;1&gt; said &quot;hi&quot; o&apos;clock'),
            `Tom & Jerry <1> said "hi" o'clock`,
        );
    });

    it('decodes hex numeric entities (uppercase and lowercase markers)', () => {
        assert.strictEqual(decodeXmlEntities('&#x27;'), "'");
        assert.strictEqual(decodeXmlEntities('&#X27;'), "'");
        assert.strictEqual(decodeXmlEntities('&#xA;line'), '\nline');
        assert.strictEqual(decodeXmlEntities('&#xD;'), '\r');
    });

    it('decodes decimal numeric entities', () => {
        assert.strictEqual(decodeXmlEntities('&#39;'), "'");
        assert.strictEqual(decodeXmlEntities('&#10;'), '\n');
        assert.strictEqual(decodeXmlEntities('&#65;'), 'A');
    });

    it('decodes entities above the BMP (astral plane) via String.fromCodePoint', () => {
        // 🎉 is U+1F389 (128265 decimal, 0x1F389 hex)
        assert.strictEqual(decodeXmlEntities('&#x1F389;'), '🎉');
        assert.strictEqual(decodeXmlEntities('&#127881;'), '🎉');
    });

    it('leaves unknown named entities untouched rather than dropping them', () => {
        assert.strictEqual(decodeXmlEntities('&nbsp;'), '&nbsp;');
        assert.strictEqual(decodeXmlEntities('before &unknown; after'), 'before &unknown; after');
    });

    it('leaves malformed / out-of-range numeric entities untouched', () => {
        // Beyond the Unicode range
        assert.strictEqual(decodeXmlEntities('&#x110000;'), '&#x110000;');
        // Garbage hex
        assert.strictEqual(decodeXmlEntities('&#xZZZZ;'), '&#xZZZZ;');
    });

    it('does NOT double-decode (regression for chained-replace bug)', () => {
        // An encoded literal `&lt;` is `&amp;lt;`. It should decode back to
        // `&lt;` — NOT to `<`, which is what the old chain produced when
        // `&amp;` ran first.
        assert.strictEqual(decodeXmlEntities('&amp;lt;'), '&lt;');
        assert.strictEqual(decodeXmlEntities('&amp;amp;'), '&amp;');
    });

    it('decodes multiple entities in one string in a single pass', () => {
        assert.strictEqual(
            decodeXmlEntities('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;'),
            `<a href="x">Tom & Jerry</a>`,
        );
    });

    it('is a no-op for strings with no entities', () => {
        assert.strictEqual(decodeXmlEntities('plain text 123'), 'plain text 123');
    });
});

describe('escapeXmlAttr', () => {
    it('round-trips with decodeXmlEntities for the five named entities', () => {
        const raw = `Tom & Jerry <1> said "hi" o'clock`;
        assert.strictEqual(decodeXmlEntities(escapeXmlAttr(raw)), raw);
    });
});

describe('extractAttr', () => {
    it('finds a simple attribute value', () => {
        assert.strictEqual(extractAttr('name="alice" age="30"', 'name'), 'alice');
    });

    it('is case-insensitive on the attribute name', () => {
        assert.strictEqual(extractAttr('Name="alice"', 'name'), 'alice');
    });

    it('returns undefined when missing', () => {
        assert.strictEqual(extractAttr('name="alice"', 'missing'), undefined);
    });
});
