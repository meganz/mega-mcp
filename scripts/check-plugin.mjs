#!/usr/bin/env node
// Release gate for the Codex plugin. Users install it from this repo's Git marketplace and
// receive every commit on the `release` branch automatically, so all of these must hold:
//   1. dist/plugin-server.js matches a fresh build of src/
//   2. package.json, manifest.json and .codex-plugin/plugin.json share one version
//   3. .agents/plugins/marketplace.json pins the plugin to this repo's `release` branch
//   4. the bundle starts on its own (no node_modules) and serves its tools over stdio
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { build } from 'esbuild';
import { outfile, pluginBundleOptions, root } from './plugin-bundle-options.mjs';

const REQUIRED_TOOLS = ['mega_whoami', 'mega_ls'];
const SMOKE_TIMEOUT_MS = 30_000;

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
  const files = ['package.json', 'manifest.json', '.codex-plugin/plugin.json'];
  const versions = files.map((file) => `${file}=${readJson(file).version}`);
  if (new Set(files.map((file) => readJson(file).version)).size !== 1) {
    throw new Error(`${versions.join(', ')}: run \`node scripts/sync-versions.mjs\`.`);
  }
  return readJson('package.json').version;
});

await check('marketplace lists the plugin', () => {
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

await check('bundle runs standalone', async () => {
  // Run a copy outside the repo so a dependency that escaped bundling can't resolve
  // from node_modules.
  const dir = mkdtempSync(join(tmpdir(), 'mega-plugin-check-'));
  try {
    const entry = join(dir, 'plugin-server.js');
    copyFileSync(outfile, entry);
    const tools = await listTools(entry);
    const missing = REQUIRED_TOOLS.filter((name) => !tools.includes(name));
    if (missing.length) throw new Error(`tools/list is missing ${missing.join(', ')}.`);
    return `${tools.length} tools`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

if (failures.length) {
  console.error(`\n${failures.length} plugin check(s) failed.`);
  process.exitCode = 1;
}

// Minimal newline-delimited JSON-RPC client: initialize, then tools/list.
function listTools(entry) {
  return new Promise((resolveTools, reject) => {
    const child = spawn(process.execPath, [entry], { cwd: dirname(entry), stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (err, tools) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (!err) return resolveTools(tools);
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
        send({ method: 'notifications/initialized' });
        send({ id: 2, method: 'tools/list' });
      } else if (message.id === 2) {
        finish(null, message.result.tools.map((tool) => tool.name));
      }
    });

    send({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'check-plugin', version: '0.0.0' } },
    });
  });
}
