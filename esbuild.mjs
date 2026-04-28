import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Plugin that emits build start/end markers and TS-style diagnostics so VS
 * Code's task runner can pick up errors during watch builds. Mirrors the
 * pattern in the official vscode-extension-samples esbuild template.
 */
const problemMatcherPlugin = {
    name: 'esbuild-problem-matcher',
    setup(build) {
        build.onStart(() => {
            console.log('[watch] build started');
        });
        build.onEnd(result => {
            for (const { text, location } of result.errors) {
                console.error(`✘ [ERROR] ${text}`);
                if (location) {
                    console.error(`    ${location.file}:${location.line}:${location.column}:`);
                }
            }
            console.log('[watch] build finished');
        });
    },
};

async function main() {
    const ctx = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node18',
        outfile: 'out/extension.js',
        external: ['vscode'],
        minify: production,
        // No sourcemap in prod — keeps the .vsix lean; .vscodeignore excludes
        // .map files anyway, so a linked map would be a dead reference.
        sourcemap: !production,
        sourcesContent: !production,
        logLevel: 'silent',
        plugins: [problemMatcherPlugin],
    });
    if (watch) {
        await ctx.watch();
    } else {
        await ctx.rebuild();
        await ctx.dispose();
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
