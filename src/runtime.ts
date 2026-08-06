import type { AuthState, Config, Resolved, RunOpts, RunResult } from './types.js';
import { basename, join } from 'node:path';
import { resolveBinaries, readActiveCacheMeta, resolvePathBinDir, serverName } from './resolve.js';
import { execClient } from './exec.js';
import { ensureServerRunning } from './server.js';
import { verifyResolvedBinary } from './download/megacmd.js';
import { detectAuth, ensureReady } from './auth.js';
import { publishMegacmdBinDir } from './paths.js';
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
   * executable, so a null binDir makes sessionStoreWarning blind to the only store
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
  ];
}

export function createRuntime(config: Config): Runtime {
  // Arm the synchronous path guard before any tool can run. Publishing again from
  // getBinDir() only adds the resolved dir on top of these.
  publishMegacmdBinDir(null, configTrustRoots(config));

  let resolvedPromise: Promise<Resolved | null> | undefined;
  let serverReady: Promise<boolean> | undefined;
  let integrityVerified: Promise<boolean> | undefined;
  let binDirPromise: Promise<string | null> | undefined;
  const getResolved = () => (resolvedPromise ??= resolveBinaries(config));
  const getBinDir: Runtime['getBinDir'] = () =>
    (binDirPromise ??= (async () => {
      const r = await getResolved();
      if (!r) return null;
      // Same fall-back as the integrity gate below: 'path' carries a null binDir
      // because its clients are invoked by bare name.
      const dir = r.binDir ?? (r.source === 'path' ? await resolvePathBinDir() : null);
      // Add the RESOLVED dir to what createRuntime already armed. This covers the
      // 'path' source, whose install dir is not in config at all.
      publishMegacmdBinDir(dir, configTrustRoots(config));
      return dir;
    })());

  const run: Runtime['run'] = async (cmd, args, opts) => {
    const resolved = await getResolved();
    if (!resolved) {
      return { code: -1, stdout: '', stderr: '', spawnError: 'NO_MEGACMD' };
    }
    // Integrity gate: verify the code signature of WHATEVER binary we
    // are about to launch — once per process, for EVERY source, not just the
    // ones we downloaded. A system/PATH/configured install lives where its
    // binary may be writable/swappable after the fact; between resolution and
    // exec it could be replaced, and we would otherwise run the swapped binary
    // against the user's live MEGA session. Identity-based, so it survives
    // MEGAcmd self-updates (signer stays "Mega Limited"; see verifyResolvedBinary).
    integrityVerified ??= (async () => {
      // 'path' has a null binDir (bare names invoked via PATH); resolve the real
      // install dir so codesign/Authenticode has a concrete target to check.
      const binDir = await getBinDir();
      const serverBin = binDir ? join(binDir, serverName()) : resolved.serverBin;
      // The CLIENT is the binary this process actually launches, every call. On
      // Windows it is a separate loose file from the server, so verifying only the
      // server checked something we never execute.
      const clientBin = resolved.clientInvocation('whoami', []).bin;
      const meta = resolved.source === 'cache' ? await readActiveCacheMeta(config) : null;
      return verifyResolvedBinary(
        { binDir, serverBin, clientBin: binDir ? join(binDir, basename(clientBin)) : clientBin, source: resolved.source },
        {
          teamId: config.download.teamId,
          serverSha256: meta?.serverSha256,
          winThumbprint: config.download.winThumbprint,
        },
      );
    })();
    if (!(await integrityVerified)) {
      integrityVerified = undefined; // never cache a transient failure
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
    return execClient(resolved, cmd, args, opts);
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
      integrityVerified = undefined;
    },
    getAuthState: () => detectAuth(run),
    ensureReady: () => ensureReady(run),
  };
}
