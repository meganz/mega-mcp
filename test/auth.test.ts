import { describe, it, expect } from 'vitest';
import { detectAuth, ensureReady } from '../src/auth.js';
import type { RunResult } from '../src/types.js';

const run = (r: Partial<RunResult>) => async () =>
  ({ code: 0, stdout: '', stderr: '', ...r }) as RunResult;

describe('detectAuth', () => {
  it('reports logged in + email on clean exit 0', async () => {
    const s = await detectAuth(run({ code: 0, stdout: 'Account e-mail: a@b.com' }));
    expect(s).toMatchObject({ loggedIn: true, reason: 'ok', email: 'a@b.com' });
  });

  it('reports not_logged_in on exit 57', async () => {
    const s = await detectAuth(run({ code: 57, stderr: '[err: 1] Not logged in.' }));
    expect(s).toMatchObject({ loggedIn: false, reason: 'not_logged_in' });
  });

  it('reports no_megacmd on a spawn error', async () => {
    const s = await detectAuth(run({ code: -1, spawnError: 'NO_MEGACMD' }));
    expect(s).toMatchObject({ loggedIn: false, reason: 'no_megacmd' });
  });

  it('NEVER reports a timed-out probe as logged in', async () => {
    const s = await detectAuth(run({ code: -1, timedOut: true }));
    expect(s.loggedIn).toBe(false);
    expect(s.reason).toBe('server_error');
  });
});

describe('ensureReady', () => {
  it('retries a transient server_error then succeeds', async () => {
    let n = 0;
    const flaky = async () => {
      n += 1;
      return n < 2
        ? ({ code: -1, stdout: '', stderr: '', timedOut: true } as RunResult)
        : ({ code: 0, stdout: 'Account e-mail: a@b.com', stderr: '' } as RunResult);
    };
    const s = await ensureReady(flaky, 3, 1);
    expect(s).toMatchObject({ loggedIn: true, email: 'a@b.com' });
    expect(n).toBe(2);
  });

  it('does not retry a missing binary', async () => {
    let n = 0;
    const missing = async () => {
      n += 1;
      return { code: -1, stdout: '', stderr: '', spawnError: 'NO_MEGACMD' } as RunResult;
    };
    const s = await ensureReady(missing, 3, 1);
    expect(s.reason).toBe('no_megacmd');
    expect(n).toBe(1);
  });
});
