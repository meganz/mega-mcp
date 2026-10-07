/**
 * Integration tests against the REAL MEGAcmd and a dedicated TEST account.
 *
 * They check the MEGAcmd behaviour the connector's guards rely on, which unit
 * tests can only assume: how put/mkdir/get/find/export actually behave.
 *
 * Safety:
 *  - Runs only when MEGA_MCP_ITEST_ACCOUNT names the account MEGAcmd is logged in
 *    as; otherwise every test is skipped.
 *  - Works only inside one fresh cloud folder, /mega-mcp-itest-<time>, deleted at
 *    the end.
 *  - Locally, only temp directories are used. The "home" with a ".megaCmd" store
 *    is a temp fixture: HOME points at it while the connector's own logic runs,
 *    and back at the real home for every MEGAcmd call, so MEGAcmd keeps using the
 *    real login session and nothing real is uploaded.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, basename } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../../src/config.js';
import { createRuntime, type Runtime } from '../../src/runtime.js';
import { registerMutate } from '../../src/tools/mutate.js';
import { registerDangerous } from '../../src/tools/dangerous.js';
import { ensureRemoteFolder } from '../../src/tools/helpers.js';
import { publishMegacmdBinDir } from '../../src/paths.js';

type ToolFn = (args: any) => Promise<CallToolResult>;
const ACCOUNT = process.env.MEGA_MCP_ITEST_ACCOUNT?.trim();
const REAL_HOME = homedir();
const ROOT = `/mega-mcp-itest-${Date.now()}`;

let rt: Runtime;
let ready = false;
let local: string;

/** Every MEGAcmd call runs with the REAL home, whatever HOME the test set. */
function realHomeRuntime(base: Runtime): Runtime {
  return {
    ...base,
    run: async (cmd, args, opts) => {
      const saved = process.env.HOME;
      process.env.HOME = REAL_HOME;
      try {
        return await base.run(cmd, args, opts);
      } finally {
        process.env.HOME = saved;
      }
    },
  };
}

function tools(register: (s: any, r: Runtime) => unknown): Map<string, ToolFn> {
  const map = new Map<string, ToolFn>();
  register({ registerTool: (n: string, _d: unknown, cb: ToolFn) => map.set(n, cb) }, rt);
  return map;
}
const text = (r: CallToolResult) => (r.content?.[0] as { text: string }).text;
const token = (r: CallToolResult) => (r.structuredContent as { confirmToken: string }).confirmToken;
async function confirmed(fn: ToolFn, args: Record<string, unknown>): Promise<CallToolResult> {
  const preview = await fn(args);
  if (preview.isError) return preview;
  return fn({ ...args, confirm: token(preview) });
}
/** Every path under `dir` in the cloud, relative to it. */
async function cloudTree(dir: string): Promise<string[]> {
  const r = await rt.run('find', [dir]);
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((p) => (p.startsWith(dir) ? p.slice(dir.length) : p))
    .filter(Boolean)
    .sort();
}
function tempTree(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(local, 't-')));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

beforeAll(async () => {
  if (!ACCOUNT) return;
  rt = realHomeRuntime(createRuntime(loadConfig()));
  const who = await rt.run('whoami', []);
  const email = who.stdout.match(/[^\s:]+@[^\s]+/)?.[0];
  if (who.code !== 0 || email !== ACCOUNT) {
    throw new Error(`Refusing to run: MEGAcmd is logged in as ${email ?? '(nobody)'}, not ${ACCOUNT}.`);
  }
  local = realpathSync(mkdtempSync(join(tmpdir(), 'mega-itest-')));
  const mk = await rt.run('mkdir', ['-p', ROOT]);
  if (mk.code !== 0) throw new Error(`Could not create ${ROOT}: ${mk.stderr}`);
  ready = true;
});

afterAll(async () => {
  publishMegacmdBinDir(null);
  if (ready) await rt.run('rm', ['-r', '-f', ROOT]);
  if (local && existsSync(local)) rmSync(local, { recursive: true, force: true });
});

describe.runIf(!!ACCOUNT)('real MEGAcmd behaviour the guards rely on', () => {
  it('mkdir -p on an existing folder / file is classified correctly', async () => {
    expect(await ensureRemoteFolder(rt, `${ROOT}/m/a`)).toBe('folder');
    // Existing folder: MEGAcmd reports it as an error, which must read as "folder".
    const again = await rt.run('mkdir', ['-p', `${ROOT}/m/a`]);
    console.log('[itest] mkdir -p existing ->', again.code, JSON.stringify(again.stderr.trim()));
    expect(await ensureRemoteFolder(rt, `${ROOT}/m/a`)).toBe('folder');

    const src = tempTree({ 'f.txt': 'x' });
    expect((await rt.run('put', ['-c', join(src, 'f.txt'), `${ROOT}/m/`])).code).toBe(0);
    expect(await ensureRemoteFolder(rt, `${ROOT}/m/f.txt`)).toBe('file');
    // A trailing slash must not make the file look like a folder.
    expect(await ensureRemoteFolder(rt, `${ROOT}/m/f.txt/`)).toBe('file');
  });

  it('mega_put puts a folder INTO the destination, whether or not it existed', async () => {
    const put = tools(registerMutate).get('mega_put')!;
    const src = tempTree({ 'a.txt': 'a', 'sub/b.txt': 'b' });
    const name = basename(src);
    expect((await confirmed(put, { localPath: src, remotePath: `${ROOT}/p-missing` })).isError).toBeFalsy();
    await rt.run('mkdir', ['-p', `${ROOT}/p-existing`]);
    expect((await confirmed(put, { localPath: src, remotePath: `${ROOT}/p-existing` })).isError).toBeFalsy();
    const want = [`/${name}`, `/${name}/a.txt`, `/${name}/sub`, `/${name}/sub/b.txt`];
    expect(await cloudTree(`${ROOT}/p-missing`)).toEqual(want);
    expect(await cloudTree(`${ROOT}/p-existing`)).toEqual(want);
  });

  it('a home folder is uploaded without its session store, and again on a re-run', async () => {
    const home = tempTree({ 'notes.txt': 'n', 'Docs/d.txt': 'd', '.megaCmd/session': 'FIXTURE-NOT-A-SESSION' });
    const put = tools(registerMutate).get('mega_put')!;
    const saved = process.env.HOME;
    try {
      process.env.HOME = home; // the connector's logic sees this fixture as $HOME
      for (const round of [1, 2]) {
        const preview = await put({ localPath: home, remotePath: `${ROOT}/home-backup` });
        expect(text(preview)).toMatch(/Left out: the MEGAcmd session store/);
        const done = await put({ localPath: home, remotePath: `${ROOT}/home-backup`, confirm: token(preview) });
        expect(done.isError, `round ${round}: ${text(done)}`).toBeFalsy();
      }
    } finally {
      process.env.HOME = saved;
    }
    const tree = await cloudTree(`${ROOT}/home-backup`);
    const name = basename(home);
    expect(tree).toContain(`/${name}/notes.txt`);
    expect(tree).toContain(`/${name}/Docs/d.txt`);
    expect(tree.some((p) => p.toLowerCase().includes('.megacmd'))).toBe(false);
  });

  it('find prints handles in the format the PCRE preview cross-checks, and recurses', async () => {
    const src = tempTree({ 'x/one.txt': '1', 'x/two.txt': '2' });
    await rt.run('put', ['-c', join(src, 'x'), `${ROOT}/f/`]);
    const named = await rt.run('find', [`${ROOT}/f/x`, '--use-pcre', '--show-handles']);
    const only = await rt.run('find', [`${ROOT}/f/x`, '--use-pcre', '--print-only-handles']);
    console.log('[itest] find --show-handles:\n' + named.stdout.trim());
    console.log('[itest] find --print-only-handles:\n' + only.stdout.trim());
    const namedLines = named.stdout.split(/\r?\n/).filter((l) => l.trim());
    const onlyLines = only.stdout.split(/\r?\n/).filter((l) => l.trim());
    expect(namedLines.every((l) => / <H:[A-Za-z0-9_-]+>$/.test(l))).toBe(true);
    expect(onlyLines.every((l) => /^H:[A-Za-z0-9_-]+$/.test(l.trim()))).toBe(true);
    expect(onlyLines.length).toBe(namedLines.length);
    // Recursion: the folder AND its contents.
    expect(namedLines.length).toBeGreaterThanOrEqual(3);
  });

  it('a PCRE move moves the matched folder as a whole', async () => {
    const src = tempTree({ 'mv/inner.txt': 'i' });
    await rt.run('put', ['-c', join(src, 'mv'), `${ROOT}/pm/`]);
    await rt.run('mkdir', ['-p', `${ROOT}/pm-dst`]);
    const mv = tools(registerMutate).get('mega_mv')!;
    const res = await confirmed(mv, { src: `${ROOT}/pm/mv`, usePcre: true, dst: `${ROOT}/pm-dst` });
    expect(res.isError, text(res)).toBeFalsy();
    expect(await cloudTree(`${ROOT}/pm-dst`)).toEqual(['/mv', '/mv/inner.txt']);
  });

  it('a folder holding a .megaCmd copy is refused for copy, download, share and links', async () => {
    const src = tempTree({ 'g/.megaCmd/session': 'FIXTURE', 'g/ok.txt': 'k' });
    await rt.run('put', ['-c', join(src, 'g'), `${ROOT}/sc/`]);
    const m = tools(registerMutate);
    const d = tools(registerDangerous);
    for (const [fn, args] of [
      [m.get('mega_cp')!, { src: `${ROOT}/sc/g`, dst: `${ROOT}` }],
      [m.get('mega_get')!, { remotePath: `${ROOT}/sc/g`, localDir: join(local, 'dl') }],
      [d.get('mega_export')!, { remotePath: `${ROOT}/sc/g`, action: 'create' }],
    ] as [ToolFn, Record<string, unknown>][]) {
      const res = await fn(args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(text(res)).toMatch(/contains a copy of the MEGAcmd session store/);
    }
  });

  it('a password-protected link is either protected or withdrawn, never left plain', async () => {
    const src = tempTree({ 'pw.txt': 'p' });
    await rt.run('put', ['-c', join(src, 'pw.txt'), `${ROOT}/`]);
    const ex = tools(registerDangerous).get('mega_export')!;
    const res = await confirmed(ex, { remotePath: `${ROOT}/pw.txt`, action: 'create', password: 'itest-pass-123' });
    console.log('[itest] password export ->', res.isError ? 'withdrawn' : 'protected', '|', text(res).split('\n')[0]);
    const status = await rt.run('export', [`${ROOT}/pw.txt`]);
    if (res.isError) {
      expect(text(res)).toMatch(/WITHOUT a password/);
      expect(status.stdout).not.toMatch(/https?:\/\//);
    } else {
      expect(text(res)).toContain('#P!');
      await rt.run('export', ['-d', `${ROOT}/pw.txt`]);
    }
  });

  it('merge download: where MEGAcmd actually writes a merged folder', async () => {
    const src = tempTree({ 'mg/new.txt': 'n' });
    await rt.run('put', ['-c', join(src, 'mg'), `${ROOT}/mgc/`]);
    const dest = realpathSync(mkdtempSync(join(local, 'merge-')));
    mkdirSync(join(dest, 'mg'));
    writeFileSync(join(dest, 'mg', 'old.txt'), 'o');
    const r = await rt.run('get', ['-m', `${ROOT}/mgc/mg`, dest]);
    const top = readdirSync(dest).sort();
    const inner = existsSync(join(dest, 'mg')) ? readdirSync(join(dest, 'mg')).sort() : [];
    console.log('[itest] merge get ->', r.code, 'localDir:', JSON.stringify(top), 'localDir/mg:', JSON.stringify(inner));
    expect(r.code).toBe(0);
  });

  it('names with spaces and non-ASCII characters survive the argv round trip', async () => {
    const src = tempTree({ 'a b 한글.txt': 'u' });
    const put = tools(registerMutate).get('mega_put')!;
    const res = await confirmed(put, { localPath: join(src, 'a b 한글.txt'), remotePath: `${ROOT}/u` });
    expect(res.isError, text(res)).toBeFalsy();
    expect(await cloudTree(`${ROOT}/u`)).toEqual(['/a b 한글.txt']);
  });
});
