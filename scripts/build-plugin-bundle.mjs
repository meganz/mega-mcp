#!/usr/bin/env node
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(root, 'dist');
const outfile = join(outdir, 'plugin-server.js');

mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});

chmodSync(outfile, 0o755);

const sizeKb = Math.ceil(statSync(outfile).size / 1024);
console.log(`Built Codex plugin bundle: ${outfile} (${sizeKb} KB)`);
