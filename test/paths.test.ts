import { describe, it, expect } from 'vitest';
import { isAbsolute, resolve, join, sep, basename } from 'node:path';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { previewSafe } from '../src/tools/helpers.js';
import {
  assertRemotePath,
  assertOptionalRemotePath,
  assertLocalPath,
  assertConstraint,
  assertNoFlag,
  assertFlagValue,
  assertNoWildcard,
  assertSecret,
  publishMegacmdBinDir,
  sessionStoresWithin,
  assertNoStoreWithin,
  assertNotStoreCopy,
  assertDownloadTarget,
  assertNoProtectedWithin,
  planUpload,
  ValidationError,
} from '../src/paths.js';

const isWin = process.platform === 'win32';
/** The filesystem root as this platform spells it — "/" is not one on Windows. */
const ROOT = resolve('/');

describe('assertRemotePath', () => {
  it('accepts an absolute MEGA path', () => {
    expect(assertRemotePath('/Photos/2024')).toBe('/Photos/2024');
  });

  it('trims surrounding whitespace', () => {
    expect(assertRemotePath('  /a/b  ')).toBe('/a/b');
  });

  it('rejects a relative path (also blocks flag-injection)', () => {
    expect(() => assertRemotePath('Photos')).toThrow(ValidationError);
    expect(() => assertRemotePath('-rf')).toThrow(ValidationError);
  });

  it('rejects an empty path', () => {
    expect(() => assertRemotePath('   ')).toThrow(ValidationError);
  });

  it('rejects a NUL byte', () => {
    expect(() => assertRemotePath(`/a${String.fromCharCode(0)}b`)).toThrow(/NUL/);
  });
});

describe('assertOptionalRemotePath', () => {
  it('passes through undefined', () => {
    expect(assertOptionalRemotePath(undefined)).toBeUndefined();
  });
  it('validates a provided value', () => {
    expect(() => assertOptionalRemotePath('rel')).toThrow(ValidationError);
  });
});

describe('assertConstraint (mtime/size)', () => {
  it('allows the "within the last N" form that starts with "-" (the old bug)', () => {
    expect(assertConstraint('-7d', 'mtime')).toBe('-7d');
    expect(assertConstraint('-100K', 'size')).toBe('-100K');
  });
  it('allows combined units and two-sided ranges', () => {
    expect(assertConstraint('+1m12d3h', 'mtime')).toBe('+1m12d3h');
    expect(assertConstraint('-3d+1h', 'mtime')).toBe('-3d+1h');
    expect(assertConstraint('-4M+100K', 'size')).toBe('-4M+100K');
    expect(assertConstraint('+5y', 'mtime')).toBe('+5y');
  });
  it('rejects empty, NUL, whitespace, and shell-metacharacter garbage', () => {
    expect(() => assertConstraint('  ', 'mtime')).toThrow(ValidationError);
    expect(() => assertConstraint(`-7${String.fromCharCode(0)}d`, 'mtime')).toThrow(/NUL/);
    expect(() => assertConstraint('-7 d', 'mtime')).toThrow(ValidationError);
    expect(() => assertConstraint('-7d; rm -rf /', 'mtime')).toThrow(ValidationError);
  });
});

describe('assertLocalPath', () => {
  it('resolves to an absolute path', () => {
    expect(isAbsolute(assertLocalPath('some/dir'))).toBe(true);
  });
  it('rejects empty and NUL', () => {
    expect(() => assertLocalPath('  ')).toThrow(ValidationError);
    expect(() => assertLocalPath(`a${String.fromCharCode(0)}b`)).toThrow(/NUL/);
  });
  it('refuses paths inside the MEGAcmd config dir (~/.megaCmd)', () => {
    const inside = `${homedir()}/.megaCmd/session`;
    expect(() => assertLocalPath(inside)).toThrow(/configuration directory/i);
  });
  it('collapses traversal back into the config dir', () => {
    expect(() => assertLocalPath(`${homedir()}/x/../.megaCmd/session`)).toThrow(/configuration directory/i);
  });
  it('still allows an ordinary local path', () => {
    // Compare against the RESOLVED form: on Windows resolve() rewrites the
    // separators, so asserting the input string back is a posix-only assumption.
    const p = join(homedir(), 'Documents', 'report.pdf');
    expect(assertLocalPath(`${homedir()}/Documents/report.pdf`)).toBe(p);
    expect(assertLocalPath(p)).toBe(p);
  });
});

/**
 * The session store is not one fixed path: MEGAcmd derives it per platform
 * (megacmdcommonutils.cpp PlatformDirectories). A guard that only knew
 * `homedir()/.megaCmd` left the Windows layout, the no-HOME fallback, and every
 * case variant reachable by mega_put / mega_get / sync / backup — and the session
 * blob carries the account MASTER KEY (SDK dumpsession), which cannot be rotated.
 */
describe('assertLocalPath — session-store coverage beyond ~/.megaCmd', () => {
  const hits = (p: string) => expect(() => assertLocalPath(p)).toThrow(/configuration directory/i);

  it('refuses case variants (same directory on APFS / NTFS)', () => {
    hits(`${homedir()}/.MEGACMD/session`);
    hits(`${homedir()}/.megacmd/session`);
  });

  it('refuses the Windows executable-relative store, wherever the binary lives', () => {
    // configDirPath() = <dir of the running exe>/.megaCmd, so this is under the
    // resolved binDir (bundled / configured / system / our download cache) and
    // shares no prefix with %USERPROFILE%\.megaCmd.
    hits('/opt/mega-cloud-mcp/megacmd/current/MEGAcmd/.megaCmd/session');
    hits(`${homedir()}/Library/Caches/mega-cloud-mcp/megacmd/current/.megaCmd/session`);
  });

  it('refuses the MEGACMD_WORKING_FOLDER_SUFFIX variant', () => {
    hits(`${homedir()}/.megaCmd_test/session`);
  });

  it('refuses the macOS runtime/socket dir', () => {
    hits(`${homedir()}/Library/Caches/megacmd.mac/megacmd.socket`);
  });

  it.runIf(process.platform !== 'win32')('refuses the POSIX no-HOME fallback /tmp/megacmd-<uid>', () => {
    hits(`/tmp/megacmd-${process.getuid?.()}/session`);
  });

  it.runIf(process.platform === 'darwin')('refuses the fallback by its REAL path too (/tmp -> /private/tmp)', () => {
    // The comparison must be symlink-proof on BOTH sides: /private/tmp/megacmd-<uid>
    // IS the directory the "/tmp" spelling names, so knowing only one form is a hole.
    hits(`/private/tmp/megacmd-${process.getuid?.()}/session`);
  });

  it.runIf(process.platform !== 'win32')('refuses a symlink that points into the store', async () => {
    const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const base = mkdtempSync(`${tmpdir()}/mega-guard-`);
    try {
      // Real store, plus an innocuously named link to it. A lexical check passes
      // the link; realpathBestEffort is what catches it.
      mkdirSync(`${base}/store/.megaCmd`, { recursive: true });
      symlinkSync(`${base}/store/.megaCmd`, `${base}/notes`);
      hits(`${base}/notes/session`);
      // Also catches it when the leaf does not exist yet (download destination).
      hits(`${base}/notes/does-not-exist-yet`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/**
 * Windows normalizes away characters that path.resolve() keeps, so the OS opens a
 * different file than the one the guard inspected. Node cannot be used to detect
 * it — libuv prefixes `\\?\`, which turns the normalization OFF — so the guard has
 * to fold the spelling itself. Verified on Windows 11: `cmd /c type` on
 * `<t>\.megaCmd.\session` prints the session blob while `existsSync` is false.
 */
describe('assertLocalPath — Win32 spellings the OS folds away', () => {
  const hits = (p: string) => expect(() => assertLocalPath(p)).toThrow(/configuration directory/i);

  it.runIf(isWin)('refuses a trailing dot on the store segment', () => {
    hits(`${homedir()}\\.megaCmd.\\session`);
    hits(`${homedir()}\\.megaCmd...\\session`);
    hits(`${homedir()}\\.megaCmd.`);
  });

  it.runIf(isWin)('refuses a trailing space on the store segment', () => {
    hits(`${homedir()}\\.megaCmd \\session`);
  });

  it.runIf(isWin)('refuses the NTFS stream spellings of the store', () => {
    // `dir::$INDEX_ALLOCATION` IS the directory; `file:stream` IS the file.
    hits(`${homedir()}\\.megaCmd::$INDEX_ALLOCATION`);
    hits(`${homedir()}\\.megaCmd::$INDEX_ALLOCATION\\session`);
    hits(`${homedir()}\\.megaCmd\\session:$DATA`);
  });

  it.runIf(isWin)('does not over-block ordinary names that merely look similar', () => {
    // The folding must not swallow real directories: only trailing dots/spaces and
    // a stream suffix are dropped, never an interior dot or a longer name.
    expect(assertLocalPath(`${homedir()}\\megaCmdStuff\\a.txt`)).toContain('megaCmdStuff');
    expect(assertLocalPath(`${homedir()}\\.megaCmdish\\a.txt`)).toContain('.megaCmdish');
    expect(assertLocalPath(`${homedir()}\\my.notes.\\a.txt`)).toContain('my.notes');
  });

  it.runIf(!isWin)('leaves posix names alone (a trailing dot IS a distinct directory there)', () => {
    // Folding on posix would refuse a legitimate directory the user really has.
    expect(assertLocalPath(`${homedir()}/.megaCmd./session`)).toContain('.megaCmd.');
  });

  /**
   * The regression test for the hole the first version of this fix left open.
   * Folding and realpath have to COMPOSE: an alias that only a filesystem lookup
   * can unmask (a junction, an NTFS 8.3 short name) combined with one trailing dot
   * defeated each of them separately — the name rule saw `MEGACM~1`, and realpath
   * was handed a spelling Node cannot open. `cmd /c type` read the real session
   * blob through the spelling the guard allowed.
   */
  it.runIf(isWin)('refuses an alias + trailing dot, which blinds fold and realpath separately', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const { tmpdir } = await import('node:os');
    const base = mkdtempSync(join(tmpdir(), 'mega-alias-'));
    try {
      const store = join(base, '.megaCmd');
      mkdirSync(store, { recursive: true });
      writeFileSync(join(store, 'session'), 'SESSIONBLOB');
      // A junction needs neither elevation nor Developer Mode (unlike a symlink).
      const link = join(base, 'notes');
      execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, store], { stdio: 'ignore' });

      // Sanity: Win32 really reaches the store through every spelling asserted
      // below, so none of these is a refusal of something unreachable anyway.
      const win32Reaches = (p: string) => {
        try {
          execFileSync('cmd.exe', ['/c', 'type', p], { stdio: 'ignore' });
          return true;
        } catch {
          return false;
        }
      };
      for (const p of [join(link, 'session'), `${link}.\\session`]) {
        expect(win32Reaches(p)).toBe(true);
        hits(p);
      }
      // …and the guard must NOT be fooled by a bogus alias that reaches nothing.
      expect(win32Reaches(`${base}\\nosuchlink.\\session`)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  /**
   * The REFUSAL path is synchronous, so it cannot await the bin dir the advisory
   * path is handed explicitly; publishMegacmdBinDir() closes that gap. It matters
   * when the store directory is itself a link: the target's path contains no
   * `.megaCmd` segment, so the NAME rule cannot see it and only the prefix rule —
   * which needs the Windows executable-relative root — refuses it.
   */
  it.runIf(isWin)('refuses the link TARGET of an exe-relative store once the bin dir is published', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const { tmpdir } = await import('node:os');
    const base = mkdtempSync(join(tmpdir(), 'mega-pub-'));
    try {
      const binDir = join(base, 'MEGAcmd');
      const elsewhere = join(base, 'relocated');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(elsewhere, { recursive: true });
      writeFileSync(join(elsewhere, 'session'), 'SESSIONBLOB');
      // <binDir>\.megaCmd is a junction pointing at a directory named nothing
      // like the store, which is what defeats the segment-name rule.
      execFileSync('cmd.exe', ['/c', 'mklink', '/J', join(binDir, '.megaCmd'), elsewhere], { stdio: 'ignore' });

      const target = join(elsewhere, 'session');
      publishMegacmdBinDir(null);
      expect(() => assertLocalPath(target)).not.toThrow(); // name rule alone cannot see it
      publishMegacmdBinDir(binDir);
      hits(target);
    } finally {
      publishMegacmdBinDir(null);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.runIf(isWin)('refuses the 8.3 short name of the store, with and without a trailing dot', async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const { tmpdir } = await import('node:os');
    const base = mkdtempSync(join(tmpdir(), 'mega-83-'));
    try {
      mkdirSync(join(base, '.megaCmd'), { recursive: true });
      // 8.3 generation is a per-volume setting; skip rather than assert nothing.
      const listing = execFileSync('cmd.exe', ['/c', 'dir', '/x', '/a', base], { encoding: 'latin1' });
      const short = /\s([A-Z0-9_~]{1,8}(?:\.[A-Z0-9_~]{1,3})?)\s+\.megaCmd\s*$/im.exec(listing)?.[1];
      if (!short) return; // volume has 8.3 names disabled
      hits(join(base, short, 'session'));
      hits(`${base}\\${short}.\\session`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/**
 * A bulk backup that CONTAINS the store is warned about, not refused: "back up my
 * home folder" is legitimate, and MEGA encrypts the upload under this account's
 * own master key, so the copy is not itself a disclosure. It becomes one on
 * export/share — the user's call, so it belongs in the preview.
 *
 * These use a scratch $HOME rather than the real one. The warning only names stores
 * that EXIST, so asserting against the developer's own machine would pass or fail
 * on whether they happen to run MEGAcmd — and on Windows the real store is beside
 * the executable, so ~/.megaCmd is normally absent.
 */
describe('sessionStoresWithin / assertNoStoreWithin (bulk upload, sync, backup)', () => {
  /**
   * Point homedir() at `dir` for the duration of `fn`. os.homedir() reads $HOME /
   * %USERPROFILE% first, and sessionStoreRoots() recomputes per call.
   *
   * MUST await `fn` before restoring: a non-awaited async body would have its
   * assertions run AFTER the finally block put $HOME back and the fixture was
   * deleted, so the test would pass no matter what the code did.
   */
  async function withHome<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
    const keys = ['HOME', 'USERPROFILE'] as const;
    const saved = keys.map((k) => [k, process.env[k]] as const);
    try {
      for (const k of keys) process.env[k] = dir;
      return await fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  /** A scratch home containing a real ~/.megaCmd, plus a real store next to a
   *  "bin dir" — the Windows executable-relative layout. */
  async function withFixture<T>(
    fn: (f: { home: string; binDir: string; homeStore: string; binStore: string }) => T | Promise<T>,
  ): Promise<T> {
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const base = mkdtempSync(join(tmpdir(), 'mega-store-'));
    const home = join(base, 'home');
    const binDir = join(base, 'MEGAcmd');
    const homeStore = join(home, '.megaCmd');
    const binStore = join(binDir, '.megaCmd');
    mkdirSync(homeStore, { recursive: true });
    mkdirSync(binStore, { recursive: true });
    try {
      return await withHome(home, () => fn({ home, binDir, homeStore, binStore }));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  /**
   * Compare reported stores by IDENTITY, not spelling. sessionStoreRoots() holds
   * two spellings of every root and the lookup de-duplicates by realpath, so which
   * spelling comes back is not contractual — on macOS the tmp fixture is reached
   * through /var -> /private/var and the realpath form is the one that survives.
   */
  const sameStore = (a: string, b: string) => {
    const real = (p: string) => {
      try {
        return realpathSync.native(p).replace(/^\\\\\?\\/, '').toLowerCase();
      } catch {
        return p.toLowerCase();
      }
    };
    return real(a) === real(b);
  };
  const reports = (list: string[], want: string) => list.some((p) => sameStore(p, want));
  const names = (paths: string[]) => paths.map((p) => p.split(/[\\/]/).pop());

  it('detects the store inside an ancestor tree', async () => {
    await withFixture(({ home, homeStore }) => {
      expect(reports(sessionStoresWithin(home), homeStore)).toBe(true);
      // The filesystem root contains it too, spelled the way this platform spells it.
      expect(sessionStoresWithin(ROOT).length).toBeGreaterThan(0);
    });
  });

  it('reports one store ONCE even when its root has two spellings', async () => {
    // sessionStoreRoots() adds both the raw and the realpath spelling of each root.
    // Before de-duplication a symlinked ancestor made both match, listing the same
    // directory twice in the preview.
    await withFixture(({ home, homeStore }) => {
      const found = sessionStoresWithin(home);
      expect(found.filter((p) => sameStore(p, homeStore))).toHaveLength(1);
    });
  });

  it('reports nothing for unrelated trees', async () => {
    await withFixture(({ home }) => {
      expect(sessionStoresWithin(join(home, 'Documents'))).toEqual([]);
    });
  });

  it('does not report the store as being within itself (that path is refused instead)', async () => {
    await withFixture(({ homeStore }) => {
      expect(sessionStoresWithin(homeStore)).toEqual([]);
    });
  });

  it('still ALLOWS a whole-home backup path through validation', async () => {
    await withFixture(({ home }) => {
      expect(assertLocalPath(home)).toBe(home);
    });
    expect(assertLocalPath(ROOT)).toBe(ROOT);
  });

  /**
   * The bug this replaces: sessionStoreRoots() lists $HOME/.megaCmd first and
   * unconditionally, and the old first-match-wins lookup therefore named it and
   * stopped — on Windows that is a directory MEGAcmd never creates, while the real
   * store (beside the executable, holding the master key) went unmentioned.
   */
  it('reports EVERY store in the tree, not just the first root that matches', async () => {
    await withFixture(({ home, binDir, homeStore, binStore }) => {
      // Both stores are inside `base`, the parent of home and binDir.
      const base = join(home, '..');
      const found = sessionStoresWithin(base, binDir);
      expect(reports(found, homeStore)).toBe(true);
      if (isWin) {
        expect(reports(found, binStore)).toBe(true);
        expect(() => assertNoStoreWithin(base, 'back up', binDir)).toThrow(binStore);
      } else {
        // posix: the store is under $HOME wherever the binary lives, so binDir must
        // NOT invent a root next to the executable.
        expect(reports(found, binStore)).toBe(false);
      }
    });
  });

  it('stays silent about a root that does not exist on disk', async () => {
    await withFixture(async ({ home, homeStore }) => {
      const { rmSync } = await import('node:fs');
      rmSync(homeStore, { recursive: true, force: true });
      // Nothing to carry away -> nothing to refuse.
      expect(sessionStoresWithin(home)).toEqual([]);
      expect(() => assertNoStoreWithin(home, 'sync')).not.toThrow();
    });
  });

  it('is not defeated by a non-canonical spelling of the same tree', async () => {
    await withFixture(({ home, homeStore }) => {
      for (const spelling of [home, `${home}${isWin ? '\\' : '/'}`, join(home, 'x', '..'), home.replace(/\\/g, '/')]) {
        expect(reports(sessionStoresWithin(spelling), homeStore)).toBe(true);
      }
    });
  });

  // Both branches of `if (isWin && binDir)` are pinned, using a REAL store next to
  // a real bin dir. The previous version asserted the posix behaviour ungated, so
  // on Windows it passed only because C:\Applications happens not to exist.
  it.runIf(!isWin)('ignores a passed-in MEGAcmd bin dir on posix (store is under $HOME there)', async () => {
    await withFixture(({ home, binDir, binStore }) => {
      // binStore really exists next to the binary; posix must still not count it,
      // or every /Applications backup would be refused for a store MEGAcmd never made.
      expect(reports(sessionStoresWithin(join(home, '..'), binDir), binStore)).toBe(false);
      expect(() => assertNoStoreWithin(binDir, 'back up', binDir)).not.toThrow();
    });
  });

  it.runIf(isWin)('DOES use a passed-in MEGAcmd bin dir on win32 (store is beside the exe)', async () => {
    await withFixture(({ binDir, binStore }) => {
      // Without binDir the executable-relative root is unknown, so the ancestor
      // check cannot see it — that is precisely why the tools thread it through.
      expect(reports(sessionStoresWithin(binDir, binDir), binStore)).toBe(true);
      expect(sessionStoresWithin(binDir)).toEqual([]);
      expect(() => assertNoStoreWithin(binDir, 'back up', binDir)).toThrow(binStore);
    });
  });

  // MEGACMD_WORKING_FOLDER_SUFFIX renames the store; the ancestor checks used to
  // know only the plain name, so a home holding just the suffixed store passed.
  it('finds a suffixed store when MEGACMD_WORKING_FOLDER_SUFFIX is set', async () => {
    await withFixture(async ({ home, homeStore }) => {
      const { renameSync } = await import('node:fs');
      const suffixed = `${homeStore}_work`;
      renameSync(homeStore, suffixed);
      const saved = process.env.MEGACMD_WORKING_FOLDER_SUFFIX;
      try {
        delete process.env.MEGACMD_WORKING_FOLDER_SUFFIX;
        expect(reports(sessionStoresWithin(home), suffixed)).toBe(false);
        process.env.MEGACMD_WORKING_FOLDER_SUFFIX = 'work';
        expect(reports(sessionStoresWithin(home), suffixed)).toBe(true);
        expect(() => assertNoStoreWithin(home, 'sync')).toThrow(/\.megaCmd_work/);
        expect(names(planUpload([home], '/B').excluded)).toContain('.megaCmd_work');
      } finally {
        if (saved === undefined) delete process.env.MEGACMD_WORKING_FOLDER_SUFFIX;
        else process.env.MEGACMD_WORKING_FOLDER_SUFFIX = saved;
      }
    });
  });

  it('refuses a sync/backup containing the store, naming it and pointing at mega_put', async () => {
    await withFixture(({ home }) => {
      expect(() => assertNoStoreWithin(home, 'sync')).toThrow(ValidationError);
      expect(() => assertNoStoreWithin(home, 'sync')).toThrow(/MASTER KEY/);
      expect(() => assertNoStoreWithin(home, 'sync')).toThrow(/\.megaCmd/);
      expect(() => assertNoStoreWithin(home, 'back up')).toThrow(/mega_put/);
      expect(() => assertNoStoreWithin(join(home, 'Documents'), 'sync')).not.toThrow();
    });
  });
});

/**
 * MCP-2: a folder holding the session store is uploaded WITHOUT it. MEGAcmd `put`
 * has no exclude option, so planUpload rebuilds the tree down to the store and
 * uploads every sibling whole; these pin that the store never becomes a source.
 */
describe('planUpload leaves the session store behind', () => {
  async function withTree<T>(fn: (t: { base: string; home: string; other: string; store: string }) => T | Promise<T>): Promise<T> {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const base = mkdtempSync(join(tmpdir(), 'mega-plan-'));
    const home = join(base, 'home');
    const other = join(base, 'other');
    const store = join(home, '.megaCmd');
    mkdirSync(store, { recursive: true });
    mkdirSync(join(home, 'Docs'), { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(store, 'session'), 'fixture');
    writeFileSync(join(home, 'a.txt'), 'a');
    writeFileSync(join(home, 'Docs', 'b.txt'), 'b');
    writeFileSync(join(other, 'c.txt'), 'c');
    const keys = ['HOME', 'USERPROFILE'] as const;
    const saved = keys.map((k) => [k, process.env[k]] as const);
    try {
      for (const k of keys) process.env[k] = home;
      return await fn({ base, home, other, store });
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(base, { recursive: true, force: true });
    }
  }
  const names = (paths: string[]) => paths.map((p) => p.split(/[\\/]/).pop());
  const noStoreSource = (plan: ReturnType<typeof planUpload>) => {
    for (const step of plan.steps) for (const src of step.sources) expect(src.toLowerCase()).not.toContain('.megacmd');
  };

  it('uploads a folder without a store whole, in one step, unchanged', async () => {
    await withTree(({ other }) => {
      expect(planUpload([other], '/B')).toEqual({ steps: [{ dest: '/B', sources: [other] }], excluded: [] });
    });
  });

  it('uploads the home folder without its .megaCmd', async () => {
    await withTree(({ home }) => {
      const plan = planUpload([home], '/Backup');
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0]!.dest).toBe('/Backup/home');
      expect(names(plan.steps[0]!.sources)).toEqual(['Docs', 'a.txt']);
      expect(names(plan.excluded)).toEqual(['.megaCmd']);
      noStoreSource(plan);
    });
  });

  it('rebuilds the path down to a deeper store, uploading the siblings whole', async () => {
    await withTree(({ base }) => {
      const plan = planUpload([base], '/B');
      const top = `/B/${base.split(/[\\/]/).pop()}`;
      expect(plan.steps.map((s) => s.dest)).toEqual([top, `${top}/home`]);
      expect(names(plan.steps[0]!.sources)).toEqual(['other']);
      expect(names(plan.steps[1]!.sources)).toEqual(['Docs', 'a.txt']);
      noStoreSource(plan);
    });
  });

  it('keeps unaffected items in one step next to the rebuilt folder', async () => {
    await withTree(({ home, other }) => {
      const file = join(other, 'c.txt');
      const plan = planUpload([file, home], '/');
      expect(plan.steps[0]).toEqual({ dest: '/', sources: [file] });
      expect(plan.steps[1]!.dest).toBe('/home');
    });
  });

  it('leaves out a .megaCmd_<suffix> sibling, whatever its case', async () => {
    await withTree(async ({ home }) => {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(home, '.MEGACMD_work'));
      const plan = planUpload([home], '/B');
      expect(names(plan.excluded).sort()).toEqual(['.MEGACMD_work', '.megaCmd']);
      noStoreSource(plan);
    });
  });

  // Symlinks need privileges on Windows; the posix run covers the logic.
  it.runIf(!isWin)('leaves out symlinks into the store, or above it, without looping', async () => {
    await withTree(async ({ base, home }) => {
      const { symlinkSync } = await import('node:fs');
      symlinkSync(join(home, '.megaCmd'), join(home, 'store-link'));
      symlinkSync(base, join(home, 'up'));
      const plan = planUpload([home], '/B');
      expect(names(plan.excluded).sort()).toEqual(['.megaCmd', 'store-link', 'up']);
      expect(names(plan.steps[0]!.sources)).toEqual(['Docs', 'a.txt']);
    });
  });
});

/**
 * MCP-2: a copy of the store that is already in the cloud is just a folder named
 * `.megaCmd`, which the local guard cannot see. The cloud-path guard refuses that
 * name, and any wildcard MEGAcmd could expand to it.
 */
describe('assertNotStoreCopy (cloud copies of the session store)', () => {
  it('refuses a path through a .megaCmd folder, in any case or suffix variant', () => {
    for (const p of ['/Backup/home/.megaCmd/session', '/b/.megaCmd', '/b/.MEGACMD/x', '/b/.megaCmd_work/session', '/b/.megaCmd_*/session']) {
      expect(() => assertNotStoreCopy(p)).toThrow(/session store/);
    }
  });

  it('refuses a wildcard that could expand to the store', () => {
    for (const p of ['/b/*/session', '/b/.mega*/session', '/b/?megaCmd/session', '/b/*md/session', '/b/.megaCmd?*/session', '/b/*_*/x', '/b/.megacmd?x/s', '/b/*']) {
      expect(() => assertNotStoreCopy(p), p).toThrow(/wildcard/);
    }
  });

  it('allows ordinary names and wildcards that cannot reach the store', () => {
    for (const p of ['/b/megaCmd/x', '/b/.megaCmdbackup/x', '/b/my.megaCmd', '/b/*.txt', '/docs/report?.pdf', '/b/mega*', '/Photos/2024/*.jpg', '/']) {
      expect(assertNotStoreCopy(p)).toBe(p);
    }
  });
});

/**
 * assertLocalPath only looks UP from a path; a download writes `<dir>/<name>` and
 * everything below it. So the target must not be inside a protected directory,
 * nor ABOVE one.
 */
describe('assertDownloadTarget / assertNoProtectedWithin', () => {
  async function withRoot(fn: (f: { parent: string; root: string }) => void | Promise<void>) {
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const parent = mkdtempSync(join(tmpdir(), 'mega-target-'));
    const root = join(parent, 'data');
    mkdirSync(root);
    try {
      publishMegacmdBinDir(null, [root]);
      await fn({ parent, root });
    } finally {
      publishMegacmdBinDir(null);
      rmSync(parent, { recursive: true, force: true });
    }
  }

  it('refuses a target inside, at, or above a protected directory', async () => {
    await withRoot(({ parent, root }) => {
      expect(() => assertDownloadTarget(root, 'file-reading.json')).toThrow(ValidationError);
      // At it: refused by the trust-root rule itself.
      expect(() => assertDownloadTarget(parent, 'data')).toThrow(ValidationError);
      expect(() => assertDownloadTarget(parent, 'DATA')).toThrow(ValidationError);
      expect(() => assertDownloadTarget(join(parent, '..'), basename(parent))).toThrow(/could write into/);
    });
  });

  it('treats an unknown name (a link) as anything directly in the folder', async () => {
    await withRoot(({ parent }) => {
      expect(() => assertDownloadTarget(parent, null)).toThrow(/subfolder/);
      expect(() => assertDownloadTarget(join(parent, 'dl'), null)).not.toThrow();
    });
  });

  it('allows a sibling target, including one sharing the prefix', async () => {
    await withRoot(({ parent }) => {
      expect(() => assertDownloadTarget(parent, 'Docs')).not.toThrow();
      expect(() => assertDownloadTarget(parent, 'data-notes')).not.toThrow();
    });
  });

  it('covers the session store the same way', () => {
    const home = homedir();
    expect(() => assertDownloadTarget(home, '.megaCmd')).toThrow(ValidationError);
    expect(() => assertDownloadTarget(join(home, '..'), basename(home))).toThrow(/could write into/);
    expect(() => assertDownloadTarget(home, 'Documents')).not.toThrow();
  });

  it('refuses a two-way sync root that contains a protected directory', async () => {
    await withRoot(({ parent }) => {
      expect(() => assertNoProtectedWithin(parent, 'sync')).toThrow(/written into it/);
      expect(() => assertNoProtectedWithin(join(parent, 'other'), 'sync')).not.toThrow();
    });
  });
});

/**
 * An argv array is not the argument boundary it looks like: the mega-* client
 * re-serializes it into one command string (quoting any element with whitespace,
 * without escaping quotes inside it) and the server re-tokenizes. Verified against
 * MEGAclient 2.5.2, a quote corrupts the command either way:
 *   SPLIT  ['find','--pattern=zzz" --type=d zzz','/'] -> --type=d applied LIVE
 *   ABSORB ['find','/nosuchzz"','--show-handles']     -> looked for `/nosuchzz" --show-handles`
 * `\"` is not unescaped and `""` splits too, so there is nothing to escape with.
 */
describe('argv re-tokenization guard', () => {
  const INJECT = 'zzz" --type=d zzz';

  // EVERY validator that feeds MEGAcmd argv, enumerated so a newly added one is a
  // visible omission here rather than a silent gap.
  it('rejects a quote on every free-text surface', () => {
    expect(() => assertFlagValue(INJECT, 'pattern')).toThrow(/double quote/i);
    expect(() => assertNoFlag(INJECT, 'attribute')).toThrow(/double quote/i);
    expect(() => assertRemotePath(`/${INJECT}`, 'remotePath')).toThrow(/double quote/i);
    expect(() => assertLocalPath(`${ROOT}tmp${sep}${INJECT}`, 'localPath')).toThrow(/double quote/i);
    expect(() => assertSecret(INJECT, 'password')).toThrow(/double quote/i);
  });

  it('rejects it whatever the whitespace is', () => {
    for (const ws of [' ', '\t', '\n']) {
      expect(() => assertFlagValue(`a"${ws}b`, 'pattern')).toThrow(/double quote/i);
    }
  });

  /**
   * No carve-out for a lone quote. It looked safe (nothing wraps an element with
   * no whitespace) but MEGAclient 2.5.2 shows the quote opens a region that
   * swallows the NEXT argv element, so a flag the caller passed silently vanishes.
   * The cost is nil: a quote-bearing name is not addressable through this client
   * either way, so refusing beats operating on the wrong node.
   */
  it('rejects a lone quote too - it absorbs the following argv element', () => {
    expect(() => assertRemotePath('/say"hi.jpg')).toThrow(/double quote/i);
    expect(() => assertNoFlag('say"hi', 'attribute')).toThrow(/double quote/i);
    expect(() => assertFlagValue('*.say"hi', 'pattern')).toThrow(/double quote/i);
  });

  it('still allows whitespace with no quote', () => {
    expect(assertRemotePath('/My Documents/report.pdf')).toBe('/My Documents/report.pdf');
    expect(assertFlagValue('-1d 2h', 'period')).toBe('-1d 2h');
  });
});

/**
 * `*` and `?` are expanded SERVER-SIDE by MEGAcmd, after the user has approved.
 * Verified read-only against MEGAclient 2.5.2: `du /Excel*` reports /Excel AND
 * /Excel2. So a one-line preview naming a single node could delete, publish or
 * share N of them, and the set is re-resolved after approval (the TOCTOU that
 * pcreGate's handle pinning exists to close).
 */
describe('native wildcard guard', () => {
  it('refuses * and ? wherever the preview names one node', () => {
    for (const v of ['/Excel*', '/*', '/test?', '/a/b*c/d']) {
      expect(() => assertNoWildcard(v, 'remotePath')).toThrow(/wildcard/i);
    }
  });

  it('points the caller at usePcre, which enumerates before confirming', () => {
    expect(() => assertNoWildcard('/*', 'remotePath')).toThrow(/usePcre/);
  });

  it('leaves ordinary paths alone', () => {
    for (const v of ['/Excel', '/a/b c/d.txt', '/naïve-이름.txt', '/a+b[c]{d}']) {
      expect(assertNoWildcard(v, 'remotePath')).toBe(v);
    }
  });
});

/**
 * assertConstraint used a regex that backtracked exponentially on a long digit run
 * followed by one invalid character. mega_find is annotated readOnlyHint, so most
 * clients auto-approve it — a single call could wedge the single-threaded server.
 * Measured before the fix: 22 digits 101 ms, 26 digits 184 ms, 30 digits 2926 ms.
 */
describe('assertConstraint is linear, not exponentially backtracking', () => {
  it('rejects a long digit run with a trailing invalid char, fast', () => {
    for (const n of [30, 60, 200, 2000]) {
      const started = Date.now();
      expect(() => assertConstraint('1'.repeat(n) + '!', 'size')).toThrow(ValidationError);
      expect(Date.now() - started).toBeLessThan(100);
    }
  });

  it('still accepts every documented form', () => {
    for (const v of ['-7d', '-100K', '+1m12d3h', '-3d+1h', '-4M+100K', '+5y', '7'])
      expect(assertConstraint(v, 'mtime')).toBe(v);
  });

  it('still rejects the same garbage as before', () => {
    for (const v of ['  ', '-7 d', '-7d; rm -rf /', 'abc', '+', '-7d+'])
      expect(() => assertConstraint(v, 'mtime')).toThrow(ValidationError);
  });
});

/**
 * The MEGAcmd program directory is a write target the guard did not cover. A
 * signature check protects the executable itself, but the Windows loader resolves
 * DLL imports from the executable's own directory first — so a download landing
 * there plants code inside the Authenticode-verified process, and %LOCALAPPDATA%\
 * MEGAcmd is unprivileged-writable on a stock install.
 */
describe('MEGAcmd program directory is not a write target', () => {
  const install = join(ROOT, 'Program Files', 'MEGAcmd');

  it('refuses the install dir and anything under it, once published', () => {
    publishMegacmdBinDir(null);
    expect(() => assertLocalPath(join(install, 'dbghelp.dll'))).not.toThrow();
    try {
      publishMegacmdBinDir(install);
      for (const p of [install, join(install, 'dbghelp.dll'), join(install, 'sub', 'x.dll')]) {
        expect(() => assertLocalPath(p)).toThrow(/program directory/i);
      }
      // A sibling that merely shares a prefix must NOT be caught.
      expect(() => assertLocalPath(join(ROOT, 'Program Files', 'MEGAcmd-notes', 'a.txt'))).not.toThrow();
    } finally {
      publishMegacmdBinDir(null);
    }
  });

  it('also refuses the extra roots the runtime publishes (cache, bundled, system)', () => {
    const cache = join(ROOT, 'cache', 'mega-cloud-mcp');
    try {
      publishMegacmdBinDir(null, [cache]);
      expect(() => assertLocalPath(join(cache, 'current', 'x.dll'))).toThrow(/program directory/i);
    } finally {
      publishMegacmdBinDir(null);
    }
  });
});

describe('preview control-character escaping', () => {
  it('escapes the characters that let a path author the preview text', () => {
    expect(previewSafe('/a\nThis will delete nothing')).toBe('/a\\nThis will delete nothing');
    expect(previewSafe('/a\r\t')).toBe('/a\\r\\t');
    expect(previewSafe('/a\x1b[2K')).toBe('/a\\e[2K');
    expect(previewSafe('/a\x07')).toBe('/a\\x07');
  });

  it('leaves ordinary text, including non-ASCII, untouched', () => {
    expect(previewSafe('/Photos/여행 2024/report.pdf')).toBe('/Photos/여행 2024/report.pdf');
  });
});

describe('legacy assertions retained', () => {
  it('quote-free whitespace still allowed', () => {
    expect(assertRemotePath('/My Documents/report.pdf')).toBe('/My Documents/report.pdf');
    expect(assertFlagValue('-1d 2h', 'period')).toBe('-1d 2h');
  });
});
