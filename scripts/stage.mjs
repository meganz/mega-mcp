#!/usr/bin/env node
// Assemble a build/ staging directory for `mcpb pack`:
//   build/manifest.json, build/dist/ (compiled server),
//   build/node_modules/ (production deps only), legal/docs,
//   and build/vendor/megacmd/ when present (mode C2).
import { rmSync, mkdirSync, cpSync, copyFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'build');

console.log('Staging MCPB bundle ->', build);
rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });

if (!existsSync(join(root, 'dist', 'index.js'))) {
  console.error('dist/index.js missing — run `npm run build` first.');
  process.exit(1);
}
cpSync(join(root, 'dist'), join(build, 'dist'), { recursive: true });

for (const f of ['manifest.json', 'NOTICE', 'LICENSE', 'README.md']) {
  if (existsSync(join(root, f))) copyFileSync(join(root, f), join(build, f));
}

// Icon / branding assets referenced by the manifest.
if (existsSync(join(root, 'assets'))) {
  cpSync(join(root, 'assets'), join(build, 'assets'), { recursive: true });
}

// Bundled MEGAcmd binaries (mode C2) are included only if vendored.
if (existsSync(join(root, 'vendor', 'megacmd'))) {
  cpSync(join(root, 'vendor', 'megacmd'), join(build, 'vendor', 'megacmd'), { recursive: true });
  console.log('Included vendor/megacmd binaries (mode C2).');
} else {
  console.log('No vendor/megacmd — bundle is mode B (relies on an installed MEGAcmd).');
}

// Production dependencies only.
copyFileSync(join(root, 'package.json'), join(build, 'package.json'));
if (existsSync(join(root, 'package-lock.json'))) {
  copyFileSync(join(root, 'package-lock.json'), join(build, 'package-lock.json'));
}
console.log('Installing production dependencies into the bundle...');
execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: build, stdio: 'inherit' });

console.log('Staging complete.');
