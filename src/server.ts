import { spawn } from 'node:child_process';
import type { Resolved, RunResult } from './types.js';
import { execClient, childEnv } from './exec.js';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Does this whoami probe indicate the server is up and responding? Exit 0 or
 * any known MEGAcmd exit code (51..71, e.g. 57 NOTLOGGEDIN) means the client
 * reached the server. A spawn error (binary missing), a timeout, or a connect
 * failure (the client prints "Unable to connect to service" and exits with a
 * non-MEGAcmd code) means it did not.
 */
function serverResponded(r: RunResult): boolean {
  if (r.spawnError || r.timedOut) return false;
  return r.code === 0 || (r.code >= 51 && r.code <= 71);
}

/**
 * Ensure a MEGAcmd server is running for the resolved binaries.
 *
 * The macOS client's auto-spawn does NOT reliably launch a server living in a
 * non-standard location (e.g. our runtime cache) — it looks for the app at a
 * hardcoded path. So for bundled/configured/cache sources we launch the server
 * ourselves, by absolute path, from the resolved bin dir. For a system PATH
 * install we leave the client's normal auto-spawn alone.
 *
 * Returns true once a server responds, false if the binary is missing or the
 * server never came up within the retry budget. Never throws.
 */
export async function ensureServerRunning(resolved: Resolved, tries = 6, baseDelayMs = 500): Promise<boolean> {
  let probe = await execClient(resolved, 'whoami', []);
  if (serverResponded(probe)) return true;
  if (probe.spawnError) return false; // binary missing — nothing to launch

  try {
    const child = spawn(resolved.serverBin, [], {
      detached: true,
      stdio: 'ignore',
      env: childEnv(resolved),
      windowsHide: true,
    });
    child.unref();
  } catch {
    return false;
  }

  for (let i = 0; i < tries; i++) {
    await delay(baseDelayMs * Math.min(i + 1, 4)); // 0.5s,1s,1.5s,2s,2s,2s
    probe = await execClient(resolved, 'whoami', []);
    if (serverResponded(probe)) return true;
  }
  return false;
}
