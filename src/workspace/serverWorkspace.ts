/**
 * Server-registered TFVC workspace lifecycle — the piece v0.3.0 dropped when
 * the extension migrated to pure REST. Needed again because SOAP Shelve is
 * workspace-scoped: you can't ship pending changes to the server without
 * first having a workspace and pending them there.
 *
 * Design goals:
 *   - Invisible to users. The workspace is a mechanism, not state they care
 *     about. We keep one per install, resolve it lazily on first shelve.
 *   - Deterministic naming so reconnecting after a VS Code restart finds the
 *     existing server workspace rather than orphaning it.
 *   - Self-healing: if the server returns "not found" (admin deleted it,
 *     workspace rotated out), we recreate without bothering the user.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TfvcSoapClient, WorkspaceInfo } from '../ado/tfvcSoapClient';

const STATE_FILENAME = 'server-workspace.json';
const NAME_PREFIX = 'vscode-tfvc-';

/**
 * JSON shape persisted to `.vscode-tfvc/server-workspace.json`. Extra fields
 * from future versions are ignored, not stripped, so downgrading doesn't
 * wipe them.
 */
interface PersistedWorkspace {
    name: string;
    owner: string;
    ownerDisplayName: string;
    computer: string;
    createdDate: string;
}

export interface ServerIdentity {
    /**
     * Primary owner identifier passed to CreateWorkspace as `owner`. Cloud
     * ADO expects the unique name here (e.g. `alice@corp.com`); the server
     * rejects with "Parameter name: OwnerName" if this can't be resolved.
     */
    owner: string;
    /** Friendly name shown in TFS UI. */
    ownerDisplayName: string;
    /** Unique-name hint ("owneruniq" attribute). Same as owner on cloud; useful when the primary identifier is a display name on on-prem. */
    ownerUniqueName?: string;
}

/**
 * Compute the deterministic workspace name for this install. The hash
 * mixes the absolute workspace root so two VS Code windows pointed at
 * different TFVC projects on the same machine don't collide. Machine name
 * is included for humans sweeping server workspaces by hand.
 */
export function computeWorkspaceName(workspaceRoot: string, machineName: string = os.hostname()): string {
    const cleanMachine = sanitiseForWorkspaceName(machineName).slice(0, 24);
    // 8 hex chars = 32 bits; collision-resistant enough for per-machine-per-folder.
    const hash = crypto.createHash('sha1').update(workspaceRoot).digest('hex').slice(0, 8);
    return `${NAME_PREFIX}${cleanMachine}-${hash}`;
}

/**
 * Sanitise a string for inclusion in a workspace name. TFVC rejects spaces
 * and some punctuation; we strip anything non-alphanumeric defensively.
 */
function sanitiseForWorkspaceName(input: string): string {
    return input.replace(/[^a-zA-Z0-9]/g, '').replace(/^-+|-+$/g, '') || 'machine';
}

export class ServerWorkspace {
    private readonly statePath: string;
    private cached: PersistedWorkspace | undefined;

    constructor(
        private readonly workspaceRoot: string,
        private readonly stateDir: string,
    ) {
        this.statePath = path.join(stateDir, STATE_FILENAME);
    }

    /**
     * Resolve a working server workspace, creating one if needed. Safe to
     * call repeatedly; cheap after the first successful resolution in the
     * current process.
     *
     * `identity` is used only when we have to create the workspace — the
     * server is the source of truth for owner + ownerDisplayName on
     * subsequent queries.
     */
    async getOrCreate(soap: TfvcSoapClient, identity: ServerIdentity): Promise<WorkspaceInfo> {
        const persisted = this.loadPersisted();
        const targetName = persisted?.name ?? computeWorkspaceName(this.workspaceRoot);

        // Try query first. A hit means the workspace exists server-side and
        // our cached identity is still valid. A miss (WorkspaceNotFound) is
        // the normal path on first run or after an admin sweep.
        const owner = persisted?.owner ?? identity.owner;
        const queried = await soap.queryWorkspace(targetName, owner);
        if (queried) {
            this.cached = {
                name: queried.name,
                owner: queried.owner,
                ownerDisplayName: queried.ownerDisplayName,
                computer: queried.computer,
                createdDate: persisted?.createdDate ?? new Date().toISOString(),
            };
            this.savePersisted(this.cached);
            return queried;
        }

        // Create. The server may normalise name/owner — we trust its echo.
        const created = await soap.createWorkspace({
            name: targetName,
            owner: identity.owner,
            ownerDisplayName: identity.ownerDisplayName,
            ownerUniqueName: identity.ownerUniqueName,
            computer: os.hostname(),
            comment: 'Managed by the VS Code TFVC extension — safe to delete.',
        });
        this.cached = {
            name: created.name,
            owner: created.owner,
            ownerDisplayName: created.ownerDisplayName,
            computer: created.computer,
            createdDate: new Date().toISOString(),
        };
        this.savePersisted(this.cached);
        return created;
    }

    /**
     * Best-effort cleanup. Called from `extension.deactivate()`. Failure
     * here is non-fatal (user's VS Code is shutting down anyway) — the
     * janitor or the next getOrCreate will sweep stragglers.
     */
    async tryDispose(soap: TfvcSoapClient): Promise<void> {
        if (!this.cached) { return; }
        try {
            await soap.deleteWorkspace(this.cached.name, this.cached.owner);
        } catch {
            // swallow — best-effort
        }
        try {
            fs.unlinkSync(this.statePath);
        } catch {
            // swallow — file may already be gone
        }
        this.cached = undefined;
    }

    /** Read the persisted metadata, tolerating missing file / parse errors. */
    private loadPersisted(): PersistedWorkspace | undefined {
        if (this.cached) { return this.cached; }
        try {
            const raw = fs.readFileSync(this.statePath, 'utf8');
            const parsed = JSON.parse(raw) as PersistedWorkspace;
            if (parsed.name && parsed.owner) {
                this.cached = parsed;
                return parsed;
            }
        } catch {
            // fall through
        }
        return undefined;
    }

    private savePersisted(ws: PersistedWorkspace): void {
        fs.mkdirSync(this.stateDir, { recursive: true });
        fs.writeFileSync(this.statePath, JSON.stringify(ws, null, 2) + '\n', 'utf8');
    }
}
