#!/usr/bin/env node
// Release gate for the Codex and Claude plugins. Codex users install from this repo's Git
// marketplace and receive every commit on the `release` branch automatically, and the
// Claude directory scans plugins/mega-mcp on that same branch, so all of these must hold:
//   1. dist/plugin-server.js matches a fresh build of src/
//   2. package.json, manifest.json and both plugin manifests share one version
//   3. .agents/plugins/marketplace.json pins the plugin to this repo's `release` branch
//   4. plugins/mega-mcp holds exact copies of the bundle, LICENSE and NOTICE, launches the
//      bundle from ${CLAUDE_PLUGIN_ROOT}, and has nothing that makes Claude Code run npm
//   5. .claude-plugin/marketplace.json pins plugins/mega-mcp to the `release` branch too
//   6. the Claude plugin folder starts on its own (no node_modules), reports its version
//      and serves its tools over stdio
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { build } from 'esbuild';
import { claudePluginDir, claudePluginMirrors, outfile, pluginBundleOptions, root } from './plugin-bundle-options.mjs';

const REQUIRED_TOOLS = ['mega_whoami', 'mega_ls'];
const SMOKE_TIMEOUT_MS = 30_000;
const CLAUDE_MANIFEST = 'plugins/mega-mcp/.claude-plugin/plugin.json';
const CLAUDE_SERVER_ARG = '${CLAUDE_PLUGIN_ROOT}/dist/plugin-server.js';
// Claude Code runs `npm ci` / `bun install` when a plugin root has package.json plus one of
// these, and the directory holds such a version for a reviewer.
const INSTALL_TRIGGERS = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb'];

const readJson = (relativePath) => JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
const failures = [];

async function check(label, run) {
  try {
    const detail = await run();
    console.log(`✓ ${label}${detail ? ` (${detail})` : ''}`);
  } catch (err) {
    failures.push(label);
    console.error(`✗ ${label}\n    ${err.message}`);
  }
}

await check('bundle matches src/', async () => {
  const result = await build({ ...pluginBundleOptions, write: false, logLevel: 'warning' });
  const fresh = Buffer.from(result.outputFiles[0].contents);
  if (!existsSync(outfile) || !fresh.equals(readFileSync(outfile))) {
    throw new Error('dist/plugin-server.js is stale: run `npm run build:plugin` and commit it.');
  }
});

await check('versions match', () => {
  const files = ['package.json', 'manifest.json', '.codex-plugin/plugin.json', CLAUDE_MANIFEST];
  const versions = files.map((file) => `${file}=${readJson(file).version}`);
  if (new Set(files.map((file) => readJson(file).version)).size !== 1) {
    throw new Error(`${versions.join(', ')}: run \`node scripts/sync-versions.mjs\`.`);
  }
  return readJson('package.json').version;
});

await check('Codex marketplace lists the plugin', () => {
  const marketplace = readJson('.agents/plugins/marketplace.json');
  const plugin = readJson('.codex-plugin/plugin.json');
  const entry = marketplace.plugins?.find((candidate) => candidate.name === plugin.name);
  if (!entry) throw new Error(`.agents/plugins/marketplace.json has no entry named "${plugin.name}".`);
  // The catalog is read from whatever branch the user's marketplace clone tracks,
  // which is the DEFAULT branch (main) when they add the repo URL in the app and
  // leave the ref empty. A `local` source would then install main's files too,
  // skipping release entirely. Pinning the plugin itself to `release` here is what
  // makes release the production branch for every install path. Checked strictly:
  // if Codex can't resolve a source it SKIPS the entry, so a typo would make the
  // plugin silently vanish from the directory rather than fail.
  const repoUrl = readJson('package.json').repository?.url?.replace(/^git\+/, '');
  const src = entry.source;
  if (src?.source !== 'url' || src.url !== repoUrl || src.ref !== 'release' || src.path !== undefined || src.sha !== undefined) {
    throw new Error(
      `"${plugin.name}" must be pinned to release: {"source":"url","url":${JSON.stringify(repoUrl)},"ref":"release"}, got ${JSON.stringify(src)}.`,
    );
  }
  if (!['AVAILABLE', 'INSTALLED_BY_DEFAULT', 'NOT_AVAILABLE'].includes(entry.policy?.installation)) {
    throw new Error(`"${plugin.name}" needs policy.installation (AVAILABLE, INSTALLED_BY_DEFAULT or NOT_AVAILABLE).`);
  }
  if (!['ON_INSTALL', 'ON_USE'].includes(entry.policy?.authentication)) {
    throw new Error(`"${plugin.name}" needs policy.authentication (ON_INSTALL or ON_USE).`);
  }
  if (!entry.category) throw new Error(`"${plugin.name}" needs a category.`);
  const servers = Object.values(readJson(plugin.mcpServers).mcpServers ?? {});
  if (!servers.some((server) => server.args?.includes('./dist/plugin-server.js'))) {
    throw new Error(`${plugin.mcpServers} does not launch ./dist/plugin-server.js.`);
  }
  return `${plugin.name}@${marketplace.name} <- ${src.ref}`;
});

await check('Claude plugin folder is complete', () => {
  const stale = claudePluginMirrors.filter(({ from, to }) => !existsSync(to) || !readFileSync(from).equals(readFileSync(to)));
  if (stale.length) {
    const names = stale.map(({ to }) => relative(root, to)).join(', ');
    throw new Error(`${names} differ from the repo root: run \`npm run build:plugin\` and commit them.`);
  }
  const triggers = INSTALL_TRIGGERS.filter((name) => existsSync(join(claudePluginDir, name)));
  if (triggers.length) {
    throw new Error(`remove ${triggers.join(', ')} from plugins/mega-mcp: the bundle needs no install step.`);
  }
  const servers = Object.values(readJson('plugins/mega-mcp/.mcp.json').mcpServers ?? {});
  // The directory blocks a server path that isn't spelled out from ${CLAUDE_PLUGIN_ROOT}
  // when the plugin is a subfolder of the repository, as this one is.
  if (!servers.some((server) => server.command === 'node' && server.args?.includes(CLAUDE_SERVER_ARG))) {
    throw new Error(`plugins/mega-mcp/.mcp.json must launch \`node ${CLAUDE_SERVER_ARG}\`.`);
  }
  return readJson(CLAUDE_MANIFEST).name;
});

await check('Claude marketplace lists the plugin', () => {
  const marketplace = readJson('.claude-plugin/marketplace.json');
  const plugin = readJson(CLAUDE_MANIFEST);
  const entry = marketplace.plugins?.find((candidate) => candidate.name === plugin.name);
  if (!entry) throw new Error(`.claude-plugin/marketplace.json has no entry named "${plugin.name}".`);
  // Same trap as the Codex marketplace: `/plugin marketplace add meganz/mega-mcp` reads the
  // catalog from the default branch (main), so a relative "./plugins/mega-mcp" source would
  // install main's files. A git-subdir source pinned to `release` keeps every install on
  // release.
  const repoUrl = readJson('package.json').repository?.url?.replace(/^git\+/, '');
  const expected = { source: 'git-subdir', url: repoUrl, path: 'plugins/mega-mcp', ref: 'release' };
  const src = entry.source ?? {};
  const keys = Object.keys(src);
  if (keys.length !== Object.keys(expected).length || keys.some((key) => src[key] !== expected[key])) {
    throw new Error(`"${plugin.name}" must be pinned to release: ${JSON.stringify(expected)}, got ${JSON.stringify(entry.source)}.`);
  }
  // Entry display fields override plugin.json in Claude Code, and they are all users see
  // before installing from a non-relative source, so they must not drift from plugin.json.
  // version is left to plugin.json, which wins over the entry anyway.
  for (const field of ['displayName', 'description']) {
    if (entry[field] !== plugin[field]) throw new Error(`"${plugin.name}".${field} differs from ${CLAUDE_MANIFEST}.`);
  }
  if (entry.version !== undefined) throw new Error(`"${plugin.name}" must not set version: ${CLAUDE_MANIFEST} owns it.`);
  return `${plugin.name}@${marketplace.name} <- ${src.ref}`;
});

await check('plugin runs standalone', async () => {
  // Run a copy of the Claude plugin folder outside the repo, the way Claude Code installs
  // it, so a dependency that escaped bundling can't resolve from node_modules. The bundle
  // is byte-identical to dist/plugin-server.js, so this covers the Codex plugin too.
  const dir = mkdtempSync(join(tmpdir(), 'mega-plugin-check-'));
  try {
    cpSync(claudePluginDir, dir, { recursive: true });
    const { tools, version } = await listTools(join(dir, 'dist', 'plugin-server.js'));
    const missing = REQUIRED_TOOLS.filter((name) => !tools.includes(name));
    if (missing.length) throw new Error(`tools/list is missing ${missing.join(', ')}.`);
    const expected = readJson('package.json').version;
    if (version !== expected) throw new Error(`server reports version ${version}, expected ${expected}.`);
    return `${tools.length} tools, v${version}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

if (failures.length) {
  console.error(`\n${failures.length} plugin check(s) failed.`);
  process.exitCode = 1;
}

// Minimal newline-delimited JSON-RPC client: initialize, then tools/list. Resolves to the
// tool names and the version the server reported in serverInfo.
function listTools(entry) {
  return new Promise((resolveTools, reject) => {
    const child = spawn(process.execPath, [entry], { cwd: dirname(entry), stdio: ['pipe', 'pipe', 'pipe'] });
    let version;
    let stderr = '';
    let settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (!err) return resolveTools(result);
      const tail = stderr.trim().slice(-500);
      reject(new Error(tail ? `${err.message}\n    stderr: ${tail}` : err.message));
    };
    const timer = setTimeout(
      () => finish(new Error(`no tools/list reply within ${SMOKE_TIMEOUT_MS / 1000}s.`)),
      SMOKE_TIMEOUT_MS,
    );
    const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', finish);
    child.on('exit', (code) => finish(new Error(`server exited early (code ${code}).`)));
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.error) return finish(new Error(`JSON-RPC error: ${JSON.stringify(message.error)}`));
      if (message.id === 1) {
        version = message.result.serverInfo?.version;
        send({ method: 'notifications/initialized' });
        send({ id: 2, method: 'tools/list' });
      } else if (message.id === 2) {
        finish(null, { tools: message.result.tools.map((tool) => tool.name), version });
      }
    });

    send({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'check-plugin', version: '0.0.0' } },
    });
  });
}
