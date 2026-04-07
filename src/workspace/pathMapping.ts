import * as path from 'path';

/**
 * Convert a TFVC server path to a local filesystem path.
 *
 * Example: serverToLocal('$/MyProject/src/app.ts', '$/MyProject', '/home/user/repo')
 *          → '/home/user/repo/src/app.ts'
 */
export function serverToLocal(serverPath: string, scope: string, root: string): string {
    const normalizedScope = scope.endsWith('/') ? scope : scope + '/';
    if (!serverPath.startsWith(normalizedScope) && serverPath !== scope) {
        throw new Error(`Server path "${serverPath}" is not under scope "${scope}"`);
    }
    const relative = serverPath === scope ? '' : serverPath.slice(normalizedScope.length);
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
    if (!localPath.startsWith(normalizedRoot) && localPath !== root) {
        throw new Error(`Local path "${localPath}" is not under root "${root}"`);
    }
    const relative = localPath === root ? '' : localPath.slice(normalizedRoot.length);
    if (!relative) {
        return scope;
    }
    // TFVC uses forward slashes
    return scope + '/' + relative.split(path.sep).join('/');
}
