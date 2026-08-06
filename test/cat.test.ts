import { describe, it, expect } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { looksBinary, registerCat } from '../src/tools/cat.js';
import { registerAll } from '../src/tools/index.js';
import { createConfirmStore } from '../src/confirm.js';
import type { Runtime } from '../src/runtime.js';
import type { Config, RunResult } from '../src/types.js';

const NUL = String.fromCharCode(0);
type ToolFn = (args: any) => Promise<CallToolResult>;

function fakeRt(run: Runtime['run'], config: Partial<Config> = {}): Runtime {
  return {
    config: { maxListLines: 1000, cacheDir: '/tmp/cache', download: { sha256Allow: [] }, exposeContacts: false, exposeAccountDetails: false, exposeFileContents: false, ...config },
    confirm: createConfirmStore(),
    run,
    getResolved: async () => null,
    getBinDir: async () => null,
    invalidateResolved: () => {},
    getAuthState: async () => ({ loggedIn: true, reason: 'ok' }),
    ensureReady: async () => ({ loggedIn: true, reason: 'ok' }),
  } as Runtime;
}

function catTool(run: Runtime['run']): ToolFn {
  const tools = new Map<string, ToolFn>();
  registerCat({ registerTool: (n: string, _d: unknown, cb: ToolFn) => tools.set(n, cb) } as any, fakeRt(run));
  return tools.get('mega_cat')!;
}

describe('looksBinary', () => {
  it('treats normal text as text', () => {
    expect(looksBinary('hello world\nthis is a text file\twith a tab')).toBe(false);
    expect(looksBinary('')).toBe(false);
  });
  it('flags a NUL byte as binary', () => {
    expect(looksBinary(`abc${NUL}def`)).toBe(true);
  });
  it('flags control-char-heavy output as binary', () => {
    const ctrl = Array.from({ length: 100 }, (_, i) => String.fromCharCode(i % 8 ? 1 : 65)).join('');
    expect(looksBinary(ctrl)).toBe(true);
  });
});

describe('mega_cat', () => {
  const okRun = (stdout: string): Runtime['run'] => async () => ({ code: 0, stdout, stderr: '' }) as RunResult;

  it('returns text contents', async () => {
    const res = await catTool(okRun('the secret contract is here'))({ remotePath: '/docs/a.txt' });
    expect(res.isError).toBeFalsy();
    expect((res.content?.[0] as any).text).toContain('the secret contract is here');
  });

  it('refuses a binary file', async () => {
    const res = await catTool(okRun(`PNG${NUL}\x01\x02garbage`))({ remotePath: '/img/a.png' });
    expect(res.isError).toBeFalsy();
    expect((res.content?.[0] as any).text).toMatch(/binary/i);
    expect(res.structuredContent).toMatchObject({ binary: true });
  });

  it('reports a clear error when the file exceeds the cap', async () => {
    const run: Runtime['run'] = async () => ({ code: -1, stdout: '', stderr: '', maxBufferExceeded: true }) as RunResult;
    const res = await catTool(run)({ remotePath: '/big.bin' });
    expect(res.isError).toBe(true);
    expect((res.content?.[0] as any).text).toMatch(/cap|too large/i);
  });

  it('passes the requested maxBytes as the exec maxBuffer (capped at 10 MB)', async () => {
    let seen: number | undefined;
    const run: Runtime['run'] = async (_c, _a, opts) => {
      seen = opts?.maxBuffer;
      return { code: 0, stdout: 'x', stderr: '' } as RunResult;
    };
    await catTool(run)({ remotePath: '/a', maxBytes: 99_000_000 }); // over hard max
    expect(seen).toBe(10_485_760);
  });

  it('rejects a non-absolute remotePath', async () => {
    const res = await catTool(okRun('x'))({ remotePath: 'relative' });
    expect(res.isError).toBe(true);
  });
});

describe('exposeFileContents gate', () => {
  const names = (exposeFileContents: boolean) => {
    const tools = new Map<string, ToolFn>();
    registerAll({ registerTool: (n: string, _d: unknown, cb: ToolFn) => tools.set(n, cb) } as any, fakeRt(async () => ({ code: 0, stdout: '', stderr: '' }) as RunResult, { exposeFileContents }));
    return tools;
  };
  it('does NOT register mega_cat by default', () => {
    expect(names(false).has('mega_cat')).toBe(false);
  });
  it('registers mega_cat only when the flag is on', () => {
    expect(names(true).has('mega_cat')).toBe(true);
  });
});
