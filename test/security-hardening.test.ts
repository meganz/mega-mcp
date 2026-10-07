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
import { registerContacts } from '../src/tools/contacts.js';
import { registerManage } from '../src/tools/manage.js';
import { createConfirmStore } from '../src/confirm.js';
import { assertNoFlag, assertRemotePath, assertDownloadTarget, assertNoLocalGlob, publishMegacmdBinDir, assertLocalPath, assertNoStoreWithin, assertNoProtectedWithin, planUpload, ValidationError } from '../src/paths.js';
import { createRuntime } from '../src/runtime.js';
import type { Runtime } from '../src/runtime.js';
import { verifyResolvedBinary } from '../src/download/megacmd.js';
import { resolvePathBinDir } from '../src/resolve.js';
import { registerWhoami } from '../src/tools/whoami.js';
import { childEnv } from '../src/exec.js';
import { childEnv } from '../src/exec.js';
import { assertSafeInvocation, scrubSecrets } from '../src/invocation.js';
import { serializeLikeClient, splitLikeServer, survivesRoundTrip } from '../src/argv.js';
import { localNamesOf } from '../src/tools/helpers.js';
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
 * Lookups a confirmation preview makes to describe a destination (MCP-4): the
 * share list, the public-link list, and a file-or-folder probe. Filtered out where
 * a test asserts the commands that actually ACT.
 */
const isProbe = (a: string[]) =>
  ((a[0] === 'share' || a[0] === 'export') && a.length === 2 && a[1] === '/') || (a[0] === 'find' && a.includes('--type=d') && a.includes('--print-only-handles'));
const acting = (argv: string[][]) => argv.filter((a) => !isProbe(a));

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
      expect(acting(argv)).toEqual([
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
      expect(acting(argv).map((a) => a[0])).toEqual(['mkdir']);
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

describe('email addresses are not hidden', () => {
  it('mega_mount, in-share patterns and status listings show sharers as MEGAcmd prints them', async () => {
    const { rt, argv } = recording(() => ({ stdout: 'D     //from/alice@example.com:Team/a   /tmp/a\n' }));
    const ro = tools(registerReadOnly, rt);
    await ro.get('mega_mount')!({});
    expect(argv).toEqual([['mount']]);
    expect((await ro.get('mega_ls')!({ remotePath: '//from/*' })).isError).toBeFalsy();
    expect(text(await ro.get('mega_transfers')!({}))).toContain('alice@example.com');
    expect(() => assertSafeInvocation('ls', ['--use-pcre', '//from/.*'])).not.toThrow();
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
      expect(() => assertSafeInvocation('killsession', args), JSON.stringify(args)).toThrow(/read differently/);
    }
    expect(() => assertSafeInvocation('ls', ['/My Docs', '/日本語'])).not.toThrow();
    expect(() => assertSafeInvocation('get', ['', '/x'])).not.toThrow();
  });

  it('keeps session-store copies out of every content command, but lets links be removed', () => {
    expect(() => assertSafeInvocation('get', ['/Backup/.megaCmd/session', '/tmp/x'])).toThrow(/session store/);
    expect(() => assertSafeInvocation('cp', ['/Backup/.mega?md', '/x'])).toThrow(/session store/);
    expect(() => assertSafeInvocation('get', ['//from/a@b.c:.megaCmd', '/tmp/x'])).toThrow(/session store/);
    expect(() => assertSafeInvocation('export', ['-d', '/Backup/.megaCmd'])).not.toThrow();
    expect(() => assertSafeInvocation('rm', ['-r', '-f', '/Backup/.megaCmd'])).not.toThrow();
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
    expect(() => assertSafeInvocation('mkdir', ['-p', '/Backup/.megaCmd/x'])).toThrow(/session store/);
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

/**
 * MCP-3: attribute listings never carry key material. MCP-4: a preview says when
 * the destination is shared or publicly linked, and when a file is replaced.
 */
describe('MCP-3: attribute listings without key material', () => {
  it('mega_attr drops the official s4 section (S4 access + secret keys)', async () => {
    const out = 'The node has 1 custom attributes:\n\tnote = hello\nOfficial attributes:\n\ts4 = {"k":"AKIA-SECRET","s":"very-secret"}\n';
    const res = await tools(registerReadOnly, recording(() => ({ stdout: out })).rt).get('mega_attr')!({ remotePath: '/Bucket' });
    expect(text(res)).toContain('note = hello');
    expect(text(res)).not.toMatch(/SECRET|very-secret|s4 =/);
    expect(text(res)).toMatch(/S4 settings are not shown/);
    expect(JSON.stringify(res.structuredContent)).not.toMatch(/SECRET/);
  });

  it('mega_userattr returns only plain profile values', async () => {
    const out = [
      '\tFirst name (firstname) = Ann',
      '\tKeyring (*keyring) = cHJpdmF0ZS1rZXk=',
      '\tKeys (^!keys) = c2VjcmV0',
      '\tPublic key (+puEd255) = AAAA',
      '',
    ].join('\n');
    const res = await tools(registerContacts, recording(() => ({ stdout: out }), { exposeContacts: true }).rt).get('mega_userattr')!({});
    expect(text(res)).toContain('Ann');
    expect(text(res)).not.toMatch(/cHJpdmF0ZS1rZXk=|c2VjcmV0|keyring|\^!keys/);
    expect(text(res)).toMatch(/3 private or key attribute\(s\) not shown/);
  });
});

describe('MCP-4: previews say who will see the result, and what is replaced', () => {
  const listings = (cmd: string, args: string[]) => {
    if (cmd === 'share' && args[0] === '/') return { stdout: '/Team, shared with bob@example.com, access read-only\n' };
    if (cmd === 'export' && args[0] === '/') return { stdout: '/Public (folder, shared as exported permanent folder link: https://mega.nz/folder/x#y)\n' };
    return {};
  };
  const summaryOf = (r: CallToolResult) => (r.structuredContent as { summary: string }).summary;

  it('copying into a shared or publicly linked folder says so, without naming recipients', async () => {
    const cp = tools(registerMutate, recording((c, a) => (c === 'find' && a.includes('--print-only-handles') ? { stdout: 'H:DIR\n' } : listings(c, a))).rt).get('mega_cp')!;
    const intoShare = summaryOf(await cp({ src: '/Private/a.pdf', dst: '/Team/sub' }));
    expect(intoShare).toMatch(/inside \/Team, which is shared with other people/);
    expect(intoShare).not.toContain('bob@example.com');
    expect(summaryOf(await cp({ src: '/Private/a.pdf', dst: '/Public' }))).toMatch(/\/Public has a public link/);
    expect(summaryOf(await cp({ src: '/Private/a.pdf', dst: '/Public/in' }))).toMatch(/inside \/Public, which has a public link/);
    expect(summaryOf(await cp({ src: '/Private/a.pdf', dst: '/Elsewhere' }))).not.toMatch(/share with|public link|REPLACED/);
  });

  it('copying or moving onto an existing file says it is replaced', async () => {
    // An existing FILE lists nothing for `find --type=d`.
    const rt = recording((c, a) => (c === 'find' && a.includes('--print-only-handles') ? { stdout: '' } : listings(c, a))).rt;
    expect(summaryOf(await tools(registerMutate, rt).get('mega_cp')!({ src: '/a.txt', dst: '/b.txt' }))).toMatch(/\/b\.txt is an existing FILE: it will be REPLACED/);
    expect(summaryOf(await tools(registerMutate, rt).get('mega_mv')!({ src: '/a.txt', dst: '/b.txt' }))).toMatch(/REPLACED/);
  });

  it("names someone else's shared folder as the destination", async () => {
    const cp = tools(registerMutate, recording((c, a) => (c === 'find' && a.includes('--print-only-handles') ? { stdout: 'H:DIR\n' } : {})).rt).get('mega_cp')!;
    expect(summaryOf(await cp({ src: '/a.txt', dst: '//from/x@y.z:Team' }))).toMatch(/someone else shared with you/);
  });

  it('uploads, imports, syncs and backups into a shared folder say so too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mega-notes-'));
    try {
      const rt = recording((c, a) => (c === 'find' && a.includes('--print-only-handles') ? { stdout: 'H:DIR\n' } : listings(c, a))).rt;
      const m = tools(registerMutate, rt);
      const s = tools(registerSync, rt);
      expect(summaryOf(await m.get('mega_put')!({ localPath: dir, remotePath: '/Team' }))).toMatch(/shared with other people/);
      expect(summaryOf(await tools(registerManage, rt).get('mega_import')!({ link: 'https://mega.nz/folder/a#k', remotePath: '/Public/in' }))).toMatch(/public link/);
      expect(summaryOf(await s.get('mega_sync_add')!({ localPath: dir, remotePath: '/Team' }))).toMatch(/shared with other people/);
      expect(summaryOf(await s.get('mega_backup_add')!({ localPath: dir, remotePath: '/Public', period: '0 0 * * *', numBackups: 3 }))).toMatch(/public link/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Sensitive output from MEGAcmd. Tools may run only the commands they need (the
 * session, master-key, password and proxy commands are unreachable), and every
 * output loses the credentials MEGAcmd prints next to a label before any tool
 * sees it.
 */
describe('MEGAcmd commands and their output', () => {
  it('refuses commands no tool needs - the ones that print sessions, keys or passwords', () => {
    for (const cmd of ['session', 'masterkey', 'passwd', 'proxy', 'login', 'signup', 'confirm', 'webdav', 'ftp', 'exec', 'cancel']) {
      expect(() => assertSafeInvocation(cmd, []), cmd).toThrow(/not one this connector runs/);
    }
    expect(() => assertSafeInvocation('ls', ['/'])).not.toThrow();
  });

  it('every MEGAcmd command named in the source is on the allowlist', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
    const used = new Set<string>();
    for (const f of files(join(__dirname, '..', 'src'))) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/(?:rt\.run|runToResult\(rt,|runPerHandle\(rt,|runBulk\(rt,)\s*\(?'([a-z-]+)'/g)) used.add(m[1] as string);
    }
    for (const s of ['speedlimit', 'https', 'graphics', 'log', 'permissions', 'reload', 'debug']) used.add(s);
    expect(used.size).toBeGreaterThan(30);
    for (const cmd of used) expect(() => assertSafeInvocation(cmd, []), cmd).not.toThrow(/not one this connector runs/);
  });

  it('removes credentials MEGAcmd prints next to a label, but keeps the link', () => {
    // export, in the formats of megacmdexecuter.cpp
    const out = [
      'Exported /Team: https://mega.nz/folder/abc#def',
      '          AuthToken = SECRET-TOKEN',
      '          Share key encryption key = SECRET-SHARE-KEY',
      '/Drop (folder, shared as exported permanent folder link: https://mega.nz/folder/x#y AuthToken=x#y:SECRET-FOLDER)',
      '/a.txt (12 B, shared as exported permanent file link: https://mega.nz/file/x#y expires at Thu, 08 Oct 2026 AuthKey=SECRET-AUTHKEY)',
    ].join('\n');
    const clean = scrubSecrets('export', [], out);
    expect(clean).not.toMatch(/SECRET-/);
    expect(clean).toContain('https://mega.nz/folder/abc#def');
    expect(clean).toContain('AuthToken = [hidden]');
    expect(clean).toContain('AuthKey=[hidden])');
    expect(scrubSecrets('users', ['-s'], out)).not.toMatch(/SECRET-(TOKEN|FOLDER|AUTHKEY)/);
    expect(scrubSecrets('find', ['/x', '-l'], out)).not.toMatch(/SECRET-(TOKEN|FOLDER|AUTHKEY)/);
    // whoami -l, as printed by MEGAcmd 2.6.0 (mega_sessions shows this block).
    const sessions = '    * Current Session\n    Session ID: AbCdEfGhIjK\n    IP: 192.0.2.1\n    -----';
    expect(scrubSecrets('whoami', ['-l'], sessions)).not.toContain('AbCdEfGhIjK');
    expect(scrubSecrets('whoami', ['-l'], sessions)).toContain('Session ID: [hidden]');
    // The login session token itself (logout --keep-session; never run).
    const token = 'A'.repeat(80);
    expect(scrubSecrets('logout', [], `You can also login with the session id: ${token}`)).not.toContain(token);
  });

  it('leaves file contents and names alone: only outputs that carry a credential are scrubbed', () => {
    const text = 'Session: Opening keynote\npassword = hunter2\nconst authToken = await login();\nAuthKey=abc';
    expect(scrubSecrets('cat', ['/notes.txt'], text)).toBe(text);
    // Names the guards parse back (PCRE previews, mkdir "already exists").
    const found = '/Talks/session: x <H:aaaaaaaa>\n/Talks/session: x/a.txt <H:bbbbbbbb>';
    expect(scrubSecrets('find', ['/Talks', '--use-pcre', '--show-handles'], found)).toBe(found);
    const exists = '[2026-10-07_03-49-59.658032 cmd ERR  Folder already exists: session: notes]';
    expect(scrubSecrets('mkdir', ['-p', '/session: notes'], exists)).toBe(exists);
    // An export of a path ending in "session" keeps its link.
    const exported = 'Exported /Music/Jam session: https://mega.nz/folder/abc#def';
    expect(scrubSecrets('export', ['-a', '/Music/Jam session'], exported)).toBe(exported);
  });

  it('the runtime scrubs credential-carrying output before a tool sees it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mega-scrub-'));
    try {
      const resolved = {
        source: 'path' as const,
        binDir: dir,
        libDir: null,
        clientInvocation: (cmd: string, args: string[]) => ({ bin: join(dir, `mega-${cmd}`), argv: args }),
        serverBin: join(dir, 'mega-cmd'),
      };
      const rt = createRuntime(
        { cacheDir: join(dir, 'cache'), systemAppBinDirs: [], download: { sha256Allow: [] }, maxListLines: 1000, exposeContacts: false, exposeAccountDetails: false, exposeFileContents: false } as Config,
        {
          resolve: async () => resolved,
          verify: async () => true,
          exec: async () => ({ code: 0, stdout: 'Exported /x: https://mega.nz/file/a#b\n  AuthToken = SECRET-TOKEN', stderr: 'Share key encryption key = SECRET-P' }),
        },
      );
      const r = await rt.run('export', ['/x']);
      expect(r.stdout).toContain('https://mega.nz/file/a#b');
      expect(r.stdout + r.stderr).not.toMatch(/SECRET-/);
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('final review fixes', () => {
  const NOTFOUND = 53;

  it('mega_put uploads one item under a new name, and the preview shows where each item lands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mega-putname-'));
    try {
      writeFileSync(join(dir, 'report.pdf'), 'r');
      const { rt, argv } = recording((cmd, args) => (cmd === 'find' && args[0] === '/Docs/report-2026.pdf' ? { code: NOTFOUND } : { stdout: 'H:aaaaaaaa' }));
      const put = tools(registerMutate, rt).get('mega_put')!;
      const preview = await put({ localPath: join(dir, 'report.pdf'), remotePath: '/Docs', name: 'report-2026.pdf' });
      const { summary, confirmToken } = preview.structuredContent as { summary: string; confirmToken: string };
      expect(summary).toContain(`${join(dir, 'report.pdf')}  ->  /Docs/report-2026.pdf`);
      const done = await put({ localPath: join(dir, 'report.pdf'), remotePath: '/Docs', name: 'report-2026.pdf', confirm: confirmToken });
      expect(done.isError).toBeFalsy();
      const ran = acting(argv).filter((a) => a[0] !== 'find');
      expect(ran).toEqual([
        ['mkdir', '-p', '/Docs'],
        ['put', '-c', join(dir, 'report.pdf'), '/Docs/report-2026.pdf'],
      ]);
      // Without a name, each item keeps its own name inside the folder.
      const plain = await put({ localPath: join(dir, 'report.pdf'), remotePath: '/Docs' });
      expect((plain.structuredContent as { summary: string }).summary).toContain('->  /Docs/report.pdf');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mega_put refuses a name that is a path, a name for several items, and an existing folder', async () => {
    const { rt, argv } = recording(() => ({ stdout: 'H:aaaaaaaa' }));
    const put = tools(registerMutate, rt).get('mega_put')!;
    for (const name of ['a/b', '..', '', 'x#1234567890', '.megaCmd']) {
      expect((await put({ localPath: '/tmp/a', remotePath: '/Docs', name })).isError, name).toBe(true);
    }
    expect((await put({ localPaths: ['/tmp/a', '/tmp/b'], remotePath: '/Docs', name: 'n' })).isError).toBe(true);
    // find lists a folder at /Docs/n: MEGAcmd would put the item inside it instead.
    const res = await put({ localPath: '/tmp/a', remotePath: '/Docs', name: 'n' });
    expect(text(res)).toMatch(/already exists as a folder/);
    expect(acting(argv).filter((a) => a[0] !== 'find')).toEqual([]);
  });

  it('mega_get checks a localDir that does not exist yet as the landing place itself', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'mega-getmissing-')));
    const root = join(base, 'cache', 'megacmd');
    publishMegacmdBinDir(null, [root]);
    try {
      const get = tools(registerMutate, recording().rt).get('mega_get')!;
      // MEGAcmd would create <root> as the downloaded folder and fill it.
      expect(text(await get({ remotePath: '/My Stuff', localDir: root }))).toMatch(/Refusing/);
      expect(text(await get({ remotePath: '/My Stuff', localDir: join(base, 'cache') }))).toMatch(/Refusing to download/);
      // An ordinary missing folder is fine.
      expect((await get({ remotePath: '/My Stuff', localDir: join(base, 'new') })).isError).toBeFalsy();
    } finally {
      publishMegacmdBinDir(null);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('a PCRE download checks where the topmost matches land, not their contents', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'mega-pcretop-')));
    const root = join(home, 'Library', 'Caches', 'x');
    mkdirSync(root, { recursive: true });
    publishMegacmdBinDir(null, [root]);
    try {
      const listing = '/Proj <H:aaaaaaaa>\n/Proj/Library <H:bbbbbbbb>';
      const { rt } = recording((cmd, args) =>
        cmd === 'find' && args.includes('--use-pcre')
          ? { stdout: args.includes('--print-only-handles') ? 'H:aaaaaaaa\nH:bbbbbbbb' : listing }
          : {},
      );
      const get = tools(registerMutate, rt).get('mega_get')!;
      const res = await get({ remotePath: '^/Proj$', localDir: home, usePcre: true, background: true });
      expect(res.isError).toBeFalsy();
      expect((res.structuredContent as { summary: string }).summary).toMatch(/in the background/);
    } finally {
      publishMegacmdBinDir(null);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('mega_mkdir creates a folder whose name starts with "*" (mkdir has no wildcards)', async () => {
    const { rt, argv } = recording();
    const mkdir = tools(registerMutate, rt).get('mega_mkdir')!;
    expect((await mkdir({ remotePath: '/Projects/* To sort' })).isError).toBeFalsy();
    expect(argv).toEqual([['mkdir', '-p', '/Projects/* To sort']]);
    expect((await mkdir({ remotePath: '/x/.megaCmd/y' })).isError).toBe(true);
  });

  it('Linux login instructions name the shell the packages install (mega-cmd)', async () => {
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const rt = {
        ...recording().rt,
        ensureReady: async () => ({ loggedIn: false, reason: 'not_logged_in' }),
        getResolved: async () => ({ binDir: '/usr/bin' }),
      } as unknown as Runtime;
      const out = text(await tools(registerWhoami, rt).get('mega_whoami')!({}));
      expect(out).toContain('mega-cmd');
      expect(out).not.toContain('MEGAcmdShell');
    } finally {
      Object.defineProperty(process, 'platform', { value: real });
    }
  });

  it('prepends the bin dir to Windows "Path" instead of shadowing it', () => {
    const real = process.platform;
    const saved = { PATH: process.env.PATH, Path: process.env.Path };
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      delete process.env.PATH;
      process.env.Path = 'C:\\Windows\\system32';
      const env = childEnv({ binDir: 'C:\\MEGAcmd', libDir: null } as never);
      expect(env.Path).toBe('C:\\MEGAcmd;C:\\Windows\\system32');
      expect(env.PATH).toBeUndefined();
    } finally {
      Object.defineProperty(process, 'platform', { value: real });
      if (saved.Path === undefined) delete process.env.Path;
      else process.env.Path = saved.Path;
      process.env.PATH = saved.PATH;
    }
  });
});
