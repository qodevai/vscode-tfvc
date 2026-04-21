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
import * as os from 'os';
import { describe, it, before } from 'node:test';
import { AdoRestClient, CATEGORY_CODE_REVIEW_REQUEST, CATEGORY_CODE_REVIEW_RESPONSE, buildOnPremBase } from '../src/ado/restClient';
import { TfvcSoapClient } from '../src/ado/tfvcSoapClient';
import { TfvcUploadClient } from '../src/ado/tfvcUploadClient';
import { loadLiveConfig, LiveConfig } from './config';

let client: AdoRestClient;
let soap: TfvcSoapClient;
let upload: TfvcUploadClient;
let cfg: LiveConfig;

function soapBaseFor(cfg: LiveConfig): string {
    return cfg.baseUrl
        ? buildOnPremBase(cfg.baseUrl, cfg.collectionPath || '')
        : `https://dev.azure.com/${encodeURIComponent(cfg.org)}`;
}

before(() => {
    cfg = loadLiveConfig();
    client = new AdoRestClient(cfg.org, cfg.pat, cfg.project, cfg.baseUrl || '', cfg.collectionPath || '');
    const base = soapBaseFor(cfg);
    soap = new TfvcSoapClient(base, cfg.pat);
    upload = new TfvcUploadClient(base, cfg.pat);
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

describe('Live ADO: TFVC shelveset write round-trip (SOAP)', () => {
    // Run tag carries the GitHub run id (or "local") + a timestamp so
    // concurrent workflows can't collide on shelveset names, workspace
    // names, or sentinel paths — and a crashed run's leftovers are still
    // trivially identifiable by the janitor.
    const runTag = `${process.env.GITHUB_RUN_ID ?? 'local'}-${Date.now()}`;
    const shelveName = `tfvc-ci-${runTag}`;
    const workspaceName = `tfvc-ci-ws-${runTag}`;
    let sentinelPath: string;
    let botName: string;
    let botUnique: string;

    before(async () => {
        sentinelPath = `$/${cfg.project}/.ci-shelveset-sentinels/run-${runTag}.txt`;
        const identity = await client.getBotIdentity();
        botName = identity.displayName;
        botUnique = identity.uniqueName;
    });

    /**
     * Drives the full SOAP shelve flow end-to-end:
     *   CreateWorkspace → UploadFile → PendChanges → Shelve →
     *   UndoPendingChanges → DeleteShelveset → DeleteWorkspace
     *
     * Every step operates on sandbox-local identifiers (names embed the
     * run tag). The test cleans its own workspace on success; the janitor
     * sweeps the shelveset if a run crashes between create and delete.
     */
    it('creates workspace, shelves a pending add, deletes shelveset + workspace', async () => {
        const content = Buffer.from(`ci smoke run ${runTag} — safe to delete`, 'utf8');

        // DEBUG: log the identity fields so we can see what the server
        // gives us in CI. Remove once CreateWorkspace is working.
        const id = await client.getBotIdentity();
        console.log('DEBUG identity:', JSON.stringify(id));

        let createdWorkspace = false;
        let createdShelveset = false;
        try {
            await soap.createWorkspace({
                name: workspaceName,
                owner: botUnique,
                ownerDisplayName: botName,
                ownerUniqueName: botUnique,
                computer: `ci-${os.hostname()}`,
                comment: 'CI smoke — safe to delete',
            });
            createdWorkspace = true;

            const uploaded = await upload.uploadFile({
                serverPath: sentinelPath,
                workspaceName,
                workspaceOwner: botUnique,
                content,
            });
            assert.ok(uploaded.hash.length > 0, 'upload response should carry a hash');

            await soap.pendChanges(workspaceName, botUnique, [{
                serverPath: sentinelPath,
                changeType: 'Add',
                itemType: 'File',
                downloadId: uploaded.downloadId,
            }]);

            const failures = await soap.shelve(
                workspaceName,
                botUnique,
                [sentinelPath],
                { name: shelveName, owner: botUnique, ownerDisplayName: botName, comment: 'CI smoke' },
                /* replace */ true,
            );
            assert.deepStrictEqual(
                failures.filter(f => f.severity === 'Error'),
                [],
                `shelve returned fatal failures: ${JSON.stringify(failures)}`,
            );
            createdShelveset = true;

            await soap.undoPendingChanges(workspaceName, botUnique, [sentinelPath]);

            const listed = await client.listShelvesets(botName);
            assert.ok(
                listed.some(s => s.name === shelveName),
                `shelveset "${shelveName}" should appear in listShelvesets after Shelve`,
            );
        } finally {
            if (createdShelveset) {
                await soap.deleteShelveset(shelveName, botUnique).catch(() => {});
            }
            if (createdWorkspace) {
                await soap.deleteWorkspace(workspaceName, botUnique).catch(() => {});
            }
        }

        const after = await client.listShelvesets(botName);
        assert.ok(
            !after.some(s => s.name === shelveName),
            `shelveset "${shelveName}" should be gone after delete`,
        );
    });
});
