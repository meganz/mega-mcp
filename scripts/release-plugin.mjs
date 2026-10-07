#!/usr/bin/env node
// Promotes main to the `release` branch that Codex users install from, and that the Claude
// directory tracks for plugins/mega-mcp. Whatever lands on `release` reaches every Codex
// user on their next start, so this refuses to push unless main is clean, matches
// origin/main, rebuilds from the LOCKFILE (npm ci) and passes typecheck, tests and the
// plugin checks there, and GitHub's CI run for this exact commit has succeeded.
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
if (git('ls-files', '--others', '--exclude-standard', '--', 'src', 'scripts', 'dist', '.agents', '.codex-plugin', '.claude-plugin', 'plugins')) {
  fail('untracked files under src/, scripts/, dist/, .agents/, .codex-plugin/, .claude-plugin/ or plugins/: commit or remove them first.');
}

git('fetch', 'origin');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('push main first (HEAD differs from origin/main).');

// Local node_modules may have drifted from the lockfile (or been tampered with), and
// check-plugin rebuilds the bundle from them - so reinstall exactly what is locked.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
for (const [label, args] of [
  ['npm ci', ['ci', '--no-audit', '--no-fund']],
  ['typecheck', ['run', 'typecheck']],
  ['tests', ['test']],
]) {
  try {
    execFileSync(npm, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  } catch {
    fail(`${label} failed; nothing was pushed.`);
  }
}
try {
  execFileSync(process.execPath, ['scripts/check-plugin.mjs'], { cwd: root, stdio: 'inherit' });
} catch {
  fail('plugin checks failed; nothing was pushed.');
}

// The same checks on a clean runner: the workflow's `check` job for this exact
// commit must have run on GitHub Actions and succeeded. Asked for by name, so an
// unrelated check (or a skipped run) cannot stand in for it.
const sha = git('rev-parse', 'HEAD');
let runs;
try {
  const res = await fetch(`https://api.github.com/repos/meganz/mega-mcp/commits/${sha}/check-runs?check_name=check&per_page=100`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  runs = ((await res.json()).check_runs ?? []).filter((r) => r.app?.slug === 'github-actions');
} catch (e) {
  fail(`could not read the CI status for ${sha.slice(0, 7)} (${e instanceof Error ? e.message : e}); nothing was pushed.`);
}
if (runs.length === 0) fail(`no CI "check" run found for ${sha.slice(0, 7)} yet; wait for it, then retry.`);
if (runs.some((r) => r.status !== 'completed')) fail(`CI is still running for ${sha.slice(0, 7)}; wait for it, then retry.`);
// The newest attempt decides (a re-run supersedes an earlier failure).
const latest = runs.reduce((a, b) => (new Date(b.started_at) > new Date(a.started_at) ? b : a));
if (latest.conclusion !== 'success') fail(`CI "check" did not succeed for ${sha.slice(0, 7)} (${latest.conclusion}); nothing was pushed.`);

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
