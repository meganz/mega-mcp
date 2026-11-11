#!/usr/bin/env node
// Release gate for the Codex and Claude plugins. Codex users install from this repo's Git
// marketplace and receive every commit on the `release` branch automatically, and the
// Claude directory scans plugins/mega-mcp on that same branch, so all of these must hold:
//   1. dist/plugin-server.js and its parts in dist/plugin-parts/ match a fresh build of src/
//   2. package.json, manifest.json and both plugin manifests share one version
//   3. .agents/plugins/marketplace.json pins the plugin to this repo's `release` branch, and
//      .mcp.json starts the launcher bin/mega-mcp from the plugin root (cwd "."), which
//      finds Node.js where Codex users have it (scripts/check-launcher.mjs)
//   4. plugins/mega-mcp holds exact copies of the bundle, LICENSE, NOTICE and icon, and a
//      dist/package.json that marks the bundle as ES modules, launches
//      the bundle from ${CLAUDE_PLUGIN_ROOT}, and has nothing that makes Claude Code run npm
//   5. .claude-plugin/marketplace.json pins plugins/mega-mcp to the `release` branch too
//   6. the Claude plugin folder starts on its own (no node_modules), reports its version
//      and serves its tools over stdio
//   7. every file in the Claude plugin folder fits what the claude.ai directory can read
//      (under 256 KiB unless an image, 512 files at most)
//   8. the Codex launcher picks Node.js from each place it promises and serves the tools
//      (on Windows, CI runs scripts/check-launcher.mjs on its own for bin/mega-mcp.cmd)
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { build } from 'esbuild';
import { checkLauncher, listTools } from './check-launcher.mjs';
import { DIRECTORY_FILE_LIMIT, bundleMirrors, claudePluginDir, claudePluginMirrors, outdir, partsDir, pluginBundleOptions, root } from './plugin-bundle-options.mjs';

const REQUIRED_TOOLS = ['mega_whoami', 'mega_ls'];
const LAUNCHER = './bin/mega-mcp';
// env_vars passes what the launchers read besides the variables Codex passes anyway (the
// ChatGPT app's own Node, and where version managers keep theirs) - exactly the names each
// launcher removes again before it starts the server - and CODEX_HOME, which tells the server
// where Codex's configuration is when it isn't ~/.codex, so it can protect it.
const SERVER_ENV_VARS = ['CODEX_HOME'];
function launcherVars() {
  // (One character class each: nothing to backtrack over when a list isn't in this shape.)
  const sh = /\n  unset ([A-Z0-9_ \\\n]+)\n  exec /.exec(readFileSync(join(root, 'bin/mega-mcp'), 'utf8'));
  const cmd = /\nset "MEGA_MCP_VARS=([A-Z0-9_ ]+)"/.exec(readFileSync(join(root, 'bin/mega-mcp.cmd'), 'utf8'));
  if (!sh || !cmd) throw new Error('could not read the variables the launchers remove (bin/mega-mcp `unset`, bin/mega-mcp.cmd MEGA_MCP_VARS).');
  const names = (text) => text.split(/[\s\\]+/).filter(Boolean).sort();
  return { sh: names(sh[1]), cmd: names(cmd[1]) };
}
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

/** Files under `dir`, relative to it ("" when it doesn't exist). */
function filesIn(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesIn(join(dir, entry.name), base) : [relative(base, join(dir, entry.name))],
  );
}

// The bundle as src/ builds it now: every file, with where it belongs.
let bundle = [];
await check('bundle matches src/', async () => {
  const result = await build({ ...pluginBundleOptions, write: false, logLevel: 'warning' });
  const mirrors = bundleMirrors(result.outputFiles.map((file) => file.path));
  bundle = result.outputFiles.map((file, i) => ({ ...mirrors[i], contents: Buffer.from(file.contents) }));
  const stale = bundle.filter(({ dist, contents }) => !existsSync(dist) || !contents.equals(readFileSync(dist)));
  const extra = filesIn(join(outdir, partsDir)).map((name) => join(partsDir, name)).filter((rel) => !bundle.some((file) => file.rel === rel));
  if (stale.length || extra.length) {
    const names = [...stale.map(({ rel }) => rel), ...extra.map((rel) => `${rel} (left over)`)].map((rel) => `dist/${rel}`).join(', ');
    throw new Error(`${names}: run \`npm run build:plugin\` and commit dist/plugin-server.js and dist/${partsDir}/.`);
  }
  // Code that finds files from its own location (config.ts, index.ts) must stay in the main
  // file: in a part it would resolve paths from dist/plugin-parts/ instead of dist/.
  const located = bundle.filter(({ rel, contents }) => rel !== 'plugin-server.js' && /import\.meta\b/.test(contents.toString()));
  if (located.length) {
    throw new Error(`${located.map(({ rel }) => `dist/${rel}`).join(', ')} use import.meta: keep that code out of scripts/plugin-parts/ groups.`);
  }
  return `${bundle.length} files`;
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
  // Codex starts a plugin's server in the conversation's folder unless the config names a
  // cwd, which it joins onto the plugin root when relative, and it expands no variables in
  // this format (codex-rs codex-mcp/src/plugin_config.rs). Without cwd "." a relative path
  // is looked up in whatever folder the conversation is in, and a bare `node` is often not
  // on the PATH Codex passes, while the ChatGPT app's own Node never is (MCP-9). So the
  // command is the launcher, relative to the plugin root: Codex runs it directly on macOS
  // and Linux, and on Windows resolves it to bin\mega-mcp.cmd (PATHEXT). env_vars hands it
  // the variables Codex doesn't pass by default.
  const server = servers.find((candidate) => candidate.command === LAUNCHER);
  if (!server || server.cwd !== '.' || server.args?.length) {
    throw new Error(`${plugin.mcpServers} must launch "${LAUNCHER}" with "cwd": "." and no args.`);
  }
  const removed = launcherVars();
  const passed = (server.env_vars ?? []).filter((name) => !SERVER_ENV_VARS.includes(name)).sort();
  for (const [file, names] of [['bin/mega-mcp', removed.sh], ['bin/mega-mcp.cmd', removed.cmd]]) {
    if (names.join(' ') !== passed.join(' ')) {
      throw new Error(`${plugin.mcpServers} env_vars (without ${SERVER_ENV_VARS.join(', ')}) and the variables ${file} removes differ:\n    env_vars: ${passed.join(' ')}\n    ${file}: ${names.join(' ')}`);
    }
  }
  const missingVars = SERVER_ENV_VARS.filter((name) => !server.env_vars?.includes(name));
  if (missingVars.length) throw new Error(`${plugin.mcpServers} env_vars must list ${missingVars.join(', ')}.`);
  for (const file of ['bin/mega-mcp', 'bin/mega-mcp.cmd']) {
    if (!existsSync(join(root, file))) throw new Error(`${file} is missing.`);
  }
  // Codex installs the plugin with git, so the launcher runs only if git records it as
  // executable (and the file on disk is too, for the check below).
  const mode = execFileSync('git', ['ls-files', '--stage', '--', 'bin/mega-mcp'], { cwd: root, encoding: 'utf8' }).split(' ')[0];
  // (Windows has no execute bit on disk; git's record is what counts.)
  if ((mode && mode !== '100755') || (process.platform !== 'win32' && !(statSync(join(root, 'bin/mega-mcp')).mode & 0o111))) {
    throw new Error('bin/mega-mcp must be executable: chmod +x bin/mega-mcp && git add --chmod=+x bin/mega-mcp.');
  }
  return `${plugin.name}@${marketplace.name} <- ${src.ref}`;
});

await check('Claude plugin folder is complete', () => {
  const stale = [
    ...claudePluginMirrors.filter(({ from, to }) => !existsSync(to) || !readFileSync(from).equals(readFileSync(to))).map(({ to }) => to),
    ...bundle.filter(({ plugin, contents }) => !existsSync(plugin) || !contents.equals(readFileSync(plugin))).map(({ plugin }) => plugin),
  ];
  const extra = filesIn(join(claudePluginDir, 'dist')).filter((rel) => rel !== 'package.json' && !bundle.some((file) => file.rel === rel));
  if (stale.length || extra.length) {
    const names = [...stale.map((to) => relative(root, to)), ...extra.map((rel) => `plugins/mega-mcp/dist/${rel} (left over)`)].join(', ');
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

await check("plugin files fit the directory's limits", () => {
  // The directory holds for a reviewer any non-image file of 256 KiB or more, or more than 512 files.
  const files = filesIn(claudePluginDir);
  if (files.length > 512) throw new Error(`plugins/mega-mcp holds ${files.length} files; the directory reads at most 512.`);
  const large = files
    // (An SVG is text to the directory.)
    .filter((rel) => !/\.(png|jpe?g|gif|webp|woff2?|ttf|otf)$/i.test(rel))
    .map((rel) => ({ rel, size: statSync(join(claudePluginDir, rel)).size }))
    .filter(({ size }) => size >= DIRECTORY_FILE_LIMIT);
  if (large.length) {
    throw new Error(`${large.map(({ rel, size }) => `${rel} (${Math.ceil(size / 1024)} KiB)`).join(', ')}: over 256 KiB; split the bundle further (scripts/plugin-parts/).`);
  }
  const biggest = Math.max(...files.map((rel) => statSync(join(claudePluginDir, rel)).size));
  return `${files.length} files, largest ${Math.ceil(biggest / 1024)} KiB`;
});

await check('plugin runs standalone', async () => {
  // Run a copy of the Claude plugin folder outside the repo, the way Claude Code installs
  // it, so a dependency that escaped bundling can't resolve from node_modules. The bundle
  // is byte-identical to dist/plugin-server.js and dist/plugin-parts/, so this covers the
  // Codex plugin too.
  const dir = mkdtempSync(join(tmpdir(), 'mega-plugin-check-'));
  try {
    cpSync(claudePluginDir, dir, { recursive: true });
    const entry = join(dir, 'dist', 'plugin-server.js');
    // As a Node that doesn't detect ES modules by itself would (18, 20 before 20.19, 22 before
    // 22.7): dist/package.json has to say so.
    const flags = process.allowedNodeEnvironmentFlags.has('--no-experimental-detect-module') ? ['--no-experimental-detect-module'] : [];
    const { tools, version } = await listTools(process.execPath, [...flags, entry], { cwd: dirname(entry) });
    const missing = REQUIRED_TOOLS.filter((name) => !tools.includes(name));
    if (missing.length) throw new Error(`tools/list is missing ${missing.join(', ')}.`);
    const expected = readJson('package.json').version;
    if (version !== expected) throw new Error(`server reports version ${version}, expected ${expected}.`);
    return `${tools.length} tools, v${version}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

if (process.platform !== 'win32') await check('Codex launcher finds Node', checkLauncher);

if (failures.length) {
  console.error(`\n${failures.length} plugin check(s) failed.`);
  process.exitCode = 1;
}
