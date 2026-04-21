/**
 * Validation for shelveset names. Kept separate from `tfvcProvider` so the
 * rules can be unit-tested without a vscode runtime, and so future callers
 * (e.g. a programmatic `shelve` API) share the same constraints.
 *
 * The returned string is the error message VS Code should show as input-box
 * validation text; `undefined` means valid.
 */
export function validateShelvesetName(value: string): string | undefined {
    if (!value.trim()) { return 'Name cannot be empty'; }
    if (value.startsWith('-')) { return 'Name cannot start with a dash'; }
    // Block shell metacharacters. These aren't strictly rejected by the ADO
    // server, but they have historically caused grief when shelveset names
    // ended up in CLI invocations, URL paths, or SOAP payloads. Rejecting
    // them up-front avoids a class of escaping bugs.
    if (/[;$<>|&]/.test(value)) { return 'Name contains invalid characters'; }
    return undefined;
}
