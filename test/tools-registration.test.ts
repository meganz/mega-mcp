import { describe, it, expect } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerAll } from '../src/tools/index.js';
import { registerDangerous } from '../src/tools/dangerous.js';
import { registerManage } from '../src/tools/manage.js';
import { registerConfig } from '../src/tools/config.js';
import { registerSync } from '../src/tools/sync.js';
import { registerMutate } from '../src/tools/mutate.js';
import { createConfirmStore } from '../src/confirm.js';
import type { Runtime } from '../src/runtime.js';
import type { Config, RunResult } from '../src/types.js';

type ToolFn = (args: any) => Promise<CallToolResult>;

function fakeRt(config: Partial<Config> = {}, run?: Runtime['run']): Runtime {
  return {
    config: { maxListLines: 1000, cacheDir: '/tmp/cache', download: { sha256Allow: [] }, exposeContacts: false, exposeAccountDetails: false, exposeFileContents: false, ...config },
    confirm: createConfirmStore(),
    run: run ?? (async () => ({ code: 0, stdout: '', stderr: '' }) as RunResult),
    getResolved: async () => null,
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
