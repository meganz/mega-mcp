import type { AuthState, Config, Resolved, RunOpts, RunResult } from './types.js';
import { basename, join, isAbsolute, dirname, resolve } from 'node:path';
import { readFileSync, readdirSync, realpathSync, lstatSync, statSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolveBinaries, readActiveCacheMeta, resolvePathBinDir, serverName } from './resolve.js';
import { execClient } from './exec.js';
import { ensureServerRunning } from './server.js';
import { verifyResolvedBinary, macLoginHelperDir } from './download/megacmd.js';
import { detectAuth, ensureReady } from './auth.js';
import { publishMegacmdBinDir } from './paths.js';
import { assertSafeInvocation, scrubSecrets } from './invocation.js';
import { stateDir } from './fileReading.js';
import { createConfirmStore, type ConfirmStore } from './confirm.js';

/**
 * The Runtime is the shared context handed to every tool. It lazily resolves
 * the MEGAcmd binaries once (so the server starts even when MEGAcmd is absent)
 * and exposes the command-execution choke point plus auth probes.
 */
export interface Runtime {
  config: Config;
  confirm: ConfirmStore;
  /** Invoke a mega-<command> client. Returns a structured result, never throws. */
  run(cmd: string, args: string[], opts?: RunOpts): Promise<RunResult>;
  /** Where the binaries were found (null until first resolution). */
  getResolved(): Promise<Resolved | null>;
  /**
   * The install DIRECTORY, resolving the 'path' source's null binDir the same way
   * the integrity gate does. On Windows the session store sits next to the
   * executable, so a null binDir makes the upload/sync store check blind to the only store
   * that actually exists — `getResolved()?.binDir` is not a safe substitute.
   */
  getBinDir(): Promise<string | null>;
  /** Drop cached resolution + server state (call after a successful download). */
  invalidateResolved(): void;
  /** Single auth probe (no retry). */
  getAuthState(): Promise<AuthState>;
  /** Auth probe with warm-up retry, for the first call after cold start. */
  ensureReady(): Promise<AuthState>;
}

/**
 * Every directory a MEGAcmd could be launched from, as far as CONFIG alone knows.
 * All four are plain config, so this needs no async resolution — which is the whole
 * point: assertNotTrustRoot is synchronous and no-ops while its root list is empty,
 * so anything that only published after the first successful resolution left the
 * guard inert on exactly the calls it exists to stop. mega_get / mega_thumbnail
 * never ask for the resolved bin dir at all, so for them "after resolution" never
 * arrived. The resolved dir is ADDED later by getBinDir(); it is a refinement, not
 * the precondition.
 */
function configTrustRoots(config: Config): string[] {
  return [
    ...(config.systemAppBinDirs ?? []),
    ...(config.megacmdDir ? [config.megacmdDir] : []),
    ...(config.bundledDir ? [config.bundledDir] : []),
    config.cacheDir,
    // The host-injected plugin data dir holds the remembered file-reading consent
    // (file-reading.json), which the connector trusts at startup. A transfer that
    // could write it would grant that consent without ever asking. Equal to
    // cacheDir when no host injects one.
    stateDir(config),
    // The macOS login helper: a script the user is told to double-click, so a
    // transfer must not be able to replace it.
    ...(process.platform === 'darwin' ? [macLoginHelperDir()] : []),
    // MEGAcmd's macOS socket dir (runtimeDirPath): a write there could hijack the server channel.
    ...(process.platform === 'darwin' ? [join(homedir(), 'Library', 'Caches', 'megacmd.mac')] : []),
  ];
}

/** Write-only protection (uploads from them stay allowed): what decides what runs at next start. */
function configWriteRoots(config: Config): () => string[] {
  const fixed = [
    // Host configuration: which MCP servers, hooks and plugins run, and the MCPB settings.
    ...hostConfigDirs(),
    // This connector's own code: a manual or repo install sits outside any host folder.
    ...(config.appDir ? [config.appDir] : []),
    ...[process.env.CLAUDE_PLUGIN_ROOT, process.env.PLUGIN_ROOT].filter((p): p is string => !!p && p.trim() !== ''),
  ];
  // The same per project (.claude, .mcp.json, .codex), re-read when a host's project list changes;
  // symlinks inside them followed again when a protected folder's own entries change.
  let key: string | null = null;
  let projects: string[] = [];
  let linkKey: string | null = null;
  let linked: string[] = [];
  let all: string[] = [];
  let checkedAt = -Infinity;
  return () => {
    // Asked for every path a transfer checks: looked at again at most once a second.
    if (Date.now() - checkedAt < 1000) return all;
    checkedAt = Date.now();
    const k = projectSourcesKey();
    if (k !== key) {
      key = k;
      projects = projectConfigPaths();
    }
    const roots = [...fixed, ...projects];
    const lk = roots.map(entryStamp).join('|');
    if (lk !== linkKey) {
      linkKey = lk;
      linked = linkedOutOf(roots);
    }
    all = [...roots, ...linked];
    return all;
  };
}

/** What linkedOutOf depends on at a root: a folder's entries, or where a link points. */
function entryStamp(p: string): string {
  try {
    const st = lstatSync(p);
    // A link: where it points, and (for a linked folder) that folder's own entries.
    if (st.isSymbolicLink()) return `L:${readlinkSync(p)}:${entryStamp(linkTarget(p))}`;
    return st.isDirectory() ? `D:${st.mtimeMs}` : 'F';
  } catch {
    return '-';
  }
}

function stamp(f: string): string {
  try {
    const st = statSync(f);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '-';
  }
}

function codexToml(): string {
  return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
}

/** Where Claude Code keeps its project list: CLAUDE_CONFIG_DIR moves it, and a legacy .config.json wins. */
function claudeProjectFiles(): string[] {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim() ? process.env.CLAUDE_CONFIG_DIR : undefined;
  return [...new Set([join(homedir(), '.claude.json'), ...(dir ? [join(dir, '.claude.json')] : []), join(dir ?? join(homedir(), '.claude'), '.config.json')])];
}

function projectSourcesKey(): string {
  return [...claudeProjectFiles(), codexToml()].map(stamp).join('|') + `|${process.cwd()}`;
}

/** Last projects read from each file: an unreadable rewrite keeps them rather than dropping them. */
const lastProjects = new Map<string, string[]>();

/** The projects the hosts know (Claude Code's project list, Codex's config.toml) and the working folder. */
function projectConfigPaths(): string[] {
  const projects = new Set<string>([process.cwd()]);
  const read = (file: string, parse: (text: string) => string[]) => {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      lastProjects.delete(file); // No such configuration.
      return;
    }
    try {
      lastProjects.set(file, parse(text));
    } catch {
      // Mid-write or damaged: keep what it listed before.
    }
    for (const p of lastProjects.get(file) ?? []) projects.add(p);
  };
  for (const f of claudeProjectFiles()) read(f, (t) => Object.keys((JSON.parse(t) as { projects?: Record<string, unknown> }).projects ?? {}));
  // Every absolute path written as a TOML string counts as a project, however the table is
  // spelled ([projects."..."], dotted keys, inline tables): more is protected, never less.
  read(codexToml(), (t) => tomlStrings(t).filter((v) => isAbsolute(v)));
  return [...projects].filter((p) => isAbsolute(p)).flatMap((p) => [join(p, '.claude'), join(p, '.mcp.json'), join(p, '.codex')]);
}

/** The values of TOML's basic ("...", escapes decoded) and literal ('...') strings, comments skipped. */
function tomlStrings(text: string): string[] {
  const esc: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
  const out: string[] = [];
  for (const m of text.matchAll(/#[^\n]*|"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'/g)) {
    if (m[1] !== undefined) {
      out.push(m[1].replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (_, e: string) => (e.length > 1 ? String.fromCodePoint(parseInt(e.slice(1), 16)) : (esc[e] ?? e))));
    } else if (m[2] !== undefined) out.push(m[2]);
  }
  return out;
}

/** Where symlinks inside the protected folders lead (a dotfiles setup): written there, they change those folders. */
function linkedOutOf(roots: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (p: string, depth: number) => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      // Every link of the chain and where it ends, also when that does not exist yet (written
      // through, it is created there; written at a link in between, the chain leads there).
      const hops = linkHops(p);
      out.push(...hops);
      // A linked folder is searched like the folder it stands for.
      const target = hops[hops.length - 1] as string;
      if (!seen.has(target)) {
        seen.add(target);
        visit(target, depth);
      }
      return;
    }
    if (!st.isDirectory() || depth >= 2) return;
    let names: string[] = [];
    try {
      // Every entry, at every depth followed: a link left out would leave its target unprotected.
      names = readdirSync(p);
    } catch {
      return;
    }
    for (const n of names) visit(join(p, n), depth + 1);
  };
  for (const r of roots) visit(r, 0);
  return out;
}

/** The links a symlink's chain passes through, each resolved from its real folder, then where it ends. */
function linkHops(p: string): string[] {
  const hops: string[] = [];
  let t = p;
  for (let i = 0; i < 16; i++) {
    try {
      if (!lstatSync(t).isSymbolicLink()) break;
      let dir = dirname(t);
      try {
        dir = realpathSync.native(dir);
      } catch {
        // A folder that does not exist yet: as written.
      }
      t = resolve(dir, readlinkSync(t));
    } catch {
      break;
    }
    hops.push(t);
  }
  try {
    hops.push(realpathSync.native(p));
  } catch {
    // Dangling: the last hop is where it leads.
  }
  return [...new Set(hops)];
}

/** A symlink's destination: its real path, or (dangling) where its chain of links points. */
function linkTarget(p: string): string {
  const hops = linkHops(p);
  return hops[hops.length - 1] ?? p;
}

function hostConfigDirs(): string[] {
  const home = homedir();
  // ~/.claude.json is Claude Code's main configuration (its MCP servers and their
  // environment); CLAUDE_CONFIG_DIR and CODEX_HOME move the hosts' folders.
  const dirs = [join(home, '.claude'), join(home, '.claude.json'), join(home, '.codex')];
  // CLAUDE_USER_DATA_DIR moves Claude Desktop's profile; "Claude-3p" is its third-party-provider profile.
  // (A value starting "~" counts both as written and expanded: a host may expand it itself.)
  for (const v of [process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME, process.env.CLAUDE_USER_DATA_DIR]) {
    if (!v || !v.trim()) continue;
    dirs.push(v);
    if (/^~(?:[/\\]|$)/.test(v)) dirs.push(join(home, v.slice(1)));
  }
  const desktop = (base: string) => dirs.push(join(base, 'Claude'), join(base, 'Claude-3p'));
  // The hosts' own programs run at the next start too: Claude Code's native install, Claude Desktop's app.
  dirs.push(join(home, '.local', 'share', 'claude'), join(home, '.local', 'bin', 'claude'));
  if (process.platform === 'darwin') dirs.push('/Applications/Claude.app', join(home, 'Applications', 'Claude.app'));
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'AnthropicClaude'));
  if (process.platform === 'darwin') desktop(join(home, 'Library', 'Application Support'));
  if (process.platform === 'win32' && process.env.APPDATA) desktop(process.env.APPDATA);
  // A packaged (MSIX) install keeps its settings in its own folder under LOCALAPPDATA\Packages.
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    try {
      for (const pkg of readdirSync(join(process.env.LOCALAPPDATA, 'Packages')).filter((n) => /claude|anthropic/i.test(n))) {
        desktop(join(process.env.LOCALAPPDATA, 'Packages', pkg, 'LocalCache', 'Roaming'));
      }
    } catch {
      // No Packages folder: nothing packaged.
    }
  }
  if (process.platform === 'linux') desktop(process.env.XDG_CONFIG_HOME || join(home, '.config'));
  return dirs;
}

/** Seams for tests; production uses the real resolver and verifier. */
export interface RuntimeDeps {
  resolve?: typeof resolveBinaries;
  verify?: typeof verifyResolvedBinary;
  exec?: typeof execClient;
}

export function createRuntime(config: Config, deps: RuntimeDeps = {}): Runtime {
  const resolveImpl = deps.resolve ?? resolveBinaries;
  const verifyImpl = deps.verify ?? verifyResolvedBinary;
  const execImpl = deps.exec ?? execClient;
  // Arm the synchronous path guard before any tool can run. Publishing again from
  // getBinDir() only adds the resolved dir on top of these.
  const writeRoots = configWriteRoots(config);
  publishMegacmdBinDir(null, configTrustRoots(config), writeRoots);

  let resolvedPromise: Promise<Resolved | null> | undefined;
  let serverReady: Promise<boolean> | undefined;
  // Keyed by the Resolved object that run() executes from, so a verification can
  // never vouch for binaries from a different resolution (setup invalidates and
  // re-resolves while other calls may be in flight).
  const verified = new WeakMap<Resolved, Promise<boolean>>();
  let binDirPromise: Promise<string | null> | undefined;
  const getResolved = () => (resolvedPromise ??= resolveImpl(config));
  const getBinDir: Runtime['getBinDir'] = () =>
    (binDirPromise ??= (async () => {
      const r = await getResolved();
      if (!r) return null;
      // Every source resolves to a concrete dir now, 'path' included; the
      // fall-back only covers a Resolved built without one.
      const dir = r.binDir ?? (r.source === 'path' ? await resolvePathBinDir() : null);
      // Add the RESOLVED dir to what createRuntime already armed. This covers the
      // 'path' source, whose install dir is not in config at all.
      publishMegacmdBinDir(dir, configTrustRoots(config), writeRoots);
      return dir;
    })());

  const run: Runtime['run'] = async (cmd, given, opts) => {
    // Every call, whatever tool built it: see invocation.ts. A copy: what runs is what was checked.
    const args = [...given];
    assertSafeInvocation(cmd, args);
    const resolved = await getResolved();
    if (!resolved) {
      return { code: -1, stdout: '', stderr: '', spawnError: 'NO_MEGACMD' };
    }
    // Integrity gate: verify the code signature of WHATEVER binary we are about
    // to launch, once per resolution, for EVERY source - not just the ones we
    // downloaded. Identity-based, so it survives MEGAcmd self-updates (signer
    // stays "Mega Limited"; see verifyResolvedBinary). Swaps made later by other
    // software running as the same user are out of scope (see SECURITY.md): such
    // software can read the session store directly.
    const binDir = resolved.binDir ?? (resolved.source === 'path' ? await resolvePathBinDir() : null);
    let ok = verified.get(resolved);
    if (!ok) {
      ok = (async () => {
        const serverBin = binDir ? join(binDir, serverName()) : resolved.serverBin;
        // The CLIENT is the binary this process actually launches, every call. On
        // Windows it is a separate loose file from the server, so verifying only
        // the server checked something we never execute.
        const clientBin = resolved.clientInvocation('whoami', []).bin;
        const meta = resolved.source === 'cache' ? await readActiveCacheMeta(config) : null;
        return verifyImpl(
          { binDir, serverBin, clientBin: binDir ? join(binDir, basename(clientBin)) : clientBin, source: resolved.source },
          {
            teamId: config.download.teamId,
            serverSha256: meta?.serverSha256,
            winThumbprint: config.download.winThumbprint,
          },
        );
      })();
      verified.set(resolved, ok);
    }
    if (!(await ok)) {
      verified.delete(resolved); // never cache a transient failure
      return { code: -1, stdout: '', stderr: '', spawnError: 'INTEGRITY_FAILED' };
    }

    // Server management: 'path' relies on the client's native auto-spawn. Every
    // other source we ensure a server ourselves — required for non-standard
    // locations (cache/bundled/configured), a harmless belt-and-suspenders for
    // 'system'. Only a SUCCESSFUL launch is memoized so a transient cold-start
    // timeout is retried on the next call rather than cached for the process.
    if (resolved.source !== 'path') {
      if (!(await (serverReady ??= ensureServerRunning(resolved)))) {
        serverReady = undefined;
      }
    }
    const result = await execImpl(resolved, cmd, args, opts);
    // Nothing a tool returns can carry a credential MEGAcmd printed next to it.
    return { ...result, stdout: scrubSecrets(cmd, args, result.stdout), stderr: scrubSecrets(cmd, args, result.stderr) };
  };

  // Warm the published bin dir for the SYNCHRONOUS refusal guard, which cannot
  // await it. Fire-and-forget: resolution failure is already handled on every
  // real path, and an unpopulated value just leaves the guard as it was before.
  void getBinDir().catch(() => {});

  return {
    config,
    confirm: createConfirmStore(),
    run,
    getResolved,
    getBinDir,
    invalidateResolved: () => {
      resolvedPromise = undefined;
      binDirPromise = undefined;
      serverReady = undefined;
      // Verifications are keyed by Resolved, so the next resolution starts fresh.
    },
    getAuthState: () => detectAuth(run),
    ensureReady: () => ensureReady(run),
  };
}
