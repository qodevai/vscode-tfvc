import * as path from 'path';

/**
 * Paths the file watcher must not react to — they're noise, not user changes,
 * and reacting would cause tight refresh loops or spurious "pending" flickers.
 */
const IGNORED_WATCHER_PREFIXES = new Set([
    '.vscode-tfvc',   // our own metadata
    '.git',           // git metadata and objects
    '.hg',            // mercurial
    '.svn',           // subversion
    '.vscode',        // editor settings
    '.idea',          // JetBrains
    'node_modules',
    'out',
    'out-test',
    'dist',
    'build',
    '.next',
    '.nuxt',
    'target',         // java/rust
    '.gradle',
    '__pycache__',
    '.venv',
    'venv',
    '.pytest_cache',
    '.tox',
    '.cache',
    'coverage',
]);

/**
 * True if a change at `fsPath` should be ignored because it falls inside an
 * uninteresting directory (build output, VCS metadata, caches …) or because
 * it's outside the workspace `root` entirely.
 */
export function isIgnoredPath(fsPath: string, root: string): boolean {
    const rel = path.relative(root, fsPath);
    if (!rel || rel.startsWith('..')) { return true; }
    const firstSegment = rel.split(path.sep)[0];
    return IGNORED_WATCHER_PREFIXES.has(firstSegment);
}
