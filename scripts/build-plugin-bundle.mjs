#!/usr/bin/env node
import { chmodSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { build } from 'esbuild';
import { claudePluginDir, claudePluginMirrors, outfile, pluginBundleOptions, root } from './plugin-bundle-options.mjs';

mkdirSync(dirname(outfile), { recursive: true });

await build({ ...pluginBundleOptions, logLevel: 'info' });

chmodSync(outfile, 0o755);

const sizeKb = Math.ceil(statSync(outfile).size / 1024);
console.log(`Built Codex plugin bundle: ${outfile} (${sizeKb} KB)`);

for (const { from, to } of claudePluginMirrors) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
console.log(`Copied the bundle, LICENSE, NOTICE and icon into ${relative(root, claudePluginDir)}/`);
