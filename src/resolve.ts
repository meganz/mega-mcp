import { access, constants, readFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import type { Config, Resolved } from './types.js';

/** Layout of a cached MEGAcmd, recorded by the downloader in meta.json. */
export interface CacheMeta {
  version?: string;
  /** Bin dir relative to the version dir (e.g. MEGAcmd.app/Contents/MacOS). */
  binSubdir: string;
  /** Optional shared-lib dir relative to the version dir (Linux /opt/megacmd/lib). */
  libSubdir?: string;
  /** SHA-256 of the server binary at install time (Win/Linux launch re-verify). */
  serverSha256?: string;
}

const pExecFile = promisify(execFile);
const isWin = process.platform === 'win32';

/** Name of a mega-<command> client binary for the current platform. Used for
 * presence detection; the actual spawn invocation goes through
 * buildClientInvocation (which avoids the .bat wrapper on win32). */
export function clientName(cmd: string): string {
  return isWin ? `mega-${cmd}.bat` : `mega-${cmd}`;
}

/** The single MEGAcmd client executable that the .bat wrappers shim over. */
export const MEGA_CLIENT_EXE = 'MEGAclient.exe';

/**
 * Build the spawn invocation for a mega subcommand. On Windows we run
 * MEGAclient.exe directly with the subcommand as the first argv element: the
 * `mega-<cmd>.bat` wrappers throw `spawn EINVAL` when execFile'd without
 * shell:true since Node's CVE-2024-27980 fix, and we deliberately never use a
 * shell (argv-array, no metacharacter injection). The `.bat` is literally
 * `MEGAclient <cmd> %*`, so this is behaviorally equivalent. On posix each
 * subcommand is its own mega-<cmd> binary, with args passed through.
 */
export function buildClientInvocation(
  win: boolean,
  binDir: string | null,
  cmd: string,
  args: string[],
): { bin: string; argv: string[] } {
  if (win) {
    return { bin: binDir ? join(binDir, MEGA_CLIENT_EXE) : MEGA_CLIENT_EXE, argv: [cmd, ...args] };
  }
  return { bin: binDir ? join(binDir, clientName(cmd)) : clientName(cmd), argv: args };
}

/** Name of the background server binary for the current platform (§A.7). */
export function serverName(): string {
  switch (process.platform) {
    case 'darwin':
      return 'mega-cmd'; // NOT mega-cmd-server on macOS
    case 'win32':
      return 'MEGAcmdServer.exe';
    default:
      return 'mega-cmd-server';
  }
}

/** Platform/arch subdirectory under the bundled vendor dir, e.g. darwin-arm64. */
export function platformDir(): string {
  return `${process.platform}-${process.arch}`;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function existsOnPath(name: string): Promise<boolean> {
  const probe = isWin ? 'where' : 'which';
  try {
    await pExecFile(probe, [name], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the REAL install dir of the on-PATH client, for the 'path' source
 * (whose binDir is null because we invoke bare `mega-*` names via PATH). We
 * `which`/`where` the whoami client, follow symlinks (realpath), and take its
 * directory — giving signature verification a concrete target (the .app bundle
 * on macOS, or the dir holding MEGAcmdServer.exe on Windows). Returns null if it
 * can't be resolved, in which case the caller skips verification rather than
 * blocking a working PATH install.
 */
export async function resolvePathBinDir(): Promise<string | null> {
  const probe = isWin ? 'where' : 'which';
  try {
    const { stdout } = await pExecFile(probe, [clientName('whoami')], { windowsHide: true });
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (!first) return null;
    return dirname(await realpath(first));
  } catch {
    return null;
  }
}

function makeResolved(source: Resolved['source'], binDir: string | null, libDir: string | null = null): Resolved {
  return {
    source,
    binDir,
    libDir,
    clientInvocation: (cmd, args) => buildClientInvocation(isWin, binDir, cmd, args),
    serverBin: binDir ? join(binDir, serverName()) : serverName(),
  };
}

/** Locate the active cached version dir + its meta. Uses the `current` symlink
 * (posix) or a `current.txt` pointer file (Windows, where symlinks need admin). */
async function readCacheMeta(cacheDir: string): Promise<{ dir: string; meta: CacheMeta } | null> {
  const viaSymlink = join(cacheDir, 'current');
  try {
    const meta = JSON.parse(await readFile(join(viaSymlink, 'meta.json'), 'utf8')) as CacheMeta;
    if (meta?.binSubdir) return { dir: viaSymlink, meta };
  } catch {
    /* fall through to the pointer-file form */
  }
  try {
    const ptr = (await readFile(join(cacheDir, 'current.txt'), 'utf8')).trim();
    if (ptr && !ptr.includes('..')) {
      const dir = join(cacheDir, ptr);
      const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as CacheMeta;
      if (meta?.binSubdir) return { dir, meta };
    }
  } catch {
    /* nothing cached */
  }
  return null;
}

/**
 * The bin/lib dirs of a runtime-downloaded MEGAcmd. Returns null if nothing is
 * cached.
 */
export async function cacheBinDir(config: Config): Promise<{ binDir: string; libDir: string | null } | null> {
  const found = await readCacheMeta(config.cacheDir);
  if (!found) return null;
  return {
    binDir: join(found.dir, found.meta.binSubdir),
    libDir: found.meta.libSubdir ? join(found.dir, found.meta.libSubdir) : null,
  };
}

/** The active cached MEGAcmd's recorded metadata, or null if nothing cached. */
export async function readActiveCacheMeta(config: Config): Promise<CacheMeta | null> {
  return (await readCacheMeta(config.cacheDir))?.meta ?? null;
}

/**
 * Locate the MEGAcmd binaries. Order (§B.1, extended):
 *   1. Bundled (C2)         — <bundledDir>/<platform>-<arch>/
 *   2. User-configured dir  — config.megacmdDir
 *   3. Runtime cache        — <cacheDir>/current/... (downloaded on first run)
 *   4. System PATH          — mode B fallback
 * Returns null if none resolve; callers surface an actionable error rather
 * than crashing.
 */
export async function resolveBinaries(config: Config): Promise<Resolved | null> {
  if (config.bundledDir) {
    const dir = join(config.bundledDir, platformDir());
    if (await isExecutable(join(dir, clientName('whoami')))) {
      return makeResolved('bundled', dir);
    }
  }

  if (config.megacmdDir) {
    if (await isExecutable(join(config.megacmdDir, clientName('whoami')))) {
      return makeResolved('configured', config.megacmdDir);
    }
  }

  // Standard OS install locations (macOS: /Applications; Windows: %LOCALAPPDATA%/
  // Program Files): the client's auto-spawn finds the server natively here, so
  // prefer them over our cache.
  for (const dir of config.systemAppBinDirs ?? []) {
    if (await isExecutable(join(dir, clientName('whoami')))) {
      return makeResolved('system', dir);
    }
  }

  const cache = await cacheBinDir(config);
  if (cache && (await isExecutable(join(cache.binDir, clientName('whoami'))))) {
    return makeResolved('cache', cache.binDir, cache.libDir);
  }

  if (await existsOnPath(clientName('whoami'))) {
    return makeResolved('path', null);
  }

  return null;
}
