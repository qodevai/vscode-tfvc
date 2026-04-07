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
