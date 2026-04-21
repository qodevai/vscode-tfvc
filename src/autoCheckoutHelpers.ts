/**
 * Pure helpers extracted from `AutoCheckoutHandler` so the filesystem
 * predicates it depends on can be unit-tested without a vscode runtime.
 * The handler itself remains the vscode adapter: event wiring, toast
 * deduplication, `repo.checkout()` dispatch.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Whether `fsPath` lies inside `workspaceRoot`. Uses `path.relative` so
 * Windows/macOS case-insensitivity matches how VS Code itself handles
 * paths. Returns false for the root itself (we don't check out a
 * directory) and for anything outside.
 */
export function isPathWithinWorkspace(workspaceRoot: string, fsPath: string): boolean {
    const rel = path.relative(workspaceRoot, fsPath);
    // Empty rel means the path IS the root; `..`-prefix means outside.
    // `path.isAbsolute(rel)` catches Windows drive-letter cases where
    // there's no relative path (different volume).
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { return false; }
    return true;
}

/**
 * Whether the file at `fsPath` is currently read-only (owner lacks the
 * write bit). Returns `false` when stat fails — a missing file isn't a
 * read-only file, and auto-checkout has nothing useful to do with it.
 */
export function isReadOnly(fsPath: string): boolean {
    try {
        const stat = fs.statSync(fsPath);
        return (stat.mode & 0o200) === 0;
    } catch {
        return false;
    }
}
