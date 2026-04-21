/**
 * Environment-variable wiring for the Layer 2 smoke suite.
 * Fail loud with a clear message if anything is missing — silent skips
 * would let a broken CI workflow go unnoticed.
 */

export interface LiveConfig {
    org: string;
    project: string;
    pat: string;
    /** Optional; when unset we hit cloud (dev.azure.com/{org}). */
    baseUrl?: string;
    /** Optional on-prem collection path; only meaningful with baseUrl. */
    collectionPath?: string;
}

export function loadLiveConfig(): LiveConfig {
    const org = process.env.TFVC_E2E_ORG;
    const project = process.env.TFVC_E2E_PROJECT;
    const pat = process.env.TFVC_E2E_PAT;
    const baseUrl = process.env.TFVC_E2E_BASE_URL;
    const collectionPath = process.env.TFVC_E2E_COLLECTION_PATH;

    const missing: string[] = [];
    if (!org && !baseUrl) { missing.push('TFVC_E2E_ORG or TFVC_E2E_BASE_URL'); }
    if (!project) { missing.push('TFVC_E2E_PROJECT'); }
    if (!pat) { missing.push('TFVC_E2E_PAT'); }
    if (missing.length > 0) {
        throw new Error(
            `Live smoke suite requires: ${missing.join(', ')}. ` +
            `In CI these come from the TFVC_E2E_* repo secrets/variables.`
        );
    }

    return {
        org: org || '',
        project: project!,
        pat: pat!,
        baseUrl,
        collectionPath,
    };
}
