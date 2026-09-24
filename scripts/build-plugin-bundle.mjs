#!/usr/bin/env node
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { build } from 'esbuild';
import { outfile, pluginBundleOptions } from './plugin-bundle-options.mjs';

mkdirSync(dirname(outfile), { recursive: true });

await build({ ...pluginBundleOptions, logLevel: 'info' });

chmodSync(outfile, 0o755);

const sizeKb = Math.ceil(statSync(outfile).size / 1024);
console.log(`Built Codex plugin bundle: ${outfile} (${sizeKb} KB)`);
