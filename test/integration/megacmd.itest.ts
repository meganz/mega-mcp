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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, realpathSync, statSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, basename } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../../src/config.js';
import { createRuntime, type Runtime } from '../../src/runtime.js';
import { registerMutate } from '../../src/tools/mutate.js';
import { registerDangerous } from '../../src/tools/dangerous.js';
import { registerReadOnly } from '../../src/tools/readonly.js';
import { registerAccountDetails } from '../../src/tools/account.js';
import { registerSync } from '../../src/tools/sync.js';
import { ensureRemoteFolder, sameNamed, sameNamedMany, syncById, folderStillAt } from '../../src/tools/helpers.js';
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

  it('MCP-4: a copy preview names a public-link destination and a replaced file', async () => {
    const src = tempTree({ 'c.txt': 'c', 'pub/keep.txt': 'k' });
    await rt.run('put', ['-c', join(src, 'c.txt'), `${ROOT}/cp/`]);
    await rt.run('put', ['-c', join(src, 'pub'), `${ROOT}/cp/`]);
    await rt.run('put', ['-c', join(src, 'c.txt'), `${ROOT}/cp/existing.txt`]);
    expect((await rt.run('export', ['-a', '-f', `${ROOT}/cp/pub`])).code).toBe(0);
    const cp = tools(registerMutate).get('mega_cp')!;
    const intoLink = text(await cp({ src: `${ROOT}/cp/c.txt`, dst: `${ROOT}/cp/pub` }));
    console.log('[itest] cp into linked folder preview:\n' + intoLink.split('\n\n')[0]);
    expect(intoLink).toMatch(/has a public link: anyone with the link/);
    const ontoFile = text(await cp({ src: `${ROOT}/cp/c.txt`, dst: `${ROOT}/cp/existing.txt` }));
    expect(ontoFile).toMatch(/existing FILE: it will be REPLACED/);
    await rt.run('export', ['-d', `${ROOT}/cp/pub`]);
  });

  it('MCP-3: mega_attr shows custom attributes but never the s4 value', async () => {
    const src = tempTree({ 'a.txt': 'a' });
    await rt.run('put', ['-c', join(src, 'a.txt'), `${ROOT}/attr/`]);
    const node = `${ROOT}/attr/a.txt`;
    expect((await rt.run('attr', [node, '-s', 'note', 'hello'])).code).toBe(0);
    const s4 = await rt.run('attr', [node, '-s', 's4', 'ITEST-S4-SECRET']);
    console.log('[itest] setting s4 on a test node ->', s4.code, JSON.stringify(s4.stderr.trim()));
    const res = await tools(registerReadOnly).get('mega_attr')!({ remotePath: node });
    console.log('[itest] mega_attr ->\n' + text(res));
    expect(text(res)).toContain('note = hello');
    expect(text(res)).not.toContain('ITEST-S4-SECRET');
    if (s4.code === 0) expect(text(res)).toMatch(/S4 settings are not shown/);
  });

  it('mega_put with a name uploads a file and a folder under that name', async () => {
    const src = tempTree({ 'report.pdf': 'r', 'Photos/a.jpg': 'a' });
    const put = tools(registerMutate).get('mega_put')!;
    const f = await confirmed(put, { localPath: join(src, 'report.pdf'), remotePath: `${ROOT}/named`, name: 'report-2026.pdf' });
    expect(f.isError, text(f)).toBeFalsy();
    const d = await confirmed(put, { localPath: join(src, 'Photos'), remotePath: `${ROOT}/named`, name: 'Pics' });
    expect(d.isError, text(d)).toBeFalsy();
    expect(await cloudTree(`${ROOT}/named`)).toEqual(['/Pics', '/Pics/a.jpg', '/report-2026.pdf']);
    // Again onto the existing file: replaced (a new version), not nested.
    const again = await confirmed(put, { localPath: join(src, 'report.pdf'), remotePath: `${ROOT}/named`, name: 'report-2026.pdf' });
    expect(again.isError, text(again)).toBeFalsy();
    expect(await cloudTree(`${ROOT}/named`)).toEqual(['/Pics', '/Pics/a.jpg', '/report-2026.pdf']);
    // Onto the existing folder: refused, since MEGAcmd would nest it.
    expect(text(await put({ localPath: join(src, 'Photos'), remotePath: `${ROOT}/named`, name: 'Pics' }))).toMatch(/already exists as a folder/);
  });

  it('get into a localDir that does not exist: where MEGAcmd writes', async () => {
    const src = tempTree({ 'dl/one.txt': '1' });
    await rt.run('put', ['-c', join(src, 'dl'), `${ROOT}/dlsrc/`]);
    await rt.run('put', ['-c', join(src, 'dl', 'one.txt'), `${ROOT}/dlsrc/`]);
    const folderDest = join(local, 'missing-folder-dest');
    const fileDest = join(local, 'missing-file-dest');
    const a = await rt.run('get', [`${ROOT}/dlsrc/dl`, folderDest]);
    const b = await rt.run('get', [`${ROOT}/dlsrc/one.txt`, fileDest]);
    const describe = (p: string) => (!existsSync(p) ? 'missing' : statSync(p).isDirectory() ? `dir ${JSON.stringify(readdirSync(p).sort())}` : 'file');
    console.log('[itest] get folder -> missing dir:', a.code, describe(folderDest), '| get file -> missing dir:', b.code, describe(fileDest));
    // The item itself takes the missing localDir's name.
    expect(describe(folderDest)).toBe('dir ["one.txt"]');
    expect(describe(fileDest)).toBe('file');
    // mega_get creates localDir first, so the item goes INTO it, as previewed.
    const into = join(local, 'missing-tool-dest');
    const get = tools(registerMutate).get('mega_get')!;
    const res = await confirmed(get, { remotePath: `${ROOT}/dlsrc/dl`, localDir: into });
    expect(res.isError, text(res)).toBeFalsy();
    expect(readdirSync(into)).toEqual(['dl']);
    expect(readdirSync(join(into, 'dl'))).toEqual(['one.txt']);
  });

  it('a file version keeps its own name; mega_get saves it under the file\'s name', async () => {
    const src = tempTree({ 'v1/secret.cfg': 'OLD', 'v2/secret.cfg': 'NEW' });
    utimesSync(join(src, 'v1', 'secret.cfg'), 1700000000, 1700000000);
    utimesSync(join(src, 'v2', 'secret.cfg'), 1700001000, 1700001000);
    await rt.run('mkdir', ['-p', `${ROOT}/ver`]);
    await rt.run('put', ['-c', join(src, 'v1', 'secret.cfg'), `${ROOT}/ver/`]);
    await rt.run('put', ['-c', join(src, 'v2', 'secret.cfg'), `${ROOT}/ver/`]);
    await rt.run('mv', [`${ROOT}/ver/secret.cfg`, `${ROOT}/ver/readme.txt`]);
    const ls = await rt.run('ls', ['--versions', `${ROOT}/ver`]);
    const old = ls.stdout.match(/readme\.txt#(1700000000)/)?.[1];
    console.log('[itest] versions listing:', JSON.stringify(ls.stdout.trim()));
    if (!old) {
      console.log('[itest] no older version (versioning off on this account?) - skipped');
      return;
    }
    // MEGAcmd itself: the older version lands under ITS name, not the one asked for.
    const raw = realpathSync(mkdtempSync(join(local, 'ver-raw-')));
    const r = await rt.run('get', [`${ROOT}/ver/readme.txt#${old}`, raw]);
    console.log('[itest] get version into a folder:', r.code, JSON.stringify(readdirSync(raw)));
    // The tool: an explicit path, under the plain name, with the old contents.
    const dl = realpathSync(mkdtempSync(join(local, 'ver-tool-')));
    const get = tools(registerMutate).get('mega_get')!;
    const res = await confirmed(get, { remotePath: `${ROOT}/ver/readme.txt#${old}`, localDir: dl });
    expect(res.isError, text(res)).toBeFalsy();
    expect(readdirSync(dl)).toEqual(['readme.txt']);
    expect(readFileSync(join(dl, 'readme.txt'), 'utf8')).toBe('OLD');
  });

  it('a file version is copied and moved onto the plain name, not its own old name', async () => {
    const src = tempTree({ 'v1/doc.txt': 'OLD', 'v2/doc.txt': 'NEW' });
    utimesSync(join(src, 'v1', 'doc.txt'), 1700000000, 1700000000);
    utimesSync(join(src, 'v2', 'doc.txt'), 1700001000, 1700001000);
    await rt.run('mkdir', ['-p', `${ROOT}/ver2`, `${ROOT}/ver2out`]);
    await rt.run('put', ['-c', join(src, 'v1', 'doc.txt'), `${ROOT}/ver2/`]);
    await rt.run('put', ['-c', join(src, 'v2', 'doc.txt'), `${ROOT}/ver2/`]);
    await rt.run('mv', [`${ROOT}/ver2/doc.txt`, `${ROOT}/ver2/renamed.txt`]);
    const ls = await rt.run('ls', ['--versions', `${ROOT}/ver2`]);
    if (!/renamed\.txt#1700000000/.test(ls.stdout)) {
      console.log('[itest] no older version (versioning off?) - skipped');
      return;
    }
    // A private destination: the copy runs at once (one call).
    const c = await tools(registerMutate).get('mega_cp')!({ src: `${ROOT}/ver2/renamed.txt#1700000000`, dst: `${ROOT}/ver2out` });
    expect(c.isError, text(c)).toBeFalsy();
    expect(await cloudTree(`${ROOT}/ver2out`)).toEqual(['/renamed.txt']);
    expect((await rt.run('cat', [`${ROOT}/ver2out/renamed.txt`])).stdout).toBe('OLD');
    // MEGAcmd itself cannot move an older version (exit 11, measured): refused up front.
    const raw = await rt.run('mv', [`${ROOT}/ver2/renamed.txt#1700000000`, `${ROOT}/ver2out/moved.txt`]);
    console.log('[itest] raw version mv exit:', raw.code);
    const m = await tools(registerMutate).get('mega_mv')!({ src: `${ROOT}/ver2/renamed.txt#1700000000`, dst: `${ROOT}/ver2out/moved.txt` });
    expect(text(m)).toMatch(/copy it with mega_cp/);
    expect(await cloudTree(`${ROOT}/ver2out`)).toEqual(['/renamed.txt']);
  });

  it('export status hides the key; create returns the existing full link', async () => {
    const src = tempTree({ 'lnk.txt': 'l' });
    await rt.run('put', ['-c', join(src, 'lnk.txt'), `${ROOT}/`]);
    const ex = tools(registerDangerous).get('mega_export')!;
    const first = await confirmed(ex, { remotePath: `${ROOT}/lnk.txt`, action: 'create' });
    expect(first.isError, text(first)).toBeFalsy();
    const full = (first.structuredContent as { link: string }).link;
    const [base, key] = full.split('#');
    const st = await ex({ remotePath: `${ROOT}/lnk.txt`, action: 'status' });
    expect(text(st)).toContain(base as string);
    expect(JSON.stringify(st)).not.toContain(key as string);
    const again = await confirmed(ex, { remotePath: `${ROOT}/lnk.txt`, action: 'create' });
    const second = (again.structuredContent as { link?: string } | undefined)?.link;
    console.log('[itest] create on an existing link:', second === full ? 'same link' : `different (${again.isError ? text(again).slice(0, 120) : 'new link'})`);
    expect(second).toBe(full);
    await rt.run('export', ['-d', `${ROOT}/lnk.txt`]);
  });

  it('round-8 listings: an older version is deleted by handle, Rubbish Bin and backup lookups parse', async () => {
    // An older version, deleted alone by its handle; the current file stays.
    const src = tempTree({ 'v1/note.txt': 'OLD', 'v2/note.txt': 'NEW' });
    utimesSync(join(src, 'v1', 'note.txt'), 1700000000, 1700000000);
    utimesSync(join(src, 'v2', 'note.txt'), 1700002000, 1700002000);
    await rt.run('mkdir', ['-p', `${ROOT}/ver3`]);
    await rt.run('put', ['-c', join(src, 'v1', 'note.txt'), `${ROOT}/ver3/`]);
    await rt.run('put', ['-c', join(src, 'v2', 'note.txt'), `${ROOT}/ver3/`]);
    const listing = await rt.run('ls', ['-l', '--versions', '--show-handles', `${ROOT}/ver3/note.txt`]);
    console.log('[itest] ls -l --versions --show-handles:', JSON.stringify(listing.stdout.split('\n').slice(-4)));
    if (/note\.txt#1700000000/.test(listing.stdout)) {
      const rm = tools(registerDangerous).get('mega_rm')!;
      const res = await confirmed(rm, { remotePath: `${ROOT}/ver3/note.txt#1700000000` });
      expect(res.isError, text(res)).toBeFalsy();
      const after = await rt.run('ls', ['--versions', `${ROOT}/ver3`]);
      expect(after.stdout).not.toMatch(/note\.txt#1700000000/);
      expect((await rt.run('cat', [`${ROOT}/ver3/note.txt`])).stdout).toBe('NEW');
    }
    // A list's contents are bound with one find over all its paths.
    await rt.run('mkdir', ['-p', `${ROOT}/many/a`, `${ROOT}/many/b`]);
    const one = await rt.run('find', [`${ROOT}/many/a`, `${ROOT}/many/b`, '--print-only-handles']);
    const each = [(await rt.run('find', [`${ROOT}/many/a`, '--print-only-handles'])).stdout.trim(), (await rt.run('find', [`${ROOT}/many/b`, '--print-only-handles'])).stdout.trim()];
    expect(one.code).toBe(0);
    expect(one.stdout.trim().split(/\r?\n/).sort()).toEqual(each.sort());
    // Shares and links are listed under the Rubbish Bin's own root.
    const binShares = await rt.run('share', ['-p', '//bin']);
    const binLinks = await rt.run('export', ['//bin']);
    const backups = await rt.run('backup', ['--path-display-size=4096']);
    console.log('[itest] share -p //bin:', binShares.code, '| export //bin:', binLinks.code, '| backup listing:', backups.code, JSON.stringify(backups.stdout.slice(0, 80)));
    // A share preview of a private folder carries no "could not check" lines.
    const share = await tools(registerDangerous).get('mega_share')!({ action: 'add', remotePath: `${ROOT}/ver3`, withEmail: 'nobody@example.com' });
    expect(text(share)).not.toMatch(/Could not check/);
    // A copy into a Rubbish Bin folder that is not shared runs at once.
    await rt.run('mkdir', ['-p', `${ROOT}/tobin`]);
    await rt.run('mv', [`${ROOT}/tobin`, '//bin/']);
    const cp = await tools(registerMutate).get('mega_cp')!({ src: `${ROOT}/ver3/note.txt`, dst: '//bin/tobin' });
    expect(cp.isError, text(cp)).toBeFalsy();
    expect((cp.structuredContent as { requiresConfirmation?: boolean } | undefined)?.requiresConfirmation).toBeFalsy();
    await rt.run('rm', ['-r', '-f', '//bin/tobin']);
    // With a scheduled backup writing into a folder, a share preview of it says so.
    const bkLocal = tempTree({ 'doc.txt': 'd' });
    await rt.run('mkdir', ['-p', `${ROOT}/bk`]);
    const made = await rt.run('backup', [bkLocal, `${ROOT}/bk`, '--period=1h', '--num-backups=1']);
    const list = await rt.run('backup', ['--path-display-size=4096']);
    const tag = list.stdout.match(/^(\d+) /m)?.[1];
    console.log('[itest] backup add:', made.code, '| listed tag:', tag);
    try {
      const bshare = await tools(registerDangerous).get('mega_share')!({ action: 'add', remotePath: `${ROOT}/bk`, withEmail: 'nobody@example.com' });
      console.log('[itest] share preview with a backup:', JSON.stringify(text(bshare).split('\n').filter((l) => /backup/i.test(l))));
      expect(text(bshare)).toMatch(/receives periodic backups of/);
      expect(text(bshare)).not.toMatch(/Could not check/);
    } finally {
      if (tag) await rt.run('backup', ['-d', tag]);
    }
  });

  it('du counts items that share a name, which MEGAcmd acts on together', async () => {
    const src = tempTree({ 'Tax Returns/a.txt': 'a' });
    await rt.run('put', ['-c', join(src, 'Tax Returns'), `${ROOT}/dupsrc/`]);
    const ex = await rt.run('export', ['-a', '-f', `${ROOT}/dupsrc/Tax Returns`]);
    const link = ex.stdout.match(/https:\/\/mega\.nz\/folder\/\S+/)?.[0];
    expect(link, ex.stdout + ex.stderr).toBeTruthy();
    await rt.run('mkdir', ['-p', `${ROOT}/dup`]);
    await rt.run('import', [link as string, `${ROOT}/dup`]);
    await rt.run('import', [link as string, `${ROOT}/dup`]);
    await rt.run('export', ['-d', `${ROOT}/dupsrc/Tax Returns`]);
    const same = await sameNamed(rt, `${ROOT}/dup/Tax Returns`);
    console.log('[itest] same-named items:', same.count);
    expect(same.count).toBe(2);
    expect((await sameNamed(rt, `${ROOT}/dupsrc/Tax Returns`)).count).toBe(1);
    // Batched: one du for several paths gives the same counts.
    const many = await sameNamedMany(rt, [`${ROOT}/dup/Tax Returns`, `${ROOT}/dupsrc/Tax Returns`]);
    expect(many.map((m) => m.count)).toEqual([2, 1]);
    const rm = tools(registerDangerous).get('mega_rm')!;
    expect(text(await rm({ remotePath: `${ROOT}/dup/Tax Returns` }))).toMatch(/2 items are named/);
  });

  it('a two-way sync leaves .megaCmd and a deeper copy out by path, and syncs the rest of that folder', async () => {
    const lp = tempTree({ 'a.txt': 'a', 'keep/b.txt': 'b', '.megaCmd/session': 'NOT-A-REAL-SESSION', 'deep/x/.MEGACMD_x/s': 'x', 'deep/c.txt': 'c' });
    const rp = `${ROOT}/synced`;
    await rt.run('mkdir', ['-p', rp]);
    const add = tools(registerSync).get('mega_sync_add')!;
    const preview = await add({ localPath: lp, remotePath: rp });
    expect(text(preview)).toContain('deep/x/.MEGACMD_x');
    const res = await add({ localPath: lp, remotePath: rp, confirm: token(preview) });
    expect(res.isError, text(res)).toBeFalsy();
    try {
      // Wait until the ordinary files are up, then a little longer.
      let tree: string[] = [];
      for (let i = 0; i < 45; i++) {
        tree = await cloudTree(rp);
        if (tree.includes('/a.txt') && tree.includes('/keep/b.txt') && tree.includes('/deep/c.txt')) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      await new Promise((r) => setTimeout(r, 6000));
      tree = await cloudTree(rp);
      console.log('[itest] synced tree:', JSON.stringify(tree));
      expect(tree).toContain('/a.txt');
      expect(tree).toContain('/keep/b.txt');
      expect(tree.some((p) => /\.megacmd/i.test(p))).toBe(false);
      expect(tree).toContain('/deep/c.txt');
    } finally {
      const del = await rt.run('sync', ['-d', lp]);
      console.log('[itest] sync removed:', del.code);
    }
  });

  it('round 10: a plain folder download goes INTO an existing same-named folder; a paused sync does not follow a move', async () => {
    const src = tempTree({ 'Proj/new.txt': 'n' });
    await rt.run('put', ['-c', join(src, 'Proj'), `${ROOT}/r10/`]);
    const dest = realpathSync(mkdtempSync(join(local, 'into-')));
    mkdirSync(join(dest, 'Proj'));
    writeFileSync(join(dest, 'Proj', 'old.txt'), 'o');
    const g = await rt.run('get', [`${ROOT}/r10/Proj`, dest]);
    console.log('[itest] get into existing ->', g.code, JSON.stringify(readdirSync(dest).sort()), JSON.stringify(readdirSync(join(dest, 'Proj')).sort()));
    expect(readdirSync(join(dest, 'Proj')).sort()).toEqual(['new.txt', 'old.txt']);
    // The folder's own handle is listed last by find.
    const h = (await rt.run('find', [`${ROOT}/r10/Proj`, '--type=d', '--print-only-handles'])).stdout.trim().split(/\r?\n/).pop() as string;
    expect(await folderStillAt(rt, `${ROOT}/r10/Proj`, h)).toBe(true);

    const lp = tempTree({ 'a.txt': 'a' });
    const rp = `${ROOT}/r10sync`;
    await rt.run('mkdir', ['-p', rp]);
    const sync = tools(registerSync);
    expect((await confirmed(sync.get('mega_sync_add')!, { localPath: lp, remotePath: rp })).isError).toBeFalsy();
    try {
      const row = await syncById(rt, lp);
      console.log('[itest] sync row:', JSON.stringify(row));
      expect(row?.remote).toBe(rp);
      const id = (await rt.run('sync', ['--output-cols=ID,LOCALPATH', '--col-separator=;;'])).stdout.split(/\r?\n/).find((l) => l.endsWith(`;;${lp}`))?.split(';;')[0] as string;
      const control = sync.get('mega_sync_control')!;
      expect((await confirmed(control, { action: 'pause', id })).isError).toBeFalsy();
      const resume = await control({ action: 'resume', id });
      expect(text(resume)).toContain(`TWO-WAY sync between ${lp} and ${rp}`);
      // Moved while paused: MEGA keeps listing the old path, so resuming is refused.
      await rt.run('mv', [rp, `${ROOT}/r10moved`]);
      const after = await syncById(rt, id);
      console.log('[itest] paused sync after a move:', JSON.stringify(after));
      expect(text(await control({ action: 'resume', id }))).toMatch(/no longer at|There is no sync/);
    } finally {
      console.log('[itest] sync removed:', (await rt.run('sync', ['-d', lp])).code);
    }
  });

  it('round 12: cp onto an existing file removes that file with its versions', async () => {
    const src = tempTree({ 'f.txt': 'one', 'g.txt': 'other' });
    await rt.run('mkdir', ['-p', `${ROOT}/r12v`]);
    await rt.run('put', ['-c', join(src, 'f.txt'), `${ROOT}/r12v/f.txt`]);
    writeFileSync(join(src, 'f.txt'), 'two');
    await rt.run('put', ['-c', join(src, 'f.txt'), `${ROOT}/r12v/f.txt`]);
    const before = (await rt.run('ls', ['--versions', `${ROOT}/r12v/f.txt`])).stdout;
    await rt.run('put', ['-c', join(src, 'g.txt'), `${ROOT}/r12v/g.txt`]);
    const cp = await rt.run('cp', [`${ROOT}/r12v/g.txt`, `${ROOT}/r12v/f.txt`]);
    const after = (await rt.run('ls', ['--versions', `${ROOT}/r12v/f.txt`])).stdout;
    const versions = (t: string) => t.split(/\r?\n/).filter((l) => /#\d{10}/.test(l)).length;
    console.log('[itest] cp onto a versioned file ->', cp.code, 'versions before:', versions(before), 'after:', versions(after));
    expect(versions(before)).toBeGreaterThan(0);
    expect(versions(after)).toBe(0);
  });

  it('an upload merged into a folder that is (or holds) a sync root gets the synced landing checks', async () => {
    const lp = tempTree({ 'a.txt': 'a' });
    const rp = `${ROOT}/r13/Work`;
    await rt.run('mkdir', ['-p', rp]);
    const sync = tools(registerSync);
    expect((await confirmed(sync.get('mega_sync_add')!, { localPath: lp, remotePath: rp })).isError).toBeFalsy();
    try {
      const put = tools(registerMutate).get('mega_put')!;
      // A local "Work" holding a nested .megaignore, uploaded into the parent: it merges into the sync root.
      const src = tempTree({ 'Work/sub/.megaignore': '+:*', 'Work/b.txt': 'b' });
      const exact = await put({ localPath: join(src, 'Work'), remotePath: `${ROOT}/r13` });
      console.log('[itest] put into exact sync root ->', text(exact).split('\n')[0]);
      expect(exact.isError).toBe(true);
      // One level up: the sync root lies below the merged folder.
      const above = tempTree({ 'r13/Work/c.txt': 'c' });
      const deeper = await put({ localPath: join(above, 'r13'), remotePath: ROOT });
      console.log('[itest] put above a sync root ->', text(deeper).split('\n')[0]);
      expect(text(deeper)).toMatch(/holds the cloud side of a two-way sync/);
    } finally {
      console.log('[itest] sync removed:', (await rt.run('sync', ['-d', lp])).code);
    }
  });

  it('a folder upload is named as cloudNameOf predicts (%xx decoded)', async () => {
    const src = tempTree({ 'My%20Docs/a.txt': 'a', 'x%2fy/b.txt': 'b' });
    await rt.run('mkdir', ['-p', `${ROOT}/r13n`]);
    await rt.run('put', ['-c', join(src, 'My%20Docs'), `${ROOT}/r13n/`]);
    const tree = await cloudTree(`${ROOT}/r13n`);
    console.log('[itest] uploaded names:', JSON.stringify(tree));
    expect(tree).toContain('/My Docs');
  });

  it('mega_cp copies a list and a pattern at once into a private folder', async () => {
    const src = tempTree({ 'a.txt': 'a', 'b.txt': 'b', 'c.pdf': 'c' });
    await rt.run('put', ['-c', join(src, 'a.txt'), join(src, 'b.txt'), join(src, 'c.pdf'), `${ROOT}/cpsrc/`]);
    await rt.run('mkdir', ['-p', `${ROOT}/cplist`, `${ROOT}/cppcre`]);
    const cp = tools(registerMutate).get('mega_cp')!;
    const list = await cp({ srcs: [`${ROOT}/cpsrc/a.txt`, `${ROOT}/cpsrc/b.txt`], dst: `${ROOT}/cplist` });
    expect(list.isError, text(list)).toBeFalsy();
    expect(list.structuredContent).not.toMatchObject({ requiresConfirmation: true });
    const pcre = await cp({ src: `${ROOT}/cpsrc/.*\\.txt`, usePcre: true, dst: `${ROOT}/cppcre` });
    expect(pcre.isError, text(pcre)).toBeFalsy();
    expect(await cloudTree(`${ROOT}/cplist`)).toEqual(['/a.txt', '/b.txt']);
    expect(await cloudTree(`${ROOT}/cppcre`)).toEqual(['/a.txt', '/b.txt']);
  });

  it('mega_sessions lists each session with its ID (a killsession handle)', async () => {
    const res = await tools(registerAccountDetails).get('mega_sessions')!({});
    expect(res.isError ?? false).toBe(false);
    expect(/Session ID: [A-Za-z0-9_-]{11}\b/.test(text(res))).toBe(true);
  });

  it('names with spaces and non-ASCII characters survive the argv round trip', async () => {
    const src = tempTree({ 'a b 한글.txt': 'u' });
    const put = tools(registerMutate).get('mega_put')!;
    const res = await confirmed(put, { localPath: join(src, 'a b 한글.txt'), remotePath: `${ROOT}/u` });
    expect(res.isError, text(res)).toBeFalsy();
    expect(await cloudTree(`${ROOT}/u`)).toEqual(['/a b 한글.txt']);
  });
});
