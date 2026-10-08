import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync, readdirSync, symlinkSync, readFileSync, chmodSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerDangerous } from '../src/tools/dangerous.js';
import { registerMutate } from '../src/tools/mutate.js';
import { registerReadOnly } from '../src/tools/readonly.js';
import { registerSync } from '../src/tools/sync.js';
import { redact } from '../src/errors.js';
import { registerConfig } from '../src/tools/config.js';
import { registerCat, looksBinary } from '../src/tools/cat.js';
import { registerContacts } from '../src/tools/contacts.js';
import { registerManage } from '../src/tools/manage.js';
import { createConfirmStore } from '../src/confirm.js';
import { isIgnoreFileName, storeCopiesIn, syncExclusions, assertRemoteDest, assertNoFlag, assertRemotePath, assertDownloadTarget, assertNoLocalGlob, publishMegacmdBinDir, assertLocalPath, assertNoStoreWithin, assertNoProtectedWithin, planUpload, ValidationError } from '../src/paths.js';
import { createRuntime } from '../src/runtime.js';
import type { Runtime } from '../src/runtime.js';
import { verifyResolvedBinary } from '../src/download/megacmd.js';
import { resolvePathBinDir } from '../src/resolve.js';
import { registerWhoami } from '../src/tools/whoami.js';
import { registerSetup } from '../src/tools/setup.js';
import { childEnv } from '../src/exec.js';
import { assertSafeInvocation, scrubSecrets } from '../src/invocation.js';
import { serializeLikeClient, splitLikeServer, survivesRoundTrip } from '../src/argv.js';
import { localNamesOf, previewSafe, destinationNotes, chunkArgs, runBulk, recoveryKeyLinesBelow, backupNamesOf } from '../src/tools/helpers.js';
import { describeExpiry } from '../src/tools/dangerous.js';
import { storeCopyIn, globCanMatchStoreName, localSpellings } from '../src/paths.js';
import { homedir } from 'node:os';
import type { Config, RunResult } from '../src/types.js';

type ToolFn = (args: any) => Promise<CallToolResult>;
type Reply = Partial<RunResult>;

/** A runtime that records every MEGAcmd call and answers with `reply`. */
/** `transfers --summary` with nothing queued (columns as MEGAcmd prints them). */
const NO_TRANSFERS = { stdout: `NUM DOWNLOADS\n${'0'.padStart(16)}${'0 B'.padStart(12)}${'0 B'.padStart(12)}${'0%'.padStart(8)}     ${'0'.padStart(16)}\n` };

function recording(reply: (cmd: string, args: string[]) => Reply = () => ({}), config: Partial<Config> = {}) {
  const argv: string[][] = [];
  const rt = {
    config: { maxListLines: 1000, cacheDir: '/tmp/cache', download: { sha256Allow: [] }, exposeContacts: false, exposeAccountDetails: false, exposeFileContents: false, ...config },
    confirm: createConfirmStore(),
    run: async (cmd: string, args: string[]) => {
      argv.push([cmd, ...args]);
      // An idle MEGAcmd unless the test says otherwise: nothing queued.
      const r = reply(cmd, args);
      if (cmd === 'transfers' && args[0] === '--summary' && r.stdout === undefined && r.code === undefined) return { code: 0, stderr: '', ...NO_TRANSFERS } as RunResult;
      return { code: 0, stdout: '', stderr: '', ...r } as RunResult;
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
  (a[0] === 'share' && a.length === 3 && a[1] === '-p' && a[2] === '/') ||
  (a[0] === 'export' && a.length === 2 && a[1] === '/') ||
  (a[0] === 'find' && a.includes('--type=d') && a.includes('--print-only-handles')) ||
  (a[0] === 'du' && a.length === 3 && String(a[1]).startsWith('--path-display-size=')) ||
  (a[0] === 'permissions' && a.join(' ') === 'permissions --files') ||
  (a[0] === 'sync' && (String(a[1]).startsWith('--output-cols=LOCALPATH') || a[1] === '--output-cols=RUN_STATE')) ||
  (a[0] === 'ls' && a.length === 2) ||
  // What a target holds (bound into confirmations), a search for nested
  // .megaignore files, and the scheduled-backup listing.
  (a[0] === 'find' && a.length === 3 && a[2] === '--print-only-handles') ||
  (a[0] === 'find' && a.includes('--type=f') && a.some((x) => x.startsWith('--pattern='))) ||
  (a[0] === 'backup' && a.length === 2 && String(a[1]).startsWith('--path-display-size='));
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
    expect(acting(argv).map((a) => a[0])).toEqual(['find', 'find']);
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
    expect(summary).toMatch(/expire after 1 day \("1d"\)/);
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
    expect(() => assertSafeInvocation('get', ['', '/x', '/tmp/dl'])).not.toThrow();
    // An empty word is not a path: MEGAcmd's client would append its own folder.
    expect(() => assertSafeInvocation('get', ['', '/x'])).toThrow(/both a cloud path and a local path/);
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
    // (`export <path>` alone only looks up an existing link.)
    expect(argv.filter((a) => a[0] === 'export' && a.length > 2)).toEqual([]);
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
    expect(argv.filter((a) => a[0] === 'export' && String(a[1]).startsWith('-')).map((a) => a[1])).toEqual(['-a', '-d']);
  });

  it('judges a shared folder by the name it is saved under, not "<email>:<name>"', async () => {
    const home = homedir();
    const get = tools(registerMutate, recording().rt).get('mega_get')!;
    expect((await get({ remotePath: '//from/a@b.c:.megaCmd', localDir: home })).isError).toBe(true);
    // (Also as Windows/exFAT/HFS+ would write it.)
    expect(localNamesOf('//from/a@b.c:Team')).toEqual(['a@b.c:Team', 'a@b.c%3aTeam', 'Team']);
    expect(localNamesOf('//from/a@b.c:Team/')).toEqual(['a@b.c:Team', 'a@b.c%3aTeam', 'Team']);
    expect(localNamesOf('a@b.c:Team')).toEqual(['a@b.c:Team', 'a@b.c%3aTeam', 'Team']);
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
      expect(argv.every((a) => a[0] === 'find' || isProbe(a)), tool).toBe(true);
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
      const { rt, argv } = recording((cmd, args) => (cmd === 'find' && args.includes('--type=d') && args[0] === '//from/a@b.c:Team' ? { stdout: 'H:DIR' } : {}));
      const put = tools(registerMutate, rt).get('mega_put')!;
      const rp = '//from/a@b.c:Team';
      const preview = await put({ localPath: join(dir, 'a.txt'), remotePath: rp });
      await put({ localPath: join(dir, 'a.txt'), remotePath: rp, confirm: token(preview) });
      expect(acting(argv).map((a) => a[0])).toEqual(['put']);
      // A folder that does not exist there would be taken by MEGAcmd as the upload's new name.
      expect(text(await put({ localPath: join(dir, 'a.txt'), remotePath: `${rp}/Missing` }))).toMatch(/not an existing folder/);
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
    const ok = await kill({ sessionId: 'AbCdEfGhIjk' });
    expect(ok.structuredContent).toMatchObject({ requiresConfirmation: true });
  });

  it('refuses to close this computer\'s own session by its ID, and says when it could not check', async () => {
    const listing = 'Current Active Sessions:\n    * Current Session\n    Session ID: OwnSess1234\n    -----\n    Session ID: OtherSess10\n    -----\n';
    const { rt, argv } = recording((cmd) => (cmd === 'whoami' ? { stdout: listing } : {}));
    const kill = tools(registerDangerous, rt).get('mega_killsession')!;
    const own = await kill({ sessionId: 'OwnSess1234' });
    expect(own.isError).toBe(true);
    expect(text(own)).toMatch(/mega_logout/);
    // The same handle spelled with the last character's spare bits set.
    expect((await kill({ sessionId: 'OwnSess1235' })).isError).toBe(true);
    const other = await kill({ sessionId: 'OtherSess10' });
    expect((other.structuredContent as { summary: string }).summary).toMatch(/not this computer's own session/);
    expect(argv.filter((a) => a[0] === 'killsession')).toEqual([]);
    const unknown = await tools(registerDangerous, recording((cmd) => (cmd === 'whoami' ? { code: 1 } : {})).rt).get('mega_killsession')!({ sessionId: 'OtherSess10' });
    expect((unknown.structuredContent as { summary: string }).summary).toMatch(/Could not check whether it is this computer's own session/);
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
      'Y29udGludWVk',
      '\tPublic key (+puEd255) = AAAA',
      '\tLast name (lastname) = Lee',
      '',
    ].join('\n');
    const res = await tools(registerContacts, recording(() => ({ stdout: out }), { exposeContacts: true }).rt).get('mega_userattr')!({});
    expect(text(res)).toContain('Ann');
    expect(text(res)).not.toMatch(/cHJpdmF0ZS1rZXk=|c2VjcmV0|keyring|\^!keys|Y29udGludWVk/);
    expect(text(res)).toContain('Lee');
    expect(text(res)).toMatch(/3 private or key attribute\(s\) not shown/);
  });
});

describe('MCP-4: previews say who will see the result, and what is replaced', () => {
  const listings = (cmd: string, args: string[]) => {
    if (cmd === 'share' && args.join(' ') === '-p /') {
      return { stdout: '/Team, shared with bob@example.com (read access)\n/Invited, shared (still pending) with carol@example.com (read access)\n' };
    }
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
    // A private destination asks nothing: the copy runs at once.
    const private_ = await cp({ src: '/Private/a.pdf', dst: '/Elsewhere' });
    expect(private_.isError).toBeFalsy();
    expect(private_.structuredContent).not.toMatchObject({ requiresConfirmation: true });
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
    // whoami -l, as printed by MEGAcmd 2.6.0 (mega_sessions shows this block): the
    // session ID is a handle for killsession, not a login, and is shown.
    const sessions = '    * Current Session\n    Session ID: AbCdEfGhIjK\n    IP: 192.0.2.1\n    -----';
    expect(scrubSecrets('whoami', ['-l'], sessions)).toBe(sessions);
    // The login session itself (logout --keep-session, the session command; neither is run).
    const token = 'A'.repeat(80);
    expect(scrubSecrets('logout', [], `You can also login with the session id: ${token}`)).not.toContain(token);
    expect(scrubSecrets('whoami', ['-l'], `Your (secret) session is: ${token}`)).not.toContain(token);
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
      const res = await get({ remotePath: '/Proj', localDir: home, usePcre: true, background: true });
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
    expect(acting(argv)).toEqual([['mkdir', '-p', '/Projects/* To sort']]);
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

describe('full-code review fixes', () => {
  const summary = (r: CallToolResult) => (r.structuredContent as { summary?: string } | undefined)?.summary ?? text(r);

  it('refuses "." and ".." path segments, which MEGAcmd resolves to another node', () => {
    for (const p of ['/./Public', '/Tmp/../Public', '/Photos/blurry/..', '/a/.']) {
      expect(() => assertRemotePath(p), p).toThrow(/"\." or "\.\."/);
    }
    for (const p of ['/a..b', '/.hidden', '/...', '/x/.megaCmdNotes']) expect(() => assertRemotePath(p), p).not.toThrow();
  });

  it('mega_mv with one listed source onto a file says it replaces it', async () => {
    const mv = tools(registerMutate, recording().rt).get('mega_mv')!;
    expect(summary(await mv({ srcs: ['/Junk/empty.txt'], dst: '/Important/thesis.docx' }))).toMatch(/existing FILE: it will be REPLACED/);
    expect(summary(await mv({ srcs: ['/a.txt', '/b.txt'], dst: '/Folder' }))).not.toMatch(/REPLACED/);
  });

  it('says when several items have the name an action uses, and voids the token if that changes', async () => {
    let copies = 2;
    const du = () => ({ stdout: ['FILENAME   SIZE', ...Array.from({ length: copies }, () => '/Tax Returns:   10 KB'), '-----', 'Total storage used:  20 KB'].join('\n') });
    const { rt, argv } = recording((cmd) => (cmd === 'du' ? du() : {}));
    const rm = tools(registerDangerous, rt).get('mega_rm')!;
    const preview = await rm({ remotePath: '/Tax Returns' });
    expect(summary(preview)).toMatch(/2 items are named \/Tax Returns - this acts on ALL of them/);
    copies = 3;
    const late = await rm({ remotePath: '/Tax Returns', confirm: (preview.structuredContent as { confirmToken: string }).confirmToken });
    expect(late.isError).toBe(true);
    expect(acting(argv).filter((a) => a[0] === 'rm')).toEqual([]);
  });

  it('mega_mkdir asks first inside a shared folder, and not elsewhere', async () => {
    const shared = (cmd: string, args: string[]) =>
      cmd === 'share' && args.join(' ') === '-p /' ? { stdout: '/Team, shared with bob@example.com (read access)\n' } : {};
    const { rt, argv } = recording(shared);
    const mkdir = tools(registerMutate, rt).get('mega_mkdir')!;
    const inside = await mkdir({ remotePath: '/Team/Q3 IBAN DE89' });
    expect(inside.structuredContent).toMatchObject({ requiresConfirmation: true });
    expect(summary(inside)).toMatch(/shared with other people/);
    await mkdir({ remotePath: '/Private/notes' });
    expect(acting(argv)).toEqual([['mkdir', '-p', '/Private/notes']]);
  });

  it('mega_cat never returns a recovery key, nor files that share a name', async () => {
    const key = 'AbCdEfGhIjKlMnOpQrStUv';
    const { rt } = recording((cmd) => (cmd === 'cat' ? { stdout: `${key}\n` } : {}));
    const cat = tools(registerCat, rt).get('mega_cat')!;
    expect(text(await cat({ remotePath: '/Backups/Downloads/MEGA-RECOVERYKEY.txt' }))).toMatch(/recovery key/);
    expect(text(await cat({ remotePath: '/Notes/renamed.txt' }))).toMatch(/recovery key/);
    expect(text(await cat({ remotePath: '/Notes/renamed.txt' }))).not.toContain(key);
    const dup = recording((cmd) => (cmd === 'du' ? { stdout: 'FILENAME SIZE\n/n.txt: 1\n/n.txt: 2\n-----\n' } : { stdout: 'hello' })).rt;
    expect(text(await tools(registerCat, dup).get('mega_cat')!({ remotePath: '/n.txt' }))).toMatch(/2 files are named/);
  });

  it('downloaded files cannot be made executable', async () => {
    const cfg = tools(registerConfig, recording().rt).get('mega_config')!;
    for (const value of ['700', '755', '601']) expect((await cfg({ setting: 'permissions', target: 'files', value })).isError, value).toBe(true);
    expect((await cfg({ setting: 'permissions', target: 'files', value: '600' })).isError).toBeFalsy();
    expect((await cfg({ setting: 'permissions', target: 'folders', value: '700' })).isError).toBeFalsy();
  });

  it('previews escape Unicode line breaks, C1 controls and bidi overrides', () => {
    expect(previewSafe('a\u2028b\u2029c\u0085d\u202Ee\u2066f')).toBe('a\\u2028b\\u2029c\\x85d\\u202ee\\u2066f');
    // Invisible text (zero-width, tag characters, variation selectors) is shown, not hidden.
    expect(previewSafe('Hi\u200b\u{E0041}\uFE0F 한글')).toBe('Hi\\u200b\\u{e0041}\\ufe0f 한글');
  });

  it('a thumbnail download onto an existing file says it replaces it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mega-thumb-'));
    try {
      writeFileSync(join(dir, 'settings.json'), '{}');
      const thumb = tools(registerMutate, recording().rt).get('mega_thumbnail')!;
      expect(summary(await thumb({ remotePath: '/p.jpg', localPath: join(dir, 'settings.json'), action: 'get' }))).toMatch(/REPLACING/);
      expect(summary(await thumb({ remotePath: '/p.jpg', localPath: join(dir, 'new.jpg'), action: 'get' }))).not.toMatch(/REPLACING/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('protects the whole macOS app bundle, not only Contents/MacOS', () => {
    publishMegacmdBinDir(null, ['/Applications/MEGAcmd.app/Contents/MacOS']);
    try {
      expect(() => assertLocalPath('/Applications/MEGAcmd.app/Contents/Frameworks/libavutil.dylib')).toThrow();
      expect(() => assertDownloadTarget('/Applications/MEGAcmd.app/Contents', 'Frameworks')).toThrow();
    } finally {
      publishMegacmdBinDir(null);
    }
  });

  it('a PCRE download is refused when a matched node was renamed after the preview', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-pcrerename-')));
    let name = 'payload';
    const { rt, argv } = recording((cmd, args) => {
      if (cmd !== 'find' || !args.includes('--use-pcre')) return {};
      return { stdout: args.includes('--print-only-handles') ? 'H:aaaaaaaa' : `/Share/${name} <H:aaaaaaaa>` };
    });
    try {
      const get = tools(registerMutate, rt).get('mega_get')!;
      const preview = await get({ remotePath: '/Share/p', localDir: dir, usePcre: true });
      name = '.megaCmd';
      const res = await get({ remotePath: '/Share/p', localDir: dir, usePcre: true, confirm: (preview.structuredContent as { confirmToken: string }).confirmToken });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/changed .* after the preview/);
      expect(argv.filter((a) => a[0] === 'get')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a .megaCmd copy anywhere in an uploaded or synced folder is left out or refused', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-storecopy-')));
    try {
      const me = join(dir, 'Backup', 'Users', 'me');
      mkdirSync(join(me, '.megaCmd'), { recursive: true });
      writeFileSync(join(me, '.megaCmd', 'session'), 'x');
      writeFileSync(join(me, 'notes.txt'), 'n');
      const plan = planUpload([join(dir, 'Backup')], '/Team');
      expect(plan.excluded.map((p) => p.split(/[\\/]/).pop())).toEqual(['.megaCmd']);
      for (const step of plan.steps) for (const src of step.sources) expect(src).not.toMatch(/\.megaCmd/);
      expect(() => assertNoStoreWithin(join(dir, 'Backup'), 'sync')).toThrow(/\.megaCmd/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a MEGAcmd that fails its signature check is reported as such', async () => {
    const rt = { ...recording().rt, ensureReady: async () => ({ loggedIn: false, reason: 'integrity_failed', detail: 'failed its signature check' }) } as unknown as Runtime;
    const res = await tools(registerWhoami, rt).get('mega_whoami')!({});
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/signature check/);
  });

  it('a pending share counts as shared in previews', async () => {
    const { rt } = recording((cmd, args) =>
      cmd === 'share' && args.join(' ') === '-p /' ? { stdout: '/Invited, shared (still pending) with carol@example.com (read access)\n' } : {},
    );
    const cp = tools(registerMutate, rt).get('mega_cp')!;
    expect(summary(await cp({ src: '/a.txt', dst: '/Invited' }))).toMatch(/shared with other people/);
  });
});

describe('second full-review fixes', () => {
  const summary = (r: CallToolResult) => (r.structuredContent as { summary?: string } | undefined)?.summary ?? text(r);
  const runtimeFor = (dir: string) =>
    createRuntime(
      { cacheDir: join(dir, 'cache'), appDir: join(dir, 'app'), systemAppBinDirs: [], download: { sha256Allow: [] }, maxListLines: 1000, exposeContacts: false, exposeAccountDetails: false, exposeFileContents: false } as Config,
      { resolve: async () => null, verify: async () => true },
    );

  it('a thumbnail is set only from an image, and the preview says who will see it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mega-thumbset-'));
    try {
      writeFileSync(join(dir, 'MEGA-RECOVERYKEY.txt'), 'AbCdEfGhIjKlMnOpQrStUv');
      writeFileSync(join(dir, 'pic.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]));
      const { rt } = recording((cmd, args) => (cmd === 'share' && args.join(' ') === '-p /' ? { stdout: '/Team, shared with bob@example.com (read access)\n' } : {}));
      const thumb = tools(registerMutate, rt).get('mega_thumbnail')!;
      expect(text(await thumb({ remotePath: '/Team/a.jpg', localPath: join(dir, 'MEGA-RECOVERYKEY.txt'), action: 'set' }))).toMatch(/not a JPEG, PNG, GIF or WebP/);
      expect(summary(await thumb({ remotePath: '/Team/a.jpg', localPath: join(dir, 'pic.jpg'), action: 'set' }))).toMatch(/inside \/Team, which is shared/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mega_cat refuses a recovery key among other lines, and a version of the key file', async () => {
    const { rt } = recording((cmd) => (cmd === 'cat' ? { stdout: 'My MEGA recovery key:\nAbCdEfGhIjKlMnOpQrStUv\n' } : {}));
    const cat = tools(registerCat, rt).get('mega_cat')!;
    expect(text(await cat({ remotePath: '/Notes/keys.txt' }))).toMatch(/recovery key/);
    expect(text(await cat({ remotePath: '/D/MEGA-RECOVERYKEY.txt#1700000000' }))).toMatch(/recovery key/);
    // By name before anything is read: translated names, a browser's " (1)", a trailing slash.
    const unread = recording((cmd) => (cmd === 'cat' ? { stdout: 'note' } : {}));
    const catByName = tools(registerCat, unread.rt).get('mega_cat')!;
    for (const name of ['MEGA-RETTUNGSSCHLUESSEL.txt', 'MEGA-回復キー (1).txt', 'mega-recoverykey.TXT', 'MEGA-RECOVERYKEY.txt/']) {
      expect(text(await catByName({ remotePath: `/D/${name}` })), name).toMatch(/recovery key/);
    }
    expect(unread.argv.filter((a) => a[0] === 'cat')).toEqual([]);
    // A lowercase-only 22-character line is an ordinary word list entry, not a key.
    const plain = recording((cmd) => (cmd === 'cat' ? { stdout: 'abcdefghijklmnopqrstuv\nhello' } : {})).rt;
    expect(text(await tools(registerCat, plain).get('mega_cat')!({ remotePath: '/n.txt' }))).toContain('hello');
  });

  it('share listings are scrubbed like users listings', () => {
    expect(scrubSecrets('share', ['-p', '/'], '/x (folder link: https://mega.nz/folder/a#b AuthKey=SECRET)')).not.toContain('SECRET');
  });

  it('downloads and syncs say when MEGAcmd will make downloaded files executable', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-execperm-')));
    try {
      const perms = (v: string) => (cmd: string) => (cmd === 'permissions' ? { stdout: `Default files permissions: ${v}\n` } : {});
      const get = tools(registerMutate, recording(perms('755')).rt).get('mega_get')!;
      const warned = await get({ remotePath: '/a.txt', localDir: dir });
      if (process.platform !== 'win32') {
        expect(warned.isError).toBeFalsy();
        expect((warned.structuredContent as { summary: string }).summary).toMatch(/EXECUTABLE: MEGAcmd's file permissions are 755/);
      }
      const ok600 = tools(registerMutate, recording(perms('600')).rt).get('mega_get')!;
      const plain = await ok600({ remotePath: '/a.txt', localDir: dir });
      expect(plain.isError).toBeFalsy();
      expect((plain.structuredContent as { summary: string }).summary).not.toMatch(/EXECUTABLE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('protects ~/.claude.json and the connector\'s own folder', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-hostcfg-')));
    try {
      runtimeFor(dir);
      expect(() => assertDownloadTarget(homedir(), '.claude.json')).toThrow();
      expect(() => assertDownloadTarget(join(dir, 'app'), 'dist')).toThrow();
      expect(() => assertDownloadTarget(dir, 'elsewhere')).not.toThrow();
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('refuses a download into a folder holding a symlink to a protected folder', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-symlinkin-')));
    try {
      runtimeFor(dir);
      mkdirSync(join(dir, 'cache'), { recursive: true });
      mkdirSync(join(dir, 'dl'));
      symlinkSync(join(dir, 'cache'), join(dir, 'dl', 'cfg'));
      expect(() => assertDownloadTarget(join(dir, 'dl'), null)).toThrow(/cfg ->/);
      expect(() => assertDownloadTarget(dir, 'dl')).toThrow(/cfg ->/);
      expect(() => assertDownloadTarget(dir, 'other')).not.toThrow();
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('megacmd_setup reports a MEGAcmd that fails its check, and how to fix it', async () => {
    const rt = {
      ...recording().rt,
      invalidateResolved: () => {},
      getResolved: async () => ({ source: 'system', binDir: '/Applications/MEGAcmd.app/Contents/MacOS' }),
      ensureReady: async () => ({ loggedIn: false, reason: 'integrity_failed', detail: 'failed its signature check' }),
      config: { ...recording().rt.config, download: { url: 'https://mega.nz/MEGAcmdSetup.dmg', version: '2.6.0', sha256Allow: [] } },
    } as unknown as Runtime;
    const res = await tools(registerSetup, rt).get('megacmd_setup')!({});
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/failed its signature check/);
  });
});

describe('second full-review fixes, previews', () => {
  const summary = (r: CallToolResult) => (r.structuredContent as { summary?: string } | undefined)?.summary ?? text(r);
  const token = (r: CallToolResult) => (r.structuredContent as { confirmToken: string }).confirmToken;

  it('paths with line breaks, empty segments or (as destinations) version names are refused', () => {
    for (const p of ['/Archive\n(nothing leaves)', '/a\u2028b', '/Shared//inbox']) expect(() => assertRemotePath(p), JSON.stringify(p)).toThrow();
    expect(() => assertRemotePath('//from/a@b.c:Team/x')).not.toThrow();
    expect(() => assertRemotePath('/Docs/report.pdf#1700000000')).not.toThrow(); // a version, as a source
    expect(() => assertRemoteDest('/Orders/Order#2024051201')).toThrow(/version/);
    expect(() => assertLocalPath('/tmp/a\nFAKE')).toThrow(/line breaks/);
  });

  // MEGAcmd resolves `name#<10 digits>` as a VERSION of `name`, and a version keeps
  // its own name - an older one, whatever the file was called before a rename.
  it('a file version is downloaded under the plain name, by an explicit path', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-getver-')));
    try {
      const { rt, argv } = recording();
      const get = tools(registerMutate, rt).get('mega_get')!;
      const preview = await get({ remotePath: '/Docs/readme.txt#1700000000', localDir: dir });
      expect(summary(preview)).toContain(`saved as ${join(dir, 'readme.txt')}`);
      const res = await get({ remotePath: '/Docs/readme.txt#1700000000', localDir: dir, confirm: token(preview) });
      expect(res.isError).toBeFalsy();
      expect(acting(argv).filter((a) => a[0] === 'get')).toEqual([['get', '/Docs/readme.txt#1700000000', join(dir, 'readme.txt')]]);
      // Onto an existing folder it would land INSIDE it under the version's own name.
      mkdirSync(join(dir, 'notes'));
      expect(text(await get({ remotePath: '/Docs/notes#1700000000', localDir: dir }))).toMatch(/is a folder/);
      expect((await get({ remotePath: '/Docs/a.txt#1700000000/b', localDir: dir })).isError).toBe(true);
      expect((await get({ remotePath: '/Docs/a.txt#1700000000', localDir: dir, merge: true })).isError).toBe(true);
      // The plain name gets the landing checks.
      expect((await get({ remotePath: '/Docs/.megaCmd#1700000000', localDir: dir })).isError).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a file version is copied or moved alone, onto an explicit plain name; lists refuse one', async () => {
    const reply = (cmd: string, args: string[]) =>
      cmd === 'find' && args[0] === '/Synced' ? { stdout: 'H:dddd\n' } : cmd === 'find' && args[0] === '/Synced/notes' ? { stdout: 'H:nnnn\n' } : cmd === 'find' && args[0].startsWith('/Synced/') ? { code: 53 } : {};
    const { rt, argv } = recording(reply);
    const t = tools(registerMutate, rt);
    for (const [tool, args] of [
      ['mega_cp', { srcs: ['/Docs/a.txt', '/Docs/readme.txt#1700000000'], dst: '/Synced' }],
      ['mega_mv', { srcs: ['/Docs/readme.txt#1700000000'], dst: '/Synced' }],
    ] as const) {
      const res = await t.get(tool)!(args);
      expect(res.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(text(res)).toMatch(/file version/);
    }
    // Alone: the version lands as /Synced/readme.txt, whatever it was called then.
    const cp = await t.get('mega_cp')!({ src: '/Docs/readme.txt#1700000000', dst: '/Synced' });
    expect(cp.isError, text(cp)).toBeFalsy();
    expect(argv.filter((a) => a[0] === 'cp')).toEqual([['cp', '/Docs/readme.txt#1700000000', '/Synced/readme.txt']]);
    // MEGA does not move an older version (measured): refused, pointing to a copy.
    expect(text(await t.get('mega_mv')!({ src: '/Docs/readme.txt#1700000000', dst: '/Synced' }))).toMatch(/copy it with mega_cp/);
    // Onto an existing folder it would land inside it under its own name again.
    expect(text(await t.get('mega_cp')!({ src: '/Docs/notes#1700000000', dst: '/Synced' }))).toMatch(/is a folder/);
  });

  it('mega_get says when several items share the name it downloads', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-getdup-')));
    try {
      const { rt } = recording((cmd) => (cmd === 'du' ? { stdout: 'FILENAME SIZE\n/Shared/invoice.pdf: 1\n/Shared/invoice.pdf: 2\n-----\n' } : {}));
      const get = tools(registerMutate, rt).get('mega_get')!;
      expect(summary(await get({ remotePath: '/Shared/invoice.pdf', localDir: dir }))).toMatch(/2 items are named/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a password link is refused when several items share the name', async () => {
    const { rt } = recording((cmd) => (cmd === 'du' ? { stdout: 'FILENAME SIZE\n/Tax: 1\n/Tax: 2\n-----\n' } : {}));
    const exp = tools(registerDangerous, rt).get('mega_export')!;
    expect(text(await exp({ remotePath: '/Tax', action: 'create', password: 'pw' }))).toMatch(/one item at a time/);
  });

  it('setting an attribute on a shared node says who will see it', async () => {
    const { rt } = recording((cmd, args) => (cmd === 'share' && args.join(' ') === '-p /' ? { stdout: '/Team, shared with bob@example.com (read access)\n' } : {}));
    const set = tools(registerManage, rt).get('mega_attr_set')!;
    expect(summary(await set({ remotePath: '/Team/doc', attribute: 'note', action: 'set', value: 'x' }))).toMatch(/inside \/Team, which is shared/);
  });

  it('reads an exported folder that also has a pending share, and fails closed on a broken listing', async () => {
    const both = recording((cmd, args) =>
      cmd === 'export' && args.join(' ') === '/'
        ? { stdout: '/Pub (folder, shared (still pending) with c@example.com (read access), shared as exported permanent folder link: https://mega.nz/folder/x#y)\n' }
        : {},
    ).rt;
    const cp = tools(registerMutate, both).get('mega_cp')!;
    expect(summary(await cp({ src: '/a.txt', dst: '/Pub' }))).toMatch(/has a public link/);
    const broken = recording((cmd, args) => (cmd === 'share' && args.join(' ') === '-p /' ? { stdout: '/Te\nam, shared with bob@example.com (read access)\n' } : {})).rt;
    const cp2 = tools(registerMutate, broken).get('mega_cp')!;
    expect(summary(await cp2({ src: '/a.txt', dst: '/Team' }))).toMatch(/Could not check/);
  });

  it('mega_cp voids its token when the destination became a file after the preview', async () => {
    let isFile = false;
    const { rt, argv } = recording((cmd, args) =>
      cmd === 'find' && args.includes('--type=d') && args.includes('--print-only-handles')
        ? { stdout: isFile ? '' : 'H:DIR' }
        : cmd === 'share' && args.join(' ') === '-p /'
          ? { stdout: '/Docs, shared with bob@example.com (read access)\n' }
          : {},
    );
    const cp = tools(registerMutate, rt).get('mega_cp')!;
    const preview = await cp({ src: '/a.txt', dst: '/Docs/thesis.docx' });
    expect(preview.structuredContent).toMatchObject({ requiresConfirmation: true });
    isFile = true;
    const res = await cp({ src: '/a.txt', dst: '/Docs/thesis.docx', confirm: token(preview) });
    expect(res.isError).toBe(true);
    expect(argv.filter((a) => a[0] === 'cp')).toEqual([]);
  });
});

describe('design-conflict review fixes', () => {
  it('host configuration and the connector folder are write-protected only: uploads from them work', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-writeonly-')));
    try {
      createRuntime(
        { cacheDir: join(dir, 'cache'), appDir: join(dir, 'app'), systemAppBinDirs: [], download: { sha256Allow: [] }, maxListLines: 1000, exposeContacts: false, exposeAccountDetails: false, exposeFileContents: false } as Config,
        { resolve: async () => null, verify: async () => true },
      );
      expect(() => assertLocalPath(join(homedir(), '.claude', 'CLAUDE.md'))).not.toThrow();
      expect(() => assertLocalPath(join(dir, 'app', 'README.md'))).not.toThrow();
      expect(() => assertDownloadTarget(join(homedir(), '.claude'), 'settings.json')).toThrow(/configuration folder/);
      expect(() => assertDownloadTarget(dir, 'app')).toThrow();
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a thumbnail download into a host configuration folder is refused', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-thumbcfg-')));
    try {
      publishMegacmdBinDir(null, [], [join(dir, 'cfg')]);
      const thumb = tools(registerMutate, recording().rt).get('mega_thumbnail')!;
      expect((await thumb({ remotePath: '/p.jpg', localPath: join(dir, 'cfg', 'settings.json'), action: 'get' })).isError).toBe(true);
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a listed move checks all its sources with one du and one find', async () => {
    const du = (args: string[]) => ({
      stdout: ['FILENAME SIZE', ...args.filter((a) => a.startsWith('/')).flatMap((p) => (p === '/Tax' ? [`${p}:   1`, `${p}:   2`] : [`${p}:   1`])), '-----'].join('\n'),
    });
    const folder = (cmd: string, args: string[]) => (cmd === 'find' && args.includes('--print-only-handles') ? { stdout: 'H:DIR' } : {});
    const { rt, argv } = recording((cmd, args) => (cmd === 'du' ? du(args) : folder(cmd, args)));
    const mv = tools(registerMutate, rt).get('mega_mv')!;
    const res = await mv({ srcs: ['/a.txt', '/Tax', '/b.txt'], dst: '/Archive' });
    expect((res.structuredContent as { summary: string }).summary).toMatch(/2 items are named \/Tax/);
    // One du for all the sources (the other one counts the destination's items).
    expect(argv.filter((a) => a[0] === 'du' && a.length > 3)).toHaveLength(1);
    const keyFind = (a: string[]) => a.some((x) => x === '--pattern=????-*' || x === '--pattern=*-????*');
    expect(argv.filter((a) => a[0] === 'find' && !a.includes('--print-only-handles') && !keyFind(a))).toHaveLength(1);
    // The recovery-key search is batched too: one find per name pattern for all the sources.
    expect(argv.filter((a) => a[0] === 'find' && keyFind(a))).toHaveLength(2);
    // What the sources hold is bound with one find for all of them, not one per item.
    expect(argv.filter((a) => a[0] === 'find' && a.includes('--print-only-handles') && !a.includes('--type=d'))).toHaveLength(1);
  });
});

describe('sync exclusions instead of refusals', () => {
  it('appends missing rules to an existing .megaignore, once, and leaves protected folders out by path', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-syncexcl-')));
    try {
      mkdirSync(join(dir, '.megaCmd'));
      mkdirSync(join(dir, 'cfg'));
      writeFileSync(join(dir, '.megaignore'), '-:*.tmp');
      publishMegacmdBinDir(null, [], [join(dir, 'cfg')]);
      const { rt } = recording();
      const add = tools(registerSync, rt).get('mega_sync_add')!;
      for (let i = 0; i < 2; i++) {
        const preview = await add({ localPath: dir, remotePath: '/x' });
        expect((preview.structuredContent as { summary: string }).summary).toMatch(/Never synced/);
        await add({ localPath: dir, remotePath: '/x', confirm: (preview.structuredContent as { confirmToken: string }).confirmToken });
      }
      const ignore = readFileSync(join(dir, '.megaignore'), 'utf8');
      expect(ignore.startsWith('-:*.tmp\n')).toBe(true);
      expect(ignore.match(/-dng:\.megacmd\*/g)).toHaveLength(1);
      expect(ignore).toContain('-apg:cfg');
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a sync of a folder inside a protected one is still refused', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-syncin-')));
    try {
      mkdirSync(join(dir, 'cfg', 'sub'), { recursive: true });
      publishMegacmdBinDir(null, [], [join(dir, 'cfg')]);
      const add = tools(registerSync, recording().rt).get('mega_sync_add')!;
      expect((await add({ localPath: join(dir, 'cfg', 'sub'), remotePath: '/x' })).isError).toBe(true);
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mega_cp asks only when needed, and copies in bulk', () => {
  const shared = (cmd: string, args: string[]) =>
    cmd === 'share' && args.join(' ') === '-p /' ? { stdout: '/Team, shared with bob@example.com (read access)\n' } : cmd === 'find' && args.includes('--print-only-handles') && args.includes('--type=d') ? { stdout: 'H:DIR' } : {};

  it('copies between private folders at once, and a list in one command', async () => {
    const { rt, argv } = recording(shared);
    const cp = tools(registerMutate, rt).get('mega_cp')!;
    expect((await cp({ src: '/a.txt', dst: '/Archive' })).structuredContent).not.toMatchObject({ requiresConfirmation: true });
    await cp({ srcs: ['/a.txt', '/b.txt'], dst: '/Archive' });
    expect(acting(argv).filter((a) => a[0] === 'cp')).toEqual([
      ['cp', '/a.txt', '/Archive'],
      ['cp', '/a.txt', '/b.txt', '/Archive'],
    ]);
  });

  it('asks first for a shared destination, for a list and for a pattern', async () => {
    const listing = '/Docs/a.pdf <H:aaaaaaaa>\n/Docs/b.pdf <H:bbbbbbbb>';
    const { rt, argv } = recording((cmd, args) =>
      cmd === 'find' && args.includes('--use-pcre') ? { stdout: args.includes('--print-only-handles') ? 'H:aaaaaaaa\nH:bbbbbbbb' : listing } : shared(cmd, args),
    );
    const cp = tools(registerMutate, rt).get('mega_cp')!;
    const list = await cp({ srcs: ['/a.txt', '/b.txt'], dst: '/Team' });
    expect(list.structuredContent).toMatchObject({ requiresConfirmation: true });
    const pcre = await cp({ src: '/Docs/.*\\.pdf$', usePcre: true, dst: '/Team/in' });
    expect((pcre.structuredContent as { summary: string }).summary).toMatch(/copy 2 node\(s\)[\s\S]*inside \/Team, which is shared/);
    const done = await cp({ src: '/Docs/.*\\.pdf$', usePcre: true, dst: '/Team/in', confirm: (pcre.structuredContent as { confirmToken: string }).confirmToken });
    expect(done.isError).toBeFalsy();
    expect(acting(argv).filter((a) => a[0] === 'cp')).toEqual([['cp', 'H:aaaaaaaa', 'H:bbbbbbbb', '/Team/in']]);
  });
});

describe('round 4 fixes', () => {
  const summary = (r: CallToolResult) => (r.structuredContent as { summary?: string } | undefined)?.summary ?? text(r);
  const isFolderProbe = (cmd: string, args: string[]) => cmd === 'find' && args.includes('--type=d') && args.includes('--print-only-handles');

  it('several sources need an existing destination folder (a batch could otherwise replace a file)', async () => {
    const { rt, argv } = recording((cmd, args) => (isFolderProbe(cmd, args) ? { stdout: '' } : {}));
    const m = tools(registerMutate, rt);
    expect(text(await m.get('mega_cp')!({ srcs: ['/a', '/b'], dst: '/Important.docx' }))).toMatch(/needs an existing destination folder/);
    expect(text(await m.get('mega_mv')!({ srcs: ['/a', '/b'], dst: '/Important.docx' }))).toMatch(/needs an existing destination folder/);
    expect(argv.filter((a) => a[0] === 'cp' || a[0] === 'mv')).toEqual([]);
  });

  it('a copy onto a same-named file in the folder asks first (it becomes a new version)', async () => {
    const { rt, argv } = recording((cmd, args) =>
      isFolderProbe(cmd, args) ? { stdout: args[0] === '/Work/report.docx' ? '' : 'H:DIR' } : cmd === 'ls' && args.length === 1 ? { stdout: 'report.docx\nother.txt\n' } : {},
    );
    const cp = tools(registerMutate, rt).get('mega_cp')!;
    const res = await cp({ src: '//from/eve@example.com:Share/report.docx', dst: '/Work' });
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
    expect(summary(res)).toMatch(/\/Work\/report\.docx already exists: the copy becomes its new version/);
    expect(argv.filter((a) => a[0] === 'cp')).toEqual([]);
  });

  it('a copy into a two-way synced folder asks first and names the local path', async () => {
    const { rt } = recording((cmd, args) =>
      cmd === 'sync' ? { stdout: 'LOCALPATH;;MEGA-MCP;;REMOTEPATH;;MEGA-MCP;;RUN_STATE\n/Users/me;;MEGA-MCP;;/Home;;MEGA-MCP;;Running\n' } : isFolderProbe(cmd, args) ? { stdout: 'H:DIR' } : {},
    );
    const res = await tools(registerMutate, rt).get('mega_cp')!({ src: '/a.plist', dst: '/Home/Library/LaunchAgents' });
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
    expect(summary(res)).toMatch(/written to this computer, at \/Users\/me\/Library\/LaunchAgents/);
  });

  it('a lookalike spelling of a shared folder reaches the same checks (NFC)', async () => {
    const kelvin = '/\u212Aids';
    expect(assertRemotePath(kelvin)).toBe('/Kids');
    const { rt } = recording((cmd, args) => (cmd === 'share' && args.join(' ') === '-p /' ? { stdout: '/Kids, shared with eve@example.com (read access)\n' } : isFolderProbe(cmd, args) ? { stdout: 'H:DIR' } : {}));
    const res = await tools(registerMutate, rt).get('mega_cp')!({ src: '/Private/passport.pdf', dst: kelvin });
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
  });

  it('sharing a folder names what was copied into it earlier without a confirmation', async () => {
    const { rt } = recording((cmd, args) => (isFolderProbe(cmd, args) ? { stdout: 'H:DIR' } : {}));
    await tools(registerMutate, rt).get('mega_cp')!({ src: '/Private/passport.pdf', dst: '/Trip' });
    const share = await tools(registerDangerous, rt).get('mega_share')!({ action: 'add', remotePath: '/Trip', withEmail: 'a@example.com' });
    expect(summary(share)).toMatch(/without a confirmation:[\s\S]*\/Trip\/passport\.pdf/);
  });

  it('a copy or folder in the Rubbish Bin runs at once, as in MEGA\'s web app (owner decision)', async () => {
    const { rt, argv } = recording((cmd, args) => (isFolderProbe(cmd, args) ? { stdout: 'H:DIR' } : {}));
    const t = tools(registerMutate, rt);
    expect((await t.get('mega_cp')!({ src: '/a.txt', dst: '//bin/old' })).structuredContent).not.toMatchObject({ requiresConfirmation: true });
    expect((await t.get('mega_mkdir')!({ remotePath: '//bin/old/new' })).structuredContent).not.toMatchObject({ requiresConfirmation: true });
    expect(argv.filter((a) => a[0] === 'cp' || a[0] === 'mkdir').length).toBe(2);
  });

  it('mega_sync_ignore cannot undo the exclusions the connector writes', async () => {
    const S = ';;MEGA-MCP;;';
    const { rt, argv } = recording((cmd, args) =>
      cmd === 'sync' && args[0] === '--show-handles'
        ? { stdout: `ID${S}LOCALPATH${S}REMOTEHANDLE${S}REMOTEPATH${S}RUN_STATE\nAbC1${S}/Users/me/W${S}<H:Abcd1234>${S}/W${S}Running\n` }
        : cmd === 'share' && args.join(' ') === '-p /'
          ? { stdout: '/W/Team, shared with eve@x.y (read access)\n' }
          : {},
    );
    const ign = tools(registerSync, rt).get('mega_sync_ignore')!;
    for (const [action, filter] of [['add', '+d:.megaCmd'], ['add', '+:*'], ['remove-exclusion', 'dng:.megacmd*'], ['remove-exclusion', 'apg:.claude'], ['remove-exclusion', 'sync:.megaignore']]) {
      expect((await ign({ action, target: 'AbC1', filters: [filter] })).isError, filter).toBe(true);
    }
    const removal = await ign({ action: 'remove-exclusion', target: 'AbC1', filters: ['f:*.tmp'] });
    expect(removal.isError).toBeFalsy();
    // The preview names both sides of the sync, and that what the rule kept out is synced now.
    expect((removal.structuredContent as { summary: string }).summary).toMatch(/between \/Users\/me\/W and \/W[\s\S]*uploaded to \/W/);
    // ...including shared or linked folders inside the sync, which receive them too.
    expect((removal.structuredContent as { summary: string }).summary).toMatch(/\/W\/Team, inside \/W, is shared with other people/);
    expect(argv.filter((a) => a[0] === 'sync-ignore')).toEqual([]);
  });

  it('protected folders deeper than the sync root are left out by their own path, not their top-level folder', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-deepexcl-')));
    try {
      mkdirSync(join(dir, 'Library', 'Application Support', 'Claude'), { recursive: true });
      mkdirSync(join(dir, '.claude'));
      publishMegacmdBinDir(null, [], [join(dir, 'Library', 'Application Support', 'Claude'), join(dir, '.claude')]);
      const rules = syncExclusions(dir).map((e) => e.rule);
      expect(rules).toContain('-apg:Library/Application Support/Claude');
      expect(rules).toContain('-apg:.claude');
      expect(rules).not.toContain('-apg:Library');
      if (process.platform === 'darwin') {
        // The firmlink spelling of the same folder gets the same rules.
        expect(syncExclusions(`/System/Volumes/Data${dir}`).map((e) => e.rule).sort()).toEqual([...rules].sort());
      }
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a deeper item under a folder whose name has " (" is left out by its full path', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-parenexcl-')));
    try {
      mkdirSync(join(dir, 'Backups (old)', '.megaCmd'), { recursive: true });
      mkdirSync(join(dir, 'Work (2026)', 'claude'), { recursive: true });
      publishMegacmdBinDir(null, [], [join(dir, 'Work (2026)', 'claude')]);
      const ex = syncExclusions(dir);
      const rules = ex.map((e) => e.rule);
      expect(rules).toContain('-apg:Backups (old)/.megaCmd');
      expect(rules).toContain('-apg:Work (2026)/claude');
      expect(rules).not.toContain('-apg:Backups (old)');
      expect(ex.find((e) => e.rule === '-apg:Work (2026)/claude')?.label).toBe('Work (2026)/claude');
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the exclusion block always ends the .megaignore, with -sync:.megaignore', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-blocklast-')));
    try {
      mkdirSync(join(dir, '.megaCmd'));
      writeFileSync(join(dir, '.megaignore'), '-dng:.megacmd*\n+:*\n');
      const { rt } = recording();
      const add = tools(registerSync, rt).get('mega_sync_add')!;
      const preview = await add({ localPath: dir, remotePath: '/x' });
      await add({ localPath: dir, remotePath: '/x', confirm: (preview.structuredContent as { confirmToken: string }).confirmToken });
      const lines = readFileSync(join(dir, '.megaignore'), 'utf8').trim().split('\n');
      expect(lines.at(-1)).toBe('-sync:.megaignore');
      expect(lines.lastIndexOf('-dng:.megacmd*')).toBeGreaterThan(lines.indexOf('+:*'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a .megaignore is never written into a synced folder, nor over a file by a thumbnail', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-ignorefile-')));
    try {
      const synced = recording((cmd) => (cmd === 'sync' ? { stdout: `LOCALPATH;;MEGA-MCP;;REMOTEPATH;;MEGA-MCP;;RUN_STATE\n${dir};;MEGA-MCP;;/W;;MEGA-MCP;;Running\n` } : {})).rt;
      const get = tools(registerMutate, synced).get('mega_get')!;
      expect(text(await get({ remotePath: '/X/.megaignore', localDir: dir }))).toMatch(/\.megaignore/);
      // Outside any sync it is an ordinary file.
      const other = realpathSync(mkdtempSync(join(tmpdir(), 'mega-ignorefree-')));
      try {
        expect((await tools(registerMutate, recording().rt).get('mega_get')!({ remotePath: '/X/.megaignore', localDir: other })).isError).toBeFalsy();
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
      const thumb = tools(registerMutate, recording().rt).get('mega_thumbnail')!;
      expect((await thumb({ remotePath: '/p.jpg', localPath: join(dir, '.MegaIgnore'), action: 'get' })).isError).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a synced folder is recognised in any spelling of its path', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-ignorecase-')));
    try {
      mkdirSync(join(dir, 'Projects'));
      const synced = recording((cmd) => (cmd === 'sync' ? { stdout: `LOCALPATH;;MEGA-MCP;;REMOTEPATH;;MEGA-MCP;;RUN_STATE\n${dir};;MEGA-MCP;;/W;;MEGA-MCP;;Running\n` } : {})).rt;
      const get = tools(registerMutate, synced).get('mega_get')!;
      const spellings = [join(dir, 'Projects')];
      if (process.platform === 'darwin') spellings.push(join(dir.toUpperCase(), 'Projects'), `/System/Volumes/Data${dir}/Projects`);
      for (const localDir of spellings) {
        expect(text(await get({ remotePath: '/X/.megaignore', localDir })), localDir).toMatch(/\.megaignore/);
        // A name APFS reads as .megaignore too.
        expect((await get({ remotePath: '/X/.MEGAIGNORE', localDir })).isError, localDir).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a protected folder that does not exist yet cannot be created through another spelling', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-missingroot-')));
    try {
      publishMegacmdBinDir(null, [], [join(dir, '.codex'), join(dir, '.claude.json'), join(dir, 'tools', 'codex')]);
      expect(() => assertDownloadTarget(dir, '.codex')).toThrow();
      // Long s, and ß/ligatures, are the same letters to APFS.
      expect(() => assertDownloadTarget(dir, '.claude.j\u017fon')).toThrow();
      expect(() => assertDownloadTarget(dir, '.claude.json')).toThrow();
      expect(() => assertDownloadTarget(dir, 'tools')).toThrow();
      expect(() => assertDownloadTarget(dir, 'notes')).not.toThrow();
      if (process.platform === 'darwin') {
        const firm = `/System/Volumes/Data${dir}`;
        expect(() => assertDownloadTarget(firm, '.codex')).toThrow();
        expect(() => assertDownloadTarget(firm, 'tools')).toThrow();
        expect(() => assertDownloadTarget(dirname(firm), basename(dir))).toThrow();
        // The local path itself is taken in the usual spelling.
        expect(assertLocalPath(join(firm, 'x'))).toBe(join(dir, 'x'));
      }
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an upload through a symlink is searched like the folder it leads to', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-uplink-')));
    try {
      const home = join(dir, 'home');
      mkdirSync(join(home, 'old', '.megaCmd'), { recursive: true });
      mkdirSync(join(dir, 'ext', 'oldhome', '.megaCmd'), { recursive: true });
      writeFileSync(join(home, 'a.txt'), 'a');
      symlinkSync(home, join(dir, 'homelink'));
      symlinkSync(join(dir, 'ext'), join(home, 'Backups'));
      // A link to the folder: the copy inside is left out, as for the folder itself.
      const viaLink = planUpload([join(dir, 'homelink')], '/B');
      expect(viaLink.excluded.map((p) => basename(p))).toContain('.megaCmd');
      expect(viaLink.steps.flatMap((s) => s.sources)).not.toContain(join(dir, 'homelink'));
      // A link INSIDE a rebuilt folder is not followed (a whole-folder put skips it).
      const plan = planUpload([home], '/B');
      expect(plan.steps.flatMap((s) => s.sources)).not.toContain(join(home, 'Backups'));
      expect(plan.links).toEqual([join(home, 'Backups')]);
      expect(plan.steps.flatMap((s) => s.sources)).toContain(join(home, 'a.txt'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a leading "//Name" is refused: MEGAcmd reads it as "/Name", a different string to every check', async () => {
    for (const p of ['//Projects/x', '//Team Docs', '//bin//x', '//from//x']) expect(() => assertRemotePath(p), p).toThrow(/empty segment/);
    for (const p of ['//bin', '//bin/x', '//in/x', '//from/a@b.c:Team/x']) expect(() => assertRemotePath(p), p).not.toThrow();
    const { rt, argv } = recording();
    const mkdir = tools(registerMutate, rt).get('mega_mkdir')!;
    for (const remotePath of ['//in/x', '//from/a@b.c:Team/x']) {
      expect(text(await mkdir({ remotePath })), remotePath).toMatch(/cannot create folders under \/\/in or \/\/from/);
    }
    expect(argv.filter((a) => a[0] === 'mkdir')).toEqual([]);
  });

  it('pattern matches are compared as absolute paths: in-share matches as //from/..., relative patterns refused', async () => {
    const shared = 'bob@x.y:Team/a.txt <H:aaaa>\n';
    const { rt } = recording((cmd, args) => (cmd === 'find' ? { stdout: args.includes('--print-only-handles') ? 'H:aaaa\n' : shared } : {}));
    const rm = tools(registerDangerous, rt).get('mega_rm')!;
    expect(summary(await rm({ remotePath: '//from/bob@x.y:Team/.*', usePcre: true }))).toContain('//from/bob@x.y:Team/a.txt <H:aaaa>');
    const rel = recording((cmd, args) => (cmd === 'find' ? { stdout: args.includes('--print-only-handles') ? 'H:aaaa\n' : 'Team Docs/a.txt <H:aaaa>\n' } : {}));
    expect((await tools(registerDangerous, rel.rt).get('mega_rm')!({ remotePath: '/Team Docs/.*', usePcre: true })).isError).toBe(true);
    const { rt: rt2, argv } = recording();
    const res = await tools(registerDangerous, rt2).get('mega_export')!({ remotePath: 'Team Docs', usePcre: true, action: 'create' });
    expect(text(res)).toMatch(/must start with "\/"/);
    expect(argv).toEqual([]);
  });

  it('a password link that could not be withdrawn is reported as still public', async () => {
    const { rt } = recording((cmd, args) => (cmd === 'export' && args[0] === '-a' ? { stdout: 'Exported /x: https://mega.nz/file/abc#key' } : cmd === 'export' && args[0] === '-d' ? { code: 1 } : {}));
    const ex = tools(registerDangerous, rt).get('mega_export')!;
    const preview = await ex({ remotePath: '/x', action: 'create', password: 'pw' });
    const res = await ex({ remotePath: '/x', action: 'create', password: 'pw', confirm: token(preview) });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/removing it again FAILED/);
    expect(text(res)).not.toMatch(/Nothing is published/);
  });

  it('export status does not hand out a link that publishes a session-store copy', async () => {
    const { rt } = recording((cmd, args) =>
      cmd === 'export' ? { stdout: '/Backup (folder, shared as exported permanent folder link: https://mega.nz/folder/abc#key)' } : cmd === 'find' && args.includes('--type=d') ? { stdout: '/Backup\n/Backup/home/.megaCmd\n' } : {},
    );
    const res = await tools(registerDangerous, rt).get('mega_export')!({ remotePath: '/Backup', action: 'status' });
    expect(res.isError).toBe(true);
    expect(text(res)).not.toMatch(/mega\.nz/);
    expect(text(res)).toMatch(/action "delete"/);
  });

  it('a file in someone else\'s shared folder is still said to be replaced', async () => {
    const { rt } = recording((cmd) => (cmd === 'find' ? { stdout: '' } : {}));
    const notes = await destinationNotes(rt, '//from/a@b.c:Team/f.txt', { overwrite: true });
    expect(notes.join('\n')).toMatch(/someone else shared/);
    expect(notes.join('\n')).toMatch(/existing FILE: it will be REPLACED/);
  });

  it('a pattern share or link is refused when a matched folder moved after the preview', async () => {
    let where = '/Case/Before';
    const { rt, argv } = recording((cmd, args) =>
      cmd === 'find' && args.includes('--use-pcre') ? { stdout: args.includes('--print-only-handles') ? 'H:aaaa\n' : `${where} <H:aaaa>\n` } : {},
    );
    const ex = tools(registerDangerous, rt).get('mega_export')!;
    const preview = await ex({ remotePath: '/Case/Before', usePcre: true, action: 'create' });
    where = '/Case/After';
    const res = await ex({ remotePath: '/Case/Before', usePcre: true, action: 'create', confirm: token(preview) });
    expect(res.isError).toBe(true);
    expect(argv.filter((a) => a[0] === 'export' && a[1] === '-a')).toEqual([]);
  });

  it.runIf(process.platform === 'darwin')('a link to a protected folder in its firmlink spelling is caught', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-firmlink-')));
    try {
      mkdirSync(join(dir, '.codex'));
      mkdirSync(join(dir, 'dl'));
      symlinkSync(`/System/Volumes/Data${dir}/.codex`, join(dir, 'dl', 'cfg'));
      publishMegacmdBinDir(null, [], [join(dir, '.codex')]);
      expect(() => assertDownloadTarget(join(dir, 'dl'), null)).toThrow(/cfg/);
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a folder holding a .megaignore deeper down is not downloaded into a synced folder', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-deepignore-')));
    try {
      const { rt } = recording((cmd, args) =>
        cmd === 'sync' ? { stdout: `LOCALPATH;;MEGA-MCP;;REMOTEPATH;;MEGA-MCP;;RUN_STATE\n${dir};;MEGA-MCP;;/W;;MEGA-MCP;;Running\n` } : cmd === 'find' && args.includes('--type=f') ? { stdout: '/X/proj/sub/.megaignore\n' } : {},
      );
      const res = await tools(registerMutate, rt).get('mega_get')!({ remotePath: '/X/proj', localDir: dir });
      expect(text(res)).toMatch(/holds \/X\/proj\/sub\/\.megaignore/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an upload without a name says when it merges into an existing folder, and a file-link import says what it replaces', async () => {
    const { rt } = recording((cmd, args) => (cmd === 'ls' ? { stdout: 'Documents\n' } : cmd === 'find' && args[0] === '/Work/Documents' ? { stdout: 'H:dddd\n' } : {}));
    const put = tools(registerMutate, rt).get('mega_put')!;
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-putmerge-')));
    try {
      mkdirSync(join(dir, 'Documents'));
      expect(summary(await put({ localPath: join(dir, 'Documents'), remotePath: '/Work' }))).toMatch(/\/Work\/Documents already exists: the upload is merged INTO that folder/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const imp = await tools(registerManage, recording().rt).get('mega_import')!({ link: 'https://mega.nz/file/abc#key', remotePath: '/Finance' });
    expect(summary(imp)).toMatch(/that file is REPLACED/);
  });

  it('export status shows a link without its key', async () => {
    for (const [out, shown] of [
      ['/x (folder, shared as exported permanent folder link: https://mega.nz/folder/abc#SECRETKEY)', 'https://mega.nz/folder/abc#...'],
      ['/x (12 B, shared as exported permanent file link: https://mega.nz/#!abc!SECRETKEY)', 'https://mega.nz/#!abc#...'],
    ]) {
      const { rt } = recording((cmd) => (cmd === 'export' ? { stdout: out } : {}));
      const res = await tools(registerDangerous, rt).get('mega_export')!({ remotePath: '/x', action: 'status' });
      expect(text(res)).toContain(shown);
      expect(JSON.stringify(res)).not.toContain('SECRETKEY');
    }
  });

  it('an unreadable sync list refuses a write instead of treating it as unsynced', async () => {
    const { rt, argv } = recording((cmd) => (cmd === 'sync' ? { code: 1 } : {}));
    const res = await tools(registerMutate, rt).get('mega_mkdir')!({ remotePath: '/Docs/new' });
    expect(text(res)).toMatch(/Could not read MEGAcmd's list of syncs/);
    expect(argv.filter((a) => a[0] === 'mkdir')).toEqual([]);
  });

  it('a download refuses an existing file as localDir, and follows links inside linked folders', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-ldfile-')));
    try {
      writeFileSync(join(dir, '.megaignore'), '-:x\n');
      const get = tools(registerMutate, recording().rt).get('mega_get')!;
      expect(text(await get({ remotePath: '/X/a.txt', localDir: join(dir, '.megaignore') }))).toMatch(/is a file, not a folder/);
      mkdirSync(join(dir, '.codex'));
      mkdirSync(join(dir, 'dl'));
      mkdirSync(join(dir, 'D'));
      symlinkSync(join(dir, 'D'), join(dir, 'dl', 'a'));
      symlinkSync(join(dir, '.codex'), join(dir, 'D', 'b'));
      publishMegacmdBinDir(null, [], [join(dir, '.codex')]);
      expect(() => assertDownloadTarget(join(dir, 'dl'), null)).toThrow(/\.codex/);
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('export status and create take the path\'s own link, not one inside it', async () => {
    const listing = '/F/inner.txt (3 B, shared as exported permanent file link: https://mega.nz/file/child#CHILDKEY)\n/F (folder, shared as exported permanent folder link: https://mega.nz/folder/own#OWNKEY)\n';
    const { rt } = recording((cmd, args) => (cmd === 'export' && args.length === 1 ? { stdout: listing } : {}));
    const ex = tools(registerDangerous, rt).get('mega_export')!;
    expect(text(await ex({ remotePath: '/F', action: 'status' }))).toContain('https://mega.nz/folder/own#...');
    const preview = await ex({ remotePath: '/F', action: 'create' });
    expect(summary(preview)).toMatch(/already has a public link/);
    const shown = await ex({ remotePath: '/F', action: 'create', confirm: token(preview) });
    expect(text(shown)).toContain('https://mega.nz/folder/own#OWNKEY');
    const child = recording((cmd, args) => (cmd === 'export' && args.length === 1 ? { stdout: listing.split('\n')[0] } : {}));
    expect(text(await tools(registerDangerous, child.rt).get('mega_export')!({ remotePath: '/F', action: 'status' }))).toMatch(/No public link for \/F/);
  });

  it('rm deletes an older version alone, by its handle, and refuses one that has the current file\'s time', async () => {
    const listing = (times: string[]) =>
      `FLAGS VERS SIZE DATE HANDLE NAME\n-------- 2 3 15Nov2023 H:cur readme.txt\n\nVersions of /Docs/readme.txt:\n` +
      times.map((t, i) => `-------- 1 3 15Nov2023 H:v${i} readme.txt#${t}`).join('\n') + '\n';
    let times = ['1700001000', '1700000000'];
    const { rt, argv } = recording((cmd, args) =>
      cmd === 'ls' && args.includes('--versions') ? { stdout: listing(times) } : cmd === 'du' ? { stdout: 'FILENAME SIZE\n/Docs/readme.txt: 3\n-----\n' } : {},
    );
    const rm = tools(registerDangerous, rt).get('mega_rm')!;
    const preview = await rm({ remotePath: '/Docs/readme.txt#1700000000' });
    expect(summary(preview)).toMatch(/one older version of \/Docs\/readme\.txt/);
    await rm({ remotePath: '/Docs/readme.txt#1700000000', confirm: token(preview) });
    expect(argv.filter((a) => a[0] === 'rm')).toEqual([['rm', '-f', 'H:v1']]);
    // The current file's own time: a name would reach the current file.
    expect(text(await rm({ remotePath: '/Docs/readme.txt#1700001000' }))).toMatch(/CURRENT/);
    // A restored file shares its old version's time: refused too.
    times = ['1700000000', '1700000000'];
    expect(text(await rm({ remotePath: '/Docs/readme.txt#1700000000' }))).toMatch(/CURRENT/);
    expect((await tools(registerDangerous, rt).get('mega_share')!({ action: 'add', remotePath: '/Docs/readme.txt#1700000000', withEmail: 'a@b.c' })).isError).toBe(true);
  });

  it('turning file versioning off says what it does', async () => {
    const res = await tools(registerManage, recording().rt).get('mega_userattr_set')!({ attribute: '^!dv', value: '1' });
    expect(summary(res)).toMatch(/VERSIONING OFF/);
  });

  it('sharing a synced folder, and downloading into one, say where the sync carries files', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-syncshare-')));
    try {
      const reply = (cmd: string) => (cmd === 'sync' ? { stdout: `LOCALPATH;;MEGA-MCP;;REMOTEPATH;;MEGA-MCP;;RUN_STATE\n${dir};;MEGA-MCP;;/Docs;;MEGA-MCP;;Running\n` } : {});
      const share = await tools(registerDangerous, recording(reply).rt).get('mega_share')!({ action: 'add', remotePath: '/Docs', withEmail: 'a@b.c' });
      expect(summary(share)).toMatch(/\/Docs is two-way synced with .*: what is saved there later is shared too/);
      const get = await tools(registerMutate, recording(reply).rt).get('mega_get')!({ remotePath: '/Private/tax.pdf', localDir: dir });
      expect(summary(get)).toMatch(/also uploaded to \/Docs/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a share is refused when the folder\'s contents changed after the preview', async () => {
    let inside = 'H:aaaa\n';
    const { rt, argv } = recording((cmd, args) => (cmd === 'find' && args.includes('--print-only-handles') && !args.includes('--type=d') ? { stdout: inside } : {}));
    const share = tools(registerDangerous, rt).get('mega_share')!;
    const preview = await share({ action: 'add', remotePath: '/Work', withEmail: 'a@b.c' });
    inside = 'H:aaaa\nH:bbbb\n';
    expect((await share({ action: 'add', remotePath: '/Work', withEmail: 'a@b.c', confirm: token(preview) })).isError).toBe(true);
    expect(argv.filter((a) => a[0] === 'share' && a[1] === '-a')).toEqual([]);
  });

  it('a move is refused when its destination became shared after the preview', async () => {
    let shared = '';
    const { rt, argv } = recording((cmd, args) => (cmd === 'share' && args[0] === '-p' ? { stdout: shared } : {}));
    const mv = tools(registerMutate, rt).get('mega_mv')!;
    const preview = await mv({ src: '/Private/secret.pdf', dst: '/Archive' });
    shared = '/Archive, shared with eve@x.y (read access)\n';
    expect((await mv({ src: '/Private/secret.pdf', dst: '/Archive', confirm: token(preview) })).isError).toBe(true);
    expect(argv.filter((a) => a[0] === 'mv')).toEqual([]);
  });

  it('a copy asks when a file shares its name with a folder there, or differs only in Unicode form', async () => {
    const pair = recording((cmd, args) =>
      cmd === 'ls' ? { stdout: 'report.pdf\n' } : cmd === 'find' && args.includes('--type=d') ? { stdout: 'H:dir\n' } : cmd === 'find' && args.includes('--type=f') ? { stdout: '/Work/report.pdf\n' } : {},
    );
    expect((await tools(registerMutate, pair.rt).get('mega_cp')!({ src: '/Private/report.pdf', dst: '/Work' })).structuredContent).toMatchObject({ requiresConfirmation: true });
    const nfd = '\u1110\u1175\u11b7.docx';
    const nfc = nfd.normalize('NFC');
    const pcre = recording((cmd, args) =>
      cmd === 'ls' ? { stdout: `${nfc}\n` } : cmd === 'find' && args.includes('--use-pcre') ? { stdout: args.includes('--print-only-handles') ? 'H:src\n' : `/Drop/${nfd} <H:src>\n` } : cmd === 'find' && args.includes('--type=d') && args[0] === '/Docs' ? { stdout: 'H:docs\n' } : {},
    );
    expect((await tools(registerMutate, pcre.rt).get('mega_cp')!({ src: '/Drop/.*\\.docx', usePcre: true, dst: '/Docs' })).structuredContent).toMatchObject({ requiresConfirmation: true });
  });

  it('a copy into a Rubbish Bin folder is tracked under its //bin path', async () => {
    const { rt } = recording((cmd, args) => (isFolderProbe(cmd, args) ? { stdout: 'H:DIR' } : {}));
    const t = tools(registerMutate, rt);
    await t.get('mega_cp')!({ src: '/Private/secret.pdf', dst: '//bin/Old' });
    const mv = await t.get('mega_mv')!({ src: '//bin/Old', dst: '/Team' });
    expect(summary(mv)).toMatch(/without a confirmation:[\s\S]*\/\/bin\/Old\/secret\.pdf/);
  });

  it('a download into a synced subfolder spelled differently still names that subfolder\'s sharing', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-syncspell-')));
    try {
      mkdirSync(join(dir, 'Team'));
      symlinkSync(dir, join(dir, '..', `${basename(dir)}-link`));
      const reply = (cmd: string, args: string[]) =>
        cmd === 'sync'
          ? { stdout: `LOCALPATH;;MEGA-MCP;;REMOTEPATH;;MEGA-MCP;;RUN_STATE\n${dir};;MEGA-MCP;;/Sync;;MEGA-MCP;;Running\n` }
          : cmd === 'share' && args[0] === '-p'
            ? { stdout: '/Sync/Team, shared with eve@x.y (read access)\n' }
            : {};
      const get = tools(registerMutate, recording(reply).rt).get('mega_get')!;
      const viaLink = join(dir, '..', `${basename(dir)}-link`, 'Team');
      const res = await get({ remotePath: '/Private/secret.pdf', localDir: viaLink });
      expect(summary(res)).toMatch(/also uploaded to \/Sync\/Team/);
      expect(summary(res)).toMatch(/shared with other people/);
    } finally {
      rmSync(join(dir, '..', `${basename(dir)}-link`), { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a file holding just one 22-character token is refused whatever its case', async () => {
    const { rt } = recording((cmd) => (cmd === 'cat' ? { stdout: 'abcdefghijklmnopqrstuv\n' } : cmd === 'du' ? { stdout: 'FILENAME SIZE\n/k.txt: 23\n-----\n' } : {}));
    const cat = registerCat({ registerTool: (_n: string, _d: unknown, cb: ToolFn) => ({ handler: cb, disable() {}, enable() {} }) } as any, rt, () => true) as unknown as { handler: ToolFn };
    expect(text(await cat.handler({ remotePath: '/k.txt' }))).toMatch(/recovery key/);
  });

  it('a password link or a folder link naming a node inside it says it can replace a file', async () => {
    const imp = tools(registerManage, recording().rt).get('mega_import')!;
    for (const link of ['https://mega.nz/#P!AgEabc', 'https://mega.nz/#F!ph!key!fh', 'https://mega.nz/folder/ph#key/file/fh', 'https://mega.nz/folder/ph#key?fh']) {
      expect(summary(await imp({ link, remotePath: '/Work' })), link).toMatch(/that file is REPLACED/);
    }
    expect(summary(await imp({ link: 'https://mega.nz/folder/ph#key', remotePath: '/Work' }))).not.toMatch(/REPLACED/);
    for (const link of ['https://mega.nz?SUBHNDL1/folder/ph#key', 'https://a!b!c!sub/folder/ph#key', 'https://mega.nz?sub/#F!ph!key']) {
      expect(summary(await imp({ link, remotePath: '/Work' })), link).toMatch(/that file is REPLACED/);
    }
  });

  it('a file link\'s closing bracket is not part of the link', async () => {
    const listing = '/F/a.txt (3 B, shared as exported permanent file link: https://mega.nz/file/H#KEY)\n';
    const { rt } = recording((cmd, args) => (cmd === 'export' && args.length === 1 ? { stdout: listing } : {}));
    const ex = tools(registerDangerous, rt).get('mega_export')!;
    const preview = await ex({ remotePath: '/F/a.txt', action: 'create' });
    expect(text(await ex({ remotePath: '/F/a.txt', action: 'create', confirm: token(preview) }))).toMatch(/https:\/\/mega\.nz\/file\/H#KEY$/);
  });

  it('a folder holding a .megaignore is not copied into a synced folder', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-cpignore-')));
    try {
      const { rt, argv } = recording((cmd, args) =>
        cmd === 'sync'
          ? { stdout: `LOCALPATH;;MEGA-MCP;;REMOTEPATH;;MEGA-MCP;;RUN_STATE\n${dir};;MEGA-MCP;;/W;;MEGA-MCP;;Running\n` }
          : cmd === 'find' && args.includes('--type=f') ? { stdout: '/Evil/proj/sub/.megaignore\n' } : isFolderProbe(cmd, args) ? { stdout: 'H:DIR' } : {},
      );
      expect(text(await tools(registerMutate, rt).get('mega_cp')!({ src: '/Evil/proj', dst: '/W' }))).toMatch(/holds \/Evil\/proj\/sub\/\.megaignore/);
      expect(argv.filter((a) => a[0] === 'cp')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a sync is refused while its cloud side holds a Unicode twin of an excluded folder', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-foldtwin-')));
    try {
      mkdirSync(join(dir, 'Library', 'Application Support', 'Claude'), { recursive: true });
      publishMegacmdBinDir(null, [], [join(dir, 'Library', 'Application Support', 'Claude')]);
      const twin = 'Application \u017Fupport';
      const { rt } = recording((cmd, args) => (cmd === 'find' && args.length === 1 && args[0] === '/Home' ? { stdout: `/Home\n/Home/Library\n/Home/Library/${twin}\n` } : {}));
      expect(text(await tools(registerSync, rt).get('mega_sync_add')!({ localPath: dir, remotePath: '/Home' }))).toMatch(/treats as the same folder as Library\/Application Support/);
      const plain = recording((cmd, args) => (cmd === 'find' && args.length === 1 && args[0] === '/Home' ? { stdout: '/Home\n/Home/Library\n/Home/Library/Application Support\n' } : {}));
      expect((await tools(registerSync, plain.rt).get('mega_sync_add')!({ localPath: dir, remotePath: '/Home' })).isError).toBeFalsy();
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pattern share is refused when a matched folder\'s contents changed after the preview', async () => {
    let listing = '/Projects/Q3 <H:q3>\n';
    const { rt, argv } = recording((cmd, args) =>
      cmd === 'find' && args.includes('--use-pcre') ? { stdout: args.includes('--print-only-handles') ? listing.split('\n').filter(Boolean).map((l) => l.match(/<(H:[^>]+)>/)![1]).join('\n') : listing } : {},
    );
    const share = tools(registerDangerous, rt).get('mega_share')!;
    const preview = await share({ action: 'add', remotePath: '/Projects/Q.*', usePcre: true, withEmail: 'a@b.c' });
    listing = '/Projects/Q3 <H:q3>\n/Projects/Q3/taxes.pdf <H:tax>\n';
    expect((await share({ action: 'add', remotePath: '/Projects/Q.*', usePcre: true, withEmail: 'a@b.c', confirm: token(preview) })).isError).toBe(true);
    expect(argv.filter((a) => a[0] === 'share' && a[1] === '-a')).toEqual([]);
  });

  it('sharing a folder that receives periodic backups says later backups are shared too', async () => {
    const pad = (v: string, n: number) => v + ' '.repeat(n - Array.from(v).length);
    const row = `${pad('3', 5)} ${pad('/Users/x/Documents', 4096)} ${pad('/Backups', 4096)} ${'ACTIVE'.padStart(14)}`;
    const { rt } = recording((cmd) => (cmd === 'backup' ? { stdout: `TAG   LOCALPATH REMOTEPARENTPATH STATUS\n${row}\n` } : {}));
    const share = await tools(registerDangerous, rt).get('mega_share')!({ action: 'add', remotePath: '/Backups', withEmail: 'a@b.c' });
    expect(summary(share)).toMatch(/\/Backups receives periodic backups of \/Users\/x\/Documents from this computer: later backups are shared too/);
  });

  it('the gate refuses command lines MEGAcmd\'s client would rewrite', () => {
    expect(() => assertSafeInvocation('get', ['/x'])).toThrow(/both a cloud path and a local path/);
    expect(() => assertSafeInvocation('thumbnail', ['-s', '/x'])).toThrow(/both a cloud path and a local path/);
    expect(() => assertSafeInvocation('get', ['-q', '/x', '/tmp/dl'])).not.toThrow();
    expect(() => assertSafeInvocation('ls', ['-o', '/x'])).toThrow(/-o/);
  });

  it('a copy or move refuses a destination that names several items or holds a wildcard', async () => {
    const twins = recording((cmd) => (cmd === 'du' ? { stdout: 'FILENAME SIZE\n/Clients/Acme/contract.pdf: 1\n/Clients/Acme/contract.pdf: 2\n-----\n' } : {}));
    expect(text(await tools(registerMutate, twins.rt).get('mega_cp')!({ src: '/Inbox/junk.pdf', dst: '/Clients/Acme/contract.pdf' }))).toMatch(/2 items are named/);
    expect(text(await tools(registerMutate, twins.rt).get('mega_mv')!({ src: '/Inbox/junk.pdf', dst: '/Clients/Acme/contract.pdf' }))).toMatch(/2 items are named/);
    expect(twins.argv.filter((a) => a[0] === 'cp' || a[0] === 'mv')).toEqual([]);
    const { rt } = recording();
    for (const [tool, args] of [
      ['mega_cp', { src: '/Y/junk.txt', dst: '/Docs/Why?.docx' }],
      ['mega_mv', { src: '/Y/junk.txt', dst: '/X/a*' }],
      ['mega_put', { localPath: '/tmp', remotePath: '/Docs/Why?.docx' }],
    ] as const) {
      expect(text(await tools(registerMutate, rt).get(tool)!(args)), tool).toMatch(/wildcard/i);
    }
  });

  it('a gated copy is refused when its source\'s contents changed after the preview', async () => {
    let inside = 'H:notes\n';
    const { rt, argv } = recording((cmd, args) =>
      cmd === 'share' && args.join(' ') === '-p /' ? { stdout: '/Team, shared with eve@x.y (read access)\n' } : cmd === 'find' && args.length === 2 && args[1] === '--print-only-handles' ? { stdout: inside } : isFolderProbe(cmd, args) ? { stdout: 'H:DIR' } : {},
    );
    const cp = tools(registerMutate, rt).get('mega_cp')!;
    const preview = await cp({ src: '/Projects/Notes', dst: '/Team' });
    inside = 'H:notes\nH:passport\n';
    expect((await cp({ src: '/Projects/Notes', dst: '/Team', confirm: token(preview) })).isError).toBe(true);
    expect(argv.filter((a) => a[0] === 'cp')).toEqual([]);
  });

  it('a failed move batch keeps what was placed without a confirmation on record', async () => {
    const { rt } = recording((cmd, args) => (cmd === 'mv' ? { code: 1 } : isFolderProbe(cmd, args) ? { stdout: 'H:DIR' } : {}));
    const t = tools(registerMutate, rt);
    await t.get('mega_cp')!({ src: '/Finance/taxes.pdf', dst: '/Work2' });
    const preview = await t.get('mega_mv')!({ srcs: ['/Work2'], dst: '/Archive' });
    await t.get('mega_mv')!({ srcs: ['/Work2'], dst: '/Archive', confirm: token(preview) });
    const share = await tools(registerDangerous, rt).get('mega_share')!({ action: 'add', remotePath: '/Work2', withEmail: 'x@evil.example' });
    expect(summary(share)).toMatch(/\/Work2\/taxes\.pdf/);
  });

  it('a thumbnail set earlier is named when its folder is shared', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-thumbnote-')));
    try {
      const img = join(dir, 'p.png');
      writeFileSync(img, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
      const { rt } = recording();
      const thumb = tools(registerMutate, rt).get('mega_thumbnail')!;
      const preview = await thumb({ remotePath: '/Album2/a.jpg', localPath: img, action: 'set' });
      await thumb({ remotePath: '/Album2/a.jpg', localPath: img, action: 'set', confirm: token(preview) });
      const share = await tools(registerDangerous, rt).get('mega_share')!({ action: 'add', remotePath: '/Album2', withEmail: 'x@y.z' });
      expect(summary(share)).toMatch(/Changed in it earlier in this session:[\s\S]*\/Album2\/a\.jpg: its thumbnail was set from/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a backup into a synced cloud folder whose local side is protected is refused', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-bkprot-')));
    try {
      mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
      mkdirSync(join(dir, 'src'));
      publishMegacmdBinDir(null, [], [join(dir, '.claude')]);
      const { rt } = recording((cmd) => (cmd === 'sync' ? { stdout: `LOCALPATH;;MEGA-MCP;;REMOTEPATH;;MEGA-MCP;;RUN_STATE\n${join(dir, '.claude')};;MEGA-MCP;;/Cfg;;MEGA-MCP;;Running\n` } : {}));
      const res = await tools(registerSync, rt).get('mega_backup_add')!({ localPath: join(dir, 'src'), remotePath: '/Cfg/skills', period: '1h', numBackups: 1 });
      expect(res.isError).toBe(true);
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a Rubbish Bin folder that is still shared makes a copy into it ask', async () => {
    const { rt, argv } = recording((cmd, args) => (cmd === 'share' && args.join(' ') === '-p //bin' ? { stdout: '//bin/Old/Acme, shared with eve@x.y (read access)\n' } : isFolderProbe(cmd, args) ? { stdout: 'H:DIR' } : {}));
    const res = await tools(registerMutate, rt).get('mega_cp')!({ src: '/Private/Tax', dst: '//bin/Old/Acme' });
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
    expect(summary(res)).toMatch(/shared with other people/);
    expect(argv.filter((a) => a[0] === 'cp')).toEqual([]);
  });

  it.runIf(process.platform === 'darwin')('a download into a synced subfolder spelled in other case names that subfolder\'s sharing', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-synccase-')));
    try {
      mkdirSync(join(dir, 'Team'));
      const reply = (cmd: string, args: string[]) =>
        cmd === 'sync' ? { stdout: `LOCALPATH;;MEGA-MCP;;REMOTEPATH;;MEGA-MCP;;RUN_STATE\n${dir};;MEGA-MCP;;/SyncRoot;;MEGA-MCP;;Running\n` } : cmd === 'share' && args[0] === '-p' ? { stdout: '/SyncRoot/Team, shared with eve@x.y (read access)\n' } : {};
      const res = await tools(registerMutate, recording(reply).rt).get('mega_get')!({ remotePath: '/Private/a.pdf', localDir: join(dir, 'team') });
      expect(summary(res)).toMatch(/also uploaded to \/SyncRoot\/Team/);
      expect(summary(res)).toMatch(/shared with other people/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a download into a synced folder, and deleteversions, are refused when the source changed after the preview', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-getbind-')));
    try {
      let inside = 'H:docs\n';
      const reply = (cmd: string, args: string[]) =>
        cmd === 'sync' ? { stdout: `LOCALPATH;;MEGA-MCP;;REMOTEPATH;;MEGA-MCP;;RUN_STATE\n${dir};;MEGA-MCP;;/Team;;MEGA-MCP;;Running\n` }
          : cmd === 'find' && args.length === 2 && args[1] === '--print-only-handles' ? { stdout: inside } : {};
      const { rt, argv } = recording(reply);
      const get = tools(registerMutate, rt).get('mega_get')!;
      const preview = await get({ remotePath: '/Docs', localDir: dir });
      inside = 'H:docs\nH:taxes\n';
      expect((await get({ remotePath: '/Docs', localDir: dir, confirm: token(preview) })).isError).toBe(true);
      expect(argv.filter((a) => a[0] === 'get')).toEqual([]);
      inside = 'H:arch\n';
      const dv = tools(registerDangerous, rt).get('mega_deleteversions')!;
      const p2 = await dv({ remotePath: '/Archive' });
      expect(summary(p2)).toMatch(/every file inside it/);
      inside = 'H:arch\nH:thesis\n';
      expect((await dv({ remotePath: '/Archive', confirm: token(p2) })).isError).toBe(true);
      expect(argv.filter((a) => a[0] === 'deleteversions')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('moving a folder that holds a sync\'s cloud side says the sync follows it', async () => {
    const { rt } = recording((cmd) => (cmd === 'sync' ? { stdout: 'LOCALPATH;;MEGA-MCP;;REMOTEPATH;;MEGA-MCP;;RUN_STATE\n/Users/x/Proj;;MEGA-MCP;;/Work/Proj;;MEGA-MCP;;Running\n' } : {}));
    const res = await tools(registerMutate, rt).get('mega_mv')!({ src: '/Work', dst: '/Team' });
    expect(summary(res)).toMatch(/\/Work\/Proj is two-way synced with \/Users\/x\/Proj on this computer: the sync follows it into \/Team/);
  });

  it('a sync is refused while its cloud folder holds a .megaignore below the root', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-syncnested-')));
    try {
      const { rt } = recording((cmd, args) => (cmd === 'find' && args.includes('--type=f') ? { stdout: '/S/.megaignore\n/S/sub/.megaignore\n' } : {}));
      expect(text(await tools(registerSync, rt).get('mega_sync_add')!({ localPath: dir, remotePath: '/S' }))).toMatch(/holds \/S\/sub\/\.megaignore/);
      const rootOnly = recording((cmd, args) => (cmd === 'find' && args.includes('--type=f') ? { stdout: '/S/.megaignore\n' } : {}));
      expect((await tools(registerSync, rootOnly.rt).get('mega_sync_add')!({ localPath: dir, remotePath: '/S' })).isError).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mega_cat refuses wildcards, and a name it cannot count', async () => {
    const forged = 'FILENAME SIZE\n/Docs/a\n-----\n.txt: 3\n/Docs/key.txt: 22\n-----\n';
    const { rt, argv } = recording((cmd) => (cmd === 'du' ? { stdout: forged } : cmd === 'cat' ? { stdout: 'x' } : {}));
    const cat = registerCat({ registerTool: (_n: string, _d: unknown, cb: ToolFn) => ({ handler: cb, disable() {}, enable() {} }) } as any, rt, () => true) as unknown as { handler: ToolFn };
    expect(text(await cat.handler({ remotePath: '/Docs/a.txt' }))).toMatch(/Could not check how many files/);
    expect(text(await cat.handler({ remotePath: '/Docs/*.txt' }))).toMatch(/wildcard/i);
    expect(argv.filter((a) => a[0] === 'cat')).toEqual([]);
  });

  it('the s4 attribute is not set, and a link MEGA left without its expiry is withdrawn', async () => {
    let created = false;
    const { rt, argv } = recording((cmd, args) => {
      if (cmd === 'export' && args[0] === '-a') {
        created = true;
        return { code: 52 };
      }
      return cmd === 'export' && args.length === 1 && created ? { stdout: '/x (3 B, shared as exported permanent file link: https://mega.nz/file/H#K)\n' } : {};
    });
    expect((await tools(registerManage, rt).get('mega_attr_set')!({ remotePath: '/x', attribute: 's4', action: 'set', value: 'v' })).isError).toBe(true);
    const ex = tools(registerDangerous, rt).get('mega_export')!;
    const preview = await ex({ remotePath: '/x', action: 'create', expire: '1d' });
    const res = await ex({ remotePath: '/x', action: 'create', expire: '1d', confirm: token(preview) });
    expect(text(res)).toMatch(/removed again/);
    expect(argv.filter((a) => a[0] === 'export' && a[1] === '-d')).toEqual([['export', '-d', '/x']]);
  });

  it('a move into someone else\'s share says it supersedes a same-named file there', async () => {
    const d = '//from/bob@example.com:Team';
    const { rt } = recording((cmd, args) =>
      cmd === 'ls' && args[0] === d ? { stdout: 'budget.xlsx\n' } : cmd === 'find' && args[0] === d && args.includes('--type=d') ? { stdout: 'H:team\n' } : {},
    );
    const res = await tools(registerMutate, rt).get('mega_mv')!({ src: '/Finance/budget.xlsx', dst: d });
    expect(summary(res)).toMatch(/budget\.xlsx already exists: the moved item becomes its new version/);
    expect(text(await tools(registerMutate, recording().rt).get('mega_mkdir')!({ remotePath: '//bin' }))).toMatch(/cannot create folders/);
  });

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)('an unreadable folder makes the search for store copies incomplete', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-unread-')));
    try {
      mkdirSync(join(dir, 'locked'));
      chmodSync(join(dir, 'locked'), 0o000);
      expect(storeCopiesIn(dir).complete).toBe(false);
      expect(syncExclusions(dir).map((e) => e.rule)).toContain('-dng:.megacmd*');
    } finally {
      chmodSync(join(dir, 'locked'), 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a destination named like a node handle is refused, and pattern links left without their expiry are withdrawn', async () => {
    expect(() => assertRemoteDest('/H:AbCd1234')).toThrow(/node handle/);
    expect(() => assertRemoteDest('/Work/H:AbCd1234/x')).toThrow(/node handle/);
    expect(() => assertRemoteDest('/Work/H:notahandle')).not.toThrow();
    const listing = '/Docs/a.txt <H:aaaa>\n';
    const { rt, argv } = recording((cmd, args) =>
      cmd === 'find' && args.includes('--use-pcre') ? { stdout: args.includes('--print-only-handles') ? 'H:aaaa\n' : listing } : cmd === 'export' && args[0] === '-a' ? { code: 54 } : {},
    );
    const ex = tools(registerDangerous, rt).get('mega_export')!;
    const preview = await ex({ remotePath: '/Docs/.*', usePcre: true, action: 'create', expire: '1d' });
    const res = await ex({ remotePath: '/Docs/.*', usePcre: true, action: 'create', expire: '1d', confirm: token(preview) });
    expect(text(res)).toMatch(/withdrawn because MEGA would not apply the password or expiry/);
    expect(argv.filter((a) => a[0] === 'export' && a[1] === '-d')).toEqual([['export', '-d', 'H:aaaa']]);
  });

  it('round 10: nested local .megaignore, cross-tree renames, %-escaped upload names, unknown destination counts', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-r10-')));
    try {
      // A .megaignore below the root of the local folder would be read before the root rules.
      mkdirSync(join(dir, 'proj'), { recursive: true });
      writeFileSync(join(dir, 'proj', '.megaignore'), '+:.claude\n');
      const sync = tools(registerSync, recording().rt).get('mega_sync_add')!;
      expect(text(await sync({ localPath: dir, remotePath: '/Home' }))).toMatch(/below the root/);
      rmSync(join(dir, 'proj', '.megaignore'));
      // MEGA uploads "%2emegaignore" as ".megaignore", and "My%20Docs" as "My Docs".
      writeFileSync(join(dir, '%2emegaignore'), 'x');
      expect(isIgnoreFileName('%2emegaignore')).toBe(true);
      mkdirSync(join(dir, 'My%20Docs'));
      const put = await tools(registerMutate, recording().rt).get('mega_put')!({ localPath: join(dir, 'My%20Docs'), remotePath: '/Up' });
      expect((put.structuredContent as { summary: string }).summary).toContain('->  /Up/My Docs');
      expect((await tools(registerMutate, recording().rt).get('mega_put')!({ localPath: join(dir, 'My%20Docs'), remotePath: '/Up', name: 'a%2eb' })).isError).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // A move between your drive and a share cannot rename: MEGAcmd renames the old handle.
    const folder = (cmd: string, args: string[]) => (cmd === 'find' && args.includes('--type=d') && args[1] === '/Finance' ? { stdout: 'H:DIR' } : {});
    const mv = tools(registerMutate, recording((cmd, args) => (cmd === 'find' && args.includes('--type=d') ? { code: 53 } : folder(cmd, args))).rt).get('mega_mv')!;
    expect(text(await mv({ src: '//from/bob@x.com:Team/budget.xlsx', dst: '/Finance/from-team.xlsx' }))).toMatch(/cannot rename or replace/);
    // A destination whose same-name count cannot be read is refused, not let through.
    const cp = tools(registerMutate, recording((cmd) => (cmd === 'du' ? { code: 1 } : {})).rt).get('mega_cp')!;
    expect(text(await cp({ src: '/a.txt', dst: '/B' }))).toMatch(/Could not check how many items are named \/B/);
  });

  it('write access to a synced folder says the sync brings what others add, and is refused above a protected folder', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-rwshare-')));
    try {
      const list = (local: string) => (cmd: string) => (cmd === 'sync' ? { stdout: `LOCALPATH;;MEGA-MCP;;REMOTEPATH;;MEGA-MCP;;RUN_STATE\n${local};;MEGA-MCP;;/Team;;MEGA-MCP;;Running\n` } : {});
      const share = (local: string) => tools(registerDangerous, recording(list(local)).rt).get('mega_share')!;
      const rw = await share(join(dir, 'Team'))({ action: 'add', remotePath: '/Team/Sub', withEmail: 'a@b.c', level: 'readwrite' });
      expect((rw.structuredContent as { summary: string }).summary).toContain(`a@b.c can add files to /Team/Sub: the two-way sync writes them to ${join(dir, 'Team', 'Sub')}`);
      const ro = await share(join(dir, 'Team'))({ action: 'add', remotePath: '/Team/Sub', withEmail: 'a@b.c' });
      expect((ro.structuredContent as { summary: string }).summary).not.toContain('can add files');
      mkdirSync(join(dir, 'Team', 'cfg'), { recursive: true });
      publishMegacmdBinDir(null, [], [join(dir, 'Team', 'cfg')]);
      expect(text(await share(join(dir, 'Team'))({ action: 'add', remotePath: '/Team', withEmail: 'a@b.c', level: 'full' }))).toMatch(/share it read-only instead/);
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'darwin')('refuses the macOS data volume root and the folders above it', () => {
    for (const p of ['/System/Volumes/Data', '/system/volumes/data/', '/System/Volumes', '/System']) expect(() => assertLocalPath(p), p).toThrow(/whole data volume/);
    // Other ways macOS names a folder (volfs, no-follow, resolve) are refused outright.
    const st = statSync('/System/Volumes/Data');
    for (const p of [`/.vol/${st.dev}/${st.ino}`, '/.nofollow/System/Volumes/Data', '/.resolve/1/Users']) expect(() => assertLocalPath(p), p).toThrow(/special path form|whole data volume/);
    expect(assertLocalPath('/System/Volumes/Data/Users')).toBe('/Users');
  });

  it('a link download is remembered for later syncs, and refused into a synced folder holding a store copy', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-linkdl-')));
    try {
      const dl = join(dir, 'dl');
      mkdirSync(dl);
      const get = tools(registerMutate, recording().rt).get('mega_get')!;
      const preview = await get({ link: 'https://mega.nz/folder/abc#key', localDir: dl });
      expect((await get({ link: 'https://mega.nz/folder/abc#key', localDir: dl, confirm: token(preview) })).isError).toBeFalsy();
      // What the link brought (simulated): a .megaignore below the later sync's root.
      mkdirSync(join(dl, 'pack'));
      writeFileSync(join(dl, 'pack', '.megaignore'), '+:.claude\n');
      expect(text(await tools(registerSync, recording((cmd) => (cmd === 'transfers' ? NO_TRANSFERS : {})).rt).get('mega_sync_add')!({ localPath: dir, remotePath: '/Home' }))).toMatch(/downloaded earlier in this session/);
      // Into a synced folder: a .megaignore in the link could bring a .megaCmd copy back into the sync.
      mkdirSync(join(dir, 'old', '.megaCmd'), { recursive: true });
      const synced = recording((cmd) => (cmd === 'sync' ? { stdout: `LOCALPATH;;MEGA-MCP;;REMOTEPATH;;MEGA-MCP;;RUN_STATE\n${dir};;MEGA-MCP;;/Home;;MEGA-MCP;;Running\n` } : {}));
      expect(text(await tools(registerMutate, synced.rt).get('mega_get')!({ link: 'https://mega.nz/folder/abc#key', localDir: dir, merge: true }))).toMatch(/copy of MEGAcmd's session store/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('project config and symlinks in host config are protected as the hosts list them, also when that changes', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'mega-projects-')));
    const home = join(base, 'home');
    const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
    try {
      for (const d of ['p1', 'p2', 'p3', 'target', 'home/.claude', 'home/.codex', 'cfg']) mkdirSync(join(base, d), { recursive: true });
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [join(base, 'p1')]: {} } }));
      process.env.HOME = home;
      process.env.CLAUDE_CONFIG_DIR = join(base, 'cfg');
      delete process.env.CODEX_HOME;
      createRuntime({ cacheDir: join(base, 'cache'), systemAppBinDirs: [], download: { sha256Allow: [] }, maxListLines: 1000, exposeContacts: false, exposeAccountDetails: false, exposeFileContents: false } as Config, {
        resolve: async () => null,
      });
      expect(() => assertDownloadTarget(join(base, 'p1'), '.claude')).toThrow();
      expect(() => assertDownloadTarget(join(base, 'p2'), '.claude')).not.toThrow();
      // Added later: CLAUDE_CONFIG_DIR's list, a single-quoted Codex key, a symlink in ~/.claude.
      writeFileSync(join(base, 'cfg', '.claude.json'), JSON.stringify({ projects: { [join(base, 'p2')]: {} } }));
      // Literal and basic keys, TOML escapes decoded ("\\u0070" is "p"), and a dotted key.
      mkdirSync(join(base, 'p4'));
      mkdirSync(join(base, 'p5'));
      writeFileSync(
        join(home, '.codex', 'config.toml'),
        `[projects.'${join(base, 'p3')}']\ntrust_level = "trusted"\n[projects."${base}/\\u00704"]\ntrust_level = "trusted"\nprojects."${join(base, 'p5')}".trust_level = "trusted" # "${join(base, 'nope')}"\n`,
      );
      symlinkSync(join(base, 'target'), join(home, '.claude', 'commands'));
      // A link past the 500th entry of a folder inside ~/.claude is followed too.
      mkdirSync(join(home, '.claude', 'hooks'));
      for (let i = 0; i < 501; i++) writeFileSync(join(home, '.claude', 'hooks', `a${String(i).padStart(4, '0')}`), '');
      mkdirSync(join(base, 'late'));
      symlinkSync(join(base, 'late'), join(home, '.claude', 'hooks', 'zz-late'));
      // A dangling link (dotfiles not created yet), and a link reached through a linked folder.
      symlinkSync(join(base, 'dot', 'settings.json'), join(home, '.claude', 'settings.json'));
      mkdirSync(join(base, 'target', 'sub'), { recursive: true });
      mkdirSync(join(base, 'deep'));
      symlinkSync(join(base, 'deep'), join(base, 'target', 'hooks'));
      // A chain whose middle link dangles: writing at the middle link is caught too.
      mkdirSync(join(base, 'mid'));
      symlinkSync(join(base, 'mid', 'cfg.json'), join(home, '.claude', 'keybindings.json'));
      symlinkSync(join(base, 'final', 'cfg.json'), join(base, 'mid', 'cfg.json'));
      await new Promise((r) => setTimeout(r, 1100));
      expect(() => assertDownloadTarget(join(base, 'dot'), 'settings.json')).toThrow();
      expect(() => assertDownloadTarget(join(base, 'deep'), 'x.sh')).toThrow();
      expect(() => assertDownloadTarget(join(base, 'mid'), 'cfg.json')).toThrow();
      expect(() => assertDownloadTarget(join(base, 'late'), 'x.sh')).toThrow();
      expect(() => assertDownloadTarget(join(base, 'p2'), '.claude')).toThrow();
      expect(() => assertDownloadTarget(join(base, 'p3'), '.codex')).toThrow();
      expect(() => assertDownloadTarget(join(base, 'p4'), '.codex')).toThrow();
      expect(() => assertDownloadTarget(join(base, 'p5'), '.claude')).toThrow();
      expect(() => assertDownloadTarget(join(base, 'target'), 'x.md')).toThrow();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      publishMegacmdBinDir(null);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('round 11: a download into a backed-up folder says the backup uploads it; a sync waits for background downloads', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-r11-')));
    try {
      const pad = (v: string, n: number) => v + ' '.repeat(n - Array.from(v).length);
      const row = `${pad('3', 5)} ${pad(dir, 4096)} ${pad('/Backups', 4096)} ${'ACTIVE'.padStart(14)}`;
      const backedUp = recording((cmd) => (cmd === 'backup' ? { stdout: `TAG   LOCALPATH REMOTEPARENTPATH STATUS\n${row}\n` } : {}));
      const preview = await tools(registerMutate, backedUp.rt).get('mega_get')!({ remotePath: '/Private/x.pdf', localDir: dir });
      expect((preview.structuredContent as { summary: string }).summary).toContain(`${dir} is backed up periodically to /Backups`);
      // A background link download may still be delivering a .megaignore when a sync is asked for.
      const dl = join(dir, 'dl');
      mkdirSync(dl);
      let running = 1;
      const r = recording((cmd) => (cmd === 'transfers' ? { stdout: `NUM DOWNLOADS\n${String(running).padStart(16)}${'1 KB'.padStart(12)}${'2 KB'.padStart(12)}${'50%'.padStart(8)}     ${'0'.padStart(16)}\n` } : {}));
      const get = tools(registerMutate, r.rt).get('mega_get')!;
      const p = await get({ link: 'https://mega.nz/folder/abc#key', localDir: dl, background: true });
      expect((await get({ link: 'https://mega.nz/folder/abc#key', localDir: dl, background: true, confirm: token(p) })).isError).toBeFalsy();
      const sync = tools(registerSync, r.rt).get('mega_sync_add')!;
      expect(text(await sync({ localPath: dir, remotePath: '/Home' }))).toMatch(/may still be running/);
      running = 0;
      expect((await sync({ localPath: dir, remotePath: '/Home' })).isError).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round 11: unknown content into synced folders, writable cloud folders, links at the landing name, root rules', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-r11b-')));
    const S = ';;MEGA-MCP;;';
    const syncs = (rows: string[]) => ({ stdout: [`LOCALPATH${S}REMOTEPATH${S}RUN_STATE`, ...rows].join('\n') + '\n' });
    try {
      // An import into a synced folder that holds a .megaCmd copy: a .megaignore in it could bring the copy back.
      mkdirSync(join(dir, 'Docs', 'old', '.megaCmd'), { recursive: true });
      const docs = recording((cmd) => (cmd === 'sync' ? syncs([`${join(dir, 'Docs')}${S}/Docs${S}Running`]) : {}));
      expect(text(await tools(registerManage, docs.rt).get('mega_import')!({ link: 'https://mega.nz/folder/a#k', remotePath: '/Docs/old' }))).toMatch(/copy of MEGAcmd's session store/);
      // Write access with the sync list unreadable is refused, not passed.
      const unknown = recording((cmd) => (cmd === 'sync' ? { code: 1 } : {}));
      expect(text(await tools(registerDangerous, unknown.rt).get('mega_share')!({ action: 'add', remotePath: '/Docs', withEmail: 'a@b.c', level: 'full' }))).toMatch(/Could not read MEGAcmd's list of syncs/);
      // A sync onto a folder others can write into, of a local folder holding a protected one.
      mkdirSync(join(dir, 'home', 'cfg'), { recursive: true });
      publishMegacmdBinDir(null, [], [join(dir, 'home', 'cfg')]);
      const shared = recording((cmd, args) => (cmd === 'share' && args.join(' ') === '-p /' ? { stdout: '/Home, shared with eve@x.y (read/write access)\n' } : {}));
      const add = tools(registerSync, shared.rt).get('mega_sync_add')!;
      expect(text(await add({ localPath: join(dir, 'home'), remotePath: '/Home' }))).toMatch(/can be written by other people/);
      expect(text(await add({ localPath: join(dir, 'home'), remotePath: '//from/eve@x.y:Team' }))).toMatch(/can be written by other people/);
      publishMegacmdBinDir(null);
      // A symlink AT the landing name that leads into a synced folder.
      mkdirSync(join(dir, 'dl'));
      symlinkSync(join(dir, 'Docs'), join(dir, 'dl', 'Work'));
      expect(text(await tools(registerMutate, docs.rt).get('mega_get')!({ remotePath: '/Cloud/Work', localDir: join(dir, 'dl') }))).toMatch(/links to .*which MEGAcmd syncs or backs up/);
      // A root has no name of its own.
      expect(text(await tools(registerMutate, recording().rt).get('mega_get')!({ remotePath: '//bin', localDir: join(dir, 'dl') }))).toMatch(/is a root/);
      // A .megaignore downloaded into a folder that later becomes the sync root is not used silently.
      const fresh = join(dir, 'fresh');
      mkdirSync(fresh);
      const get = tools(registerMutate, recording().rt).get('mega_get')!;
      const p = await get({ remotePath: '/Inbox/.megaignore', localDir: fresh });
      expect((await get({ remotePath: '/Inbox/.megaignore', localDir: fresh, confirm: token(p) })).isError).toBeFalsy();
      writeFileSync(join(fresh, '.megaignore'), '+:.*\n');
      expect(text(await tools(registerSync, recording((cmd) => (cmd === 'transfers' ? NO_TRANSFERS : {})).rt).get('mega_sync_add')!({ localPath: fresh, remotePath: '/F' }))).toMatch(/a download of this session put at the root of/);
      // A cloud file MEGA decodes to .megaignore counts as one.
      const enc = recording((cmd, args) => (cmd === 'find' && args.includes('--pattern=%2e*') ? { stdout: '/F2/sub/%2emegaignore\n' } : {}));
      mkdirSync(join(dir, 'f2'));
      expect(text(await tools(registerSync, enc.rt).get('mega_sync_add')!({ localPath: join(dir, 'f2'), remotePath: '/F2' }))).toMatch(/%2emegaignore/);
      // A pattern download's preview cannot be given extra lines through a %0a in localDir.
      const nl = join(dir, 'Docs', 'in%0aFORGED LINE');
      mkdirSync(nl);
      const pcre = recording((cmd, args) =>
        cmd === 'sync' ? syncs([`${join(dir, 'Docs')}${S}/Docs${S}Running`]) : cmd === 'find' && args.includes('--use-pcre') ? { stdout: args.includes('--print-only-handles') ? 'H:aaaaaaaa' : '/Private/a.pdf <H:aaaaaaaa>' } : {},
      );
      const prev = await tools(registerMutate, pcre.rt).get('mega_get')!({ remotePath: '/Private/.*', usePcre: true, localDir: nl });
      expect((prev.structuredContent as { summary: string }).summary.split('\n')).not.toContain('FORGED LINE');
      // A thumbnail is set only from a file that can be read here.
      expect(text(await tools(registerMutate, recording().rt).get('mega_thumbnail')!({ remotePath: '/f.jpg', localPath: join(dir, 'missing.jpg'), action: 'set' }))).toMatch(/cannot be read/);
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round 12: shares below where a download or upload merges are named; backed-up folders count at the landing', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-r12-')));
    const S = ';;MEGA-MCP;;';
    try {
      // A download into a synced folder merges into existing subfolders: a linked one below is named.
      mkdirSync(join(dir, 'S', 'Public'), { recursive: true });
      const synced = recording((cmd, args) =>
        cmd === 'sync' ? { stdout: `LOCALPATH${S}REMOTEPATH${S}RUN_STATE\n${join(dir, 'S')}${S}/S${S}Running\n` } : cmd === 'export' && args[0] === '/' ? { stdout: '/S/Public (folder, shared as exported permanent folder link: https://mega.nz/folder/x#y)\n' } : {},
      );
      const dl = await tools(registerMutate, synced.rt).get('mega_get')!({ remotePath: '/P/Public', localDir: join(dir, 'S') });
      expect((dl.structuredContent as { summary: string }).summary).toMatch(/\/S\/Public, inside \/S, has a public link/);
      // An upload that merges into an existing folder reaches a shared folder inside it.
      mkdirSync(join(dir, 'Acme', 'Sub'), { recursive: true });
      const up = recording((cmd, args) =>
        cmd === 'ls' ? { stdout: 'Acme\n' } : cmd === 'find' && args.includes('--type=d') && args[1] !== undefined && String(args[0]).startsWith('/Projects') ? { stdout: 'H:DIR' } : cmd === 'share' && args.join(' ') === '-p /' ? { stdout: '/Projects/Acme/Sub, shared with eve@x.y (read access)\n' } : {},
      );
      const put = await tools(registerMutate, up.rt).get('mega_put')!({ localPath: join(dir, 'Acme'), remotePath: '/Projects' });
      expect((put.structuredContent as { summary: string }).summary).toMatch(/\/Projects\/Acme\/Sub, inside \/Projects\/Acme, is shared with other people/);
      // A scheduled backup's folder at the landing name counts like a synced one.
      mkdirSync(join(dir, 'home', 'Documents'), { recursive: true });
      const pad = (v: string, n: number) => v + ' '.repeat(n - Array.from(v).length);
      const row = `${pad('3', 5)} ${pad(join(dir, 'home', 'Documents'), 4096)} ${pad('/Backups', 4096)} ${'ACTIVE'.padStart(14)}`;
      const backed = recording((cmd) => (cmd === 'backup' ? { stdout: `TAG   LOCALPATH REMOTEPARENTPATH STATUS\n${row}\n` } : {}));
      expect(text(await tools(registerMutate, backed.rt).get('mega_get')!({ remotePath: '/X/Documents', localDir: join(dir, 'home') }))).toMatch(/which MEGAcmd syncs or backs up/);
      // A link inside the landing that leads elsewhere in the same synced folder is refused.
      mkdirSync(join(dir, 'S', 'Private', 'in'), { recursive: true });
      symlinkSync(join(dir, 'S', 'Public'), join(dir, 'S', 'Private', 'in', 'pub'));
      expect(text(await tools(registerMutate, synced.rt).get('mega_get')!({ remotePath: '/P/in', localDir: join(dir, 'S', 'Private') }))).toMatch(/which MEGAcmd syncs or backs up/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Error text never carries a link's key, however short.
    expect(redact('Failed: https://mega.nz/folder/abcdefgh#AbCdEfGhIjKlMnOpQrStUv')).not.toContain('AbCdEfGhIjKlMnOpQrStUv');
  });

  it('round 12: a recovery key file inside a shared, published or copied folder is named; backups say what they delete', async () => {
    const key = (cmd: string, args: string[]) => (cmd === 'find' && args.includes('--pattern=????-*') ? { stdout: '/Downloads/mega-recoverykey.txt\n' } : {});
    const share = await tools(registerDangerous, recording(key).rt).get('mega_share')!({ action: 'add', remotePath: '/Downloads', withEmail: 'x@example.com' });
    expect((share.structuredContent as { summary: string }).summary).toMatch(/recovery key file[\s\S]*\/Downloads\/mega-recoverykey\.txt/);
    const exp = await tools(registerDangerous, recording(key).rt).get('mega_export')!({ action: 'create', remotePath: '/Downloads' });
    expect((exp.structuredContent as { summary: string }).summary).toMatch(/recovery key file/);
    // A copy of such a folder asks first, even between private folders.
    const cp = await tools(registerMutate, recording(key).rt).get('mega_cp')!({ src: '/Downloads', dst: '/Backup2' });
    expect(cp.structuredContent).toMatchObject({ requiresConfirmation: true });
    // MEGA deletes the oldest "<name>_bk_<time>" folders beyond the count, whoever made them.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-bk-')));
    try {
      const bk = recording((cmd) => (cmd === 'ls' ? { stdout: `${basename(dir)}_bk_20260101000000\nother\n` } : {}));
      const add = await tools(registerSync, bk.rt).get('mega_backup_add')!({ localPath: dir, remotePath: '/Backups', period: '0 0 * * *', numBackups: 1 });
      expect((add.structuredContent as { summary: string }).summary).toMatch(/oldest are DELETED, whoever made them/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round 12: a writable link counts as others writing; a backup whose cloud folder is gone does not block downloads', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-r12w-')));
    const S = ';;MEGA-MCP;;';
    try {
      mkdirSync(join(dir, 'Proj', 'cfg'), { recursive: true });
      publishMegacmdBinDir(null, [], [join(dir, 'Proj', 'cfg')]);
      const synced = recording((cmd) => (cmd === 'sync' ? { stdout: `LOCALPATH${S}REMOTEPATH${S}RUN_STATE\n${join(dir, 'Proj')}${S}/Proj${S}Running\n` } : {}));
      expect(text(await tools(registerDangerous, synced.rt).get('mega_export')!({ action: 'create', remotePath: '/Proj', writable: true }))).toMatch(/make a read-only link instead/);
      const linked = recording((cmd, args) => (cmd === 'export' && args[0] === '/' ? { stdout: '/Proj (folder, shared as exported permanent folder link: https://mega.nz/folder/x#y AuthToken=[redacted])\n' } : {}));
      expect(text(await tools(registerSync, linked.rt).get('mega_sync_add')!({ localPath: join(dir, 'Proj'), remotePath: '/Proj' }))).toMatch(/can be written by other people/);
      publishMegacmdBinDir(null);
      // MEGAcmd lists a backup whose cloud folder is gone as INVALIDPATH: it writes nowhere.
      const pad = (v: string, n: number) => v + ' '.repeat(n - Array.from(v).length);
      const row = `${pad('3', 5)} ${pad(join(dir, 'Old'), 4096)} ${pad('INVALIDPATH', 4096)} ${'FAILED'.padStart(14)}`;
      const gone = recording((cmd) => (cmd === 'backup' ? { stdout: `TAG   LOCALPATH REMOTEPARENTPATH STATUS\n${row}\nBACKUP not found \n` } : {}));
      mkdirSync(join(dir, 'dl'));
      expect((await tools(registerMutate, gone.rt).get('mega_get')!({ remotePath: '/X/a.pdf', localDir: join(dir, 'dl') })).isError).toBeFalsy();
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round 12: cp/mv onto a file say its versions are deleted; moving a shared folder into a synced one says so', async () => {
    // A version copied onto its own file would take the file and all its versions with it.
    const verRt = recording((cmd, args) => (cmd === 'find' && args.includes('--type=d') && args[0] === '/X' ? { stdout: 'H:DIR' } : {}));
    expect(text(await tools(registerMutate, verRt.rt).get('mega_cp')!({ src: '/X/report.txt#1700000000', dst: '/X' }))).toMatch(/delete it and all its versions/);
    const fileRt = recording((c, a) => (c === 'find' && a.includes('--print-only-handles') ? { stdout: '' } : {}));
    expect((await tools(registerMutate, fileRt.rt).get('mega_cp')!({ src: '/a.txt', dst: '/b.txt' })).structuredContent).toMatchObject({ summary: expect.stringMatching(/all its older versions are deleted for good/) });
    // A folder shared with others, moved into a two-way synced folder.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-mvsync-')));
    const S = ';;MEGA-MCP;;';
    try {
      const rt = recording((cmd, args) =>
        cmd === 'sync'
          ? { stdout: `LOCALPATH${S}REMOTEPATH${S}RUN_STATE\n${dir}${S}/Home${S}Running\n` }
          : cmd === 'share' && args.join(' ') === '-p /'
            ? { stdout: '/Collab, shared with eve@x.y (read access)\n' }
            : cmd === 'find' && args.includes('--type=d') && args.includes('--print-only-handles')
              ? { stdout: 'H:DIR' }
              : {},
      ).rt;
      const mv = await tools(registerMutate, rt).get('mega_mv')!({ src: '/Collab', dst: '/Home' });
      expect((mv.structuredContent as { summary: string }).summary).toMatch(/Moved into the synced folder .*: \/Collab is shared with other people/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('codex report: uploads above a sync root, rebuilt names, %-named stores, deletes with an unknown sync list, FIFOs', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-cx-')));
    const S = ';;MEGA-MCP;;';
    try {
      // An upload merged into an existing folder that holds a sync's cloud side.
      mkdirSync(join(dir, 'Work', 'sub'), { recursive: true });
      const up = recording((cmd, args) =>
        cmd === 'ls' ? { stdout: 'Work\n' } : cmd === 'sync' ? { stdout: `LOCALPATH${S}REMOTEPATH${S}RUN_STATE\n/Users/me/s${S}/Up/Work/sub${S}Running\n` } : cmd === 'find' && args.includes('--type=d') ? { stdout: 'H:DIR' } : {},
      );
      expect(text(await tools(registerMutate, up.rt).get('mega_put')!({ localPath: join(dir, 'Work'), remotePath: '/Up' }))).toMatch(/holds the cloud side of a two-way sync/);
      // ...or that IS a sync's cloud side: what Work holds gets the synced landing checks.
      mkdirSync(join(dir, 'sync', '.claude'), { recursive: true });
      publishMegacmdBinDir(null, [], [join(dir, 'sync', '.claude')]);
      mkdirSync(join(dir, 'Work', '.claude'), { recursive: true });
      const exact = recording((cmd, args) =>
        cmd === 'ls' ? { stdout: 'Work\n' } : cmd === 'sync' ? { stdout: `LOCALPATH${S}REMOTEPATH${S}RUN_STATE\n${join(dir, 'sync')}${S}/Up/Work${S}Running\n` } : cmd === 'find' && args.includes('--type=d') ? { stdout: 'H:DIR' } : {},
      );
      expect(text(await tools(registerMutate, exact.rt).get('mega_put')!({ localPath: join(dir, 'Work'), remotePath: '/Up' }))).toMatch(/app configuration folder/);
      publishMegacmdBinDir(null);
      // A folder rebuilt around the store goes up under the name MEGA gives it (decoded).
      mkdirSync(join(dir, 'Old%20Laptop', '.megaCmd'), { recursive: true });
      writeFileSync(join(dir, 'Old%20Laptop', 'a.txt'), 'a');
      const plan = planUpload([join(dir, 'Old%20Laptop')], '/Backup', null);
      expect(plan.steps.map((st) => st.dest)).toContain('/Backup/Old Laptop');
      // Decoded, a name must not climb out of the target ("%2e%2e" is "..").
      mkdirSync(join(dir, 'up', '%2e%2e', '%2e%2e', 'Public', '.megaCmd'), { recursive: true });
      writeFileSync(join(dir, 'up', '%2e%2e', '%2e%2e', 'Public', 'payload.txt'), 'p');
      expect(() => planUpload([join(dir, 'up')], '/Private/Drop', null)).toThrow(/read differently by MEGAcmd/);
      // A copy of the store named so that it uploads as .megaCmd is left out too.
      mkdirSync(join(dir, 'Docs', '%2emegaCmd'), { recursive: true });
      writeFileSync(join(dir, 'Docs', 'b.txt'), 'b');
      expect(planUpload([join(dir, 'Docs')], '/B', null).excluded.some((x) => x.endsWith('%2emegaCmd'))).toBe(true);
      // Renamed copies (another client's "keep both") count as store copies too.
      for (const p of ['/x/.megaCmd (1)/session', '/x/.megaCmd copy/session']) expect(storeCopyIn(p), p).toBe('name');
      // Deleting with the sync list unreadable is refused (it could change a protected local folder).
      const unknown = recording((cmd) => (cmd === 'sync' ? { code: 1 } : {}));
      expect(text(await tools(registerDangerous, unknown.rt).get('mega_rm')!({ remotePath: '/Home/x' }))).toMatch(/Could not read MEGAcmd's list of syncs/);
      // A FIFO is not opened (it would block the server).
      if (process.platform !== 'win32') {
        execFileSync('mkfifo', [join(dir, 'pipe.jpg')]);
        expect(text(await tools(registerMutate, recording().rt).get('mega_thumbnail')!({ remotePath: '/f.jpg', localPath: join(dir, 'pipe.jpg'), action: 'set' }))).toMatch(/not a regular file/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a sync waits for a background upload that may still deliver a .megaignore into its cloud folder', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-bgup-')));
    try {
      mkdirSync(join(dir, 'pack', 'sub'), { recursive: true });
      writeFileSync(join(dir, 'pack', 'sub', '.megaignore'), '+:.claude\n');
      mkdirSync(join(dir, 'local'));
      // Where the upload puts its .megaignore: missing until it arrives.
      let arrived = false;
      const r = recording((cmd, args) => (cmd === 'find' && args[0] === '/Drop/pack/sub/.megaignore' ? (arrived ? { stdout: '' } : { code: 53 }) : {}));
      const put = tools(registerMutate, r.rt).get('mega_put')!;
      const p = await put({ localPath: join(dir, 'pack'), remotePath: '/Drop', background: true });
      expect((await put({ localPath: join(dir, 'pack'), remotePath: '/Drop', background: true, confirm: token(p) })).isError).toBeFalsy();
      const add = tools(registerSync, r.rt).get('mega_sync_add')!;
      expect(text(await add({ localPath: join(dir, 'local'), remotePath: '/Drop' }))).toMatch(/puts \/Drop\/pack\/sub\/\.megaignore .* may still arrive/);
      arrived = true;
      expect((await add({ localPath: join(dir, 'local'), remotePath: '/Drop' })).isError).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round 14: %xx local names map to their cloud names; moves into a backup folder name rotation', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-r14-')));
    const S = ';;MEGA-MCP;;';
    try {
      // The local folder "my%20project" is the cloud's "my project": a write root inside it counts.
      mkdirSync(join(dir, 'my%20project', '.claude'), { recursive: true });
      publishMegacmdBinDir(null, [], [join(dir, 'my%20project', '.claude')]);
      const synced = recording((cmd) => (cmd === 'sync' ? { stdout: `LOCALPATH${S}REMOTEPATH${S}RUN_STATE\n${dir}${S}/Home${S}Running\n` } : {}));
      expect(text(await tools(registerMutate, synced.rt).get('mega_cp')!({ src: '/X/settings.json', dst: '/Home/my project/.claude' }))).toMatch(/app configuration folder|depends on|Refusing/);
      publishMegacmdBinDir(null);
      // A moved folder named like a backup copy in a backup's cloud folder is rotated away by MEGA.
      const pad = (v: string, n: number) => v + ' '.repeat(n - Array.from(v).length);
      const row = `${pad('3', 5)} ${pad('/Users/me/Docs', 4096)} ${pad('/Backups', 4096)} ${'ACTIVE'.padStart(14)}`;
      const bk = recording((cmd, args) => (cmd === 'backup' ? { stdout: `TAG   LOCALPATH REMOTEPARENTPATH STATUS\n${row}\n` } : cmd === 'find' && args.includes('--type=d') && args[0] === '/Backups' ? { stdout: 'H:DIR' } : {}));
      const mv = await tools(registerMutate, bk.rt).get('mega_mv')!({ src: '/Work/Docs_bk_20260101000000', dst: '/Backups' });
      expect((mv.structuredContent as { summary: string }).summary).toMatch(/would count as a backup copy of \/Users\/me\/Docs/);
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resuming a paused sync runs the sync_add checks on its current cloud folder', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-resume-')));
    try {
      const S = ';;MEGA-MCP;;';
      const listing = `ID${S}LOCALPATH${S}REMOTEHANDLE${S}REMOTEPATH${S}RUN_STATE\nSyncId00001${S}${dir}${S}<H:Abcd1234>${S}/Work${S}Paused\n`;
      const reply = (at: string, extra: (cmd: string, args: string[]) => object = () => ({})) => (cmd: string, args: string[]) =>
        cmd === 'sync' && args[0] === '--show-handles' ? { stdout: listing } : cmd === 'find' && args.includes('--pattern=Work') ? { stdout: `H:Sub00001\n${at}\n` } : extra(cmd, args);
      const control = (r: ReturnType<typeof recording>) => tools(registerSync, r.rt).get('mega_sync_control')!;
      // Moved while paused: the last known path holds another folder now.
      const moved = recording(reply('H:Other000'));
      expect(text(await control(moved)({ action: 'resume', id: 'SyncId00001' }))).toMatch(/no longer at \/Work/);
      // In place: the preview names both sides, and a nested .megaignore in the cloud is refused.
      const ok = recording(reply('H:Abcd1234'));
      const preview = await control(ok)({ action: 'resume', id: 'SyncId00001' });
      expect((preview.structuredContent as { summary: string }).summary).toContain(`TWO-WAY sync between ${dir} and /Work`);
      const nested = recording(reply('H:Abcd1234', (cmd, args) => (cmd === 'find' && args.includes('--type=f') ? { stdout: '/Work/sub/.megaignore\n' } : {})));
      expect(text(await control(nested)({ action: 'resume', id: 'SyncId00001' }))).toMatch(/\.megaignore/);
      for (const r of [moved, ok, nested]) expect(r.argv.filter((a) => a[0] === 'sync' && a[1] === '-e')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a merged download into a folder above a synced folder is refused, and backups match without trailing spaces', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-mergeabove-')));
    try {
      mkdirSync(join(dir, 'Proj'));
      const { rt, argv } = recording((cmd, args) =>
        cmd === 'sync' ? { stdout: `LOCALPATH;;MEGA-MCP;;REMOTEPATH;;MEGA-MCP;;RUN_STATE\n${join(dir, 'Proj')};;MEGA-MCP;;/Proj;;MEGA-MCP;;Running\n` } : cmd === 'find' && args.includes('--type=d') && args[0] === '/X' ? { stdout: 'H:DIR' } : {},
      );
      expect(text(await tools(registerMutate, rt).get('mega_get')!({ remotePath: '/X', localDir: dir, merge: true }))).toMatch(/holds or links to .*which MEGAcmd syncs or backs up/);
      expect((await tools(registerMutate, rt).get('mega_get')!({ remotePath: '/X', localDir: dir })).isError).toBeFalsy();
      // Without merge, an existing <localDir>/<name> is downloaded INTO: here it is the synced folder.
      expect(text(await tools(registerMutate, rt).get('mega_get')!({ remotePath: '/X/Proj', localDir: dir }))).toMatch(/which MEGAcmd syncs or backs up/);
      // A symlink inside the merge target leads into the synced folder.
      const other = join(dir, 'Other');
      mkdirSync(other);
      symlinkSync(join(dir, 'Proj'), join(other, 'shared'));
      expect(text(await tools(registerMutate, rt).get('mega_get')!({ remotePath: '/X', localDir: other, merge: true }))).toMatch(/links to .*which MEGAcmd syncs or backs up/);
      expect(argv.filter((a) => a[0] === 'get')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const pad = (v: string, n: number) => v + ' '.repeat(n - Array.from(v).length);
    const row = `${pad('3', 5)} ${pad('/Users/x/Documents', 4096)} ${pad('/Backups ', 4096)} ${'ACTIVE'.padStart(14)}`;
    const { rt } = recording((cmd) => (cmd === 'backup' ? { stdout: `TAG   LOCALPATH REMOTEPARENTPATH STATUS\n${row}\n` } : {}));
    const share = await tools(registerDangerous, rt).get('mega_share')!({ action: 'add', remotePath: '/Backups /', withEmail: 'a@b.c' });
    expect(summary(share)).toMatch(/receives periodic backups/);
  });

  it('a long run of "*" is checked in linear time', () => {
    const t = Date.now();
    expect(globCanMatchStoreName('*'.repeat(200_000) + '.txt')).toBe(false);
    expect(globCanMatchStoreName('*'.repeat(200_000))).toBe(true);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('a long pattern preview shows the pattern and where the unlisted matches are', async () => {
    const listing = [...Array.from({ length: 200 }, (_, i) => `/Junk/f${i} <H:j${i}>`), '/Documents/cv.pdf <H:doc>'].join('\n');
    const { rt } = recording((cmd, args) => (cmd === 'find' && args.includes('--use-pcre') ? { stdout: args.includes('--print-only-handles') ? listing.split('\n').map((l) => l.match(/<(H:[^>]+)>$/)![1]).join('\n') : listing } : {}));
    const res = await tools(registerDangerous, rt).get('mega_rm')!({ remotePath: '/(Junk|Documents)/.*', usePcre: true });
    const sum = summary(res);
    expect(sum).toMatch(/\(pattern: \/\(Junk\|Documents\)\/\.\*\)/);
    expect(sum).toMatch(/Not listed: 1 in \/Documents/);
  });
});

describe('round 5 fixes', () => {
  const summary = (r: CallToolResult) => (r.structuredContent as { summary?: string } | undefined)?.summary ?? text(r);
  const tokenOf = (r: CallToolResult) => (r.structuredContent as { confirmToken: string }).confirmToken;
  const folder = (cmd: string, args: string[]) => cmd === 'find' && args.includes('--type=d') && args.includes('--print-only-handles');
  const syncList = (rows: string[]) => ({ stdout: ['LOCALPATH;;MEGA-MCP;;REMOTEPATH;;MEGA-MCP;;RUN_STATE', ...rows].join('\n') + '\n' });

  it('an item placed unconfirmed after a share preview voids its token', async () => {
    const { rt, argv } = recording((cmd, args) => (folder(cmd, args) ? { stdout: 'H:DIR' } : {}));
    const share = tools(registerDangerous, rt).get('mega_share')!;
    const preview = await share({ action: 'add', remotePath: '/Trip9', withEmail: 'eve@example.com' });
    await tools(registerMutate, rt).get('mega_cp')!({ src: '/Private/passport9.pdf', dst: '/Trip9' });
    const res = await share({ action: 'add', remotePath: '/Trip9', withEmail: 'eve@example.com', confirm: tokenOf(preview) });
    expect(res.isError).toBe(true);
    expect(argv.filter((a) => a[0] === 'share' && a.includes('-a'))).toEqual([]);
  });

  it('names the original of an unconfirmed copy, follows moves, and shows up in pattern previews', async () => {
    const listing = '/Report <H:aaaaaaaa>';
    // /Q3/notes.txt and /Report do not exist yet (new name; rename).
    const { rt } = recording((cmd, args) =>
      folder(cmd, args)
        ? ['/Q3/notes.txt', '/Report'].includes(args[0] as string)
          ? { code: 53 }
          : { stdout: 'H:DIR' }
        : cmd === 'find' && args.includes('--use-pcre')
          ? { stdout: args.includes('--print-only-handles') ? 'H:aaaaaaaa' : listing }
          : {},
    );
    const m = tools(registerMutate, rt);
    // The recovery key file is not copied without asking, whatever the destination.
    expect(summary(await m.get('mega_cp')!({ src: '/Downloads/MEGA-RECOVERYKEY.txt', dst: '/Q3/notes.txt' }))).toMatch(/recovery key file/);
    await m.get('mega_cp')!({ src: '/Downloads/budget.xlsx', dst: '/Q3/notes.txt' });
    const mvPreview = await m.get('mega_mv')!({ src: '/Q3', dst: '/Report' });
    await m.get('mega_mv')!({ src: '/Q3', dst: '/Report', confirm: tokenOf(mvPreview) });
    const share = await tools(registerDangerous, rt).get('mega_share')!({ action: 'add', remotePath: '/Report', usePcre: true, withEmail: 'eve@example.com' });
    expect(summary(share)).toMatch(/\/Report\/notes\.txt \(a copy of \/Downloads\/budget\.xlsx\)/);
    // A download of the renamed copy names it too (not only into a synced folder).
    const dl = await m.get('mega_get')!({ remotePath: '/Report/notes.txt', localDir: tmpdir() });
    expect(summary(dl)).toMatch(/\/Report\/notes\.txt \(a copy of \/Downloads\/budget\.xlsx\)/);
  });

  it('recognises a sync of an incoming share, and a paused sync by its last known path', async () => {
    const inShare = recording((cmd, args) => (cmd === 'sync' ? syncList(['/Users/me/team;;MEGA-MCP;;eve@example.com:Team;;MEGA-MCP;;Running']) : folder(cmd, args) ? { stdout: 'H:DIR' } : {})).rt;
    const res = await tools(registerMutate, inShare).get('mega_cp')!({ src: '/a.txt', dst: '//from/eve@example.com:Team/sub' });
    expect(summary(res)).toMatch(/written to this computer, at \/Users\/me\/team\/sub/);
    // A paused sync, and MEGAcmd's notice line after the table: no blanket "unknown".
    const paused = recording((cmd, args) =>
      cmd === 'sync'
        ? { stdout: syncList(['/Users/me/w;;MEGA-MCP;;/Old;;MEGA-MCP;;Paused']).stdout + '\nSome of your "Pending" sync uploads are being delayed.\n' }
        : folder(cmd, args)
          ? { stdout: 'H:DIR' }
          : {},
    ).rt;
    const elsewhere = await tools(registerMutate, paused).get('mega_cp')!({ src: '/a.txt', dst: '/Elsewhere' });
    expect(elsewhere.structuredContent).not.toMatchObject({ requiresConfirmation: true });
    const intoPaused = await tools(registerMutate, paused).get('mega_cp')!({ src: '/a.txt', dst: '/Old/x' });
    expect(summary(intoPaused)).toMatch(/written to this computer, at \/Users\/me\/w\/x/);
  });

  it('sees a sync added a moment ago (no cached list)', async () => {
    let rows: string[] = [];
    const { rt } = recording((cmd, args) => (cmd === 'sync' ? syncList(rows) : folder(cmd, args) ? { stdout: 'H:DIR' } : {}));
    const mkdir = tools(registerMutate, rt).get('mega_mkdir')!;
    await mkdir({ remotePath: '/Scratch' });
    rows = ['/Users/me/Work;;MEGA-MCP;;/Work;;MEGA-MCP;;Running'];
    const res = await tools(registerMutate, rt).get('mega_cp')!({ src: '/evil.plist', dst: '/Work' });
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
  });

  it('removing or moving out of a synced folder names the local change, and refuses protected or rule files', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-srcsync-')));
    try {
      mkdirSync(join(dir, '.claude'), { recursive: true });
      publishMegacmdBinDir(null, [], [join(dir, '.claude')]);
      const { rt } = recording((cmd, args) => (cmd === 'sync' ? syncList([`${dir};;MEGA-MCP;;/Home;;MEGA-MCP;;Running`]) : folder(cmd, args) ? { stdout: 'H:DIR' } : {}));
      const rm = tools(registerDangerous, rt).get('mega_rm')!;
      expect(summary(await rm({ remotePath: '/Home/notes.txt' }))).toMatch(/also removed on this computer/);
      expect((await rm({ remotePath: '/Home/.claude/settings.json' })).isError).toBe(true);
      expect((await rm({ remotePath: '/Home/.megaignore' })).isError).toBe(true);
      expect((await tools(registerMutate, rt).get('mega_mv')!({ src: '/Home/.claude/hooks', dst: '/Archive' })).isError).toBe(true);
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mega_sync_ignore cannot remove a rule that keeps .megaCmd out (MEGA default -:.*)', async () => {
    const S = ';;MEGA-MCP;;';
    const ign = tools(registerSync, recording((cmd, args) => (cmd === 'sync' && args[0] === '--show-handles' ? { stdout: `ID${S}LOCALPATH${S}REMOTEHANDLE${S}REMOTEPATH${S}RUN_STATE\nX1${S}/Users/me${S}<H:Abcd1234>${S}/Home${S}Running\n` } : {})).rt).get('mega_sync_ignore')!;
    for (const f of [':.*', 'r:.+', 'd:.mega*']) expect((await ign({ action: 'remove-exclusion', target: '/Users/me', filters: [f] })).isError, f).toBe(true);
    expect((await ign({ action: 'remove-exclusion', target: '/Users/me', filters: ['f:*.tmp'] })).isError).toBeFalsy();
  });

  it('leaves out a protected folder whose path has outer spaces, wildcard characters or %-escapes by an exact regex rule', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-spacename-')));
    try {
      mkdirSync(join(dir, 'old home ', '.megaCmd'), { recursive: true });
      mkdirSync(join(dir, 'site [old]', '.megaCmd'), { recursive: true });
      mkdirSync(join(dir, 'My%20Project', '.megaCmd'), { recursive: true });
      const rules = syncExclusions(dir).map((e) => e.rule);
      expect(rules).toContain('-apr:old[ ]home[ ]/\\.megaCmd');
      expect(rules).toContain('-apr:site[ ]\\[old]/\\.megaCmd');
      // Rules match cloud names: the SDK uploads My%20Project as "My Project".
      expect(rules).toContain('-apg:My Project/.megaCmd');
      expect(() => syncExclusions(join(dir, 'x%2fy'))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mega_mkdir binds its notes, and a synced destination carries the executable-permission note', async () => {
    let linked = false;
    const { rt } = recording((cmd, args) =>
      cmd === 'share' && args.join(' ') === '-p /'
        ? { stdout: '/Team, shared with bob@example.com (read access)\n' }
        : cmd === 'export' && args.join(' ') === '/' && linked
          ? { stdout: '/Team (folder, shared as exported permanent folder link: https://mega.nz/folder/x#y)\n' }
          : {},
    );
    const mkdir = tools(registerMutate, rt).get('mega_mkdir')!;
    const preview = await mkdir({ remotePath: '/Team/new' });
    linked = true;
    expect((await mkdir({ remotePath: '/Team/new', confirm: tokenOf(preview) })).isError).toBe(true);
    if (process.platform !== 'win32') {
      const synced = recording((cmd, args) =>
        cmd === 'sync' ? syncList(['/Users/me/w;;MEGA-MCP;;/W;;MEGA-MCP;;Running']) : cmd === 'permissions' ? { stdout: 'Default files permissions: 755\n' } : folder(cmd, args) ? { stdout: 'H:DIR' } : {},
      ).rt;
      expect(summary(await tools(registerMutate, synced).get('mega_cp')!({ src: '/a', dst: '/W' }))).toMatch(/EXECUTABLE/);
    }
  });
});

describe('round 5 functional fixes', () => {
  const folder = (cmd: string, args: string[]) => cmd === 'find' && args.includes('--type=d') && args.includes('--print-only-handles');

  it('a new .megaignore starts from MEGA\'s built-in exclusions when the default file does not exist yet', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-sdkdefaults-')));
    try {
      mkdirSync(join(dir, '.megaCmd'));
      const { rt } = recording((cmd) => (cmd === 'sync-ignore' ? { code: 53 } : {}));
      const add = tools(registerSync, rt).get('mega_sync_add')!;
      const preview = await add({ localPath: dir, remotePath: '/x' });
      await add({ localPath: dir, remotePath: '/x', confirm: (preview.structuredContent as { confirmToken: string }).confirmToken });
      const content = readFileSync(join(dir, '.megaignore'), 'utf8');
      expect(content).toContain('-:.*\n');
      expect(content).toContain('-:*.tmp\n');
      expect(content.trim().split('\n').at(-1)).toBe('-sync:.megaignore');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an import is refused where a synced folder holds a protected one below, and allowed elsewhere in it', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-importhome-')));
    try {
      mkdirSync(join(dir, '.claude'));
      mkdirSync(join(dir, 'Docs'));
      publishMegacmdBinDir(null, [], [join(dir, '.claude')]);
      const { rt } = recording((cmd) => (cmd === 'sync' ? { stdout: `LOCALPATH;;MEGA-MCP;;REMOTEPATH;;MEGA-MCP;;RUN_STATE\n${dir};;MEGA-MCP;;/Home;;MEGA-MCP;;Running\n` } : {}));
      const imp = tools(registerManage, rt).get('mega_import')!;
      // Its names are not known before: a tree could reach .claude under a name
      // the sync's rules (ASCII-only case folding) do not match.
      expect((await imp({ link: 'https://mega.nz/folder/abc#key', remotePath: '/Home' })).isError).toBe(true);
      const ok = await imp({ link: 'https://mega.nz/folder/abc#key', remotePath: '/Home/Docs' });
      expect(ok.isError, text(ok)).toBeFalsy();
      expect((ok.structuredContent as { summary: string }).summary).toMatch(/written to this computer/);
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('copying a folder next to a same-named folder needs no question (MEGA keeps both)', async () => {
    const { rt } = recording((cmd, args) => (folder(cmd, args) ? { stdout: 'H:DIR' } : cmd === 'ls' && args.length === 1 ? { stdout: 'Photos\n' } : {}));
    const res = await tools(registerMutate, rt).get('mega_cp')!({ src: '/Old/Photos', dst: '/Archive' });
    expect(res.structuredContent).not.toMatchObject({ requiresConfirmation: true });
  });

  it('a large plain upload is split into command lines that fit', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-putchunk-')));
    try {
      const lps = Array.from({ length: 2500 }, (_, i) => join(dir, `f${i}.txt`));
      for (const p of lps) writeFileSync(p, 'x');
      const { rt, argv } = recording((cmd, args) => (cmd === 'mkdir' ? {} : folder(cmd, args) ? { stdout: 'H:DIR' } : {}));
      const put = tools(registerMutate, rt).get('mega_put')!;
      const preview = await put({ localPaths: lps, remotePath: '/Up' });
      const done = await put({ localPaths: lps, remotePath: '/Up', confirm: (preview.structuredContent as { confirmToken: string }).confirmToken });
      expect(done.isError, text(done)).toBeFalsy();
      const puts = argv.filter((a) => a[0] === 'put');
      expect(puts.length).toBeGreaterThan(1);
      expect(puts.reduce((n, a) => n + a.length - 3, 0)).toBe(2500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('a pattern preview of 20,000 matches is quick', async () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `/Big/f${i} <H:h${i}>`);
    const { rt } = recording((cmd, args) => (cmd === 'find' && args.includes('--use-pcre') ? { stdout: args.includes('--print-only-handles') ? lines.map((l) => l.match(/<(H:[^>]+)>$/)![1]).join('\n') : lines.join('\n') } : {}));
    const t0 = Date.now();
    const res = await tools(registerDangerous, rt).get('mega_rm')!({ remotePath: '/Big/.*', usePcre: true });
    expect(res.isError).toBeFalsy();
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});


describe('round 14 fixes', () => {
  const summary = (r: CallToolResult) => (r.structuredContent as { summary?: string } | undefined)?.summary ?? text(r);
  const S = ';;MEGA-MCP;;';
  const pad = (v: string, n: number) => v + ' '.repeat(n - Array.from(v).length);
  const backupRow = (local: string, remote: string) => ({ stdout: `TAG   LOCALPATH REMOTEPARENTPATH STATUS\n${pad('3', 5)} ${pad(local, 4096)} ${pad(remote, 4096)} ${'ACTIVE'.padStart(14)}\n` });

  it('splits command lines by the gate\'s own count, other words included, and a refused batch only counts as failed', async () => {
    const d = `/${'d'.repeat(1500)}`;
    const items = Array.from({ length: 600 }, (_, i) => `/src/${'x'.repeat((i * 37) % 300)}${i}`);
    const chunks = chunkArgs(items, 2000, [d]);
    expect(chunks.flat()).toEqual(items);
    for (const c of chunks) expect(() => assertSafeInvocation('mv', [...c, d])).not.toThrow();
    const rt = { run: async (_c: string, args: string[]) => {
      if (args.includes('/b')) throw new ValidationError('too long');
      return { code: 0, stdout: '', stderr: '' };
    } } as unknown as Runtime;
    expect(await runBulk(rt, 'mv', ['/a', '/b', '/c'], ['/D'], 1)).toEqual({ done: 2, failed: 1 });
  });

  it('mkdir and cp ask before making a name a periodic backup counts as one of its copies', async () => {
    const { rt, argv } = recording((cmd, args) =>
      cmd === 'backup' ? backupRow('/Users/me/Docs', '/Backups') : cmd === 'find' && args.includes('--type=d') && args[0] === '/Backups' ? { stdout: 'H:DIR' } : {},
    );
    const mut = tools(registerMutate, rt);
    const mk = await mut.get('mega_mkdir')!({ remotePath: '/Backups/Docs_bk_20260101000000/sub' });
    expect(mk.structuredContent).toMatchObject({ requiresConfirmation: true });
    expect(summary(mk)).toMatch(/Docs_bk_20260101000000 would count as a backup copy of \/Users\/me\/Docs/);
    expect(argv.some((a) => a[0] === 'mkdir')).toBe(false);
    // An ordinary name runs at once, without reading the backup list.
    const before = argv.length;
    expect((await mut.get('mega_mkdir')!({ remotePath: '/Backups/plain' })).structuredContent).not.toMatchObject({ requiresConfirmation: true });
    expect(argv.slice(before).some((a) => a[0] === 'backup')).toBe(false);
    const cp = await mut.get('mega_cp')!({ src: '/Work/Docs_bk_20260101000000', dst: '/Backups' });
    expect(cp.structuredContent).toMatchObject({ requiresConfirmation: true });
    expect(summary(cp)).toMatch(/would count as a backup copy/);
    // An import's name is known only once fetched: a backup's folder is named.
    const imp = await tools(registerManage, rt).get('mega_import')!({ link: 'https://mega.nz/folder/abc#key', remotePath: '/Backups' });
    expect(summary(imp)).toMatch(/periodic backup of \/Users\/me\/Docs keeps its copies/);
  });

  it('a single folder copied to a new name in a synced folder is checked under its own name first, in list mode too', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-r14cp-')));
    try {
      mkdirSync(join(dir, '.claude'));
      publishMegacmdBinDir(null, [], [join(dir, '.claude')]);
      const { rt, argv } = recording((cmd, args) =>
        cmd === 'sync'
          ? { stdout: `LOCALPATH${S}REMOTEPATH${S}RUN_STATE\n${dir}${S}/Home${S}Running\n` }
          : cmd === 'find' && args.includes('--type=d') && args.includes('--print-only-handles')
            ? args[0] === '/Home/newname' ? { code: 53 } : { stdout: 'H:DIR' }
            : {},
      );
      const cp = tools(registerMutate, rt).get('mega_cp')!;
      for (const call of [{ src: '/X/.claude', dst: '/Home/newname' }, { srcs: ['/X/.claude'], dst: '/Home/newname' }]) {
        expect((await cp(call)).isError, JSON.stringify(call)).toBe(true);
      }
      expect(argv.some((a) => a[0] === 'cp')).toBe(false);
    } finally {
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a recovery key copied, moved or uploaded under another name is still named when its folder is shared', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-r14rk-')));
    try {
      const { rt } = recording((cmd, args) => (cmd === 'find' && args.includes('--type=d') && args.includes('--print-only-handles') && /notes|moved|up14/.test(args[0] as string) ? { code: 53 } : {}));
      const mut = tools(registerMutate, rt);
      const share = tools(registerDangerous, rt).get('mega_share')!;
      const cp = mut.get('mega_cp')!;
      const pre = await cp({ src: '/RK14/MEGA-RECOVERYKEY.txt', dst: '/Docs14/notes.txt' });
      expect(summary(pre)).toMatch(/recovery key/);
      expect((await cp({ src: '/RK14/MEGA-RECOVERYKEY.txt', dst: '/Docs14/notes.txt', confirm: token(pre) })).isError).toBeFalsy();
      expect(summary(await share({ action: 'add', remotePath: '/Docs14', withEmail: 'x@example.com', level: 'read' }))).toContain('/Docs14/notes.txt (a copy of /RK14/MEGA-RECOVERYKEY.txt)');
      const mv = mut.get('mega_mv')!;
      const mpre = await mv({ src: '/RK14b/MEGA-RECOVERYKEY.txt', dst: '/Docs14b/moved.txt' });
      expect((await mv({ src: '/RK14b/MEGA-RECOVERYKEY.txt', dst: '/Docs14b/moved.txt', confirm: token(mpre) })).isError).toBeFalsy();
      expect(summary(await share({ action: 'add', remotePath: '/Docs14b', withEmail: 'x@example.com', level: 'read' }))).toContain('/Docs14b/moved.txt (a copy of /RK14b/MEGA-RECOVERYKEY.txt)');
      // Uploaded (MEGA's web client saves it under this name): named in the preview, and remembered renamed.
      const key = join(dir, 'MEGA-RECOVERYKEY.txt');
      writeFileSync(key, 'AbCdEfGhIjKlMnOpQrStUv');
      const put = mut.get('mega_put')!;
      const ppre = await put({ localPath: key, remotePath: '/Up14', name: 'up14.txt' });
      expect(summary(ppre)).toMatch(/Named like MEGA's recovery key file/);
      expect((await put({ localPath: key, remotePath: '/Up14', name: 'up14.txt', confirm: token(ppre) })).isError).toBeFalsy();
      expect(summary(await share({ action: 'add', remotePath: '/Up14', withEmail: 'x@example.com', level: 'read' }))).toContain(`/Up14/up14.txt (a copy of ${key})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a search for the recovery key that could not run is said to be incomplete', async () => {
    const { rt } = recording((cmd) => (cmd === 'find' ? { code: -1, spawnError: 'EACCES' as RunResult['spawnError'] } : {}));
    expect(await recoveryKeyLinesBelow(rt, ['/A'])).toContain("(Could not check everything inside for MEGA's recovery key file.)");
  });

  it('a link expiry is read as MEGAcmd reads it ("m" is months), and anything else is refused', async () => {
    expect(describeExpiry('1m')).toBe('1 month');
    expect(describeExpiry('30M')).toBe('30 minutes');
    expect(describeExpiry('1m2d')).toBe('1 month 2 days');
    for (const bad of ['2w', '1', 'd', '1d ', '-1d', '1.5d']) expect(() => describeExpiry(bad), bad).toThrow(/expire must be/);
    const exp = tools(registerDangerous, recording().rt).get('mega_export')!;
    expect(text(await exp({ action: 'create', remotePath: '/Team', expire: '2w' }))).toMatch(/expire must be/);
    expect(summary(await exp({ action: 'create', remotePath: '/Team', expire: '1m' }))).toContain('expire after 1 month ("1m")');
  });

  it('a pattern link whose password MEGA could not add is withdrawn, but a link there before is left alone', async () => {
    const lines = '/Team/a <H:ha>\n/Team/b <H:hb>';
    const { rt, argv } = recording((cmd, args) => {
      if (cmd === 'find' && args.includes('--use-pcre')) return { stdout: args.includes('--print-only-handles') ? 'H:ha\nH:hb' : lines };
      // As MEGAcmd answers: published, then failed adding the password (path printed relative to "/");
      // already linked before (EXISTS, nothing changed).
      if (cmd === 'export' && args[0] === '-a') return args.includes('H:ha') ? { code: 59, stdout: 'Exported /Team/a: https://mega.nz/file/x#y\n' } : { code: 64 };
      return {};
    });
    const exp = tools(registerDangerous, rt).get('mega_export')!;
    const pre = await exp({ action: 'create', remotePath: '/Team/.*', usePcre: true, password: 'pw-1234' });
    const done = await exp({ action: 'create', remotePath: '/Team/.*', usePcre: true, password: 'pw-1234', confirm: token(pre) });
    expect(done.structuredContent).toMatchObject({ unprotected: 1, failed: 1 });
    expect(argv.filter((a) => a[0] === 'export' && a[1] === '-d').map((a) => a[2])).toEqual(['H:ha']);
  });

  it('a password check reads the link MEGA made, not a link-shaped name in its path', async () => {
    const { rt, argv } = recording((cmd, args) =>
      cmd === 'export' && args[0] === '-a' ? { stdout: 'Exported /Docs/see https://mega.nz/#P!z/x: https://mega.nz/file/plain#key\n' } : {},
    );
    const exp = tools(registerDangerous, rt).get('mega_export')!;
    const pre = await exp({ action: 'create', remotePath: '/Docs/x', password: 'pw-1234' });
    const done = await exp({ action: 'create', remotePath: '/Docs/x', password: 'pw-1234', confirm: token(pre) });
    expect(done.structuredContent).toMatchObject({ unprotected: true });
    expect(argv.some((a) => a[0] === 'export' && a[1] === '-d')).toBe(true);
  });

  it('an own folder whose name holds ":" is expected under its whole name when downloaded', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-r14colon-')));
    try {
      const { rt } = recording((cmd, args) => (cmd === 'find' && String(args.at(-1)).startsWith('--pattern=.??') && args[0] === '/Docs/x:Share' ? { stdout: '/Docs/x:Share/sub/.megaignore\n' } : {}));
      const get = tools(registerMutate, rt).get('mega_get')!;
      const pre = await get({ remotePath: '/Docs/x:Share', localDir: dir, background: true });
      expect((await get({ remotePath: '/Docs/x:Share', localDir: dir, background: true, confirm: token(pre) })).isError).toBeFalsy();
      // Arrived (simulated) under the whole name: a sync of that folder is refused over it.
      mkdirSync(join(dir, 'x:Share', 'sub'), { recursive: true });
      writeFileSync(join(dir, 'x:Share', 'sub', '.megaignore'), '+:.claude\n');
      expect(text(await tools(registerSync, recording().rt).get('mega_sync_add')!({ localPath: join(dir, 'x:Share'), remotePath: '/S14' }))).toMatch(/a download of this session put below/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a .megaignore expected from a download stays expected after a check that found no transfers', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-r14keep-')));
    try {
      mkdirSync(join(dir, 'pack'));
      const { rt } = recording((cmd, args) => (cmd === 'find' && String(args.at(-1)).startsWith('--pattern=.??') && args[0] === '/Pack14' ? { stdout: '/Pack14/.megaignore\n' } : {}));
      const get = tools(registerMutate, rt).get('mega_get')!;
      const pre = await get({ remotePath: '/Pack14', localDir: join(dir, 'pack'), background: true });
      expect((await get({ remotePath: '/Pack14', localDir: join(dir, 'pack'), background: true, confirm: token(pre) })).isError).toBeFalsy();
      const sync = tools(registerSync, recording().rt).get('mega_sync_add')!;
      // Not there yet and nothing queued (a folder transfer still scanning): the sync may run...
      mkdirSync(join(dir, 'pack', 'Pack14'));
      const first = await sync({ localPath: join(dir, 'pack'), remotePath: '/O14' });
      expect(first.structuredContent, text(first)).toMatchObject({ requiresConfirmation: true });
      // ...but once it arrives it is still known as downloaded.
      writeFileSync(join(dir, 'pack', 'Pack14', '.megaignore'), '+:.claude\n');
      expect(text(await sync({ localPath: dir, remotePath: '/H14' }))).toMatch(/a download of this session put below/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a one-character non-ASCII name with a version suffix is a version, as MEGAcmd counts bytes', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-r14ver-')));
    try {
      const get = tools(registerMutate, recording().rt).get('mega_get')!;
      expect(summary(await get({ remotePath: '/D/日#1700000000', localDir: dir }))).toContain(`saved as ${join(dir, '日')}`);
      // One ASCII character makes 12 bytes: a plain name to MEGAcmd too.
      expect(summary(await get({ remotePath: '/D/a#1700000000', localDir: dir }))).not.toContain('saved as');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renamed copies of the session store are left out of uploads and refused in the cloud', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-r14store-')));
    try {
      for (const n of ['.megaCmd.bak', '.megaCmd~', 'docs']) mkdirSync(join(dir, n));
      const plan = planUpload([dir], '/B', null);
      expect(plan.excluded.map((p) => basename(p)).sort()).toEqual(['.megaCmd.bak', '.megaCmd~']);
      expect(storeCopyIn('/Backup/home/.megaCmd.old/session')).toBe('name');
      expect(storeCopyIn('/b/*.txt')).toBe(null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'darwin')('protects Claude Desktop\'s other profile folders', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-r14host-')));
    const prev = process.env.CLAUDE_USER_DATA_DIR;
    try {
      process.env.CLAUDE_USER_DATA_DIR = join(dir, 'profile');
      createRuntime(
        { cacheDir: join(dir, 'cache'), systemAppBinDirs: [], download: { sha256Allow: [] }, maxListLines: 1000, exposeContacts: false, exposeAccountDetails: false, exposeFileContents: false } as Config,
        { resolve: async () => null, verify: async () => true },
      );
      expect(() => assertDownloadTarget(join(homedir(), 'Library', 'Application Support'), 'Claude-3p')).toThrow();
      expect(() => assertDownloadTarget(dir, 'profile')).toThrow();
      expect(() => assertDownloadTarget(dir, 'elsewhere')).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_USER_DATA_DIR;
      else process.env.CLAUDE_USER_DATA_DIR = prev;
      publishMegacmdBinDir(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('round 15 fixes', () => {
  const summary = (r: CallToolResult) => (r.structuredContent as { summary?: string } | undefined)?.summary ?? text(r);
  const S = ';;MEGA-MCP;;';
  const pad = (v: string, n: number) => v + ' '.repeat(n - Array.from(v).length);
  const backupRow = (local: string, remote: string) => ({ stdout: `TAG   LOCALPATH REMOTEPARENTPATH STATUS\n${pad('3', 5)} ${pad(local, 4096)} ${pad(remote, 4096)} ${'ACTIVE'.padStart(14)}\n` });

  it('mega_cat asks for reading consent again after waiting for the write lock', async () => {
    let calls = 0;
    const { rt, argv } = recording((cmd) => (cmd === 'cat' ? { stdout: 'SECRET' } : {}));
    const cat = registerCat({ registerTool: (_n: string, _d: unknown, cb: ToolFn) => ({ handler: cb, disable() {}, enable() {} }) } as any, rt, () => ++calls === 1) as unknown as { handler: ToolFn };
    const res = await cat.handler({ remotePath: '/Docs/a.txt' });
    expect(text(res)).toMatch(/turned off/);
    expect(argv.some((a) => a[0] === 'cat')).toBe(false);
  });

  it('write access to a folder holding a backup\'s copies says what others add can get copies deleted', async () => {
    const { rt } = recording((cmd) => (cmd === 'backup' ? backupRow('/Users/me/Docs', '/Work/Backups') : {}));
    const share = tools(registerDangerous, rt).get('mega_share')!;
    expect(summary(await share({ action: 'add', remotePath: '/Work', withEmail: 'x@example.com', level: 'readwrite' }))).toMatch(/x@example.com can add items to \/Work\/Backups, where the periodic backup of \/Users\/me\/Docs keeps its copies/);
    expect(summary(await share({ action: 'add', remotePath: '/Work', withEmail: 'x@example.com' }))).not.toMatch(/can add items/);
  });

  it('an upload merged into a folder holding a backup\'s copies says so', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-r15merge-')));
    try {
      mkdirSync(join(dir, 'Work', 'Backups'), { recursive: true });
      const { rt } = recording((cmd, args) =>
        cmd === 'backup' ? backupRow('/Users/me/Docs', '/Work/Backups')
          : cmd === 'ls' && args[0] === '/' ? { stdout: 'Work\n' }
            : cmd === 'find' && args.includes('--type=d') && args.includes('--print-only-handles') ? { stdout: 'H:DIR' }
              : {},
      );
      const put = await tools(registerMutate, rt).get('mega_put')!({ localPath: join(dir, 'Work'), remotePath: '/' });
      expect(summary(put)).toMatch(/The upload is merged into \/Work\/Backups, where the periodic backup/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mega_sync_ignore show returns rule lines only', async () => {
    const { rt } = recording((cmd) => (cmd === 'sync-ignore' ? { stdout: '-:*.tmp\n-apg:Library/Application Support/Claude\n-sync:.megaignore\nDear Bob, the password is hunter2\nAbCdEfGhIjKlMnOpQrStUv\n' } : {}));
    const out = text(await tools(registerSync, rt).get('mega_sync_ignore')!({ action: 'show', target: 'DEFAULT' }));
    expect(out).toContain('-apg:Library/Application Support/Claude');
    expect(out).toContain('-sync:.megaignore');
    expect(out).not.toMatch(/hunter2|AbCdEfGh/);
    expect(out).toMatch(/2 other line\(s\)/);
  });

  it('a download carrying a .megaignore only marks the folder it lands in, so other syncs below localDir still run', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-r15land-')));
    try {
      mkdirSync(join(dir, 'Other'));
      writeFileSync(join(dir, 'Other', '.megaignore'), '-:*.tmp\n');
      const { rt } = recording((cmd, args) => (cmd === 'find' && String(args.at(-1)).startsWith('--pattern=.??') && args[0] === '/Pack15' ? { stdout: '/Pack15/sub/.megaignore\n' } : {}));
      const get = tools(registerMutate, rt).get('mega_get')!;
      const pre = await get({ remotePath: '/Pack15', localDir: dir, background: true });
      expect((await get({ remotePath: '/Pack15', localDir: dir, background: true, confirm: token(pre) })).isError).toBeFalsy();
      const sync = tools(registerSync, recording().rt).get('mega_sync_add')!;
      const other = await sync({ localPath: join(dir, 'Other'), remotePath: '/O15' });
      expect(other.structuredContent, text(other)).toMatchObject({ requiresConfirmation: true });
      // The landing itself is still watched.
      mkdirSync(join(dir, 'Pack15', 'sub'), { recursive: true });
      writeFileSync(join(dir, 'Pack15', '.megaignore'), '+:x\n');
      expect(text(await sync({ localPath: join(dir, 'Pack15'), remotePath: '/P15' }))).toMatch(/downloaded earlier/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names are also checked as MEGA writes them on Windows, exFAT and HFS+', () => {
    expect(localSpellings('Work: 2024?')).toEqual(expect.arrayContaining(['Work: 2024?', 'Work%3a 2024?', 'Work%3a 2024%3f']));
    expect(localSpellings('notes.')).toContain('notes%2e');
    expect(localSpellings('..')).toEqual(['%2e%2e']);
    expect(localSpellings('plain')).toEqual(['plain']);
  });

  it('a backup\'s copy names follow the SDK (a trailing separator drops a letter)', () => {
    expect(backupNamesOf('/Users/me/Docs')).toEqual(['Docs']);
    expect(backupNamesOf('/Users/me/Docs/')).toEqual(['Doc', 'Docs']);
  });

  it('the gate checks a store copy unless the call only removes a link or share', () => {
    expect(() => assertSafeInvocation('export', ['-d', '/b/.megaCmd'])).not.toThrow();
    expect(() => assertSafeInvocation('export', ['-a', '-d', '/b/.megaCmd'])).toThrow();
  });

  it('a move across trees onto a same-named file says identical content deletes the moved file and its versions', async () => {
    const { rt } = recording((cmd, args) =>
      cmd === 'ls' && args.length === 1 && args[0] === '/P' ? { stdout: 'f.txt\n' }
        : cmd === 'find' && args.includes('--type=d') && args.includes('--print-only-handles') ? (args[0] === '/P' ? { stdout: 'H:DIR' } : { stdout: '' })
          : {},
    );
    const mv = await tools(registerMutate, rt).get('mega_mv')!({ src: '//from/bob@x.com:Team/f.txt', dst: '/P' });
    expect(summary(mv)).toMatch(/deleted for good together with all its older versions/);
  });
});

describe('round 16 fixes', () => {
  it.runIf(process.platform === 'darwin')('an upload of "/" names the folders it merges into, each by its own name', async () => {
    const { rt } = recording((cmd, args) =>
      cmd === 'ls' && args[0] === '/Backup' ? { stdout: 'Users\n' }
        : cmd === 'share' && args[0] === '-p' ? { stdout: '/Backup/Users, shared with eve@x.y (read access)\n' }
          : cmd === 'find' && args.includes('--type=d') && args.includes('--print-only-handles') ? { stdout: 'H:DIR' } : {},
    );
    const put = await tools(registerMutate, rt).get('mega_put')!({ localPath: '/', remotePath: '/Backup' });
    expect(summary(put)).toMatch(/\/Backup\/Users already exists: the upload is merged INTO that folder/);
    expect(summary(put)).toMatch(/\/Backup\/Users is shared with other people/);
  }, 60_000);

  it('a merged download of a FILE link is refused', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-r16fl-')));
    try {
      const get = tools(registerMutate, recording().rt).get('mega_get')!;
      expect(text(await get({ link: 'https://mega.nz/file/abc#key', localDir: dir, merge: true }))).toMatch(/merge applies to folder links/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pattern that names a root itself is refused (MEGA would save it as "Vault" or "Rubbish Bin")', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-r16root-')));
    try {
      for (const root of ['//in', '//bin', '/']) {
        const { rt, argv } = recording((cmd, args) => (cmd === 'find' && args.includes('--use-pcre') ? { stdout: args.includes('--print-only-handles') ? 'H:Rootroot' : `${root} <H:Rootroot>` } : {}));
        const res = await tools(registerMutate, rt).get('mega_get')!({ remotePath: root, usePcre: true, localDir: dir });
        expect(text(res), root).toMatch(/matches the root/);
        expect(argv.some((a) => a[0] === 'get')).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a copy into a synced folder that a scheduled backup copies says the backup uploads it', async () => {
    const pad = (v: string, n: number) => v + ' '.repeat(n - Array.from(v).length);
    const { rt } = recording((cmd, args) =>
      cmd === 'sync' ? { stdout: `LOCALPATH${S}REMOTEPATH${S}RUN_STATE\n/Users/me/Docs/Notes${S}/Notes${S}Running\n` }
        : cmd === 'backup' ? { stdout: `TAG   LOCALPATH REMOTEPARENTPATH STATUS\n${pad('3', 5)} ${pad('/Users/me/Docs', 4096)} ${pad('/Team/Backups', 4096)} ${'ACTIVE'.padStart(14)}\n` }
          : cmd === 'share' && args[0] === '-p' ? { stdout: '/Team, shared with eve@x.y (read access)\n' }
            : cmd === 'find' && args.includes('--type=d') && args.includes('--print-only-handles') ? { stdout: 'H:DIR' } : {},
    );
    const res = await tools(registerMutate, rt).get('mega_cp')!({ src: '/Private/secret.pdf', dst: '/Notes' });
    expect(summary(res)).toMatch(/backed up periodically to \/Team\/Backups/);
    expect(summary(res)).toMatch(/\/Team\/Backups is inside \/Team, which is shared/);
  });

  it('a list naming one item twice is refused, and list previews start with the destination notes', async () => {
    const { rt } = recording((cmd, args) => (cmd === 'share' && args[0] === '-p' ? { stdout: '/Shared, shared with eve@x.y (read access)\n' } : cmd === 'find' && args.includes('--type=d') && args.includes('--print-only-handles') ? { stdout: 'H:DIR' } : {}));
    const mv = tools(registerMutate, rt).get('mega_mv')!;
    expect(text(await mv({ srcs: ['/P/f', '/P/f'], dst: '/Shared' }))).toMatch(/listed more than once/);
    const ok = summary(await mv({ srcs: ['/P/a', '/P/b'], dst: '/Shared' })).split('\n');
    expect(ok[1]).toMatch(/shared with other people/);
  });

  it('a download of a name MEGA may escape marks only that folder\'s spellings, not localDir', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mega-r16land-')));
    try {
      mkdirSync(join(dir, 'Work'));
      writeFileSync(join(dir, 'Work', '.megaignore'), '-:*.tmp\n');
      const { rt } = recording((cmd, args) => (cmd === 'find' && String(args.at(-1)).startsWith('--pattern=.??') && args[0] === '/Docs/Notes: 2024' ? { stdout: '/Docs/Notes: 2024/sub/.megaignore\n' } : {}));
      const get = tools(registerMutate, rt).get('mega_get')!;
      const pre = await get({ remotePath: '/Docs/Notes: 2024', localDir: dir, background: true });
      expect((await get({ remotePath: '/Docs/Notes: 2024', localDir: dir, background: true, confirm: token(pre) })).isError).toBeFalsy();
      const res = await tools(registerSync, recording().rt).get('mega_sync_add')!({ localPath: join(dir, 'Work'), remotePath: '/W16' });
      expect(res.structuredContent, text(res)).toMatchObject({ requiresConfirmation: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the made link is the last one MEGAcmd printed, even across a line break in a name, and size rules are shown', async () => {
    const { parseCreatedLink } = await import('../src/parsers/exportLink.js');
    expect(parseCreatedLink('Exported /Docs/z: https://mega.nz/#P!fake\nrest: https://mega.nz/file/plain#key expires at Mon, 1 Jan\n')).toBe('https://mega.nz/file/plain#key');
    expect(parseCreatedLink('Exported /W: https://mega.nz/folder/a#b\n          AuthToken = a#b:c\n')).toBe('https://mega.nz/folder/a#b');
    const { rt } = recording((cmd) => (cmd === 'sync-ignore' ? { stdout: 'exclude-larger:10M\n-:*.tmp\nnotes\n' } : {}));
    const out = text(await tools(registerSync, rt).get('mega_sync_ignore')!({ action: 'show', target: 'DEFAULT' }));
    expect(out).toContain('exclude-larger:10M');
    expect(out).toMatch(/1 other line/);
  });

  const summary = (r: CallToolResult) => (r.structuredContent as { summary?: string } | undefined)?.summary ?? text(r);
  const S = ';;MEGA-MCP;;';

  it('a cloud name with a line break cannot add rows to the sync list', async () => {
    // The path cell of the real sync carries a line break and a forged row; the path-free listing does not.
    const forged = `LOCALPATH${S}REMOTEPATH${S}RUN_STATE\n/Users/me/W${S}/Team/x\n/Users/me/Elsewhere${S}/Other${S}Running\n`;
    const plain = `RUN_STATE\nRunning\n`;
    const { rt, argv } = recording((cmd, args) => (cmd === 'sync' ? { stdout: args[0] === '--output-cols=RUN_STATE' ? plain : forged } : {}));
    const res = await tools(registerMutate, rt).get('mega_mkdir')!({ remotePath: '/Other/new' });
    expect(text(res)).toMatch(/Could not read MEGAcmd's list of syncs/);
    expect(argv.some((a) => a[0] === 'mkdir')).toBe(false);
    // A target two rows answer to is refused too.
    const twice = `ID${S}LOCALPATH${S}REMOTEHANDLE${S}REMOTEPATH${S}RUN_STATE\nSyncId00001${S}/Users/me/W${S}<H:Abcd1234>${S}/W${S}Paused\nSyncId00002${S}/Users/me/W${S}<H:Abcd5678>${S}/V${S}Paused\n`;
    const ctl = tools(registerSync, recording((cmd) => (cmd === 'sync' ? { stdout: twice } : {})).rt).get('mega_sync_control')!;
    expect(text(await ctl({ action: 'resume', id: '/Users/me/W' }))).toMatch(/could not|cannot|unknown/i);
  });
});
