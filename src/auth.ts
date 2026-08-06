import type { AuthState, RunOpts, RunResult } from './types.js';
import { ExitCode, classifyExit } from './errors.js';
import { parseWhoami } from './parsers/whoami.js';

type RunFn = (cmd: string, args: string[], opts?: RunOpts) => Promise<RunResult>;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Budget for the auth probe. ensureReady() runs up to three of these back to back,
 * so the default command timeout would let a single wedged probe outlast the whole
 * request deadline an MCP client allows. `whoami` is a millisecond call either way.
 */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * One-shot auth probe via `mega-whoami`. The probe runs plain `whoami`
 * (never `-l`), so no session material is ever requested on this path. (The
 * extended `-l` form is used only by mega_account, behind an allowlist parser.)
 * Doubles as a server liveness probe because any mega-* call auto-spawns the
 * server.
 */
export async function detectAuth(run: RunFn): Promise<AuthState> {
  const r = await run('whoami', [], { timeoutMs: PROBE_TIMEOUT_MS });

  if (r.spawnError) {
    return { loggedIn: false, reason: 'no_megacmd', detail: classifyExit(r) };
  }
  if (r.code === ExitCode.OK) {
    const email = parseWhoami(r.stdout);
    return { loggedIn: true, reason: 'ok', email };
  }
  if (r.code === ExitCode.NOTLOGGEDIN) {
    return { loggedIn: false, reason: 'not_logged_in' };
  }
  return { loggedIn: false, reason: 'server_error', detail: classifyExit(r) };
}

/**
 * Auth probe with warm-up retry. A freshly auto-spawned server
 * can transiently report NOTLOGGEDIN / server errors while it restores its
 * session cache. We retry those with backoff before concluding the user is
 * actually logged out. We do NOT retry `no_megacmd` (binary missing won't fix
 * itself) or a successful login.
 */
export async function ensureReady(run: RunFn, tries = 3, baseDelayMs = 500): Promise<AuthState> {
  let last: AuthState = { loggedIn: false, reason: 'server_error' };
  for (let i = 0; i < tries; i++) {
    last = await detectAuth(run);
    if (last.loggedIn || last.reason === 'no_megacmd') return last;
    if (i < tries - 1) await delay(baseDelayMs * (i + 1)); // e.g. 500ms, 1000ms
  }
  return last;
}
