/**
 * Normalize ADO change type strings (e.g. "add, edit, encoding") to a
 * simple label like "add", "edit", "delete".
 *
 * Used consistently by both the SCM provider and the review tree.
 */
export function normalizeChangeLabel(changeType: string): string {
    const label = changeType.split(',')[0].trim().toLowerCase();
    // Map compound or alternate forms to canonical labels
    if (label === 'add' || label === 'branch') { return 'add'; }
    if (label === 'delete') { return 'delete'; }
    if (label === 'rename') { return 'rename'; }
    return 'edit';
}
