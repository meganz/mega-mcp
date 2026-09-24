#!/usr/bin/env node
// Promotes main to the `release` branch that Codex users install from. Whatever lands on
// `release` reaches every user on their next Codex start, so this refuses to push unless
// main is clean, matches origin/main and passes the plugin checks.
//
// Usage: npm run release:plugin [-- --dry-run]
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const fail = (message) => {
  console.error(`release:plugin: ${message}`);
  process.exit(1);
};

if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('check out main first.');
if (git('status', '--porcelain', '--untracked-files=no')) fail('commit or stash your changes first.');
// Untracked files in these paths would pass the local checks but be missing from the release.
if (git('ls-files', '--others', '--exclude-standard', '--', 'src', 'scripts', 'dist', '.agents', '.codex-plugin')) {
  fail('untracked files under src/, scripts/, dist/, .agents/ or .codex-plugin/: commit or remove them first.');
}

git('fetch', 'origin');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('push main first (HEAD differs from origin/main).');

try {
  execFileSync(process.execPath, ['scripts/check-plugin.mjs'], { cwd: root, stdio: 'inherit' });
} catch {
  fail('plugin checks failed; nothing was pushed.');
}

const releaseExists = git('ls-remote', '--heads', 'origin', 'release') !== '';
const pending = releaseExists ? git('log', '--oneline', 'origin/release..HEAD') : git('log', '--oneline', '-5');
if (!pending) {
  console.log('release is already up to date with main.');
  process.exit(0);
}
console.log(`\n${releaseExists ? 'Promoting to release' : 'Creating release from main (latest commits)'}:\n${pending}\n`);
if (dryRun) {
  console.log('Dry run: nothing pushed.');
  process.exit(0);
}
// A plain push only fast-forwards; git rejects it if release has diverged from main.
execFileSync('git', ['push', 'origin', 'HEAD:release'], { cwd: root, stdio: 'inherit' });
