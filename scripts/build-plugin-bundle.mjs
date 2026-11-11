#!/usr/bin/env node
import { chmodSync, copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { build } from 'esbuild';
import { bundleMirrors, claudePluginDir, claudePluginMirrors, outdir, outfile, partsDir, pluginBundleOptions, root } from './plugin-bundle-options.mjs';

// Part file names carry a content hash: clear the old ones so no stale part is left behind.
for (const dir of [join(outdir, partsDir), join(claudePluginDir, 'dist', partsDir)]) rmSync(dir, { recursive: true, force: true });
mkdirSync(dirname(outfile), { recursive: true });

const result = await build({ ...pluginBundleOptions, metafile: true, logLevel: 'info' });

chmodSync(outfile, 0o755);

const files = bundleMirrors(Object.keys(result.metafile.outputs).map((path) => join(root, path)));
const sizeKb = Math.ceil(files.reduce((total, { dist }) => total + statSync(dist).size, 0) / 1024);
console.log(`Built the plugin bundle: ${relative(root, outfile)} and ${files.length - 1} part(s) in dist/${partsDir}/ (${sizeKb} KB)`);

for (const { dist, plugin } of files) {
  mkdirSync(dirname(plugin), { recursive: true });
  copyFileSync(dist, plugin);
}
chmodSync(join(claudePluginDir, 'dist', 'plugin-server.js'), 0o755);
for (const { from, to } of claudePluginMirrors) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
console.log(`Copied the bundle, LICENSE, NOTICE and icon into ${relative(root, claudePluginDir)}/`);
