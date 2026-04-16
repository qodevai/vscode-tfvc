/**
 * Normalize ADO change type strings (e.g. "add, edit, encoding") to a
 * simple label.
 *
 * Known add-like variants (branch, undelete) are mapped to 'add' so UI
 * branching stays simple. Unknown labels are returned verbatim (lower-cased)
 * rather than silently collapsed to 'edit' — that way the tree/SCM view
 * surfaces the actual ADO change kind instead of misrepresenting it.
 */
export function normalizeChangeLabel(changeType: string): string {
    if (!changeType) { return 'edit'; }
    const tokens = changeType.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    if (tokens.length === 0) { return 'edit'; }

    // Pick the most specific token rather than always the first — ADO often
    // formats compound changes as "edit, encoding" where `edit` is the
    // primary action.
    const priority = ['delete', 'rename', 'undelete', 'merge', 'branch', 'add', 'edit'];
    const label = priority.find(p => tokens.includes(p)) ?? tokens[0];

    if (label === 'branch' || label === 'undelete') { return 'add'; }
    return label;
}
