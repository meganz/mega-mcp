#!/usr/bin/env node
// Checks the Codex plugin's launcher: bin/mega-mcp, or bin/mega-mcp.cmd on Windows. From a
// copy of the plugin's files outside the repo, started the way Codex starts it (command
// "./bin/mega-mcp" in the plugin folder) with a trimmed environment, it must pick Node.js
// from each place it promises, in order, serve the MCP tools, write nothing else to
// stdout, leave out of the server's environment the variables .mcp.json passes only for
// finding Node, and pass the server the places it searched (MEGA_MCP_NODE_ROOTS), which
// the server protects. A preload logs which node ran the server and what it saw. check-plugin
// runs this; CI also runs it alone on Windows, where the rest of check-plugin doesn't
// apply. Only node: built-ins, so it runs without npm ci.
//
// Usage: node scripts/check-launcher.mjs
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const REQUIRED_TOOLS = ['mega_whoami', 'mega_ls'];
const SMOKE_TIMEOUT_MS = 30_000;
const NODE = isWindows ? 'node.exe' : 'node';

// Minimal newline-delimited JSON-RPC client: initialize, then tools/list. Resolves to the
// tool names, the version the server reported in serverInfo, and its stderr.
export function listTools(command, args, options = {}) {
  return new Promise((resolveTools, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
    let version;
    let stderr = '';
    let settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Closing stdin ends the server even when a Windows cmd.exe sits in between.
      child.stdin.end();
      child.kill();
      if (!err) return resolveTools({ ...result, stderr });
      const tail = stderr.trim().slice(-500);
      reject(new Error(tail ? `${err.message}\n    stderr: ${tail}` : err.message));
    };
    const timer = setTimeout(
      () => finish(new Error(`no tools/list reply within ${SMOKE_TIMEOUT_MS / 1000}s.`)),
      SMOKE_TIMEOUT_MS,
    );
    const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdin.on('error', () => {});
    child.on('error', finish);
    child.on('exit', (code) => finish(new Error(`server exited early (code ${code}).`)));
    createInterface({ input: child.stdout }).on('line', (line) => {
      // Anything but JSON-RPC on stdout breaks the MCP stream for the host.
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return finish(new Error(`non-JSON line on stdout: ${JSON.stringify(line.slice(0, 200))}`));
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
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'check-launcher', version: '0.0.0' } },
    });
  });
}

// Runs a command to its end: exit code, stdout and stderr.
function runToEnd(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`still running after ${SMOKE_TIMEOUT_MS / 1000}s.`));
    }, SMOKE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdin.on('error', () => {});
    child.stdin.end();
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

// What Codex runs for "./bin/mega-mcp" with cwd set to the plugin folder. On Unix it
// spawns the relative path from that folder. On Windows it resolves it with the which
// crate against that folder: the extensionless file is no executable, so PATHEXT's
// extensions are tried and bin\mega-mcp.cmd is found, which Rust runs through cmd.exe.
function codexCommand(pluginDir) {
  if (!isWindows) return { command: './bin/mega-mcp', args: [] };
  const base = join(pluginDir, 'bin', 'mega-mcp');
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const found = exts.map((ext) => base + ext).find((file) => existsSync(file));
  if (!found) throw new Error(`no ${base}<PATHEXT> for Codex to run on Windows.`);
  const comspec = process.env.ComSpec || join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  // As Rust std builds it for a batch file: the whole command line quoted once more.
  return { command: comspec, args: ['/e:ON', '/v:OFF', '/d', '/c', `""${found}""`], windowsVerbatimArguments: true };
}

// A node of its own at DIR/node(.exe), so the log shows which candidate ran: a hard link
// to this node where possible, else a copy.
function placeNode(dir) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, NODE);
  try {
    linkSync(process.execPath, file);
  } catch {
    copyFileSync(process.execPath, file);
    chmodSync(file, 0o755);
  }
  return file;
}

export async function checkLauncher() {
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mega-launcher-check-')));
  try {
    // The files Codex installs that the launcher uses, in a folder whose path needs quoting.
    const pluginDir = join(work, 'plug in & (x)');
    cpSync(join(root, 'bin'), join(pluginDir, 'bin'), { recursive: true });
    // (package.json says "type": "module", which the Codex plugin's bundle relies on.)
    cpSync(join(root, 'package.json'), join(pluginDir, 'package.json'));
    mkdirSync(join(pluginDir, 'dist'));
    cpSync(join(root, 'dist', 'plugin-server.js'), join(pluginDir, 'dist', 'plugin-server.js'));
    cpSync(join(root, 'dist', 'plugin-parts'), join(pluginDir, 'dist', 'plugin-parts'), { recursive: true });

    // What .mcp.json passes only for finding Node: none of it may reach the server. CODEX_HOME
    // is passed for the server, and MEGA_MCP_NODE_ROOTS is what the launcher hands it.
    const SERVER_VARS = ['CODEX_HOME', 'MEGA_MCP_NODE_ROOTS'];
    const envVars = Object.values(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers)[0].env_vars ?? [];
    const launcherVars = envVars.filter((name) => !SERVER_VARS.includes(name));
    const log = join(work, 'node.log');
    const preload = join(work, 'preload.cjs');
    writeFileSync(
      preload,
      `if (/plugin-server\\.js$/.test(process.argv[1] || '')) {
  const names = ${JSON.stringify(launcherVars)};
  const allowed = ${JSON.stringify(SERVER_VARS)};
  const leaked = Object.keys(process.env).filter((k) => !allowed.includes(k.toUpperCase()) && (names.some((n) => n.toUpperCase() === k.toUpperCase()) || /^MEGA_MCP_/i.test(k)));
  const env = (n) => process.env[Object.keys(process.env).find((k) => k.toUpperCase() === n) ?? n];
  require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ execPath: process.execPath, leaked, roots: env('MEGA_MCP_NODE_ROOTS'), codexHome: env('CODEX_HOME') }) + '\\n');
}\n`,
    );
    const empty = join(work, 'empty');
    mkdirSync(empty);
    const onPath = placeNode(join(work, 'on-path'));
    const named = placeNode(join(work, 'named'));
    const codexApp = placeNode(join(work, 'codex-app'));
    const home = join(work, 'home');
    // The Codex app's runtime cache: ~/.cache on macOS and Linux, %USERPROFILE%\.cache on Windows.
    const cached = placeNode(join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin'));

    // The variables Codex passes to a plugin's server by default, pointed at an empty home
    // so the machine's own Node installs in home folders don't interfere.
    const base = isWindows
      ? {
          SystemRoot: process.env.SystemRoot,
          ComSpec: process.env.ComSpec,
          PATHEXT: process.env.PATHEXT,
          TEMP: work,
          TMP: work,
          USERPROFILE: home,
          LOCALAPPDATA: join(home, 'AppData', 'Local'),
          APPDATA: join(home, 'AppData', 'Roaming'),
          ProgramFiles: process.env.ProgramFiles,
          'ProgramFiles(x86)': process.env['ProgramFiles(x86)'],
          ProgramW6432: process.env.ProgramW6432,
        }
      : { HOME: home };
    // As a Node that doesn't detect ES modules by itself starts it, where this Node can.
    const noDetect = process.allowedNodeEnvironmentFlags.has('--no-experimental-detect-module') ? ' --no-experimental-detect-module' : '';
    base.NODE_OPTIONS = `--require "${preload.replace(/\\/g, '/')}"${noDetect}`;

    const scenarios = [
      { name: 'node on PATH', env: { PATH: dirname(onPath) }, expect: onPath },
      { name: 'MEGA_MCP_NODE before PATH', env: { PATH: dirname(onPath), MEGA_MCP_NODE: named }, expect: named },
      {
        name: 'unusable MEGA_MCP_NODE falls back',
        env: { PATH: dirname(onPath), MEGA_MCP_NODE: join(work, 'missing', NODE) },
        expect: onPath,
        stderr: /MEGA_MCP_NODE .*looking elsewhere/,
      },
      { name: "the Codex app's Node (CODEX_MCP_NODE_PATH)", env: { PATH: empty, CODEX_MCP_NODE_PATH: codexApp }, expect: codexApp },
      { name: "the Codex app's runtime cache", env: { PATH: empty }, expect: cached },
      {
        name: 'launcher-only variables stay out of the server, CODEX_HOME reaches it',
        env: { PATH: empty, ...Object.fromEntries(launcherVars.map((name) => [name, empty])), MEGA_MCP_NODE: named, CODEX_HOME: home },
        expect: named,
        codexHome: home,
        // With every variable pointing at one folder: the places each of them adds to the search.
        roots: isWindows
          ? ['cua_node', 'node.exe', 'aliases', 'node-versions', join('tools', 'image', 'node'), join('installs', 'node'), join('apps', 'nodejs')].map((rel) => join(empty, rel))
          : [
              join('cua_node', 'bin', 'node'),
              join('codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin', 'node'),
              join('bin', 'node'),
              join('aliases', 'default', 'bin', 'node'),
              'node-versions',
              join('fnm', 'node-versions'),
              join('versions', 'node'),
              join('tools', 'image', 'node'),
              join('installs', 'nodejs'),
              join('installs', 'node'),
              'versions',
            ].map((rel) => join(empty, rel)),
      },
    ];
    // A version manager's shim on PATH picks a Node from config files around it: skipped.
    const shim = placeNode(join(work, 'manager', 'shims'));
    scenarios.push({ name: "a version manager's shim on PATH is skipped", env: { PATH: dirname(shim), CODEX_MCP_NODE_PATH: codexApp }, expect: codexApp });
    // Volta's shim: %LOCALAPPDATA%\Volta\bin on Windows, ~/.volta/bin elsewhere.
    const volta = placeNode(isWindows ? join(base.LOCALAPPDATA, 'Volta', 'bin') : join(home, '.volta', 'bin'));
    scenarios.push({ name: "Volta's shim on PATH is skipped", env: { PATH: dirname(volta), CODEX_MCP_NODE_PATH: codexApp }, expect: codexApp });
    // A real node later on PATH is still found after a shim.
    scenarios.push({ name: 'a node on PATH after a shim is used', env: { PATH: [dirname(shim), dirname(onPath)].join(isWindows ? ';' : ':') }, expect: isWindows ? cached : onPath });
    if (isWindows) {
      // Installed versions (nvm-windows' folder): passed over when not Node 18+, with nothing
      // else to find - no Program Files, an empty profile.
      const bare = join(work, 'bare-home');
      const nvm = join(work, 'nvm');
      mkdirSync(join(nvm, 'v10.0.0'), { recursive: true });
      writeFileSync(join(nvm, 'v10.0.0', NODE), '');
      const installed = placeNode(join(nvm, 'v22.0.0'));
      scenarios.push({
        name: 'an installed version is found by folder, an unusable one passed over',
        env: { PATH: empty, NVM_HOME: nvm, USERPROFILE: bare, LOCALAPPDATA: join(bare, 'Local'), APPDATA: join(bare, 'Roaming'), ProgramFiles: undefined, 'ProgramFiles(x86)': undefined, ProgramW6432: undefined },
        expect: installed,
        cacheRoot: join(bare, '.cache', 'codex-runtimes'),
      });
    }
    if (!isWindows) {
      // dash prints "<dir>//node" for a PATH entry that ends in "/".
      scenarios.push({ name: 'a shim in a PATH entry ending in "/" is skipped', env: { PATH: `${dirname(shim)}/`, CODEX_MCP_NODE_PATH: codexApp }, expect: codexApp });
      // A `node` on PATH that isn't Node 18+ (an old release, or another program by that name).
      const old = join(work, 'old');
      mkdirSync(old);
      writeFileSync(join(old, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      scenarios.push({ name: 'old node on PATH is skipped', env: { PATH: old, CODEX_MCP_NODE_PATH: codexApp }, expect: codexApp });
    }

    const { command, args, windowsVerbatimArguments } = codexCommand(pluginDir);
    const passed = [];
    for (const scenario of scenarios) {
      rmSync(log, { force: true });
      let result;
      try {
        const env = Object.fromEntries(Object.entries({ ...base, ...scenario.env }).filter(([, value]) => value !== undefined));
        result = await listTools(command, args, { cwd: pluginDir, env, windowsVerbatimArguments });
      } catch (e) {
        throw new Error(`${scenario.name}: ${e instanceof Error ? e.message : e}`);
      }
      const missing = REQUIRED_TOOLS.filter((name) => !result.tools.includes(name));
      if (missing.length) throw new Error(`${scenario.name}: tools/list is missing ${missing.join(', ')}.`);
      const last = existsSync(log) ? readFileSync(log, 'utf8').trim().split(/\r?\n/).pop() : undefined;
      const logged = last ? JSON.parse(last) : {};
      const { execPath: ran, leaked = [] } = logged;
      const same = ran !== undefined && existsSync(ran) && realpathSync.native(ran) === realpathSync.native(scenario.expect);
      if (!same) throw new Error(`${scenario.name}: ran ${ran ?? 'no node we can see'}, expected ${scenario.expect}.`);
      if (leaked.length) throw new Error(`${scenario.name}: the server's environment still has ${leaked.join(', ')}.`);
      // The Codex runtime cache is searched on every platform, so it is always among the roots
      // (in XDG_CACHE_HOME when that is set, outside Windows).
      const cacheRoot = scenario.cacheRoot ?? join((!isWindows && scenario.env.XDG_CACHE_HOME) || join(home, '.cache'), 'codex-runtimes');
      const fold = (p) => (isWindows ? p.toLowerCase().replace(/\\+$/, '') : p);
      const roots = (logged.roots ?? '').split(isWindows ? ';' : ':').filter(Boolean).map(fold);
      const within = (p) => roots.some((r) => fold(p) === r || fold(p).startsWith(r + (isWindows ? '\\' : '/')));
      if (!roots.some((r) => r === fold(cacheRoot) || r.startsWith(fold(cacheRoot) + (isWindows ? '\\' : '/')))) {
        throw new Error(`${scenario.name}: MEGA_MCP_NODE_ROOTS doesn't list ${cacheRoot}: ${logged.roots}`);
      }
      // The node it chose is in a place it listed (PATH's own node is the server's to protect).
      const fromPath = (scenario.env.PATH ?? '').split(isWindows ? ';' : ':').some((dir) => fold(dir.replace(/\/$/, '')) === fold(dirname(scenario.expect)));
      if (!fromPath && !within(scenario.expect)) {
        throw new Error(`${scenario.name}: MEGA_MCP_NODE_ROOTS doesn't cover the node it ran (${scenario.expect}): ${logged.roots}`);
      }
      const unlisted = (scenario.roots ?? []).filter((place) => !roots.includes(fold(place)));
      if (unlisted.length) throw new Error(`${scenario.name}: MEGA_MCP_NODE_ROOTS doesn't list ${unlisted.join(', ')}: ${logged.roots}`);
      if (scenario.codexHome && logged.codexHome !== scenario.codexHome) throw new Error(`${scenario.name}: CODEX_HOME didn't reach the server.`);
      if (scenario.stderr && !scenario.stderr.test(result.stderr)) {
        throw new Error(`${scenario.name}: stderr doesn't match ${scenario.stderr}: ${result.stderr.trim().slice(-300)}`);
      }
      passed.push(scenario.name);
    }
    if (isWindows) {
      // Nothing to find (an empty profile, no Program Files, only a shim on PATH): it says what
      // to do on stderr, nothing on stdout, and exits 127. (Elsewhere a system Node is always
      // found, so this path can't be reached in a check.)
      const bare = join(work, 'bare-home');
      const env = { ...base, PATH: dirname(shim), USERPROFILE: bare, LOCALAPPDATA: join(bare, 'Local'), APPDATA: join(bare, 'Roaming') };
      for (const name of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) delete env[name];
      const { code, stdout, stderr } = await runToEnd(command, args, { cwd: pluginDir, env, windowsVerbatimArguments });
      if (code !== 127 || stdout !== '' || !/passed over/.test(stderr) || !/restart Codex/.test(stderr)) {
        throw new Error(`nothing to find: exit ${code}, stdout ${JSON.stringify(stdout.slice(0, 200))}, stderr ${JSON.stringify(stderr.slice(-400))}`);
      }
      passed.push('nothing to find');
    }
    return `${isWindows ? 'bin/mega-mcp.cmd' : 'bin/mega-mcp'}: ${passed.length} cases`;
  } finally {
    // Windows may hold a file for a moment after the server exits; a left-over temp folder is
    // no reason to fail the check.
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // left for the OS to clean up
    }
  }
}

// Started as a script (by its real path: a link in the path must not make this a silent no-op).
const started = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (started) {
  try {
    console.log(`ok   Codex launcher finds Node (${await checkLauncher()})`);
  } catch (e) {
    console.error(`FAIL Codex launcher finds Node\n     ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}
