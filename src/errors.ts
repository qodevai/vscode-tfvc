/** Shared TFVC error class used across the extension. */
export class TfvcError extends Error {
    constructor(
        message: string,
        public readonly statusCode?: number,
        public readonly detail?: string
    ) {
        super(message);
        this.name = 'TfvcError';
    }
}

/**
 * Translate an HTTP error response into a TfvcError with a user-actionable
 * message so callers (and the status bar) can distinguish auth failures from
 * server faults from missing resources without parsing raw bodies.
 */
export function classifyHttpError(status: number, body: string, prefix: string): TfvcError {
    const detail = body.slice(0, 500);
    let message: string;
    if (status === 401) {
        message = 'Azure DevOps authentication failed — check your PAT (Set PAT command).';
    } else if (status === 403) {
        message = 'Azure DevOps denied the request — your PAT lacks permission for this operation.';
    } else if (status === 404) {
        message = 'Azure DevOps resource not found — verify the project/path configuration.';
    } else if (status === 409) {
        message = 'Azure DevOps reported a conflict — the resource changed on the server.';
    } else if (status === 429) {
        message = 'Azure DevOps rate-limited the request — retry in a moment.';
    } else if (status >= 500) {
        message = `Azure DevOps server error (${status}) — try again shortly.`;
    } else {
        message = `${prefix} ${status}: ${detail}`;
    }
    return new TfvcError(message, status, detail);
}
