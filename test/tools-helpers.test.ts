import { describe, it, expect, vi } from 'vitest';
import { checkConfirm, runToResult } from '../src/tools/helpers.js';
import { createConfirmStore } from '../src/confirm.js';
import type { Runtime } from '../src/runtime.js';
import type { RunResult } from '../src/types.js';

function fakeRt(overrides: Partial<Runtime> = {}): Runtime {
  return {
    config: { maxListLines: 1000, cacheDir: '/tmp/cache', download: { sha256Allow: [] } },
    confirm: createConfirmStore(),
    run: async () => ({ code: 0, stdout: '', stderr: '' }) as RunResult,
    getResolved: async () => null,
    invalidateResolved: () => {},
    getAuthState: async () => ({ loggedIn: true, reason: 'ok' }),
    ensureReady: async () => ({ loggedIn: true, reason: 'ok' }),
    ...overrides,
  } as Runtime;
}

describe('checkConfirm gate', () => {
  it('first call returns a confirmation prompt with a token and does not proceed', () => {
    const rt = fakeRt();
    const res = checkConfirm(rt, 'mega_rm', { remotePath: '/a' }, undefined, 'will delete /a');
    expect(res).not.toBeNull();
    expect(res!.isError).toBeFalsy();
    expect(res!.structuredContent).toMatchObject({ requiresConfirmation: true });
    expect(typeof (res!.structuredContent as any).confirmToken).toBe('string');
  });

  it('second call with the right token proceeds (returns null)', () => {
    const rt = fakeRt();
    const first = checkConfirm(rt, 'mega_rm', { remotePath: '/a' }, undefined, 's');
    const token = (first!.structuredContent as any).confirmToken as string;
    const second = checkConfirm(rt, 'mega_rm', { remotePath: '/a' }, token, 's');
    expect(second).toBeNull();
  });

  it('rejects a token issued for different args', () => {
    const rt = fakeRt();
    const first = checkConfirm(rt, 'mega_rm', { remotePath: '/a' }, undefined, 's');
    const token = (first!.structuredContent as any).confirmToken as string;
    const res = checkConfirm(rt, 'mega_rm', { remotePath: '/OTHER' }, token, 's');
    expect(res!.isError).toBe(true);
  });
});

describe('runToResult exit-code mapping', () => {
  it('maps success through onSuccess', async () => {
    const rt = fakeRt({ run: async () => ({ code: 0, stdout: 'hi', stderr: '' }) });
    const res = await runToResult(rt, 'whoami', [], (r) => ({ content: [{ type: 'text', text: r.stdout }] }));
    expect(res.isError).toBeFalsy();
    expect(res.content[0]).toMatchObject({ text: 'hi' });
  });

  it('maps exit 57 to the login-required error', async () => {
    const rt = fakeRt({ run: async () => ({ code: 57, stdout: '', stderr: '[err:1] Not logged in.' }) });
    const onSuccess = vi.fn();
    const res = await runToResult(rt, 'ls', [], onSuccess as any);
    expect(res.isError).toBe(true);
    expect(res.content[0]).toMatchObject({ text: expect.stringMatching(/interactive shell/) });
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
