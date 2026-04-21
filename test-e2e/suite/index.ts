/**
 * Mocha bootstrap — runs inside the extension host. Globs *.test.js under
 * this directory and executes them. Returns a Promise so the host can
 * surface failures back to the runner.
 */

import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'tdd', // matches the suite/test globals used by the test files
        color: true,
        timeout: 30_000, // VS Code activation + first command call can be slow on first run
    });

    const testsRoot = path.resolve(__dirname);
    const files = await glob('**/*.test.js', { cwd: testsRoot });
    for (const f of files) {
        mocha.addFile(path.resolve(testsRoot, f));
    }

    return new Promise((resolve, reject) => {
        try {
            mocha.run(failures => {
                if (failures > 0) {
                    reject(new Error(`${failures} e2e test(s) failed`));
                } else {
                    resolve();
                }
            });
        } catch (err) {
            reject(err as Error);
        }
    });
}
