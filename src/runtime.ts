import type { AuthState, Config, Resolved, RunOpts, RunResult } from './types.js';
import { join } from 'node:path';
import { resolveBinaries, readActiveCacheMeta, resolvePathBinDir, serverName } from './resolve.js';
import { execClient } from './exec.js';
import { ensureServerRunning } from './server.js';
import { verifyResolvedBinary } from './download/megacmd.js';
import { detectAuth, ensureReady } from './auth.js';
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
  /** Drop cached resolution + server state (call after a successful download). */
  invalidateResolved(): void;
  /** Single auth probe (no retry). */
  getAuthState(): Promise<AuthState>;
  /** Auth probe with warm-up retry, for the first call after cold start. */
  ensureReady(): Promise<AuthState>;
}

export function createRuntime(config: Config): Runtime {
  let resolvedPromise: Promise<Resolved | null> | undefined;
  let serverReady: Promise<boolean> | undefined;
  let integrityVerified: Promise<boolean> | undefined;
  const getResolved = () => (resolvedPromise ??= resolveBinaries(config));

  const run: Runtime['run'] = async (cmd, args, opts) => {
    const resolved = await getResolved();
    if (!resolved) {
      return { code: -1, stdout: '', stderr: '', spawnError: 'NO_MEGACMD' };
    }
    // Integrity gate (§review): verify the code signature of WHATEVER binary we
    // are about to launch — once per process, for EVERY source, not just the
    // ones we downloaded. A system/PATH/configured install lives where its
    // binary may be writable/swappable after the fact; between resolution and
    // exec it could be replaced, and we would otherwise run the swapped binary
    // against the user's live MEGA session. Identity-based, so it survives
    // MEGAcmd self-updates (signer stays "Mega Limited"; see verifyResolvedBinary).
    integrityVerified ??= (async () => {
      // 'path' has a null binDir (bare names invoked via PATH); resolve the real
      // install dir so codesign/Authenticode has a concrete target to check.
      const binDir = resolved.binDir ?? (resolved.source === 'path' ? await resolvePathBinDir() : null);
      const serverBin = binDir ? join(binDir, serverName()) : resolved.serverBin;
      const meta = resolved.source === 'cache' ? await readActiveCacheMeta(config) : null;
      return verifyResolvedBinary(
        { binDir, serverBin },
        { teamId: config.download.teamId, serverSha256: meta?.serverSha256 },
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

  return {
    config,
    confirm: createConfirmStore(),
    run,
    getResolved,
    invalidateResolved: () => {
      resolvedPromise = undefined;
      serverReady = undefined;
      integrityVerified = undefined;
    },
    getAuthState: () => detectAuth(run),
    ensureReady: () => ensureReady(run),
  };
}
