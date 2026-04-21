import * as assert from 'assert';
import { describe, it } from 'node:test';
import { classifyHttpError, TfvcError } from '../src/errors';

describe('classifyHttpError', () => {
    it('maps 401 to an auth-specific message', () => {
        const err = classifyHttpError(401, 'TF400813: unauthorized', 'ADO API error');
        assert.ok(err instanceof TfvcError);
        assert.strictEqual(err.statusCode, 401);
        assert.match(err.message, /authentication failed/i);
        assert.match(err.message, /PAT/);
    });

    it('maps 403 to a permissions-specific message', () => {
        const err = classifyHttpError(403, 'forbidden', 'ADO API error');
        assert.strictEqual(err.statusCode, 403);
        assert.match(err.message, /denied/i);
    });

    it('maps 404 to a resource-not-found message', () => {
        const err = classifyHttpError(404, 'not found', 'ADO API error');
        assert.strictEqual(err.statusCode, 404);
        assert.match(err.message, /not found/i);
    });

    it('maps 429 to a rate-limit message', () => {
        const err = classifyHttpError(429, 'too many requests', 'ADO API error');
        assert.strictEqual(err.statusCode, 429);
        assert.match(err.message, /rate-limited/i);
    });

    it('maps 400 to a bad-request message with detail', () => {
        const err = classifyHttpError(400, 'TF400890: Invalid foo', 'ADO API error');
        assert.strictEqual(err.statusCode, 400);
        assert.match(err.message, /Bad Request/);
        assert.match(err.message, /TF400890/);
    });

    it('maps 408 to a timeout message pointing at proxy/network', () => {
        const err = classifyHttpError(408, 'request timeout', 'ADO API error');
        assert.strictEqual(err.statusCode, 408);
        assert.match(err.message, /timed out/i);
        assert.match(err.message, /tfvc\.proxy/);
    });

    it('maps 502 / 503 / 504 to a gateway/unavailable message', () => {
        for (const status of [502, 503, 504]) {
            const err = classifyHttpError(status, 'unavailable', 'ADO API error');
            assert.strictEqual(err.statusCode, status);
            assert.match(err.message, /temporarily unavailable/i, `status ${status}`);
            assert.ok(err.message.includes(String(status)));
        }
    });

    it('falls back to the generic 5xx message for other server errors', () => {
        const err = classifyHttpError(500, 'internal', 'ADO API error');
        assert.strictEqual(err.statusCode, 500);
        assert.match(err.message, /server error \(500\)/);
    });

    it('falls back to generic formatting for unrecognised statuses', () => {
        const err = classifyHttpError(418, 'teapot body', 'ADO API error');
        assert.strictEqual(err.statusCode, 418);
        assert.match(err.message, /ADO API error 418/);
        assert.match(err.message, /teapot body/);
    });

    it('truncates long response bodies on the detail field', () => {
        const huge = 'x'.repeat(2000);
        const err = classifyHttpError(500, huge, 'ADO API error');
        assert.ok(err.detail!.length <= 500);
    });
});
