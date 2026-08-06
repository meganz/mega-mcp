import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { cacheBinDir } from '../src/resolve.js';
import { verifyResolvedBinary } from '../src/download/megacmd.js';
import { assertFlagValue, ValidationError } from '../src/paths.js';
import { registerReadOnly } from '../src/tools/readonly.js';
import { registerDangerous } from '../src/tools/dangerous.js';
import { registerSync } from '../src/tools/sync.js';
import { createConfirmStore } from '../src/confirm.js';

const NUL = String.fromCharCode(0);

function fakeRt(seen: string[][] = []): any {
  return {
    config: { maxListLines: 1000, cacheDir: '/tmp/c', download: { sha256Allow: [] } },
    confirm: createConfirmStore(),
    run: async (cmd: string, args: string[]) => (seen.push([cmd, ...args]), { code: 0, stdout: '', stderr: '' }),
    getResolved: async () => null,
    getBinDir: async () => null,
    ensureReady: async () => ({ loggedIn: true, reason: 'ok' }),
  };
}
function cap(reg: any, rt: any): Map<string, (a: any) => Promise<CallToolResult>> {
  const t = new Map();
  reg({ registerTool: (n: string, _d: unknown, cb: any) => t.set(n, cb) } as any, rt);
  return t;
}

/**
 * meta.json lives in a user-writable cache, so its fields are untrusted. Left
 * unchecked, `binSubdir: "../../evil"` relocated the binary we are about to launch
 * outside the cache, where the launch-time signature check found no .app to verify
 * and allowed it — defeating the very tamper window that check exists to close.
 */
describe('cache metadata cannot relocate the binary we launch', () => {
  function makeCache(meta: unknown): { cacheDir: string; cleanup: () => void } {
    const base = mkdtempSync(join(tmpdir(), 'mega-cache-'));
    const cacheDir = join(base, 'cache');
    mkdirSync(join(cacheDir, 'v1'), { recursive: true });
    mkdirSync(join(base, 'evil'), { recursive: true });
    writeFileSync(join(cacheDir, 'current.txt'), 'v1');
    writeFileSync(join(cacheDir, 'v1', 'meta.json'), JSON.stringify(meta));
    return { cacheDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
  }

  it('refuses a binSubdir that escapes the version dir', async () => {
    const { cacheDir, cleanup } = makeCache({ binSubdir: '../../evil' });
    try {
      expect(await cacheBinDir({ cacheDir } as any)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('refuses an escaping libSubdir even when binSubdir is fine', async () => {
    const { cacheDir, cleanup } = makeCache({ binSubdir: 'bin', libSubdir: '../../evil' });
    try {
      expect(await cacheBinDir({ cacheDir } as any)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('still accepts an ordinary nested layout', async () => {
    const { cacheDir, cleanup } = makeCache({ binSubdir: 'MEGAcmd.app/Contents/MacOS' });
    try {
      const got = await cacheBinDir({ cacheDir } as any);
      expect(got?.binDir).toBe(join(cacheDir, 'v1', 'MEGAcmd.app', 'Contents', 'MacOS'));
    } finally {
      cleanup();
    }
  });
});

describe('verifyResolvedBinary fails closed for a tampered cache layout', () => {
  const nonApp = { binDir: '/tmp/evil/bin', serverBin: '/tmp/evil/bin/mega-cmd' };

  it.runIf(process.platform === 'darwin')('refuses a cache install that is no longer an .app', async () => {
    // We installed the cache copy AS an .app, so any other layout means it moved.
    expect(await verifyResolvedBinary({ ...nonApp, source: 'cache' })).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('still allows layouts we did not create (bundled / PATH)', async () => {
    expect(await verifyResolvedBinary({ ...nonApp, source: 'bundled' })).toBe(true);
    expect(await verifyResolvedBinary({ ...nonApp, source: 'path' })).toBe(true);
  });
});

describe('assertFlagValue', () => {
  it('rejects NUL and empty but allows a leading "-"', () => {
    expect(() => assertFlagValue(`x${NUL}y`, 'pattern')).toThrow(/NUL/);
    expect(() => assertFlagValue('   ', 'pattern')).toThrow(ValidationError);
    expect(assertFlagValue('-*.tmp', 'pattern')).toBe('-*.tmp');
    expect(assertFlagValue('  1d  ', 'expire')).toBe('1d');
  });
});

describe('free-text argv values are validated at the tool boundary', () => {
  it('mega_find rejects a NUL in pattern instead of passing it to argv', async () => {
    const seen: string[][] = [];
    const res = await cap(registerReadOnly, fakeRt(seen)).get('mega_find')!({ pattern: `x${NUL}y` });
    expect(res.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it('mega_find still accepts an ordinary glob', async () => {
    const seen: string[][] = [];
    const res = await cap(registerReadOnly, fakeRt(seen)).get('mega_find')!({ pattern: '*.jpg' });
    expect(res.isError).toBeFalsy();
    expect(seen[0]).toContain('--pattern=*.jpg');
  });

  it('mega_export uses the normalized expire, not the raw input', async () => {
    const seen: string[][] = [];
    const tools = cap(registerDangerous, fakeRt(seen));
    const args = { remotePath: '/f', action: 'create', expire: '  1d  ' };
    const token = (await tools.get('mega_export')!(args)).structuredContent as any;
    await tools.get('mega_export')!({ ...args, confirm: token.confirmToken });
    expect(seen.flat()).toContain('--expire=1d');
  });

  it('mega_backup_add uses the normalized period and rejects a NUL one', async () => {
    const seen: string[][] = [];
    const tools = cap(registerSync, fakeRt(seen));
    const args = { localPath: '/tmp/src', remotePath: '/dst', period: '  0 0 * * *  ', numBackups: 3 };
    const token = (await tools.get('mega_backup_add')!(args)).structuredContent as any;
    await tools.get('mega_backup_add')!({ ...args, confirm: token.confirmToken });
    expect(seen.flat()).toContain('--period=0 0 * * *');

    const bad = await tools.get('mega_backup_add')!({ ...args, period: `x${NUL}y` });
    expect(bad.isError).toBe(true);
  });
});
