import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerDangerous } from '../src/tools/dangerous.js';
import { registerMutate } from '../src/tools/mutate.js';
import { registerReadOnly } from '../src/tools/readonly.js';
import { registerSync } from '../src/tools/sync.js';
import { registerConfig } from '../src/tools/config.js';
import { registerCat, looksBinary } from '../src/tools/cat.js';
import { createConfirmStore } from '../src/confirm.js';
import { assertNoFlag, assertRemotePath, assertDownloadTarget, assertNoLocalGlob, publishMegacmdBinDir, assertLocalPath, assertNoStoreWithin, assertNoProtectedWithin, planUpload, ValidationError } from '../src/paths.js';
import { createRuntime } from '../src/runtime.js';
import type { Runtime } from '../src/runtime.js';
import { verifyResolvedBinary } from '../src/download/megacmd.js';
import { resolvePathBinDir } from '../src/resolve.js';
import { childEnv } from '../src/exec.js';
import { assertSafeInvocation } from '../src/invocation.js';
import { serializeLikeClient, splitLikeServer, survivesRoundTrip } from '../src/argv.js';
import { localNamesOf, hideContacts } from '../src/tools/helpers.js';
import { storeCopyIn } from '../src/paths.js';
import { homedir } from 'node:os';
import type { Config, RunResult } from '../src/types.js';

type ToolFn = (args: any) => Promise<CallToolResult>;
type Reply = Partial<RunResult>;

/** A runtime that records every MEGAcmd call and answers with `reply`. */
function recording(reply: (cmd: string, args: string[]) => Reply = () => ({}), config: Partial<Config> = {}) {
  const argv: string[][] = [];
  const rt = {
    config: { maxListLines: 1000, cacheDir: '/tmp/cache', download: { sha256Allow: [] }, exposeContacts: false, exposeAccountDetails: false, exposeFileContents: false, ...config },
    confirm: createConfirmStore(),
    run: async (cmd: string, args: string[]) => {
      argv.push([cmd, ...args]);
      return { code: 0, stdout: '', stderr: '', ...reply(cmd, args) } as RunResult;
    },
    getResolved: async () => null,
    getBinDir: async () => null,
    invalidateResolved: () => {},
    getAuthState: async () => ({ loggedIn: true, reason: 'ok' }),
    ensureReady: async () => ({ loggedIn: true, reason: 'ok' }),
  } as unknown as Runtime;
  return { rt, argv };
}

function tools(register: (server: any, rt: Runtime) => unknown, rt: Runtime): Map<string, ToolFn> {
  const map = new Map<string, ToolFn>();
  register({ registerTool: (name: string, _d: unknown, cb: ToolFn) => map.set(name, cb) }, rt);
  return map;
}

const text = (res: CallToolResult) => (res.content?.[0] as { text: string }).text;
const token = (res: CallToolResult) => (res.structuredContent as { confirmToken: string }).confirmToken;

/**
 * `find` prints node names raw, one per line. A name with a line break can add
 * lines of its own, each carrying any handle - so the named listing is checked
 * against the handle-only listing, which a name cannot forge.
 */
describe('PCRE previews cannot be forged by a node name', () => {
  it('refuses when the named listing carries a handle the real match set does not have', async () => {
    const forged = '/Docs/a.txt <H:EVIL>\n/Docs/b.txt <H:REAL>\n';
    const { rt, argv } = recording((cmd, args) =>
      cmd === 'find' ? { stdout: args.includes('--print-only-handles') ? 'H:REAL\n' : forged } : {},
    );
    const res = await tools(registerDangerous, rt).get('mega_rm')!({ remotePath: '/Docs/.*', usePcre: true });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/cannot list unambiguously/);
    expect(argv.map((a) => a[0])).toEqual(['find', 'find']);
  });

  it('refuses a listing line without a handle (a name split by a line break)', async () => {
    const { rt } = recording((cmd, args) =>
      cmd === 'find' ? { stdout: args.includes('--print-only-handles') ? 'H:REAL\n' : '/Docs/a\nb.txt <H:REAL>\n' } : {},
    );
    expect((await tools(registerDangerous, rt).get('mega_rm')!({ remotePath: '/Docs/.*', usePcre: true })).isError).toBe(true);
  });

  it('still previews an ordinary match set', async () => {
    const { rt } = recording((cmd, args) =>
      cmd === 'find' ? { stdout: args.includes('--print-only-handles') ? 'H:A\nH:B\n' : '/x/a <H:A>\n/x/b <H:B>\n' } : {},
    );
    const res = await tools(registerDangerous, rt).get('mega_rm')!({ remotePath: '/x/.*', usePcre: true });
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
  });
});

describe('mega_put', () => {
  // put runs glob(3) on a local path that does not exist and has "*" or "?", AFTER
  // approval - so the uploaded set would not be the previewed one.
  it('refuses an upload source MEGAcmd would expand as a glob', async () => {
    const { rt, argv } = recording();
    const res = await tools(registerMutate, rt).get('mega_put')!({ localPath: join(tmpdir(), 'no-such-dir-zz', '*'), remotePath: '/x' });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/expand it as a pattern/);
    expect(argv).toEqual([]);
  });

  it('takes an existing name with "?" literally', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mega-glob-'));
    try {
      const file = join(dir, 'what?.txt');
      writeFileSync(file, 'x');
      expect(assertNoLocalGlob(file)).toBe(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // With -c and a MISSING destination, MEGAcmd uploads under the destination's
  // last name instead of into it; mkdir -p reports an EXISTING folder as an error.
  it('creates the destination folder first and treats "already exists" as success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mega-put-'));
    try {
      const file = join(dir, 'a.txt');
      writeFileSync(file, 'x');
      // The exact line MEGAcmd 2.6.0 prints (measured): last component, in the log bracket.
      const { rt, argv } = recording((cmd) => (cmd === 'mkdir' ? { code: 54, stderr: '[2026-10-07_03-49-59.658032 cmd ERR  Folder already exists: Backup]' } : {}));
      const put = tools(registerMutate, rt).get('mega_put')!;
      const preview = await put({ localPath: file, remotePath: '/Backup' });
      const done = await put({ localPath: file, remotePath: '/Backup', confirm: token(preview) });
      expect(done.isError).toBeFalsy();
      expect(argv).toEqual([
        ['mkdir', '-p', '/Backup'],
        ['put', '-c', file, '/Backup'],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops when the destination is something mkdir cannot make into a folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mega-put-'));
    try {
      const { rt, argv } = recording((cmd) => (cmd === 'mkdir' ? { code: 1, stderr: 'boom' } : {}));
      const put = tools(registerMutate, rt).get('mega_put')!;
      const preview = await put({ localPath: dir, remotePath: '/Backup' });
      const done = await put({ localPath: dir, remotePath: '/Backup', confirm: token(preview) });
      expect(done.isError).toBe(true);
      expect(argv.map((a) => a[0])).toEqual(['mkdir']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mega_get', () => {
  // A MERGED folder lands in localDir itself, not in <localDir>/<name>, so the
  // check must cover everything directly in localDir.
  it('with merge, refuses a destination that holds a protected directory', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'mega-merge-'));
    try {
      mkdirSync(join(parent, 'data'));
      publishMegacmdBinDir(null, [join(parent, 'data')]);
      const get = tools(registerMutate, recording().rt).get('mega_get')!;
      expect((await get({ remotePath: '/x/Docs', localDir: parent, merge: true })).isError).toBe(true);
      // Without merge the folder lands in <parent>/Docs, which is fine.
      expect((await get({ remotePath: '/x/Docs', localDir: parent })).isError).toBeFalsy();
    } finally {
      publishMegacmdBinDir(null);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('refuses to download a cloud copy of the session store', async () => {
    const { rt, argv } = recording((cmd, args) =>
      cmd === 'find'
        ? { stdout: args.includes('--print-only-handles') ? 'H:A\n' : '/Backup/home/.megaCmd/session <H:A>\n' }
        : {},
    );
    const get = tools(registerMutate, rt).get('mega_get')!;
    const dl = join(tmpdir(), 'dl');
    expect(text(await get({ remotePath: '/Backup/home/.megaCmd/session', localDir: dl }))).toMatch(/session store/);
    expect(text(await get({ remotePath: '/Backup/.*', usePcre: true, localDir: dl }))).toMatch(/session store/);
    expect(argv.map((a) => a[0])).toEqual(['find', 'find']);
  });

  it('shows the link itself in the preview', async () => {
    const res = await tools(registerMutate, recording().rt).get('mega_get')!({ link: 'https://mega.nz/file/abc#key', localDir: join(tmpdir(), 'dl') });
    expect((res.structuredContent as { summary: string }).summary).toContain('https://mega.nz/file/abc#key');
  });
});

describe('argv: values MEGAcmd would re-read as options', () => {
  // The server strips a single quote at the start of a word, so "'-a" became "-a".
  it('refuses a leading single quote in free-text values', () => {
    expect(() => assertNoFlag("'-a", 'id')).toThrow(/single quote/);
    expect(() => assertNoFlag("'x", 'id')).toThrow(/single quote/);
    expect(assertNoFlag("it's", 'id')).toBe("it's");
  });

  it('mega_killsession runs the same guard', async () => {
    const { rt, argv } = recording();
    const res = await tools(registerDangerous, rt).get('mega_killsession')!({ sessionId: "'-a" });
    expect(res.isError).toBe(true);
    expect(argv).toEqual([]);
  });

  // MEGAcmd unescapes "\ " and "\\" in remote paths, so the node it acts on is not
  // the one the checks looked at.
  it('refuses a backslash in a remote path', () => {
    expect(() => assertRemotePath('/a\\ b')).toThrow(/backslash/);
  });
});

describe('download target: file versions', () => {
  it('checks the plain name of a `name#<10 digits>` version too', () => {
    const parent = mkdtempSync(join(tmpdir(), 'mega-ver-'));
    try {
      mkdirSync(join(parent, 'data'));
      publishMegacmdBinDir(null, [join(parent, 'data')]);
      expect(() => assertDownloadTarget(parent, 'data#1234567890')).toThrow();
      expect(() => assertDownloadTarget(parent, 'notes#1234567890')).not.toThrow();
    } finally {
      publishMegacmdBinDir(null);
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

/**
 * Incoming shares are listed as //from/<sharer-email>:<folder>, so listing them
 * reveals third-party email addresses - gated like mega_share list.
 */
describe('incoming-share listings and contact details', () => {
  it('mega_mount asks first when contact details are not exposed', async () => {
    const { rt, argv } = recording();
    const res = await tools(registerReadOnly, rt).get('mega_mount')!({});
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
    expect(text(res)).toMatch(/EMAIL ADDRESSES/);
    expect(argv).toEqual([]);
  });

  it('mega_mount lists freely when contact details are exposed', async () => {
    const { rt, argv } = recording(() => ({}), { exposeContacts: true });
    await tools(registerReadOnly, rt).get('mega_mount')!({});
    expect(argv).toEqual([['mount']]);
  });

  it('refuses enumerating incoming shares by pattern, but not a specific share', async () => {
    const { rt } = recording();
    const ro = tools(registerReadOnly, rt);
    expect((await ro.get('mega_ls')!({ remotePath: '//from/*' })).isError).toBe(true);
    expect((await ro.get('mega_find')!({ remotePath: '//f*' })).isError).toBe(true);
    expect((await ro.get('mega_ls')!({ remotePath: '//from/a@b.c:Team' })).isError).toBeFalsy();
    expect((await tools(registerDangerous, rt).get('mega_rm')!({ remotePath: '//from/.*', usePcre: true })).isError).toBe(true);
  });
});

describe('previews name every option that is executed', () => {
  it('mega_export create shows MEGA hosting, password and expiry', async () => {
    const res = await tools(registerDangerous, recording().rt).get('mega_export')!({
      remotePath: '/Team',
      action: 'create',
      megaHosted: true,
      password: 'pw',
      expire: '1d',
    });
    const summary = (res.structuredContent as { summary: string }).summary;
    expect(summary).toMatch(/shared with MEGA/);
    expect(summary).toMatch(/password-protected/);
    expect(summary).toMatch(/expire after 1d/);
    expect(summary).not.toContain('pw');
  });

  it('mega_config shows the direction a limit applies to', async () => {
    const res = await tools(registerConfig, recording().rt).get('mega_config')!({ setting: 'speedlimit', value: '100K', direction: 'upload' });
    expect((res.structuredContent as { summary: string }).summary).toMatch(/for upload/);
  });
});

describe('mega_cat output', () => {
  it('treats a terminal escape anywhere in the file as binary, not only in the first 8 KB', () => {
    expect(looksBinary(`${'a'.repeat(20_000)}\u001b[2J`)).toBe(true);
  });

  it('returns the text once, without mirroring it into structuredContent', async () => {
    const map = new Map<string, ToolFn>();
    const { rt } = recording(() => ({ stdout: 'hello' }));
    registerCat({ registerTool: (n: string, _d: unknown, cb: ToolFn) => map.set(n, cb) } as any, rt);
    const res = await map.get('mega_cat')!({ remotePath: '/notes.txt' });
    expect(text(res)).toBe('hello');
    expect(res.structuredContent).toBeUndefined();
  });
});

// A quoted id must not reach `sync -d` as an option.
describe('sync control ids', () => {
  it('refuses a quoted id', async () => {
    const { rt, argv } = recording();
    const res = await tools(registerSync, rt).get('mega_sync_control')!({ action: 'delete', id: "'-a" });
    expect(res.isError).toBe(true);
    expect(argv).toEqual([]);
  });
});

/**
 * The integrity gate: a requirement codesign evaluates (not a substring of its
 * text output), verification tied to the resolution that runs and repeated when
 * the install changes, PATH entries that cannot point at the working directory,
 * and a child environment that cannot replace the verified binary.
 */
/** A small app signed with someone else's Developer ID, or null. */
function findDeveloperIdApp(): string | null {
  let apps: string[];
  try {
    apps = readdirSync('/Applications').filter((a) => a.endsWith('.app') && a !== 'MEGAcmd.app').map((a) => join('/Applications', a));
  } catch {
    return null;
  }
  for (const app of apps.slice(0, 40)) {
    const res = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8' });
    if (!/^Authority=Developer ID Application: /m.test(res.stderr) || /Mega Limited/.test(res.stderr)) continue;
    const size = Number(spawnSync('/usr/bin/du', ['-sm', app], { encoding: 'utf8' }).stdout.split('\t')[0]);
    if (size > 0 && size < 60) return app;
  }
  return null;
}

describe('binary integrity', () => {
  const megacmdApp = '/Applications/MEGAcmd.app/Contents/MacOS';
  const onMacWithMegacmd = process.platform === 'darwin' && existsSync(megacmdApp);

  it.runIf(onMacWithMegacmd)('accepts the genuine MEGAcmd bundle', async () => {
    expect(await verifyResolvedBinary({ binDir: megacmdApp, serverBin: join(megacmdApp, 'mega-cmd'), source: 'system' })).toBe(true);
  });

  it.runIf(onMacWithMegacmd)('rejects it under a different team pin, and rejects a malformed pin', async () => {
    const r = { binDir: megacmdApp, serverBin: join(megacmdApp, 'mega-cmd'), source: 'system' };
    expect(await verifyResolvedBinary(r, { teamId: 'AAAAAAAAAA' })).toBe(false);
    expect(await verifyResolvedBinary(r, { teamId: 'X" or true' })).toBe(false);
  });

  it.runIf(process.platform === 'darwin' && existsSync('/System/Applications/Calculator.app'))('rejects an app signed by anyone else', async () => {
    const dir = '/System/Applications/Calculator.app/Contents/MacOS';
    expect(await verifyResolvedBinary({ binDir: dir, serverBin: join(dir, 'Calculator'), source: 'system' })).toBe(false);
  });

  /**
   * The old check searched `codesign -dv` text, which also echoes the bundle's
   * on-disk path. Reproduced on macOS: ANY Developer-ID app copied under a folder
   * named "Authority=Developer ID Application: Mega Limited (…) TeamIdentifier=…"
   * passed codesign --verify, spctl and both substring tests.
   */
  it.runIf(process.platform === 'darwin')('rejects another Developer-ID app placed under a folder named like MEGA\'s signer', async () => {
    const donor = findDeveloperIdApp();
    if (!donor) return; // no third-party Developer-ID app on this machine
    const base = mkdtempSync(join(tmpdir(), 'mega-h1-'));
    try {
      const crafted = join(base, 'Authority=Developer ID Application: Mega Limited (T9RH74Y7L9) TeamIdentifier=T9RH74Y7L9');
      const app = join(crafted, 'Donor.app');
      mkdirSync(crafted, { recursive: true });
      execFileSync('/usr/bin/ditto', [donor, app]);
      execFileSync('/usr/bin/xattr', ['-cr', app]);
      const binDir = join(app, 'Contents', 'MacOS');
      expect(await verifyResolvedBinary({ binDir, serverBin: '', source: 'cache' })).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);

  it('verifies once per resolution, never caches a failure, and checks every call first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mega-verify-'));
    try {
      const make = () => ({
        source: 'path' as const,
        binDir: dir,
        libDir: null,
        clientInvocation: (cmd: string, args: string[]) => ({ bin: join(dir, `mega-${cmd}`), argv: args }),
        serverBin: join(dir, 'mega-cmd'),
      });
      let current = make();
      let verifies = 0;
      let verdict = true;
      const rt = createRuntime(
        { cacheDir: join(dir, 'cache'), systemAppBinDirs: [], download: { sha256Allow: [] }, maxListLines: 1000, exposeContacts: false, exposeAccountDetails: false, exposeFileContents: false } as Config,
        { resolve: async () => current, verify: async () => (verifies++, verdict) },
      );
      await rt.run('whoami', []);
      await rt.run('whoami', []);
      expect(verifies).toBe(1);
      // A new resolution (after setup) is verified on its own.
      current = make();
      rt.invalidateResolved();
      verdict = false;
      expect((await rt.run('whoami', [])).spawnError).toBe('INTEGRITY_FAILED');
      verdict = true;
      await rt.run('whoami', []);
      expect(verifies).toBe(3);
      // The shared gate runs before anything is resolved or launched.
      await expect(rt.run('killsession', ['\u0001-a'])).rejects.toThrow(/read differently/);
      expect(verifies).toBe(3);
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('looks only at absolute PATH entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mega-pathwalk-'));
    const saved = process.env.PATH;
    try {
      writeFileSync(join(dir, 'mega-whoami'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      process.env.PATH = `::.:relative/bin:${dir}`;
      expect(await resolvePathBinDir()).toBe(realpathSync(dir));
      process.env.PATH = '::.:relative/bin';
      expect(await resolvePathBinDir()).toBeNull();
    } finally {
      process.env.PATH = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips variables that could run code in the children, and adds no empty PATH entry', () => {
    const keys = ['BASH_ENV', 'BASH_FUNC_mega-exec%%', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'PATH', 'LD_LIBRARY_PATH'] as const;
    const saved = keys.map((k) => [k, process.env[k]] as const);
    try {
      process.env.BASH_ENV = '/tmp/x';
      process.env['BASH_FUNC_mega-exec%%'] = '() { :; }';
      process.env.DYLD_INSERT_LIBRARIES = '/tmp/x.dylib';
      process.env.LD_PRELOAD = '/tmp/x.so';
      delete process.env.PATH;
      delete process.env.LD_LIBRARY_PATH;
      const env = childEnv({ source: 'cache', binDir: '/opt/mega/bin', libDir: '/opt/mega/lib', clientInvocation: () => ({ bin: '', argv: [] }), serverBin: '' });
      for (const k of ['BASH_ENV', 'BASH_FUNC_mega-exec%%', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD']) expect(env[k], k).toBeUndefined();
      expect(env.PATH).toBe('/opt/mega/bin');
      expect(env.LD_LIBRARY_PATH).toBe('/opt/mega/lib');
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

/**
 * macOS firmlinks: /System/Volumes/Data/<path> IS /<path> (same device and inode),
 * yet realpath keeps the spelling it is given, so every string comparison missed
 * it. The guards now also compare on-disk identity.
 */
describe.runIf(process.platform === 'darwin' && existsSync('/System/Volumes/Data/private'))('firmlink spellings', () => {
  async function withHomeStore(fn: (f: { home: string; alias: string }) => void | Promise<void>) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'mega-firm-')));
    const home = join(base, 'home');
    mkdirSync(join(home, '.megaCmd'), { recursive: true });
    writeFileSync(join(home, '.megaCmd', 'session'), 'fixture');
    writeFileSync(join(home, 'notes.txt'), 'n');
    const saved = process.env.HOME;
    try {
      process.env.HOME = home;
      await fn({ home, alias: `/System/Volumes/Data${home}` });
    } finally {
      if (saved === undefined) delete process.env.HOME;
      else process.env.HOME = saved;
      rmSync(base, { recursive: true, force: true });
    }
  }

  it('sees the session store inside the firmlinked spelling of home', async () => {
    await withHomeStore(({ alias }) => {
      expect(existsSync(join(alias, '.megaCmd'))).toBe(true);
      expect(() => assertNoStoreWithin(alias, 'sync')).toThrow(/MASTER KEY/);
      const plan = planUpload([alias], '/Backup');
      expect(plan.excluded.map((p) => p.split('/').pop())).toContain('.megaCmd');
      for (const step of plan.steps) for (const src of step.sources) expect(src).not.toContain('.megaCmd');
    });
  });

  it('refuses a protected directory reached through its firmlinked spelling', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'mega-firm-root-')));
    try {
      const root = join(base, 'data');
      mkdirSync(root);
      publishMegacmdBinDir(null, [root]);
      const alias = `/System/Volumes/Data${root}`;
      expect(() => assertLocalPath(join(alias, 'file-reading.json'))).toThrow(ValidationError);
      expect(() => assertDownloadTarget(`/System/Volumes/Data${base}`, 'data')).toThrow(ValidationError);
      expect(() => assertNoProtectedWithin(`/System/Volumes/Data${base}`, 'sync')).toThrow(/written into it/);
    } finally {
      publishMegacmdBinDir(null);
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/**
 * Round 3 (scope: a misled assistant, see SECURITY.md). One gate checks every
 * MEGAcmd call; argv must survive MEGAcmd's own join-and-split unchanged.
 */
describe('the shared invocation gate', () => {
  it('refuses any value MEGAcmd would read back differently', () => {
    for (const args of [['\u0001-a'], ['\u001b-a'], ["'-a"], ['-a', '--password=pw\\', '--expire=1d', '/x']]) {
      expect(() => assertSafeInvocation('killsession', args, false), JSON.stringify(args)).toThrow(/read differently/);
    }
    expect(() => assertSafeInvocation('ls', ['/My Docs', '/日本語'], false)).not.toThrow();
    expect(() => assertSafeInvocation('get', ['', '/x'], false)).not.toThrow();
  });

  it('keeps session-store copies out of every content command, but lets links be removed', () => {
    expect(() => assertSafeInvocation('get', ['/Backup/.megaCmd/session', '/tmp/x'], false)).toThrow(/session store/);
    expect(() => assertSafeInvocation('cp', ['/Backup/.mega?md', '/x'], false)).toThrow(/session store/);
    expect(() => assertSafeInvocation('get', ['//from/a@b.c:.megaCmd', '/tmp/x'], false)).toThrow(/session store/);
    expect(() => assertSafeInvocation('export', ['-d', '/Backup/.megaCmd'], false)).not.toThrow();
    expect(() => assertSafeInvocation('rm', ['-r', '-f', '/Backup/.megaCmd'], false)).not.toThrow();
  });

  it('refuses in-share enumeration in any spelling unless contacts are exposed', () => {
    for (const p of ['//from/*', '//f*', '//?rom/*', '//*/*']) {
      expect(() => assertSafeInvocation('ls', [p], false), p).toThrow(/email addresses/);
      expect(() => assertSafeInvocation('ls', [p], true), p).not.toThrow();
    }
    expect(() => assertSafeInvocation('ls', ['--use-pcre', '//from/.*'], false)).toThrow(/email addresses/);
    expect(() => assertSafeInvocation('ls', ['//bin/*'], false)).not.toThrow();
    expect(() => assertSafeInvocation('ls', ['//from/a@b.c:Team'], false)).not.toThrow();
  });

  it('matches MEGAcmd on how it splits a joined command line', () => {
    expect(splitLikeServer(serializeLikeClient(['put', '-c', '/a b', '/x']))).toEqual(['put', '-c', '/a b', '/x']);
    expect(splitLikeServer('cmd \u0001-a')).toEqual(['cmd', '-a']);
    expect(splitLikeServer("cmd '-a'")).toEqual(['cmd', '-a']);
    expect(splitLikeServer('cmd a\\ b c')).toEqual(['cmd', 'a\\ b', 'c']);
  });
});

describe('links, passwords and shared-folder names', () => {
  it('mega_get takes only a real public link as "link" - never a path in disguise', async () => {
    const { rt, argv } = recording();
    const get = tools(registerMutate, rt).get('mega_get')!;
    for (const link of ['/Backup/home/.megaCmd/session', '/*', 'H:abcd', 'https://example.com/no-link-markers']) {
      const res = await get({ link, localDir: join(tmpdir(), 'dl') });
      expect(res.isError, link).toBe(true);
    }
    expect(argv).toEqual([]);
    expect((await get({ link: 'https://mega.nz/file/abc#key', localDir: join(tmpdir(), 'dl') })).isError).toBeFalsy();
  });

  it('a confirmed download, import or link cannot be spent with a different password', async () => {
    const { rt, argv } = recording((cmd) => (cmd === 'export' ? { stdout: 'Exported /x: https://mega.nz/#P!abc' } : {}));
    const ex = tools(registerDangerous, rt).get('mega_export')!;
    const preview = await ex({ remotePath: '/x', action: 'create', password: 'one' });
    const swapped = await ex({ remotePath: '/x', action: 'create', password: 'two', confirm: token(preview) });
    expect(swapped.isError).toBe(true);
    expect(argv.filter((a) => a[0] === 'export')).toEqual([]);
  });

  // On an account that cannot password-protect links MEGAcmd still publishes the
  // node and succeeds with a PLAIN link. The preview promised protection.
  it('withdraws a link MEGA published without the requested password', async () => {
    const { rt, argv } = recording((cmd, args) => (cmd === 'export' && args[0] === '-a' ? { stdout: 'Exported /x: https://mega.nz/file/abc#key' } : {}));
    const ex = tools(registerDangerous, rt).get('mega_export')!;
    const preview = await ex({ remotePath: '/x', action: 'create', password: 'pw' });
    const res = await ex({ remotePath: '/x', action: 'create', password: 'pw', confirm: token(preview) });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/WITHOUT a password/);
    expect(argv.filter((a) => a[0] === 'export').map((a) => a[1])).toEqual(['-a', '-d']);
  });

  it('judges a shared folder by the name it is saved under, not "<email>:<name>"', async () => {
    const home = homedir();
    const get = tools(registerMutate, recording().rt).get('mega_get')!;
    expect((await get({ remotePath: '//from/a@b.c:.megaCmd', localDir: home })).isError).toBe(true);
    expect(localNamesOf('//from/a@b.c:Team')).toEqual(['a@b.c:Team', 'Team']);
    expect(localNamesOf('//from/a@b.c:Team/')).toEqual(['a@b.c:Team', 'Team']);
    expect(localNamesOf('a@b.c:Team')).toEqual(['a@b.c:Team', 'Team']);
    expect(localNamesOf('/Docs/report.txt')).toEqual(['report.txt']);
  });
});

describe('folders that contain a session-store copy', () => {
  // The path checks see only the path's own segments; a parent folder carries the
  // copy along. A find below the source runs at preview and again before running.
  it('refuses to copy, move, download, share or publish them', async () => {
    // The check lists every folder below and judges names case-insensitively
    // (MEGAcmd's own wildcards are case-sensitive and would miss `.MEGACMD`).
    const below = (cmd: string, args: string[]) =>
      cmd === 'find' && args.includes('--type=d') ? { stdout: `${args[0]}\n${args[0]}/sub\n${args[0]}/sub/.MEGACMD\n` } : {};
    const cases: [string, (s: any, r: Runtime) => unknown, any][] = [
      ['mega_cp', registerMutate, { src: '/Backup/home', dst: '/Shared' }],
      ['mega_mv', registerMutate, { src: '/Backup/home', dst: '/Shared' }],
      ['mega_mv', registerMutate, { srcs: ['/Docs', '/Backup/home'], dst: '/Shared' }],
      ['mega_get', registerMutate, { remotePath: '/Backup/home', localDir: join(tmpdir(), 'dl') }],
      ['mega_export', registerDangerous, { remotePath: '/Backup/home', action: 'create' }],
      ['mega_share', registerDangerous, { remotePath: '/Backup/home', action: 'add', withEmail: 'a@b.c' }],
    ];
    for (const [tool, register, args] of cases) {
      const { rt, argv } = recording(below);
      const res = await tools(register, rt).get(tool)!(args);
      expect(res.isError, tool).toBe(true);
      expect(text(res), tool).toMatch(/contains a copy of the MEGAcmd session store/);
      expect(argv.every((a) => a[0] === 'find'), tool).toBe(true);
    }
  });

  // find recurses into a matched folder; acting on every descendant flattened a
  // moved folder and published a link per file. Only the topmost matches run.
  it('a PCRE operation acts on matched folders as a whole', async () => {
    const listing = '/a/f1.txt <H:F1>\n/a <H:A>\n/b.txt <H:B>\n';
    const { rt, argv } = recording((cmd, args) =>
      cmd === 'find' ? { stdout: args.includes('--print-only-handles') ? 'H:F1\nH:A\nH:B\n' : listing } : {},
    );
    const mv = tools(registerMutate, rt).get('mega_mv')!;
    const preview = await mv({ src: '/.*', usePcre: true, dst: '/Archive' });
    expect(text(preview)).not.toContain('H:F1');
    await mv({ src: '/.*', usePcre: true, dst: '/Archive', confirm: token(preview) });
    expect(argv.filter((a) => a[0] === 'mv')).toEqual([['mv', 'H:A', 'H:B', '/Archive']]);
  });
});

describe('destination folders and status listings', () => {
  it('never runs mkdir on a special root, and refuses rebuilding a tree there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mega-root-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'x');
      const { rt, argv } = recording();
      const put = tools(registerMutate, rt).get('mega_put')!;
      const rp = '//from/a@b.c:Team';
      const preview = await put({ localPath: join(dir, 'a.txt'), remotePath: rp });
      await put({ localPath: join(dir, 'a.txt'), remotePath: rp, confirm: token(preview) });
      expect(argv.map((a) => a[0])).toEqual(['put']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('only MEGAcmd\'s own "already exists" line for THIS path counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mega-exists-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'x');
      const { rt } = recording((cmd) => (cmd === 'mkdir' ? { code: 54, stderr: '[2026-10-07_03-49-59.658032 cmd ERR  Folder already exists: Elsewhere]' } : {}));
      const put = tools(registerMutate, rt).get('mega_put')!;
      const preview = await put({ localPath: join(dir, 'a.txt'), remotePath: '/Backup' });
      expect((await put({ localPath: join(dir, 'a.txt'), remotePath: '/Backup', confirm: token(preview) })).isError).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hides sharer emails in transfer and sync listings unless contacts are exposed', async () => {
    const out = 'TYPE  SOURCE                         DESTINATION\nD     //from/alice@example.com:Team/a   /tmp/a\n';
    const hidden = await tools(registerReadOnly, recording(() => ({ stdout: out })).rt).get('mega_transfers')!({});
    expect(text(hidden)).not.toContain('alice@example.com');
    expect(text(hidden)).toContain('<contact>:Team');
    const shown = await tools(registerReadOnly, recording(() => ({ stdout: out }), { exposeContacts: true }).rt).get('mega_transfers')!({});
    expect(text(shown)).toContain('alice@example.com');
    expect(hideContacts('/Docs/report.pdf', false)).toBe('/Docs/report.pdf');
  });
});

describe('final scoped review fixes', () => {
  it('models the split MEGAcmd executes: a trailing control byte is dropped, so refused', () => {
    expect(survivesRoundTrip(['sync-ignore', '--add-exclusion', 'x', '\u0001'])).toBe(false);
    expect(() => assertNoFlag('\u0001', 'target')).toThrow(/control characters/);
  });

  it('mega_sync_add refuses a cloud folder holding a session-store copy below it', async () => {
    const { rt, argv } = recording((cmd, args) => (cmd === 'find' && args.includes('--type=d') ? { stdout: `${args[0]}/.megaCmd\n` } : {}));
    const dir = mkdtempSync(join(tmpdir(), 'mega-syncbelow-'));
    try {
      const res = await tools(registerSync, rt).get('mega_sync_add')!({ localPath: dir, remotePath: '/Backup/home' });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/session store/);
      expect(argv.every((a) => a[0] === 'find')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no folder is created inside a cloud session-store copy', async () => {
    const { rt, argv } = recording();
    expect((await tools(registerMutate, rt).get('mega_mkdir')!({ remotePath: '/Backup/home/.megaCmd/x' })).isError).toBe(true);
    expect(() => assertSafeInvocation('mkdir', ['-p', '/Backup/.megaCmd/x'], false)).toThrow(/session store/);
    expect(argv).toEqual([]);
  });

  it('a PCRE download of a share top folder is judged by the name it is saved under', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'mega-sharename-'));
    try {
      mkdirSync(join(parent, 'data'));
      publishMegacmdBinDir(null, [join(parent, 'data')]);
      const { rt } = recording((cmd, args) =>
        cmd === 'find' ? { stdout: args.includes('--print-only-handles') ? 'H:S\n' : 'x@y.z:data <H:S>\n' } : {},
      );
      const get = tools(registerMutate, rt).get('mega_get')!;
      expect((await get({ remotePath: 'x@y.z:data', usePcre: true, localDir: parent })).isError).toBe(true);
      expect((await get({ remotePath: '//from/x@y.z:data/', localDir: parent })).isError).toBe(true);
    } finally {
      publishMegacmdBinDir(null);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('the share-list preview says what it reveals', async () => {
    const d = tools(registerDangerous, recording().rt).get('mega_share')!;
    expect(text(await d({ action: 'list' }))).toMatch(/EVERY shared folder in the account/);
    expect(text(await d({ action: 'list', remotePath: '/Team', pending: true }))).toMatch(/\/Team or any folder inside it is shared with, including pending/);
    expect(text(await d({ action: 'list', remotePath: '/' }))).toMatch(/EVERY shared folder in the account/);
  });

  it('hides shortened sharer addresses too', () => {
    expect(hideContacts('D  alice@e...am/a  /tmp/a', false)).not.toContain('alice');
    expect(hideContacts('/Docs/report.pdf', false)).toBe('/Docs/report.pdf');
  });

  // MEGAcmd closes EVERY other session for "all" and for any id decoding to the
  // all-ones invalid handle; only a real handle may name a single session.
  it('accepts only a real session handle', async () => {
    const { rt, argv } = recording();
    const kill = tools(registerDangerous, rt).get('mega_killsession')!;
    for (const sessionId of ['all', 'ALL', '___________', '//////////8', 'short', 'AAAAAAAAAAAAAAA']) {
      expect((await kill({ sessionId })).isError, sessionId).toBe(true);
    }
    expect(argv).toEqual([]);
    const ok = await kill({ sessionId: 'AbCdEfGhIjK' });
    expect(ok.structuredContent).toMatchObject({ requiresConfirmation: true });
  });

  it('finds a store copy below a folder whose name merely looks like a wildcard', () => {
    expect(storeCopyIn('/Backup/*/.megaCmd')).toBe('name');
  });
});
