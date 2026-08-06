import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execClient } from '../src/exec.js';
import type { Resolved } from '../src/types.js';

// A Resolved whose invocation always points at a fixed real binary, so we can
// drive execClient with a real child process (args passed through).
function resolvedFor(bin: string): Resolved {
  return { source: 'path', binDir: null, clientInvocation: (_cmd, args) => ({ bin, argv: args }), serverBin: '' };
}

// Drive the child with the Node binary already running this suite instead of the
// POSIX coreutils `true` / `sh` / `sleep`, none of which exist on Windows — the
// old fixtures failed there with ENOENT and so asserted nothing about execClient.
const NODE = process.execPath;
const node = (script: string) => ({ resolved: resolvedFor(NODE), argv: ['-e', script] });

describe('execClient outcome classification', () => {
  it('reports a clean exit as code 0 (success)', async () => {
    const { resolved, argv } = node('');
    const r = await execClient(resolved, 'whoami', argv);
    expect(r.code).toBe(0);
    expect(r.timedOut).toBeFalsy();
    expect(r.spawnError).toBeUndefined();
  });

  it('passes a genuine non-zero exit code through unchanged', async () => {
    const { resolved, argv } = node('process.exit(57)');
    const r = await execClient(resolved, 'whoami', argv);
    expect(r.code).toBe(57);
    expect(r.timedOut).toBeFalsy();
    expect(r.spawnError).toBeUndefined();
  });

  it('does NOT report a timed-out/killed process as success', async () => {
    const { resolved, argv } = node('setTimeout(() => {}, 60000)');
    const r = await execClient(resolved, 'whoami', argv, { timeoutMs: 250 });
    expect(r.code).not.toBe(0);
    expect(r.code).toBe(-1);
    expect(r.timedOut).toBe(true);
  });

  it('reports a missing binary as a spawn error (not success)', async () => {
    const r = await execClient(resolvedFor('no-such-binary-xyz-123'), 'whoami', []);
    expect(r.code).toBe(-1);
    expect(r.spawnError).toBeTruthy();
    expect(r.timedOut).toBeFalsy();
  });

  it('caps output at maxBuffer instead of buffering without bound', async () => {
    const { resolved, argv } = node('process.stdout.write("x".repeat(200000))');
    const r = await execClient(resolved, 'whoami', argv, { maxBuffer: 1024 });
    expect(r.maxBufferExceeded).toBe(true);
    expect(r.code).toBe(-1);
  });
});

/**
 * The cold-start regression. A mega-* client auto-spawns MEGAcmdServer as a
 * DETACHED grandchild that inherits the client's stdout/stderr, so those pipes
 * stay open long after the client has exited 0 with its complete answer written.
 * execFile completes on stdio EOF, so the first call after a cold start blocked
 * for the full 120s command timeout — past the 60s an MCP client allows a request,
 * turning a slow start into a visible failure. Completion must key off the child's
 * own exit instead.
 */
describe('execClient does not wait on a detached grandchild', () => {
  it('completes as soon as the child exits, with its output intact', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mega-exec-'));
    try {
      const grandchild = join(base, 'grandchild.mjs');
      const child = join(base, 'child.mjs');
      writeFileSync(grandchild, 'setTimeout(() => {}, 60000);\n');
      writeFileSync(
        child,
        `import { spawn } from 'node:child_process';\n` +
          `process.stdout.write('Account e-mail: someone@example.com\\n');\n` +
          // stdio:'inherit' is what makes the grandchild hold OUR pipes.
          `spawn(process.execPath, [${JSON.stringify(grandchild)}], { detached: true, stdio: 'inherit' }).unref();\n` +
          `process.exit(0);\n`,
      );

      const started = Date.now();
      // A timeout far below the grandchild's lifetime: if completion still keyed
      // off stdio EOF this would burn the whole budget and report timedOut.
      const r = await execClient(resolvedFor(NODE), 'whoami', [child], { timeoutMs: 20_000 });
      const elapsed = Date.now() - started;

      expect(r.code).toBe(0);
      expect(r.timedOut).toBeFalsy();
      expect(r.stdout).toContain('someone@example.com');
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
