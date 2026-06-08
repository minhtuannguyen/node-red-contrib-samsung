'use strict';

const { build } = require('esbuild');
const fs = require('fs');
const path = require('path');

const NODE_ENTRIES = [
    'src/nodes/samsung-tv-config.js',
    'src/nodes/samsung-tv-command.js',
    'src/nodes/samsung-tv-power.js',
];

async function main() {
    // Clean and recreate dist/
    fs.rmSync('dist', { recursive: true, force: true });
    fs.mkdirSync(path.join('dist', 'nodes'), { recursive: true });

    // Bundle each node JS + all its dependencies into a single self-contained file.
    // platform=node ensures Node.js built-ins (net, http, crypto…) stay as require() calls.
    // bufferutil / utf-8-validate are optional native add-ons for ws — exclude them so
    // esbuild doesn't fail if they're not installed; ws works fine without them.
    await build({
        entryPoints: NODE_ENTRIES,
        bundle: true,
        platform: 'node',
        target: 'node14',
        outbase: 'src',
        outdir: 'dist',
        external: ['bufferutil', 'utf-8-validate'],
        logLevel: 'info',
    });

    // Copy HTML files (esbuild only handles JS)
    const htmlFiles = fs.readdirSync(path.join('src', 'nodes'))
        .filter(f => f.endsWith('.html'));

    for (const f of htmlFiles) {
        fs.copyFileSync(
            path.join('src', 'nodes', f),
            path.join('dist', 'nodes', f),
        );
        console.log(`copied  dist/nodes/${f}`);
    }

    console.log('\nBuild complete.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
