/**
 * Layer 2 smoke suite — hits a real Azure DevOps sandbox instead of a
 * local mock, so unit tests can't substitute for this.
 *
 * What lives here (and why):
 *   - All tests are read-only. TFVC changesets are immutable, so any
 *     write test would permanently pollute the sandbox's history. Keep
 *     the blast radius at zero for nightly automation. Writes stay in
 *     manual testing for now.
 *   - We drive the AdoRestClient directly (not the extension host) —
 *     that's the layer where the "is our shape correct for the real
 *     server?" questions actually live. The extension host is covered
 *     by the Layer 1 e2e suite.
 *
 * Failure here means: the extension will misbehave against a real ADO
 * cloud in a way our mock-based unit tests don't catch.
 */

import * as assert from 'assert';
import { describe, it, before } from 'node:test';
import { AdoRestClient, CATEGORY_CODE_REVIEW_REQUEST, CATEGORY_CODE_REVIEW_RESPONSE } from '../src/ado/restClient';
import { loadLiveConfig } from './config';

let client: AdoRestClient;

before(() => {
    const cfg = loadLiveConfig();
    client = new AdoRestClient(cfg.org, cfg.pat, cfg.project, cfg.baseUrl || '', cfg.collectionPath || '');
});

describe('Live ADO: auth + identity', () => {
    it('getBotIdentity resolves the authenticated user', async () => {
        // Regression for the v0.3.6 fix — cloud ADO rejects api-version=7.1
        // on /_apis/connectionData. If this starts failing on a future
        // server change the fix is usually "pin a different api-version".
        const id = await client.getBotIdentity();
        assert.ok(id.displayName, `expected a display name, got: ${JSON.stringify(id)}`);
        assert.ok(id.id, `expected a user id, got: ${JSON.stringify(id)}`);
    });
});

describe('Live ADO: work-item-type categories', () => {
    it('resolves Microsoft.CodeReviewRequestCategory to a type name', async () => {
        const name = await client.getWorkItemTypeByCategory(CATEGORY_CODE_REVIEW_REQUEST);
        assert.ok(name && name.length > 0, `expected a non-empty type name, got: ${JSON.stringify(name)}`);
        // Don't snapshot the actual name — on a German server it's
        // "Codereviewanforderung", on English "Code Review Request".
        // The contract we care about is that *something* comes back.
    });

    it('resolves Microsoft.CodeReviewResponseCategory to a type name', async () => {
        const name = await client.getWorkItemTypeByCategory(CATEGORY_CODE_REVIEW_RESPONSE);
        assert.ok(name && name.length > 0);
    });

    it('caches category lookups (second call adds no extra request)', async () => {
        // Indirect smoke: the second call should succeed instantly. We
        // already asserted correctness above; this is just a latency
        // sanity check that the cache path is wired.
        const start = Date.now();
        await client.getWorkItemTypeByCategory(CATEGORY_CODE_REVIEW_RESPONSE);
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 100, `cached lookup should be instant, took ${elapsed}ms`);
    });
});

describe('Live ADO: TFVC shelveset listing', () => {
    it('listShelvesets returns an array (count can be anything)', async () => {
        const shelves = await client.listShelvesets();
        assert.ok(Array.isArray(shelves));
        // If the sandbox has any, each should have a non-empty name.
        for (const s of shelves) {
            assert.ok(s.name, `shelveset missing name: ${JSON.stringify(s)}`);
        }
    });
});

describe('Live ADO: WIQL IN GROUP filter', () => {
    it('queryOpenReviews executes without error (count can be 0)', async () => {
        // Regression for the v0.3.4 WIQL rewrite — [System.WorkItemType]
        // IN GROUP 'Microsoft.CodeReviewRequestCategory'. If the server
        // rejects the IN GROUP syntax on a future change this fails loud.
        const reviews = await client.queryOpenReviews('Requested');
        assert.ok(Array.isArray(reviews));
        // Each review, if any, should have an id and title.
        for (const r of reviews) {
            assert.ok(typeof r.id === 'number' && r.id > 0);
            assert.ok(typeof r.title === 'string');
        }
    });
});
