/**
 * Janitor: sweep stranded `tfvc-ci-*` shelvesets from crashed live-smoke
 * runs. Runs as a separate CI step with `if: always()` so it fires even
 * when the test step failed.
 *
 * Safety:
 *   - Only targets the bot's own shelvesets (listShelvesets(owner)).
 *   - Only targets names that start with `tfvc-ci-` — a human's manually
 *     named shelveset cannot match.
 *   - Only targets shelvesets older than 1 hour, so a fresh one from a
 *     concurrent run is never swept out from under it.
 */

import { AdoRestClient, buildOnPremBase } from '../src/ado/restClient';
import { TfvcSoapClient } from '../src/ado/tfvcSoapClient';
import { loadLiveConfig } from './config';

const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1h

async function main(): Promise<void> {
    const cfg = loadLiveConfig();
    const client = new AdoRestClient(
        cfg.org,
        cfg.pat,
        cfg.project,
        cfg.baseUrl || '',
        cfg.collectionPath || '',
    );
    // Same SOAP base the extension uses — shelveset delete is SOAP-only on
    // real ADO (REST is read-only; the whole point of issue #10).
    const soapBase = cfg.baseUrl
        ? buildOnPremBase(cfg.baseUrl, cfg.collectionPath || '')
        : `https://dev.azure.com/${encodeURIComponent(cfg.org)}`;
    const soap = new TfvcSoapClient(soapBase, cfg.pat);

    const identity = await client.getBotIdentity();
    // listShelvesets(owner) filters server-side by display name. Scopes
    // the sweep to the PAT's own shelvesets regardless of what else lives
    // on the project.
    const shelves = await client.listShelvesets(identity.displayName);

    const cutoffMs = Date.now() - STALE_THRESHOLD_MS;
    const victims = shelves.filter(s => {
        if (!s.name.startsWith('tfvc-ci-')) { return false; }
        const created = Date.parse(s.createdDate);
        // If we can't parse the date, skip — better to leak than mis-delete.
        return Number.isFinite(created) && created < cutoffMs;
    });

    let deleted = 0;
    for (const s of victims) {
        try {
            await soap.deleteShelveset(s.name, identity.displayName);
            console.log(`janitor: deleted ${s.name} (created ${s.createdDate})`);
            deleted++;
        } catch (err) {
            // Log and keep going — one bad entry shouldn't block the rest.
            console.warn(`janitor: failed to delete ${s.name}:`, err);
        }
    }

    console.log(`janitor: swept ${deleted}/${shelves.length} shelvesets (${victims.length} stale tfvc-ci-*)`);
}

main().catch(err => {
    console.error('janitor fatal:', err);
    process.exit(1);
});
