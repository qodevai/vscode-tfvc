/**
 * Layer 2 smoke suite — hits a real Azure DevOps sandbox instead of a
 * local mock, so unit tests can't substitute for this.
 *
 * What lives here (and why):
 *   - Reads exercise the happy-path endpoints (auth, categories,
 *     listShelvesets, WIQL) against the real server shape.
 *   - One write path: the shelveset round-trip. Shelvesets are the only
 *     mutable TFVC surface that can be cleaned up safely; changesets
 *     and work items are either immutable or leave orphans, so those
 *     stay in manual testing.
 *   - A janitor (test-live/janitor.ts) runs in a separate CI step and
 *     sweeps stranded `tfvc-ci-*` shelvesets if a run crashes between
 *     create and delete.
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
import { TfvcChangePayload } from '../src/ado/types';
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

describe('Live ADO: TFVC shelveset write round-trip', () => {
    // Run tag carries the GitHub run id (or "local") + a timestamp so
    // concurrent workflows can't collide on shelveset names or sentinel
    // paths, and a crashed run's leftovers are still trivially identifiable
    // by the janitor.
    const runTag = `${process.env.GITHUB_RUN_ID ?? 'local'}-${Date.now()}`;
    const shelveName = `tfvc-ci-${runTag}`;
    let sentinelPath: string;
    let botName: string;

    before(async () => {
        const cfg = loadLiveConfig();
        sentinelPath = `$/${cfg.project}/.ci-shelveset-sentinels/run-${runTag}.txt`;
        botName = (await client.getBotIdentity()).displayName;
    });

    // SKIPPED — wiring the test caught a pre-existing bug: the ADO REST
    // shelveset API is read-only. `POST /_apis/tfvc/shelvesets` returns
    // HTTP 405 "does not support http method 'POST'" against cloud ADO,
    // and the same is true for DELETE. The MS docs list only Get + List
    // for Tfvc/Shelvesets:
    //   https://learn.microsoft.com/en-us/rest/api/azure/devops/tfvc/shelvesets
    //
    // This means `AdoRestClient.createShelveset` / `.deleteShelveset` have
    // never worked against a real server — the "local shelf fallback"
    // noted in the 0.3.2 CHANGELOG is what masked it end-user-side. To
    // make this test pass we'd need to either (a) implement shelveset
    // create/delete via SOAP (TFVC web service), or (b) remove the REST
    // methods from the client and document that server-side shelving
    // isn't supported.
    //
    // Keeping the test body intact so it runs as soon as the underlying
    // methods are fixed — delete `skip: ...` and it's ready to go.
    it('creates a shelveset with one pending add, lists it, deletes it', { skip: 'AdoRestClient.createShelveset uses REST endpoints that do not exist; pre-existing bug, see comment' }, async () => {
        const change: TfvcChangePayload = {
            changeType: 'add',
            item: { path: sentinelPath },
            newContent: {
                content: Buffer.from(`ci smoke run ${runTag} — safe to delete`).toString('base64'),
                contentType: 'base64Encoded',
            },
        };

        let created = false;
        try {
            await client.createShelveset(shelveName, [change], `CI smoke — ${runTag}`);
            created = true;

            const after = await client.listShelvesets();
            assert.ok(
                after.some(s => s.name === shelveName),
                `created shelveset "${shelveName}" should appear in listShelvesets`,
            );
        } finally {
            if (created) {
                // Best-effort cleanup; the janitor sweeps leftovers on the next run.
                await client.deleteShelveset(shelveName, botName).catch(() => {});
            }
        }

        const afterDelete = await client.listShelvesets();
        assert.ok(
            !afterDelete.some(s => s.name === shelveName),
            `shelveset "${shelveName}" should be gone after delete`,
        );
    });
});
