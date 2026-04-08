import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { WorkspaceState } from '../src/workspace/workspaceState';

function md5base64(content: string): string {
    return crypto.createHash('md5').update(content).digest('base64');
}

describe('WorkspaceState', () => {
    let tmpDir: string;
    const scope = '$/TestProject';

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfvc-ws-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('starts uninitialized when .vscode-tfvc/ does not exist', () => {
        const state = new WorkspaceState(tmpDir, scope);
        assert.strictEqual(state.isInitialized, false);
    });

    it('detects as initialized after state dir is created', () => {
        fs.mkdirSync(path.join(tmpDir, '.vscode-tfvc'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, '.vscode-tfvc', 'baseline.json'), '{"scope":"$/TestProject","root":"' + tmpDir + '","version":0,"items":[]}');
        const state = new WorkspaceState(tmpDir, scope);
        assert.strictEqual(state.isInitialized, true);
    });

    it('markAdd tracks files and persists to pending.json', () => {
        const state = new WorkspaceState(tmpDir, scope);
        const filePath = path.join(tmpDir, 'newfile.txt');
        fs.writeFileSync(filePath, 'new content');

        state.markAdd([filePath]);

        // Verify persisted
        const pendingPath = path.join(tmpDir, '.vscode-tfvc', 'pending.json');
        assert.ok(fs.existsSync(pendingPath));
        const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
        assert.deepStrictEqual(pending.adds, [filePath]);
    });

    it('markDelete tracks server paths', () => {
        const state = new WorkspaceState(tmpDir, scope);
        const filePath = path.join(tmpDir, 'existing.txt');

        state.markDelete([filePath]);

        const pendingPath = path.join(tmpDir, '.vscode-tfvc', 'pending.json');
        const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
        assert.deepStrictEqual(pending.deletes, ['$/TestProject/existing.txt']);
    });

    it('markCheckout tracks local paths', () => {
        const state = new WorkspaceState(tmpDir, scope);
        const filePath = path.join(tmpDir, 'file.txt');

        state.markCheckout([filePath]);

        const pendingPath = path.join(tmpDir, '.vscode-tfvc', 'pending.json');
        const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
        assert.deepStrictEqual(pending.checkouts, [filePath]);
    });

    it('clearPending removes specific paths', () => {
        const state = new WorkspaceState(tmpDir, scope);
        const file1 = path.join(tmpDir, 'a.txt');
        const file2 = path.join(tmpDir, 'b.txt');

        state.markAdd([file1, file2]);
        state.markCheckout([file1, file2]);
        state.clearPending([file1]);

        const pendingPath = path.join(tmpDir, '.vscode-tfvc', 'pending.json');
        const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
        assert.deepStrictEqual(pending.adds, [file2]);
        assert.deepStrictEqual(pending.checkouts, [file2]);
    });

    it('clearAll resets all pending state', () => {
        const state = new WorkspaceState(tmpDir, scope);
        state.markAdd([path.join(tmpDir, 'a.txt')]);
        state.markDelete([path.join(tmpDir, 'b.txt')]);
        state.markCheckout([path.join(tmpDir, 'c.txt')]);

        state.clearAll();

        const pendingPath = path.join(tmpDir, '.vscode-tfvc', 'pending.json');
        const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
        assert.deepStrictEqual(pending.adds, []);
        assert.deepStrictEqual(pending.deletes, []);
        assert.deepStrictEqual(pending.checkouts, []);
    });

    it('getPendingChanges detects explicit adds', async () => {
        const state = new WorkspaceState(tmpDir, scope);
        const filePath = path.join(tmpDir, 'newfile.txt');
        fs.writeFileSync(filePath, 'new content');
        state.markAdd([filePath]);

        const changes = await state.getPendingChanges();
        assert.strictEqual(changes.length, 1);
        assert.strictEqual(changes[0].changeType, 'add');
        assert.strictEqual(changes[0].localPath, filePath);
        assert.strictEqual(changes[0].serverPath, '$/TestProject/newfile.txt');
    });

    it('getPendingChanges detects explicit deletes', async () => {
        const state = new WorkspaceState(tmpDir, scope);
        const filePath = path.join(tmpDir, 'deleted.txt');
        state.markDelete([filePath]);

        const changes = await state.getPendingChanges();
        assert.strictEqual(changes.length, 1);
        assert.strictEqual(changes[0].changeType, 'delete');
        assert.strictEqual(changes[0].serverPath, '$/TestProject/deleted.txt');
    });

    it('getPendingChanges auto-detects edits via hash comparison', async () => {
        // Seed a baseline with a known file
        const stateDir = path.join(tmpDir, '.vscode-tfvc');
        fs.mkdirSync(stateDir, { recursive: true });

        const filePath = path.join(tmpDir, 'tracked.txt');
        const originalContent = 'original content';
        fs.writeFileSync(filePath, originalContent);
        const originalHash = md5base64(originalContent);

        const baseline = {
            scope,
            root: tmpDir,
            version: 1,
            items: [{
                serverPath: '$/TestProject/tracked.txt',
                localPath: filePath,
                version: 1,
                hash: originalHash,
                mtime: 0, // Force hash check by using stale mtime
                isFolder: false,
            }],
        };
        fs.writeFileSync(path.join(stateDir, 'baseline.json'), JSON.stringify(baseline));
        fs.writeFileSync(path.join(stateDir, 'pending.json'), '{"adds":[],"deletes":[],"checkouts":[]}');

        // Modify the file
        fs.writeFileSync(filePath, 'modified content');

        const state = new WorkspaceState(tmpDir, scope);
        const changes = await state.getPendingChanges();

        assert.strictEqual(changes.length, 1);
        assert.strictEqual(changes[0].changeType, 'edit');
        assert.strictEqual(changes[0].localPath, filePath);
    });

    it('getPendingChanges skips files where mtime matches baseline', async () => {
        const stateDir = path.join(tmpDir, '.vscode-tfvc');
        fs.mkdirSync(stateDir, { recursive: true });

        const filePath = path.join(tmpDir, 'unchanged.txt');
        const content = 'unchanged content';
        fs.writeFileSync(filePath, content);
        const hash = md5base64(content);
        const mtime = fs.statSync(filePath).mtimeMs;

        const baseline = {
            scope,
            root: tmpDir,
            version: 1,
            items: [{
                serverPath: '$/TestProject/unchanged.txt',
                localPath: filePath,
                version: 1,
                hash,
                mtime,
                isFolder: false,
            }],
        };
        fs.writeFileSync(path.join(stateDir, 'baseline.json'), JSON.stringify(baseline));
        fs.writeFileSync(path.join(stateDir, 'pending.json'), '{"adds":[],"deletes":[],"checkouts":[]}');

        const state = new WorkspaceState(tmpDir, scope);
        const changes = await state.getPendingChanges();

        assert.strictEqual(changes.length, 0);
    });

    it('local shelf round-trip: save and apply', async () => {
        const stateDir = path.join(tmpDir, '.vscode-tfvc');
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(path.join(stateDir, 'baseline.json'), JSON.stringify({ scope, root: tmpDir, version: 0, items: [] }));
        fs.writeFileSync(path.join(stateDir, 'pending.json'), '{"adds":[],"deletes":[],"checkouts":[]}');

        const state = new WorkspaceState(tmpDir, scope);

        // Create a file and mark as add
        const filePath = path.join(tmpDir, 'shelved.txt');
        fs.writeFileSync(filePath, 'shelved content');
        state.markAdd([filePath]);

        // Shelve locally
        await state.saveLocalShelf('my-shelf', 'test comment');

        // Verify shelf listing
        const shelves = state.listLocalShelves();
        assert.strictEqual(shelves.length, 1);
        assert.strictEqual(shelves[0].name, 'my-shelf');
        assert.strictEqual(shelves[0].comment, 'test comment');

        // Clear and re-apply
        state.clearAll();
        await state.applyLocalShelf('my-shelf');

        const changes = await state.getPendingChanges();
        assert.strictEqual(changes.length, 1);
        assert.strictEqual(changes[0].changeType, 'add');

        // Delete shelf
        state.deleteLocalShelf('my-shelf');
        assert.strictEqual(state.listLocalShelves().length, 0);
    });
});
