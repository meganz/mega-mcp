import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Resolved, RunOpts, RunResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
/**
 * How long to keep reading stdio after the child has ALREADY exited.
 *
 * We cannot wait for stdio EOF, which is what execFile did and why the first call
 * after a cold start took the full timeout: a mega-* client auto-spawns
 * MEGAcmdServer as a DETACHED grandchild that INHERITS the client's stdout/stderr,
 * so the pipes stay open long after the client itself has exited 0 with its
 * complete answer already written. Measured with a synthetic child+grandchild:
 * execFile settled after 6027 ms on a 6 s timeout (err null, stdout complete),
 * while resolving on 'exit' settled after 274 ms with identical output.
 *
 * So 'exit' is the completion signal and this is only a drain window for bytes
 * still in flight. It costs nothing in the normal case: 'close' fires right after
 * 'exit' when no grandchild holds the pipes, and that settles immediately.
 */
const STDIO_DRAIN_GRACE_MS = 250;
/** Grace before escalating a timeout kill to SIGKILL (no-op on win32). */
const KILL_ESCALATE_MS = 2_000;

/**
 * Environment for spawned mega-* clients. We pass through the user's HOME and
 * PATH so we operate on the out-of-band `mega-login` session, and
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
 * Single choke point for invoking a mega-<command> client.
 *
 * Hard rules:
 *  - argv array, NEVER `shell: true` → no shell metacharacter injection.
 *  - control flow is driven by the numeric exit code, not stderr text.
 *  - a spawn failure (e.g. ENOENT) returns code -1 with `spawnError` set.
 *  - completion is the child's OWN exit, never stdio EOF (see STDIO_DRAIN_GRACE_MS).
 *
 * Clean exit (code 0) is the ONLY success. Every other branch yields a non-zero or
 * sentinel code, so a timeout can never be mistaken for a clean exit.
 */
export async function execClient(
  resolved: Resolved,
  cmd: string,
  args: string[],
  opts: RunOpts = {},
): Promise<RunResult> {
  // On win32 this yields MEGAclient.exe + [cmd, ...args] (the mega-<cmd>.bat
  // wrappers can't be spawned without a shell since Node's CVE-2024-27980 fix);
  // on posix it is the mega-<cmd> client + args. Either way: argv array, no shell.
  const { bin, argv } = resolved.clientInvocation(cmd, args);
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;

  return new Promise<RunResult>((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, argv, {
        windowsHide: true,
        env: childEnv(resolved),
        stdio: ['ignore', 'pipe', 'pipe'],
        // NO shell: true
      });
    } catch (e) {
      // spawn can throw SYNCHRONOUSLY (e.g. EINVAL); degrade to a clean result
      // rather than letting an uncaught throw surface as "Internal error".
      const err = e as NodeJS.ErrnoException;
      resolvePromise({ code: -1, stdout: '', stderr: '', spawnError: err.code ?? 'SPAWN_THROW' });
      return;
    }

    let out = '';
    let errOut = '';
    let bytes = 0;
    let overflowed = false;
    // Decode ACROSS chunk boundaries. A pipe splits wherever the OS decides, so
    // buf.toString() per chunk mangles any multi-byte character that straddles the
    // split into U+FFFD — which for this connector means a non-ASCII filename in a
    // listing, silently corrupted. (execFile did this for us; spawn does not.)
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    let timedOut = false;
    let settled = false;
    let drainTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const settle = (r: RunResult): void => {
      if (settled) return;
      settled = true;
      // Flush any trailing partial multi-byte sequence held by the decoders.
      r.stdout += outDec.end();
      r.stderr += errDec.end();
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      if (killTimer) clearTimeout(killTimer);
      // Release our read ends. A detached grandchild may still hold the write
      // ends; without this our own process could not exit while it lives.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolvePromise(r);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // SIGTERM is advisory on posix; make sure a wedged child cannot pin us.
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_ESCALATE_MS);
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const collect = (buf: Buffer, isErr: boolean): void => {
      bytes += buf.length;
      if (bytes > maxBuffer) {
        // Bound the response before it can flood the model context, and stop the
        // producer rather than keep buffering what we will discard.
        overflowed = true;
        child.kill();
        return;
      }
      if (isErr) errOut += errDec.write(buf);
      else out += outDec.write(buf);
    };
    child.stdout?.on('data', (b: Buffer) => collect(b, false));
    child.stderr?.on('data', (b: Buffer) => collect(b, true));
    // A pipe torn down under us must not raise an unhandled 'error'.
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});

    // Asynchronous spawn failure (ENOENT, EACCES, …). No exit follows.
    child.on('error', (e: NodeJS.ErrnoException) => {
      settle({ code: -1, stdout: out, stderr: errOut, spawnError: e.code ?? 'UNKNOWN' });
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      // Order matters: an overflow and a timeout both kill the child, so neither
      // may be read as the ordinary "killed by a signal" case.
      if (overflowed) return settle({ code: -1, stdout: out, stderr: errOut, maxBufferExceeded: true });
      if (timedOut || signal) {
        return settle({ code: -1, stdout: out, stderr: errOut, timedOut: true, killedSignal: signal ?? undefined });
      }
      // No code and no signal should be unreachable; fail closed, never code 0.
      if (code === null) return settle({ code: -1, stdout: out, stderr: errOut, spawnError: 'UNKNOWN' });
      settle({ code, stdout: out, stderr: errOut });
    };

    // 'close' means stdio is fully drained — the accurate signal, and the one that
    // normally fires microseconds after 'exit'. But it never fires while a detached
    // grandchild holds the pipes, so 'exit' + a bounded drain window is the backstop.
    child.on('close', finish);
    child.on('exit', (code, signal) => {
      drainTimer = setTimeout(() => finish(code, signal), STDIO_DRAIN_GRACE_MS);
    });
  });
}
