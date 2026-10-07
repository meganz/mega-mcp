import type { AuthState, Config, Resolved, RunOpts, RunResult } from './types.js';
import { basename, join } from 'node:path';
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
  ];
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
  publishMegacmdBinDir(null, configTrustRoots(config));

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
      publishMegacmdBinDir(dir, configTrustRoots(config));
      return dir;
    })());

  const run: Runtime['run'] = async (cmd, args, opts) => {
    // Every call, whatever tool built it: see invocation.ts.
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
