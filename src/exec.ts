import { execFile } from 'node:child_process';
import type { Resolved, RunOpts, RunResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Environment for spawned mega-* clients. We pass through the user's HOME and
 * PATH so we operate on the out-of-band `mega-login` session (§A.6/§B.2), and
 * prepend the resolved bin dir to PATH so the client can locate its siblings /
 * auto-spawn the server. We NEVER inject credentials.
 */
export function childEnv(resolved: Resolved): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (resolved.binDir) {
    env.PATH = `${resolved.binDir}${process.platform === 'win32' ? ';' : ':'}${env.PATH ?? ''}`;
  }
  // Bundled shared libs (Linux /opt/megacmd/lib) referenced by absolute RUNPATH
  // won't exist at our cache prefix, so point the loader at the extracted libs.
  if (resolved.libDir) {
    env.LD_LIBRARY_PATH = `${resolved.libDir}:${env.LD_LIBRARY_PATH ?? ''}`;
  }
  return env;
}

/**
 * Single choke point for invoking a mega-<command> client (§B.4).
 *
 * Hard rules:
 *  - argv array, NEVER `shell: true` → no shell metacharacter injection.
 *  - control flow is driven by the numeric exit code, not stderr text.
 *  - a spawn failure (e.g. ENOENT) returns code -1 with `spawnError` set.
 */
export async function execClient(
  resolved: Resolved,
  cmd: string,
  args: string[],
  opts: RunOpts = {},
): Promise<RunResult> {
  // On win32 this yields MEGAclient.exe + [cmd, ...args] (the mega-<cmd>.bat
  // wrappers can't be execFile'd without shell since Node's CVE-2024-27980 fix);
  // on posix it is the mega-<cmd> client + args. Either way: argv array, no shell.
  const { bin, argv } = resolved.clientInvocation(cmd, args);
  return new Promise<RunResult>((resolvePromise) => {
    // execFile can throw SYNCHRONOUSLY (e.g. spawn EINVAL) before the callback
    // runs; catch it so it degrades to a clean spawnError result instead of an
    // uncaught throw surfacing as "Internal error".
    try {
      execFile(
        bin,
        argv,
        {
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        windowsHide: true,
        env: childEnv(resolved),
        // NO shell: true
      },
      (error, stdout, stderr) => {
        const out = stdout?.toString() ?? '';
        const errOut = stderr?.toString() ?? '';

        // Clean exit (code 0) is the ONLY success. Every error branch below
        // resolves to a non-zero/sentinel code so a failure can never be read
        // as success (§ review: timeout-as-success was a critical bug).
        if (!error) {
          resolvePromise({ code: 0, stdout: out, stderr: errOut });
          return;
        }

        const e = error as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: NodeJS.Signals | null;
        };

        // Output exceeded maxBuffer (code is a string; child was killed). Check
        // before the killed/signal branch so it isn't mistaken for a timeout.
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolvePromise({ code: -1, stdout: out, stderr: errOut, maxBufferExceeded: true });
          return;
        }

        // Killed by our timeout or an external signal (code is null here).
        if (e.killed || e.signal) {
          resolvePromise({
            code: -1,
            stdout: out,
            stderr: errOut,
            timedOut: true,
            killedSignal: e.signal ?? undefined,
          });
          return;
        }

        // Spawn-level failure (ENOENT, EACCES, ...): code is an errno string.
        if (typeof e.code === 'string') {
          resolvePromise({ code: -1, stdout: out, stderr: errOut, spawnError: e.code });
          return;
        }

        // Genuine MEGAcmd exit code.
        if (typeof e.code === 'number') {
          resolvePromise({ code: e.code, stdout: out, stderr: errOut });
          return;
        }

        // Truthy error with no usable code: fail closed, never code 0.
        resolvePromise({ code: -1, stdout: out, stderr: errOut, spawnError: 'UNKNOWN' });
      },
      );
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      resolvePromise({ code: -1, stdout: '', stderr: '', spawnError: err.code ?? 'SPAWN_THROW' });
    }
  });
}
