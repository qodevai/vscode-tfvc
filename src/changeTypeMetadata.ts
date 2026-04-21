/**
 * Shared metadata mapping TFVC change types to presentation attributes.
 *
 * Two surfaces consume this:
 *   - `TfvcDecorationProvider` — Explorer badges (M/A/D/R/C).
 *   - `TfvcSCMProvider.toResourceState` — SCM tree icons + tooltips.
 *
 * Previously each maintained its own switch statement with slightly
 * different wording. Keeping the metadata here makes it consistent and
 * unit-testable without a vscode runtime.
 */

import { ChangeType } from './workspace/types';

export interface ChangeTypeMetadata {
    /** One-letter badge for Explorer decorations: M / A / D / R / C. */
    letter: string;
    /** Human label used in tooltips ("Modified", "Added", …). */
    label: string;
    /**
     * Codicon name for the SCM view (e.g. `diff-added`, `diff-modified`,
     * `warning` for conflicts). Used with `vscode.ThemeIcon`.
     */
    themeIcon: string;
    /**
     * `vscode.ThemeColor` name keying into the color registry. Undefined
     * for change types with no distinct color.
     */
    themeColor: string | undefined;
    /** True when the SCM resource should be rendered with strikethrough (deletes). */
    strikeThrough?: boolean;
}

const METADATA: Record<ChangeType, ChangeTypeMetadata> = {
    edit: {
        letter: 'M',
        label: 'Modified',
        themeIcon: 'diff-modified',
        themeColor: 'gitDecoration.modifiedResourceForeground',
    },
    add: {
        letter: 'A',
        label: 'Added',
        themeIcon: 'diff-added',
        themeColor: 'gitDecoration.addedResourceForeground',
    },
    delete: {
        letter: 'D',
        label: 'Deleted',
        themeIcon: 'diff-removed',
        themeColor: 'gitDecoration.deletedResourceForeground',
        strikeThrough: true,
    },
    rename: {
        letter: 'R',
        label: 'Renamed',
        themeIcon: 'diff-renamed',
        themeColor: 'gitDecoration.renamedResourceForeground',
    },
    merge: {
        letter: 'C',
        label: 'Conflict',
        themeIcon: 'warning',
        themeColor: 'gitDecoration.conflictingResourceForeground',
    },
    // TFVC change types we don't surface distinct visuals for; fall back to
    // "modified" shape with the raw type name in the tooltip so it's obvious
    // what's happening instead of silently collapsing to `edit`.
    branch: {
        letter: 'M',
        label: 'Branch',
        themeIcon: 'diff-modified',
        themeColor: 'gitDecoration.modifiedResourceForeground',
    },
    lock: {
        letter: 'M',
        label: 'Lock',
        themeIcon: 'diff-modified',
        themeColor: 'gitDecoration.modifiedResourceForeground',
    },
    undelete: {
        letter: 'M',
        label: 'Undelete',
        themeIcon: 'diff-modified',
        themeColor: 'gitDecoration.modifiedResourceForeground',
    },
};

/**
 * Look up presentation metadata for a change type. Unknown types fall
 * back to a "modified" shape with the raw type in the label — never
 * silently collapsed to `edit`, since a surprising type in the UI beats
 * a wrong one.
 */
export function metadataFor(changeType: ChangeType | string): ChangeTypeMetadata {
    const hit = METADATA[changeType as ChangeType];
    if (hit) { return hit; }
    return {
        letter: 'M',
        label: changeType,
        themeIcon: 'diff-modified',
        themeColor: 'gitDecoration.modifiedResourceForeground',
    };
}
