import type { AuthState, Config, Resolved, RunOpts, RunResult } from './types.js';
import { resolveBinaries, readActiveCacheMeta } from './resolve.js';
import { execClient } from './exec.js';
import { ensureServerRunning } from './server.js';
import { verifyCachedBinary } from './download/megacmd.js';
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
  let cacheVerified: Promise<boolean> | undefined;
  const getResolved = () => (resolvedPromise ??= resolveBinaries(config));

  const run: Runtime['run'] = async (cmd, args, opts) => {
    const resolved = await getResolved();
    if (!resolved) {
      return { code: -1, stdout: '', stderr: '', spawnError: 'NO_MEGACMD' };
    }
    // 'path' (on PATH) relies on the client's native auto-spawn. For every other
    // source we ensure a server ourselves: required for non-standard locations
    // (cache/bundled/configured), and a harmless belt-and-suspenders for 'system'
    // (the probe just succeeds via native auto-spawn if it already works).
    const managed = resolved.source === 'cache' || resolved.source === 'bundled';
    if (resolved.source !== 'path') {
      // Re-verify binaries WE downloaded (cache/bundled) once per process before
      // launching — closes the between-launches tamper window on the user cache
      // (macOS code signature, Windows Authenticode, Linux SHA-256).
      if (managed && resolved.binDir) {
        cacheVerified ??= (async () => {
          const meta = resolved.source === 'cache' ? await readActiveCacheMeta(config) : null;
          return verifyCachedBinary(resolved, {
            teamId: config.download.teamId,
            serverSha256: meta?.serverSha256,
          });
        })();
        if (!(await cacheVerified)) {
          cacheVerified = undefined;
          return { code: -1, stdout: '', stderr: '', spawnError: 'INTEGRITY_FAILED' };
        }
      }
      // Only memoize a SUCCESSFUL launch, so a transient cold-start timeout is
      // retried on the next call rather than cached for the process lifetime.
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
      cacheVerified = undefined;
    },
    getAuthState: () => detectAuth(run),
    ensureReady: () => ensureReady(run),
  };
}
