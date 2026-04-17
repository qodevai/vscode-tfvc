import * as path from 'path';

/**
 * Normalise a path for comparison. TFVC is case-insensitive on both
 * server paths and (typically) local paths on Windows/macOS, so lower-casing
 * is the safe cross-platform default. Keep the original casing everywhere
 * outside of lookups/keys so the user-visible paths stay accurate.
 */
export function pathKey(p: string): string {
    return p.toLowerCase();
}

/** True when two paths refer to the same TFVC resource (case-insensitive). */
export function samePath(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
}

/**
 * Convert a TFVC server path to a local filesystem path.
 *
 * Example: serverToLocal('$/MyProject/src/app.ts', '$/MyProject', '/home/user/repo')
 *          → '/home/user/repo/src/app.ts'
 */
export function serverToLocal(serverPath: string, scope: string, root: string): string {
    const normalizedScope = scope.endsWith('/') ? scope : scope + '/';
    const lowerPath = serverPath.toLowerCase();
    const lowerScope = normalizedScope.toLowerCase();
    if (!lowerPath.startsWith(lowerScope) && lowerPath !== scope.toLowerCase()) {
        throw new Error(`Server path "${serverPath}" is not under scope "${scope}"`);
    }
    const relative = lowerPath === scope.toLowerCase() ? '' : serverPath.slice(normalizedScope.length);
    return path.join(root, relative);
}

/**
 * Convert a local filesystem path to a TFVC server path.
 *
 * Example: localToServer('/home/user/repo/src/app.ts', '$/MyProject', '/home/user/repo')
 *          → '$/MyProject/src/app.ts'
 */
export function localToServer(localPath: string, scope: string, root: string): string {
    const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
    const lowerPath = localPath.toLowerCase();
    const lowerRoot = normalizedRoot.toLowerCase();
    if (!lowerPath.startsWith(lowerRoot) && lowerPath !== root.toLowerCase()) {
        throw new Error(`Local path "${localPath}" is not under root "${root}"`);
    }
    const relative = lowerPath === root.toLowerCase() ? '' : localPath.slice(normalizedRoot.length);
    if (!relative) {
        return scope;
    }
    // TFVC uses forward slashes
    return scope + '/' + relative.split(path.sep).join('/');
}
