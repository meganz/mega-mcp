#!/usr/bin/env node
// Assemble a build/ staging directory for `mcpb pack`:
//   build/manifest.json, build/dist/ (compiled server),
//   build/node_modules/ (production deps only), legal/docs,
//   and build/vendor/megacmd/ when present (mode C2).
import { rmSync, mkdirSync, cpSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'build');

// The package is built from the working tree, so it must BE the reviewed commit:
// no uncommitted changes, and no untracked source that would be compiled in.
if (!process.argv.includes('--allow-dirty')) {
  const dirty = execSync('git status --porcelain --untracked-files=no', { cwd: root, encoding: 'utf8' }).trim();
  const untracked = execSync('git ls-files --others --exclude-standard -- src', { cwd: root, encoding: 'utf8' }).trim();
  if (dirty || untracked) {
    console.error('Uncommitted changes or untracked files under src/ - commit them first (or pass --allow-dirty for a local test build).');
    process.exit(1);
  }
}

console.log('Staging MCPB bundle ->', build);
rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });

if (!existsSync(join(root, 'dist', 'index.js'))) {
  console.error('dist/index.js missing — run `npm run build` first.');
  process.exit(1);
}
// Only what tsc emits for a CURRENT source file: not the plugin bundle (a different
// build), and not output left behind by a source file that no longer exists.
function stageCompiled(rel) {
  for (const entry of readdirSync(join(root, 'dist', rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      stageCompiled(path);
      continue;
    }
    const m = path.match(/^(.*)\.js(\.map)?$/);
    if (!m || !existsSync(join(root, 'src', `${m[1]}.ts`))) continue;
    mkdirSync(join(build, 'dist', rel), { recursive: true });
    copyFileSync(join(root, 'dist', path), join(build, 'dist', path));
  }
}
stageCompiled('');

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
