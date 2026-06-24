import { describe, it, expect } from 'vitest';
import { execClient } from '../src/exec.js';
import type { Resolved } from '../src/types.js';

// A Resolved whose invocation always points at a fixed real binary, so we can
// drive execClient with `true`, `sh`, `sleep`, etc. (args passed through).
function resolvedFor(bin: string): Resolved {
  return { source: 'path', binDir: null, clientInvocation: (_cmd, args) => ({ bin, argv: args }), serverBin: '' };
}

describe('execClient outcome classification', () => {
  it('reports a clean exit as code 0 (success)', async () => {
    const r = await execClient(resolvedFor('true'), 'whoami', []);
    expect(r.code).toBe(0);
    expect(r.timedOut).toBeFalsy();
    expect(r.spawnError).toBeUndefined();
  });

  it('passes a genuine non-zero exit code through unchanged', async () => {
    const r = await execClient(resolvedFor('sh'), 'whoami', ['-c', 'exit 57']);
    expect(r.code).toBe(57);
    expect(r.timedOut).toBeFalsy();
    expect(r.spawnError).toBeUndefined();
  });

  it('does NOT report a timed-out/killed process as success', async () => {
    const r = await execClient(resolvedFor('sleep'), 'whoami', ['5'], { timeoutMs: 150 });
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
});
