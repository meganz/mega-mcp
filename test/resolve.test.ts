import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBinaries, cacheBinDir, clientName, buildClientInvocation, resolvePathBinDir } from '../src/resolve.js';
import type { Config } from '../src/types.js';

let root: string;

function cfg(over: Partial<Config> = {}): Config {
  return {
    bundledDir: join(root, 'no-bundle'),
    cacheDir: join(root, 'cache'),
    systemAppBinDirs: [join(root, 'no-system')],
    download: { sha256Allow: [] },
    maxListLines: 1000,
    exposeContacts: false,
    exposeAccountDetails: false,
    exposeFileContents: false,
    ...over,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mega-resolve-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('cacheBinDir', () => {
  it('returns null when nothing is cached', async () => {
    expect(await cacheBinDir(cfg())).toBeNull();
  });

  it('reads binSubdir (and optional libSubdir) from current/meta.json', async () => {
    const versionDir = join(root, 'cache', '2.5.2');
    const binDir = join(versionDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(versionDir, 'meta.json'), JSON.stringify({ version: '2.5.2', binSubdir: 'bin', libSubdir: 'lib' }));
    symlinkSync(versionDir, join(root, 'cache', 'current'), 'dir');
    const got = await cacheBinDir(cfg());
    expect(got?.binDir).toBe(join(root, 'cache', 'current', 'bin'));
    expect(got?.libDir).toBe(join(root, 'cache', 'current', 'lib'));
  });

  it('falls back to a current.txt pointer when there is no symlink (Windows)', async () => {
    const versionDir = join(root, 'cache', '2.5.2');
    mkdirSync(join(versionDir, 'bin'), { recursive: true });
    writeFileSync(join(versionDir, 'meta.json'), JSON.stringify({ binSubdir: 'bin' }));
    writeFileSync(join(root, 'cache', 'current.txt'), '2.5.2');
    const got = await cacheBinDir(cfg());
    expect(got?.binDir).toBe(join(root, 'cache', '2.5.2', 'bin'));
  });
});

describe('resolveBinaries cache source', () => {
  it('resolves to the cache when an executable client is present there', async () => {
    const versionDir = join(root, 'cache', '2.5.2');
    const binDir = join(versionDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(versionDir, 'meta.json'), JSON.stringify({ binSubdir: 'bin' }));
    writeFileSync(join(binDir, clientName('whoami')), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    symlinkSync(versionDir, join(root, 'cache', 'current'), 'dir');

    const resolved = await resolveBinaries(cfg());
    expect(resolved?.source).toBe('cache');
    // posix CI: invocation is the mega-<cmd> client in the cache bin dir, args as-is.
    expect(resolved?.clientInvocation('whoami', []).bin).toBe(join(root, 'cache', 'current', 'bin', clientName('whoami')));
  });
});

describe('resolvePathBinDir', () => {
  // Posix only: exercises `which` + realpath. On Windows the probe is `where`
  // and the client is a .bat; skip rather than special-case the harness.
  it.skipIf(process.platform === 'win32')('follows a PATH symlink to the real install dir', async () => {
    const realDir = join(root, 'binreal');
    const linkDir = join(root, 'binlink');
    mkdirSync(realDir, { recursive: true });
    mkdirSync(linkDir, { recursive: true });
    writeFileSync(join(realDir, clientName('whoami')), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    // A PATH entry that is a symlink into the real install dir — the exact
    // shape a Homebrew/`/usr/local/bin` link into /Applications/MEGAcmd.app has.
    symlinkSync(join(realDir, clientName('whoami')), join(linkDir, clientName('whoami')));

    const savedPath = process.env.PATH;
    process.env.PATH = `${linkDir}:${savedPath ?? ''}`;
    try {
      // realpath collapses the temp root (/var -> /private/var on macOS), so
      // compare against the realpath'd target rather than the raw path.
      expect(await resolvePathBinDir()).toBe(realpathSync(realDir));
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it.skipIf(process.platform === 'win32')('returns null when the client is not on PATH', async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = join(root, 'empty-nonexistent');
    try {
      expect(await resolvePathBinDir()).toBeNull();
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe('buildClientInvocation', () => {
  it('posix: runs mega-<cmd> with args passed through', () => {
    const inv = buildClientInvocation(false, '/opt/megacmd', 'ls', ['-l', '/']);
    expect(inv.bin).toBe(join('/opt/megacmd', 'mega-ls'));
    expect(inv.argv).toEqual(['-l', '/']);
  });

  it('win32: runs MEGAclient.exe with the subcommand prepended (no .bat)', () => {
    const inv = buildClientInvocation(true, 'C:\\MEGAcmd', 'ls', ['-l', '/']);
    expect(inv.bin).toBe(join('C:\\MEGAcmd', 'MEGAclient.exe'));
    expect(inv.argv).toEqual(['ls', '-l', '/']);
    expect(inv.bin).not.toMatch(/\.bat$/);
  });

  it('win32 on PATH (no binDir): bare MEGAclient.exe', () => {
    const inv = buildClientInvocation(true, null, 'whoami', []);
    expect(inv.bin).toBe('MEGAclient.exe');
    expect(inv.argv).toEqual(['whoami']);
  });
});
