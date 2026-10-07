import { describe, it, expect, vi } from 'vitest';
import { checkConfirm, runToResult, runBulk } from '../src/tools/helpers.js';
import { createConfirmStore } from '../src/confirm.js';
import type { Runtime } from '../src/runtime.js';
import type { RunResult } from '../src/types.js';

function fakeRt(overrides: Partial<Runtime> = {}): Runtime {
  return {
    config: { maxListLines: 1000, cacheDir: '/tmp/cache', download: { sha256Allow: [] } },
    confirm: createConfirmStore(),
    run: async () => ({ code: 0, stdout: '', stderr: '' }) as RunResult,
    getResolved: async () => null,
    getBinDir: async () => null,
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

describe('runBulk (multi-source in one call)', () => {
  it('moves the whole list in a SINGLE call: `mv src1 src2 src3 dst`', async () => {
    const calls: string[][] = [];
    const rt = fakeRt({ run: async (_c, argv) => (calls.push(argv), { code: 0, stdout: '', stderr: '' }) });
    const { done, failed } = await runBulk(rt, 'mv', ['a', 'b', 'c'], ['/dst']);
    expect(done).toBe(3);
    expect(failed).toBe(0);
    expect(calls).toEqual([['a', 'b', 'c', '/dst']]); // one call, sources then trailing
  });

  it('chunks large lists to bound argv length', async () => {
    const calls: string[][] = [];
    const rt = fakeRt({ run: async (_c, argv) => (calls.push(argv), { code: 0, stdout: '', stderr: '' }) });
    const srcs = ['a', 'b', 'c', 'd', 'e'];
    const { done } = await runBulk(rt, 'mv', srcs, ['/dst'], 2);
    expect(done).toBe(5);
    expect(calls.length).toBe(3); // 2 + 2 + 1
  });

  // A multi-source mv fails as a whole when the destination is not a folder, and a
  // one-source mv to it is a RENAME: retrying item by item renamed the first node to
  // the destination name and then replaced it with each next one, deleting data.
  it('does NOT retry a failed chunk item by item', async () => {
    const calls: string[][] = [];
    const rt = fakeRt({
      run: async (_c, argv) => {
        calls.push(argv);
        return { code: 1, stdout: '', stderr: 'bulk failed' };
      },
    });
    const { done, failed } = await runBulk(rt, 'mv', ['a', 'b', 'c'], ['/not-a-folder']);
    expect(done).toBe(0);
    expect(failed).toBe(3);
    expect(calls).toEqual([['a', 'b', 'c', '/not-a-folder']]);
  });
});
