/**
 * Static checks against package.json that catch common manifest bugs:
 *
 *   - Every `tfvc.*` command has a `title` and a `category` (palette
 *     items without a category collapse into a mystery group).
 *   - Palette-visible commands have a matching `onCommand:tfvc.X`
 *     entry in `activationEvents`. Without it the extension doesn't
 *     activate when the user runs the command from the palette — the
 *     v0.3.2 regression class.
 *   - Commands that aren't palette-visible (hidden via
 *     `"commandPalette": [{ "command": "tfvc.X", "when": "false" }]`)
 *     are allowed to skip the activation-event — menus trigger
 *     activation via the surfaces they live under.
 *   - Every command referenced in `contributes.menus` is declared in
 *     `contributes.commands` (catches typos in menu wiring).
 *   - Every configuration property has a description.
 *
 * Lives as a unit test rather than in the e2e suite because it's pure
 * JSON parsing — no vscode runtime needed, and fast feedback beats
 * running under @vscode/test-electron.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it } from 'node:test';

interface ManifestCommand {
    command: string;
    title?: string;
    category?: string;
    icon?: string;
}

interface MenuEntry {
    command?: string;
    group?: string;
    when?: string;
}

interface Manifest {
    activationEvents: string[];
    contributes: {
        commands: ManifestCommand[];
        menus: Record<string, MenuEntry[]>;
        configuration: {
            properties: Record<string, { description?: string; type?: string }>;
        };
    };
}

function loadManifest(): Manifest {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const raw = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
    return JSON.parse(raw) as Manifest;
}

describe('manifest: contributes.commands', () => {
    const manifest = loadManifest();
    const tfvcCommands = manifest.contributes.commands.filter(c => c.command.startsWith('tfvc.'));

    it('there is at least one tfvc.* command (guards against accidental removal)', () => {
        assert.ok(tfvcCommands.length > 0, 'no tfvc.* commands found — did contributes.commands get clobbered?');
    });

    for (const cmd of (manifest.contributes?.commands ?? []).filter(c => c.command?.startsWith('tfvc.'))) {
        it(`${cmd.command} has title and category`, () => {
            assert.ok(cmd.title, `${cmd.command} is missing title`);
            assert.strictEqual(cmd.category, 'TFVC', `${cmd.command} should have category "TFVC"`);
        });
    }
});

describe('manifest: activationEvents', () => {
    const manifest = loadManifest();

    /** Commands explicitly hidden from the palette via `"when": "false"`. */
    function paletteHiddenCommands(): Set<string> {
        const hidden = new Set<string>();
        const paletteEntries = manifest.contributes.menus.commandPalette ?? [];
        for (const entry of paletteEntries) {
            if (entry.command && entry.when === 'false') {
                hidden.add(entry.command);
            }
        }
        return hidden;
    }

    it('does not use the broad "onStartupFinished" trigger (v0.3.2 fix)', () => {
        // Pre-v0.3.2 the extension loaded in every VS Code window by
        // declaring onStartupFinished. That's the specific regression we're
        // guarding against — if someone re-adds it, users get the extension
        // booting in unrelated projects.
        assert.ok(
            !manifest.activationEvents.includes('onStartupFinished'),
            'activationEvents should not contain "onStartupFinished" — use per-command triggers instead',
        );
    });

    it('every palette-visible tfvc.* command has a matching onCommand activation event', () => {
        const tfvcCommands = manifest.contributes.commands.filter(c => c.command.startsWith('tfvc.'));
        const hidden = paletteHiddenCommands();
        const activationCommands = new Set(
            manifest.activationEvents
                .filter(e => e.startsWith('onCommand:'))
                .map(e => e.slice('onCommand:'.length)),
        );

        const missing = tfvcCommands
            .map(c => c.command)
            .filter(id => !hidden.has(id) && !activationCommands.has(id));

        assert.deepStrictEqual(
            missing, [],
            `palette-visible commands missing onCommand activation: ${missing.join(', ')}`,
        );
    });

    it('keeps a workspaceContains trigger for auto-activation in TFVC projects', () => {
        // Without this, users opening a folder with .vscode-tfvc/ have to
        // manually run a command to wake the extension up. The check is
        // coarse: any workspaceContains entry referencing .vscode-tfvc/.
        const hasWorkspaceContains = manifest.activationEvents.some(e =>
            e.startsWith('workspaceContains:') && e.includes('.vscode-tfvc'),
        );
        assert.ok(hasWorkspaceContains, 'missing workspaceContains:**/.vscode-tfvc/** activation event');
    });
});

describe('manifest: contributes.menus', () => {
    const manifest = loadManifest();

    it('every command referenced in a menu is declared in contributes.commands', () => {
        const declared = new Set(manifest.contributes.commands.map(c => c.command));
        const referenced = new Set<string>();
        for (const entries of Object.values(manifest.contributes.menus)) {
            for (const entry of entries) {
                if (entry.command) { referenced.add(entry.command); }
            }
        }
        const dangling = [...referenced].filter(id => !declared.has(id));
        assert.deepStrictEqual(dangling, [], `menu references undeclared commands: ${dangling.join(', ')}`);
    });
});

describe('manifest: contributes.configuration', () => {
    const manifest = loadManifest();

    for (const [key, prop] of Object.entries(manifest.contributes.configuration.properties)) {
        it(`${key} has a description`, () => {
            assert.ok(prop.description, `${key}: configuration property must have a description`);
            assert.ok(prop.description!.length >= 10, `${key}: description too short (${prop.description!.length} chars)`);
        });
    }
});
