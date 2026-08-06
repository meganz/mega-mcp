import { describe, it, expect } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerAll } from '../src/tools/index.js';
import { registerDangerous } from '../src/tools/dangerous.js';
import { registerManage } from '../src/tools/manage.js';
import { registerConfig } from '../src/tools/config.js';
import { registerSync } from '../src/tools/sync.js';
import { registerMutate } from '../src/tools/mutate.js';
import { createConfirmStore } from '../src/confirm.js';
import { createRuntime } from '../src/runtime.js';
import { publishMegacmdBinDir } from '../src/paths.js';
import type { Runtime } from '../src/runtime.js';
import type { Config, RunResult } from '../src/types.js';

type ToolFn = (args: any) => Promise<CallToolResult>;

function fakeRt(config: Partial<Config> = {}, run?: Runtime['run'], binDir: string | null = null): Runtime {
  return {
    config: { maxListLines: 1000, cacheDir: '/tmp/cache', download: { sha256Allow: [] }, exposeContacts: false, exposeAccountDetails: false, exposeFileContents: false, ...config },
    confirm: createConfirmStore(),
    run: run ?? (async () => ({ code: 0, stdout: '', stderr: '' }) as RunResult),
    getResolved: async () => null,
    // Defaults to null like the real 'path' source. The store warning needs a REAL
    // value on Windows (the store is executable-relative), so tests that assert on
    // it must pass one — see 'names the executable-relative store' below.
    getBinDir: async () => binDir,
    invalidateResolved: () => {},
    getAuthState: async () => ({ loggedIn: true, reason: 'ok' }),
    ensureReady: async () => ({ loggedIn: true, reason: 'ok' }),
  } as Runtime;
}

/** Capture every tool a register* function declares. */
function capture(register: (server: any, rt: Runtime) => void, rt: Runtime): Map<string, ToolFn> {
  const tools = new Map<string, ToolFn>();
  const server = { registerTool: (name: string, _def: unknown, cb: ToolFn) => tools.set(name, cb) };
  register(server, rt);
  return tools;
}

/**
 * Run `fn` with $HOME pointed at a scratch dir that really does contain a
 * ~/.megaCmd. The store warning only names stores that EXIST, so asserting against
 * the developer's own home would pass or fail on whether they happen to run
 * MEGAcmd — and on Windows the real store sits beside the executable, so
 * ~/.megaCmd is normally absent there. os.homedir() reads $HOME / %USERPROFILE%
 * first and sessionStoreRoots() recomputes per call, so this genuinely relocates it.
 */
async function withStoreHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const base = mkdtempSync(join(tmpdir(), 'mega-home-'));
  mkdirSync(join(base, '.megaCmd'), { recursive: true });
  const keys = ['HOME', 'USERPROFILE'] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  try {
    for (const k of keys) process.env[k] = base;
    return await fn(base);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(base, { recursive: true, force: true });
  }
}

/**
 * End-to-end: the session-store guard must fire through the real tool handlers,
 * not just in assertLocalPath. Every one of these is an exfiltration path for the
 * account master key (see DESIGN.md Constraint 3), and the path argument is
 * model-supplied, so it is reachable by indirect prompt injection.
 */
describe('session-store exfiltration is refused by the tools themselves', () => {
  const store = `${homedir()}/.megaCmd`;
  const refused = (res: CallToolResult) => {
    expect(res.isError).toBe(true);
    return (res.content?.[0] as any).text as string;
  };

  it('mega_put refuses the store, its case variants, and a parent of it', async () => {
    const tools = capture(registerMutate, fakeRt());
    const put = tools.get('mega_put')!;
    expect(refused(await put({ localPath: `${store}/session`, remotePath: '/x' }))).toMatch(/configuration directory/i);
    expect(refused(await put({ localPath: `${homedir()}/.MEGACMD/session`, remotePath: '/x' }))).toMatch(/configuration directory/i);
    // Hidden in a batch alongside innocuous files.
    expect(refused(await put({ localPaths: ['/tmp/ok.txt', `${store}/session`], remotePath: '/x' }))).toMatch(/configuration directory/i);
  });

  // A whole-home backup is a legitimate request, so it proceeds — but the preview
  // must say the session store is going along (see paths.ts sessionStoreWithin).
  it('mega_put ALLOWS a bulk backup containing the store, but warns in the preview', async () => {
    await withStoreHome(async (home) => {
      const tools = capture(registerMutate, fakeRt());
      const res = await tools.get('mega_put')!({ localPath: home, remotePath: '/Backup' });
      expect(res.isError).toBeFalsy();
      const summary = (res.structuredContent as { summary: string }).summary;
      expect(summary).toMatch(/MASTER KEY/);
      expect(summary).toContain('.megaCmd');
      expect(summary).toMatch(/mega_sync_ignore/);
    });
  });

  it('mega_get refuses the store as a download destination (overwrite)', async () => {
    const tools = capture(registerMutate, fakeRt());
    const res = await tools.get('mega_get')!({ remotePath: '/f', localDir: `${homedir()}/.megacmd` });
    expect(refused(res)).toMatch(/configuration directory/i);
  });

  it('mega_thumbnail refuses the store for both directions', async () => {
    const tools = capture(registerMutate, fakeRt());
    const thumb = tools.get('mega_thumbnail')!;
    expect(refused(await thumb({ remotePath: '/f', localPath: `${store}/session`, action: 'set' }))).toMatch(/configuration directory/i);
    expect(refused(await thumb({ remotePath: '/f', localPath: `${store}/x.jpg`, action: 'download' }))).toMatch(/configuration directory/i);
  });

  it('mega_sync_add / mega_backup_add refuse the store itself', async () => {
    const tools = capture(registerSync, fakeRt());
    for (const name of ['mega_sync_add', 'mega_backup_add']) {
      const extra = name === 'mega_backup_add' ? { period: '0 0 * * *', numBackups: 3 } : {};
      expect(refused(await tools.get(name)!({ localPath: store, remotePath: '/x', ...extra }))).toMatch(/configuration directory/i);
    }
  });

  it('mega_sync_add warns that a two-way sync of $HOME can also WRITE into the store', async () => {
    await withStoreHome(async (home) => {
      const tools = capture(registerSync, fakeRt());
      const res = await tools.get('mega_sync_add')!({ localPath: home, remotePath: '/x' });
      expect(res.isError).toBeFalsy();
      const summary = (res.structuredContent as { summary: string }).summary;
      expect(summary).toMatch(/MASTER KEY/);
      expect(summary).toMatch(/WRITE into the live store/i);
    });
  });

  /**
   * On Windows the store lives beside the executable, so the warning can only find
   * it via the resolved bin dir. That wiring (rt.getBinDir() -> sessionStoreWarning)
   * had no end-to-end coverage: deleting the binDir argument left the suite green.
   */
  it.runIf(process.platform === 'win32')('names the executable-relative store, which is only reachable via binDir', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mega-bindir-'));
    try {
      const binDir = join(base, 'MEGAcmd');
      const binStore = join(binDir, '.megaCmd');
      mkdirSync(binStore, { recursive: true });

      const withBin = capture(registerMutate, fakeRt({}, undefined, binDir));
      const found = await withBin.get('mega_put')!({ localPath: base, remotePath: '/Backup' });
      expect((found.structuredContent as { summary: string }).summary).toContain(binStore);

      // Same upload, binDir unknown (the 'path' source before this was threaded
      // through): the store is invisible to the ancestor check.
      const without = capture(registerMutate, fakeRt());
      expect((await without.get('mega_put')!({ localPath: base, remotePath: '/Backup' })).structuredContent as { summary: string })
        .not.toMatchObject({ summary: expect.stringContaining('MASTER KEY') });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('does not over-block or over-warn on ordinary local paths', async () => {
    const mutate = capture(registerMutate, fakeRt());
    const sync = capture(registerSync, fakeRt());
    const doc = `${homedir()}/Documents`;
    const put = await mutate.get('mega_put')!({ localPath: `${doc}/report.pdf`, remotePath: '/x' });
    expect(put.isError).toBeFalsy();
    expect((put.structuredContent as { summary: string }).summary).not.toMatch(/MASTER KEY/);
    expect((await mutate.get('mega_get')!({ remotePath: '/f', localDir: homedir() })).isError).toBeFalsy();
    expect((await sync.get('mega_sync_add')!({ localPath: doc, remotePath: '/x' })).isError).toBeFalsy();
  });
});

/**
 * Handler-level wiring for the security sweep's findings. The validators are unit
 * tested in paths.test.ts; these assert every confirm-gated TOOL actually calls
 * them — the sweep's finding was precisely that some call sites were missed.
 */
describe('security-sweep regressions, at the tool boundary', () => {
  /** Ran the command? A guard that returns an error but still executed is no guard. */
  function recordingRt(binDir: string | null = null) {
    const argv: string[][] = [];
    const rt = fakeRt({}, async (cmd, args) => (argv.push([cmd, ...args]), { code: 0, stdout: '', stderr: '' }) as RunResult, binDir);
    return { rt, argv };
  }
  const blocked = (res: CallToolResult, argv: string[][], want: RegExp) => {
    expect(argv).toEqual([]);
    expect(res.isError).toBe(true);
    expect((res.content?.[0] as any).text).toMatch(want);
  };

  /**
   * `*` and `?` are expanded SERVER-SIDE after approval — verified read-only:
   * `du /Excel*` reports /Excel AND /Excel2. So a preview naming one node could
   * delete, publish or share N, and the set is re-resolved post-approval.
   */
  it('refuses a native wildcard on every confirm-gated path', async () => {
    const cases: [string, (s: any, r: Runtime) => void, any][] = [
      ['mega_rm', registerDangerous, { remotePath: '/Excel*' }],
      ['mega_rm', registerDangerous, { remotePath: '/*' }],
      ['mega_deleteversions', registerDangerous, { remotePath: '/Ex*' }],
      ['mega_export', registerDangerous, { remotePath: '/Ex*', action: 'create' }],
      ['mega_share', registerDangerous, { remotePath: '/Ex*', action: 'add', withEmail: 'a@b.c' }],
      ['mega_mv', registerMutate, { src: '/Ex*', dst: '/d' }],
      ['mega_get', registerMutate, { remotePath: '/Ex*', localDir: join(tmpdir(), 'dl') }],
    ];
    for (const [tool, register, args] of cases) {
      const { rt, argv } = recordingRt();
      blocked(await capture(register, rt).get(tool)!(args), argv, /wildcard/i);
    }
  });

  /**
   * The guard is armed by createRuntime, NOT by the tool call — so it has to be
   * exercised through a REAL runtime. Pre-arming it with publishMegacmdBinDir() (as
   * the test below does, to isolate the guard's logic) hides whether production ever
   * arms it at all: it did not. trustRoots was published only from getBinDir(), and
   * getBinDir() is called only by the store-warning path — mega_put / sync_add /
   * backup_add. mega_get and mega_thumbnail, the two write destinations this guard
   * exists to stop, never called it, so assertNotTrustRoot no-opped on an empty root
   * list for the whole process. Deleting the publish in createRuntime must fail here.
   */
  it('arms the program-directory guard from config alone, with nothing resolved yet', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mega-arm-'));
    try {
      const install = join(base, 'MEGAcmd');
      mkdirSync(install, { recursive: true });
      // A real runtime over a config that cannot resolve any binary. No tool has
      // run, so nothing has awaited getResolved()/getBinDir().
      const rt = createRuntime({
        megacmdDir: install,
        cacheDir: join(base, 'cache'),
        bundledDir: undefined,
        systemAppBinDirs: [],
        download: { sha256Allow: [] },
        maxListLines: 1000,
        exposeContacts: false,
        exposeAccountDetails: false,
        exposeFileContents: false,
      } as Config);
      const tools = capture(registerMutate, rt);

      // mega_get is the vector: it never asks for the resolved bin dir.
      for (const args of [
        { remotePath: '/f', localDir: install },
        { remotePath: '/f', localDir: join(install, 'plugins') },
      ]) {
        const res = await tools.get('mega_get')!(args);
        expect(res.isError).toBe(true);
        expect((res.content?.[0] as any).text).toMatch(/program directory/i);
      }
      const thumb = await tools.get('mega_thumbnail')!({ remotePath: '/f', localPath: join(install, 'dbghelp.dll') });
      expect(thumb.isError).toBe(true);

      // cacheDir is a trust root too, and is pure config.
      const cached = await tools.get('mega_get')!({ remotePath: '/f', localDir: join(base, 'cache', 'current') });
      expect(cached.isError).toBe(true);

      // Control: an ordinary destination still works.
      expect((await tools.get('mega_get')!({ remotePath: '/f', localDir: join(base, 'dl') })).isError).toBeFalsy();
    } finally {
      publishMegacmdBinDir(null);
      rmSync(base, { recursive: true, force: true });
    }
  });

  /**
   * A signature covers the executable, but the Windows loader resolves DLL imports
   * from the executable's own directory first — so a download landing there plants
   * code inside the Authenticode-verified MEGAcmd process.
   */
  it('refuses reads and writes inside the MEGAcmd program directory', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mega-trust-'));
    try {
      const install = join(base, 'MEGAcmd');
      mkdirSync(install, { recursive: true });
      publishMegacmdBinDir(install);
      for (const [tool, register, args] of [
        ['mega_get', registerMutate, { remotePath: '/f', localDir: install }],
        ['mega_get', registerMutate, { remotePath: '/f', localDir: join(install, 'plugins') }],
        ['mega_put', registerMutate, { localPath: join(install, 'MEGAclient.exe'), remotePath: '/x' }],
        ['mega_thumbnail', registerMutate, { remotePath: '/f', localPath: join(install, 'a.jpg'), action: 'download' }],
      ] as [string, (s: any, r: Runtime) => void, any][]) {
        const { rt, argv } = recordingRt();
        blocked(await capture(register, rt).get(tool)!(args), argv, /program directory/i);
      }
      // A sibling sharing the prefix must NOT be caught.
      const { rt } = recordingRt();
      expect((await capture(registerMutate, rt).get('mega_get')!({ remotePath: '/f', localDir: `${install}-notes` })).isError).toBeFalsy();
    } finally {
      publishMegacmdBinDir(null);
      rmSync(base, { recursive: true, force: true });
    }
  });

  // These two fields were NUL-checked only, so the quote guard never applied to
  // them: a quote in the invite message turned a previewed "send" into `-d`.
  it('applies the argv-quote guard to the manage.ts fields that missed it', async () => {
    const a = recordingRt();
    blocked(
      await capture(registerManage, a.rt).get('mega_import')!({ link: 'https://mega.nz/folder/a#k', remotePath: '/d', password: 'p" "/Elsewhere' }),
      a.argv, /double quote/i,
    );
    const b = recordingRt();
    blocked(
      await capture(registerManage, b.rt).get('mega_invite')!({ email: 'a@b.c', action: 'send', message: 'hi" "-d' }),
      b.argv, /double quote/i,
    );
  });

  /**
   * Escaping is central (in checkConfirm), so a tool added later cannot forget it.
   * mega_attr_set is asserted precisely because nothing was changed in it.
   */
  it('escapes control characters in every preview, centrally', async () => {
    const { rt } = recordingRt();
    const res = await capture(registerManage, rt).get('mega_attr_set')!({ remotePath: '/a\nFAKE LINE', attribute: 'x', action: 'delete' });
    const summary = (res.structuredContent as { summary: string }).summary;
    expect(summary).toContain('\\nFAKE LINE');
    expect(summary).not.toContain('\nFAKE LINE');
  });

  it('keeps multi-line previews structured while still escaping each entry', async () => {
    const { rt } = recordingRt();
    const tools = capture(registerMutate, rt);
    const listed = (res: CallToolResult) => (res.structuredContent as { summary: string }).summary;

    const ok = listed(await tools.get('mega_put')!({ localPaths: [join(tmpdir(), 'a'), join(tmpdir(), 'b')], remotePath: '/dst' }));
    expect(ok.split('\n').length).toBeGreaterThanOrEqual(3); // header + one line per path
    expect(ok).toContain(`  ${resolve(join(tmpdir(), 'a'))}`);

    // ...but a newline inside a listed path must not become a line of its own.
    const forged = listed(await tools.get('mega_put')!({ localPaths: [join(tmpdir(), 'a\nFAKE LINE')], remotePath: '/dst' }));
    expect(forged).toContain('\\nFAKE LINE');
    expect(forged).not.toContain('\nFAKE LINE');
  });

  it('does not over-block ordinary confirm-gated calls', async () => {
    for (const [tool, register, args] of [
      ['mega_rm', registerDangerous, { remotePath: '/Excel' }],
      ['mega_mv', registerMutate, { src: '/a', dst: '/b' }],
      ['mega_invite', registerManage, { email: 'a@b.c', action: 'send', message: 'Hello there' }],
    ] as [string, (s: any, r: Runtime) => void, any][]) {
      const { rt } = recordingRt();
      expect((await capture(register, rt).get(tool)!(args)).isError).toBeFalsy();
    }
  });
});

describe('mega_killsession argv hardening', () => {
  it('rejects a sessionId that could be parsed as a flag', async () => {
    const tools = capture(registerDangerous, fakeRt());
    const res = await tools.get('mega_killsession')!({ sessionId: '-a' });
    expect(res.isError).toBe(true);
    expect((res.content?.[0] as any).text).toMatch(/must not start with/i);
  });

  it('rejects a whitespace-bearing sessionId', async () => {
    const tools = capture(registerDangerous, fakeRt());
    const res = await tools.get('mega_killsession')!({ sessionId: 'a b' });
    expect(res.isError).toBe(true);
  });

  it('a valid sessionId reaches the confirm gate (not an error)', async () => {
    const tools = capture(registerDangerous, fakeRt());
    const res = await tools.get('mega_killsession')!({ sessionId: 'goodHandle123' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
  });
});

describe('exposeContacts gate', () => {
  const CONTACT_TOOLS = ['mega_users', 'mega_showpcr', 'mega_userattr'];

  it('does NOT register contact tools by default (flag off)', () => {
    const tools = capture(registerAll, fakeRt({ exposeContacts: false }));
    for (const name of CONTACT_TOOLS) expect(tools.has(name)).toBe(false);
    // sanity: core tools still present
    expect(tools.has('mega_account')).toBe(true);
  });

  it('registers contact tools only when the flag is on', () => {
    const tools = capture(registerAll, fakeRt({ exposeContacts: true }));
    for (const name of CONTACT_TOOLS) expect(tools.has(name)).toBe(true);
  });
});

describe('exposeAccountDetails gate', () => {
  const ACCOUNT_TOOLS = ['mega_sessions', 'mega_balance'];

  it('does NOT register account-detail tools by default', () => {
    const tools = capture(registerAll, fakeRt({ exposeAccountDetails: false }));
    for (const name of ACCOUNT_TOOLS) expect(tools.has(name)).toBe(false);
  });

  it('registers them only when the flag is on', () => {
    const tools = capture(registerAll, fakeRt({ exposeAccountDetails: true }));
    for (const name of ACCOUNT_TOOLS) expect(tools.has(name)).toBe(true);
  });
});

describe('new mutation tools — input guards', () => {
  const manage = () => capture(registerManage, fakeRt());

  it('attr_set requires a value for action=set', async () => {
    const res = await manage().get('mega_attr_set')!({ remotePath: '/a', attribute: 'foo', action: 'set' });
    expect(res.isError).toBe(true);
  });

  it('attr_set rejects a flag-like attribute name', async () => {
    const res = await manage().get('mega_attr_set')!({ remotePath: '/a', attribute: '-d', action: 'delete' });
    expect(res.isError).toBe(true);
    expect((res.content?.[0] as any).text).toMatch(/must not start with/i);
  });

  it('attr_set delete (valid) reaches the confirm gate', async () => {
    const res = await manage().get('mega_attr_set')!({ remotePath: '/a', attribute: 'foo', action: 'delete' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
  });

  it('transfer_control requires exactly one of tag / all', async () => {
    const neither = await manage().get('mega_transfer_control')!({ action: 'pause' });
    expect(neither.isError).toBe(true);
    const both = await manage().get('mega_transfer_control')!({ action: 'pause', tag: '5', all: true });
    expect(both.isError).toBe(true);
  });

  it('import rejects a value that does not look like a link', async () => {
    const res = await manage().get('mega_import')!({ link: 'notalink', remotePath: '/x' });
    expect(res.isError).toBe(true);
    expect((res.content?.[0] as any).text).toMatch(/link/i);
  });

  it('user_remove / invite reject a flag-like email (email() allows leading "-")', async () => {
    const tools = manage();
    const rm = await tools.get('mega_user_remove')!({ email: '-d@x.co' });
    expect(rm.isError).toBe(true);
    expect((rm.content?.[0] as any).text).toMatch(/must not start with/i);
    const inv = await tools.get('mega_invite')!({ email: '-x@y.com', action: 'send' });
    expect(inv.isError).toBe(true);
  });
});

describe('mega_config', () => {
  const cfg = () => capture(registerConfig, fakeRt());

  it('allows https off now, behind the confirm gate', async () => {
    const res = await cfg().get('mega_config')!({ setting: 'https', value: 'off' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
  });

  it('rejects an invalid on/off value', async () => {
    const res = await cfg().get('mega_config')!({ setting: 'graphics', value: 'maybe' });
    expect(res.isError).toBe(true);
  });

  it('requires a target when setting permissions', async () => {
    const res = await cfg().get('mega_config')!({ setting: 'permissions', value: '700' });
    expect(res.isError).toBe(true);
    expect((res.content?.[0] as any).text).toMatch(/target/i);
  });

  it('changing a value reaches the confirm gate', async () => {
    const res = await cfg().get('mega_config')!({ setting: 'graphics', value: 'on' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
  });

  it('reload is confirm-gated', async () => {
    const res = await cfg().get('mega_config')!({ setting: 'reload' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
  });
});

describe('mega_sync_add', () => {
  it('confirm preview does not execute', async () => {
    const tools = capture(registerSync, fakeRt());
    const res = await tools.get('mega_sync_add')!({ localPath: '/tmp/x', remotePath: '/Backups' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
    expect((res.content?.[0] as any).text).toMatch(/TWO-WAY/i);
  });
});

describe('unlocked capabilities reach the confirm gate', () => {
  it('export writable warns and confirms', async () => {
    const tools = capture(registerDangerous, fakeRt());
    const res = await tools.get('mega_export')!({ remotePath: '/f', action: 'create', writable: true });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
    expect((res.content?.[0] as any).text).toMatch(/WRITABLE/i);
  });

  it('share accepts owner level', async () => {
    const tools = capture(registerDangerous, fakeRt());
    const res = await tools.get('mega_share')!({ remotePath: '/f', action: 'add', withEmail: 'a@b.com', level: 'owner' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
  });

  it('put accepts multiple local paths', async () => {
    const tools = capture(registerMutate, fakeRt());
    const res = await tools.get('mega_put')!({ localPaths: ['/tmp/a', '/tmp/b'], remotePath: '/dst' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
  });

  it('put requires at least one path', async () => {
    const tools = capture(registerMutate, fakeRt());
    const res = await tools.get('mega_put')!({ remotePath: '/dst' });
    expect(res.isError).toBe(true);
  });

  // Security control, not cosmetics: the upload data path is file -> MEGAcmd
  // child -> cloud and never enters the model context, so this preview is the
  // ONLY place a human can see what is leaving the machine. "upload 2 item(s)"
  // gave nothing to withhold approval on.
  it('put names every local path in the confirmation preview', async () => {
    const tools = capture(registerMutate, fakeRt());
    // The preview shows RESOLVED paths, which on Windows are backslash-separated
    // and drive-rooted — assert against the resolved form, not the input literal.
    const inputs = ['/tmp/a', '/tmp/b'];
    const res = await tools.get('mega_put')!({ localPaths: inputs, remotePath: '/dst' });
    const summary = (res.structuredContent as { summary: string }).summary;
    for (const p of inputs) expect(summary).toContain(resolve(p));
    expect(summary).toContain('/dst');
  });

  it('get accepts a public link (flag-guarded) instead of a path', async () => {
    const tools = capture(registerMutate, fakeRt());
    const res = await tools.get('mega_get')!({ link: 'https://mega.nz/folder/abc#key', localDir: '/tmp/dl' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
  });

  it('get rejects a flag-like link', async () => {
    const tools = capture(registerMutate, fakeRt());
    const res = await tools.get('mega_get')!({ link: '--bad', localDir: '/tmp/dl' });
    expect(res.isError).toBe(true);
  });

  it('user_verify is confirm-gated', async () => {
    const tools = capture(registerManage, fakeRt());
    const res = await tools.get('mega_user_verify')!({ email: 'a@b.com', action: 'verify' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
  });
});

describe('PCRE destructive ops show a dry-run preview', () => {
  it('rm with usePcre previews matches and confirm-gates (no execution)', async () => {
    const tools = capture(registerDangerous, fakeRt());
    const res = await tools.get('mega_rm')!({ remotePath: '/.*\\.tmp', usePcre: true });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
    expect((res.content?.[0] as any).text).toMatch(/matching the pattern/i);
  });

  it('rm with usePcre rejects a flag-like pattern', async () => {
    const tools = capture(registerDangerous, fakeRt());
    const res = await tools.get('mega_rm')!({ remotePath: '-rf', usePcre: true });
    expect(res.isError).toBe(true);
  });

  it('export create with usePcre confirm-gates with a match note', async () => {
    const tools = capture(registerDangerous, fakeRt());
    const res = await tools.get('mega_export')!({ remotePath: '/.*', action: 'create', usePcre: true });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
    expect((res.content?.[0] as any).text).toMatch(/public link/i);
  });
});

describe('mega_share list contact-PII gate (#2)', () => {
  it('confirm-gates the listing when exposeContacts is off (reveals recipient emails)', async () => {
    const tools = capture(registerDangerous, fakeRt({ exposeContacts: false }));
    const res = await tools.get('mega_share')!({ action: 'list' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
    expect((res.content?.[0] as any).text).toMatch(/email/i);
  });

  it('lists freely when exposeContacts is on (the persistent "always allow")', async () => {
    const tools = capture(registerDangerous, fakeRt({ exposeContacts: true }));
    const res = await tools.get('mega_share')!({ action: 'list' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).not.toMatchObject({ requiresConfirmation: true });
  });
});

describe('PCRE node-handle execution is TOCTOU-safe (#3)', () => {
  it('rm usePcre executes on the previewed HANDLES, not a re-evaluated pattern', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run: Runtime['run'] = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'find') return { code: 0, stdout: '/a.tmp <H:AAAA>\n/b.tmp <H:BBBB>\n', stderr: '' } as RunResult;
      return { code: 0, stdout: '', stderr: '' } as RunResult;
    };
    const tools = capture(registerDangerous, fakeRt({}, run));

    const first = await tools.get('mega_rm')!({ remotePath: '/.*\\.tmp', usePcre: true });
    const token = (first.structuredContent as any).confirmToken as string;
    expect(token).toBeTruthy();
    expect((first.content?.[0] as any).text).toContain('H:AAAA');

    const second = await tools.get('mega_rm')!({ remotePath: '/.*\\.tmp', usePcre: true, confirm: token });
    expect(second.isError).toBeFalsy();
    const rmCalls = calls.filter((c) => c.cmd === 'rm');
    expect(rmCalls.map((c) => c.args)).toEqual([
      ['-r', '-f', 'H:AAAA'],
      ['-r', '-f', 'H:BBBB'],
    ]);
    // never re-evaluates the pattern at execution time
    expect(rmCalls.some((c) => c.args.includes('--use-pcre'))).toBe(false);
  });

  it('an expired/unknown confirm token does not fall back to the pattern', async () => {
    const run: Runtime['run'] = async (cmd) =>
      (cmd === 'find' ? { code: 0, stdout: '/a <H:AAAA>\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }) as RunResult;
    const tools = capture(registerDangerous, fakeRt({}, run));
    // a token never issued by this store -> plan missing -> safe error, no rm
    const res = await tools.get('mega_rm')!({ remotePath: '/.*', usePcre: true, confirm: 'bogus-token' });
    expect(res.isError).toBe(true);
  });
});

describe('sync subcommands', () => {
  it('sync_ignore show is read-only (no confirm)', async () => {
    const tools = capture(registerSync, fakeRt());
    const res = await tools.get('mega_sync_ignore')!({ action: 'show', target: 'DEFAULT' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).not.toMatchObject({ requiresConfirmation: true });
  });

  it('sync_ignore add requires at least one filter', async () => {
    const tools = capture(registerSync, fakeRt());
    const res = await tools.get('mega_sync_ignore')!({ action: 'add', target: 'DEFAULT' });
    expect(res.isError).toBe(true);
  });

  it('sync_ignore add with filters confirm-gates', async () => {
    const tools = capture(registerSync, fakeRt());
    const res = await tools.get('mega_sync_ignore')!({ action: 'add', target: 'DEFAULT', filters: ['*.tmp'] });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ requiresConfirmation: true });
  });

  it('sync_ignore rejects a flag-like filter', async () => {
    const tools = capture(registerSync, fakeRt());
    const res = await tools.get('mega_sync_ignore')!({ action: 'add', target: 'DEFAULT', filters: ['-x'] });
    expect(res.isError).toBe(true);
  });
});

// Capture every tool DEFINITION (name -> def) a register* function declares.
function captureDefs(register: (server: any, rt: Runtime) => void, rt: Runtime): Map<string, any> {
  const defs = new Map<string, any>();
  const server = { registerTool: (name: string, def: unknown, _cb: ToolFn) => defs.set(name, def) };
  register(server, rt);
  return defs;
}

describe('directory submission: tool annotation completeness', () => {
  const allTools = () =>
    captureDefs(registerAll, fakeRt({ exposeContacts: true, exposeAccountDetails: true, exposeFileContents: true }));

  it('registers all 50 tools when every opt-in flag is on', () => {
    expect(allTools().size).toBe(50);
  });

  it('every tool has a non-empty annotations.title, a readOnly/destructive hint, and a name <= 64 chars', () => {
    for (const [name, def] of allTools()) {
      const ann = def?.annotations ?? {};
      expect(typeof ann.title === 'string' && ann.title.length > 0, `${name}: missing annotations.title`).toBe(true);
      const hasHint = ann.readOnlyHint === true || typeof ann.destructiveHint === 'boolean';
      expect(hasHint, `${name}: needs readOnlyHint:true or a destructiveHint boolean`).toBe(true);
      expect(name.length <= 64, `${name}: exceeds 64 chars`).toBe(true);
    }
  });
});
