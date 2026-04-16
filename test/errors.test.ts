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

    it('maps 5xx to a server-error message', () => {
        const err = classifyHttpError(503, 'service unavailable', 'ADO API error');
        assert.strictEqual(err.statusCode, 503);
        assert.match(err.message, /server error \(503\)/);
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
