import { resolve, sep, dirname, basename, join, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { realpathSync, existsSync, readdirSync, lstatSync, statSync, type Dirent } from 'node:fs';

/** Thrown when a model-supplied path fails validation. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** "\" is a legal filename char on posix, so only win32 may read it as a separator. */
const isWin = process.platform === 'win32';
const SEG_SPLIT = isWin ? /[\\/]+/ : /\//;

/** Fold always: required on NTFS/APFS, and elsewhere it only over-blocks a dotdir
 *  named ".MEGACMD", which hitsSessionStore() refuses on every platform anyway.
 *  As APFS does: NFC and full case folding ("ß" is "ss": toUpperCase expands it). */
function fold(p: string): string {
  // Twice: "ẞ" lowers to "ß", which only the second pass expands to "ss".
  return p.normalize('NFC').toUpperCase().toLowerCase().toUpperCase().toLowerCase().normalize('NFC');
}

/** A file or folder NAME folded as fold() does, for name checks elsewhere. */
export function foldName(name: string): string {
  return fold(name);
}

/**
 * Fold one path SEGMENT to the name Win32 will actually open. Two normalizations
 * that resolve() does NOT perform, and that a lexical name check therefore misses:
 *
 *   - trailing dots and spaces are stripped by the Win32 path parser, so
 *     `.megaCmd.\session` opens `.megaCmd\session`;
 *   - `name:stream` (notably `.megaCmd::$INDEX_ALLOCATION`) names the same object
 *     as `name`.
 *
 * realpathBestEffort cannot cover either: Node/libuv prefixes `\\?\` internally,
 * which DISABLES the stripping, so fs reports ENOENT for a spelling MEGAcmd — a
 * plain Win32 consumer — opens fine. Verified on Windows 11: `existsSync` is false
 * for `<t>\.megaCmd.\session` while `cmd /c type` on it prints the session blob.
 *
 * Structural segments are returned untouched: "", ".", ".." carry no name, and a
 * drive designator ("C:") is not a stream.
 */
function normSegment(s: string): string {
  if (!isWin || s === '' || /^\.+$/.test(s) || /^[A-Za-z]:$/.test(s)) return s;
  const cut = s.indexOf(':');
  return (cut === -1 ? s : s.slice(0, cut)).replace(/[. ]+$/, '');
}

/** normSegment applied across a whole path, separators preserved verbatim (so a
 *  UNC prefix and the drive root survive). Identity on posix. */
function normWinPath(p: string): string {
  if (!isWin) return p;
  return p
    .split(/([\\/]+)/)
    .map((part, i) => (i % 2 === 0 ? normSegment(part) : part))
    .join('');
}

/** True when `child` IS `parent` or lives under it. */
function isAtOrUnder(child: string, parent: string): boolean {
  const c = fold(child);
  const p = fold(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** (dev, ino) of an existing path, else null. bigint: NTFS file ids exceed 2^53. */
function diskId(p: string): string | null {
  try {
    const st = statSync(p, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

/**
 * The on-disk identities of `p` (when it exists) and of every directory above it.
 *
 * Comparing path STRINGS cannot tell that two spellings name one directory when no
 * symlink is involved: on macOS /System/Volumes/Data/Users/<u> is /Users/<u> (a
 * firmlink), and realpath keeps whichever spelling it was given. Every containment
 * check below therefore also asks the filesystem: is the other directory's
 * identity in this chain?
 */
function diskChain(p: string): Set<string> {
  const ids = new Set<string>();
  let cur = resolve(p);
  for (;;) {
    const id = diskId(cur);
    if (id) ids.add(id);
    const parent = dirname(cur);
    if (parent === cur) return ids;
    cur = parent;
  }
}

/**
 * `child` is `parent` or under it, by on-disk identity. A missing `parent` is matched by its
 * nearest existing ancestor plus folded names below, so a firmlink spelling cannot evade it.
 */
function onDiskAtOrUnder(child: string, parent: string, chain: Set<string> = diskChain(child)): boolean {
  const id = diskId(parent);
  if (id !== null) return chain.has(id);
  const rest: string[] = [];
  let base = resolve(parent);
  for (;;) {
    const up = dirname(base);
    if (up === base) return false;
    rest.unshift(basename(base));
    base = up;
    const baseId = diskId(base);
    if (baseId === null) continue;
    if (!chain.has(baseId)) return false;
    const below: string[] = [];
    for (let c = resolve(child); ; ) {
      if (diskId(c) === baseId) return below.length >= rest.length && rest.every((r, i) => fold(r) === fold(below[i] as string));
      const cUp = dirname(c);
      if (cUp === c) return false;
      below.unshift(basename(c));
      c = cUp;
    }
  }
}

/** `child` is `parent` or under it, by any spelling (folded text, realpath, on disk). */
export function localAtOrUnder(child: string, parent: string): boolean {
  const parents = [parent, realpathBestEffort(parent)];
  return spellingsOf(resolve(child)).some((c) => parents.some((p) => isAtOrUnder(normWinPath(c), p)) || onDiskAtOrUnder(c, parent));
}

/**
 * macOS firmlink: /System/Volumes/Data/<path> is /<path>. Protected folders are known by the
 * short spelling, so use it when the nearest existing directory is the same on disk.
 */
function shortFirmlinkSpelling(abs: string): string {
  if (process.platform !== 'darwin') return abs;
  const m = abs.match(/^\/System\/Volumes\/Data(\/.+)$/i);
  if (!m) return abs;
  const short = m[1] as string;
  let a = abs;
  let b = short;
  while (!existsSync(a)) {
    const up = dirname(a);
    if (up === a || dirname(b) === b) return abs;
    a = up;
    b = dirname(b);
  }
  return sameOnDisk(a, b) ? short : abs;
}

function sameOnDisk(a: string, b: string): boolean {
  const id = diskId(a);
  return id !== null && id === diskId(b);
}

/**
 * MEGAcmd's resolved install dir, published by the runtime once it knows it.
 *
 * The REFUSAL path (assertLocalPath) is synchronous, so it cannot await the
 * resolution the advisory path passes in explicitly. Without this, on Windows —
 * where the store is executable-relative and $HOME/.megaCmd does not exist — the
 * segment-NAME rule was the single thing standing between a model-supplied path
 * and the master key. Now the prefix rule covers it too, so erasing the name is
 * not sufficient on its own. Best-effort and additive: unset simply means the
 * refusal falls back to exactly what it checked before.
 */
let publishedBinDir: string | null = null;
/**
 * Directories that hold the MEGAcmd binaries this process launches, plus the
 * places a MEGAcmd could be installed into. Writing anywhere inside one of them
 * is refused — see assertNotTrustRoot.
 */
let trustRoots: string[] = [];

/** Write-protected only (host config, this connector's code); uploading from them is allowed. */
let writeRootsOf: () => readonly string[] = () => [];

/** `writeOnly` may be a function: read on every check, so a project opened later counts. */
export function publishMegacmdBinDir(dir: string | null, roots: readonly string[] = [], writeOnly: readonly string[] | (() => readonly string[]) = []): void {
  publishedBinDir = dir;
  trustRoots = [...new Set([...(dir ? [dir] : []), ...roots].filter(Boolean).map((p) => resolve(appBundleOf(p))))];
  writeRootsOf = typeof writeOnly === 'function' ? writeOnly : () => writeOnly;
}

function currentWriteRoots(): string[] {
  return [...new Set(writeRootsOf().filter(Boolean).map((p) => resolve(p)))];
}

/** A bin dir in a macOS .app stands for the whole bundle: its programs load Contents/Frameworks. */
function appBundleOf(p: string): string {
  const m = p.match(/^(.*?\.app)(?:[\\/]|$)/i);
  return m ? (m[1] as string) : p;
}

/**
 * Every directory MEGAcmd may use as its session store, derived rather than
 * hardcoded to one absolute form. Mirrors its PlatformDirectories
 * (megacmdcommonutils.cpp):
 *   POSIX   configDirPath()      = $HOME/.megaCmd, else noHomeFallbackFolder()
 *   POSIX   noHomeFallbackFolder = /tmp/megacmd-<uid>   (no usable HOME)
 *   Windows configDirPath()      = <dir of the running exe>/.megaCmd
 * Recomputed per call: a few stats, against a process spawn.
 *
 * `binDir` is the resolved install dir. Callers that can await it pass it in;
 * otherwise the published value is used. Windows only, since on posix the store is
 * under $HOME wherever the binary lives.
 */
function homeIsDir(): boolean {
  try {
    const home = homedir();
    return home !== '' && statSync(home).isDirectory();
  } catch {
    return false;
  }
}

function sessionStoreRoots(binDir?: string | null): string[] {
  binDir ??= publishedBinDir;
  const roots = new Set<string>();
  // Each root is held by BOTH spellings: on macOS /tmp is a symlink to
  // /private/tmp, so knowing only one would let the same directory through.
  const add = (p: string) => {
    roots.add(p);
    roots.add(realpathBestEffort(p));
  };
  // MEGACMD_WORKING_FOLDER_SUFFIX renames the store to .megaCmd_<suffix>. MEGAcmd
  // inherits this process's environment, so when it is set here that is the store
  // actually in use; the plain name is kept too, since one may already exist.
  const suffix = process.env.MEGACMD_WORKING_FOLDER_SUFFIX?.trim();
  const names = ['.megaCmd', ...(suffix ? [`.megaCmd_${suffix}`] : [])];
  // No separate $HOME root: Node's homedir() reads HOME then getpwuid, exactly as
  // MEGAcmd's homeDirPath() does, so the two cannot disagree.
  for (const name of names) add(resolve(homedir(), name));
  // getuid() is undefined on win32 — the same platform with no /tmp fallback.
  // MEGAcmd uses /tmp/megacmd-<uid> only when HOME is unset or not a directory
  // (it is also its socket folder of last resort), so it is held when that is the
  // case or when it exists; otherwise /tmp stays an ordinary download folder.
  const uid = process.getuid?.();
  if (uid !== undefined) {
    const fallback = `/tmp/megacmd-${uid}`;
    if (!homeIsDir() || existsSync(fallback)) add(fallback);
  }
  // win32 only: on posix the store is under $HOME wherever the binary lives, so
  // deriving a root from the install dir would invent one that never exists.
  if (isWin && binDir) for (const name of names) add(resolve(binDir, name));
  return [...roots];
}

/**
 * True when `abs` IS, or lies inside, a MEGAcmd session store. Matched by
 * directory NAME first, which is what covers `<exeDir>\.megaCmd` on Windows
 * wherever resolveBinaries() found the binary — no absolute prefix can.
 *
 * Both rules run against the Win32-folded spelling (normWinPath), never the raw
 * one: on Windows the OS strips trailing dots/spaces and stream suffixes that
 * resolve() preserves, so the raw form is not the name that gets opened. Folding
 * can only ever match MORE paths, and the extra ones it matches are spellings no
 * plain Win32 consumer can reach as a distinct object — `\\?\` really can create
 * a directory literally named `.megaCmd.`, but nothing that does not itself use
 * `\\?\` (MEGAcmd included) can then open it, so over-blocking costs nothing.
 */
function hitsSessionStore(rawAbs: string): boolean {
  const abs = normWinPath(rawAbs);
  for (const segment of abs.split(SEG_SPLIT)) {
    if (isStoreName(segment)) return true;
    // macOS runtimeDirPath(): the command socket. No session material, but writing
    // there can hijack the channel to the running server. Name-only, since backing
    // up ~/Library/Caches carries away nothing but a socket.
    if (fold(segment) === 'megacmd.mac') return true;
  }
  const chain = diskChain(abs);
  return sessionStoreRoots().some((r) => isAtOrUnder(abs, r) || onDiskAtOrUnder(abs, r, chain));
}

/**
 * The local spellings MEGA may give a cloud name when it writes it to disk (SDK escapefsincompatible):
 * as is (APFS, ext), ":" escaped (HFS+), or every character Windows, exFAT and FAT reject as %xx
 * (exFAT/FAT also escape trailing dots). "." and ".." become %2e and %2e%2e everywhere.
 */
export function localSpellings(name: string): string[] {
  if (name === '.') return ['%2e'];
  if (name === '..') return ['%2e%2e'];
  const esc = (bad: (c: string) => boolean) => Array.from(name, (c) => (c.length === 1 && c.charCodeAt(0) < 0x80 && bad(c) ? `%${c.charCodeAt(0).toString(16).padStart(2, '0')}` : c)).join('');
  const strict = esc((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f || '\\/:?"<>|*'.includes(c));
  const dots = strict.replace(/\.+$/, (m) => '%2e'.repeat(m.length));
  return [...new Set([name, esc((c) => c === '/' || c === '\0'), esc((c) => c === '/' || c === ':' || c === '\0'), strict, dots])];
}

/** .megaCmd, the MEGACMD_WORKING_FOLDER_SUFFIX variant .megaCmd_<suffix>, and renamed copies. */
function isStoreName(name: string): boolean {
  // Also as uploaded ("%2emegaCmd" arrives as ".megaCmd"), and any name starting so: a copy kept
  // aside (".megaCmd (1)", ".megaCmd.bak", ".megaCmd.old", ".megaCmd~") may still hold a valid
  // session - the same rule (-dng:.megacmd*) every sync gets.
  return [name, cloudNameOf(name)].some((n) => fold(n).startsWith('.megacmd'));
}

/**
 * Resolve symlinks WITHOUT requiring the path to exist: realpath the longest
 * existing ancestor, then re-attach the missing tail. Download destinations are
 * routinely absent, and a lexical check would let `~/link/session` (link ->
 * ~/.megaCmd) through. `.native` also resolves Windows MSIX redirection.
 */
function realpathBestEffort(abs: string): string {
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(head).replace(/^\\\\\?\\/, '');
      return tail.length ? join(real, ...tail) : real;
    } catch {
      const parent = dirname(head);
      if (parent === head) return abs; // reached the root without resolving
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

/**
 * Every spelling of `abs` that could name the same object, for the guards to check.
 *
 * The two transforms must COMPOSE, not run in sequence on the raw input. Folding
 * alone loses an alias that only a filesystem lookup can unmask (an NTFS 8.3 short
 * name, a junction); realpath alone is blinded by a trailing dot, because Node
 * cannot open that spelling at all. Applied separately they leave a hole that the
 * combination walks straight through — verified against the live store:
 *   <install>\.megaCmd\session     REFUSED (both rules)
 *   <install>\MEGACM~1\session     REFUSED (realpath unmasks the 8.3 alias)
 *   <install>\.megaCmd.\session    REFUSED (fold strips the dot)
 *   <install>\MEGACM~1.\session    ALLOWED before this — and `cmd /c type` read it
 * realpath OF THE FOLDED form is what closes it: de-dotting first lets Node open
 * the path, and the alias then expands to a name the rules already catch.
 */
function spellingsOf(abs: string): string[] {
  const folded = normWinPath(abs);
  const real = realpathBestEffort(abs);
  const realOfFolded = realpathBestEffort(folded);
  // One more fold: an alias can itself expand to a name carrying a trailing dot.
  return [...new Set([abs, folded, real, realOfFolded, normWinPath(realOfFolded)])];
}

/**
 * Refuse paths that TARGET the session store, checking every spelling that could
 * name it. Denied by name/location rather than by an allowlist, since uploading
 * user-chosen files is the point of this connector.
 */
function assertNotConfigDir(abs: string): void {
  if (pathHitsSessionStore(abs)) {
    throw new ValidationError('Refusing to access the MEGAcmd configuration directory.');
  }
}

function pathHitsSessionStore(abs: string): boolean {
  return spellingsOf(abs).some(hitsSessionStore);
}

/**
 * Refuse a path inside a directory the connector LAUNCHES BINARIES FROM.
 *
 * The integrity gate Authenticode-verifies MEGAclient.exe and MEGAcmdServer.exe
 * before the first spawn, but a signature only covers the executable itself — the
 * Windows loader still resolves most DLL imports from the executable's own
 * directory first. So a model-supplied download destination pointing at that
 * directory turns mega_get into an arbitrary-write primitive INTO a trusted
 * process: drop `dbghelp.dll` next to a genuinely signed MEGAclient.exe and the
 * next spawn loads it, with the signature check still passing. The confirm
 * preview reads like an ordinary download ("… into C:\Users\<u>\AppData\Local\
 * MEGAcmd"), and that location is unprivileged-writable on a stock install.
 *
 * Deny-listed, not merely warned about: unlike the session store there is no
 * legitimate reason for a connector-driven transfer to land in the install dir,
 * so refusing costs nothing. Folded through the same spellingsOf() as the store
 * guard, or the Win32 aliases would walk around it just as they did there.
 */
function assertNotTrustRoot(abs: string): void {
  insideAny(abs, trustRoots, "Refusing to read or write inside the MEGAcmd program directory or this connector's data directory - a file placed there would be loaded by MEGAcmd or by the connector itself.");
}

/**
 * A .megaignore written into a synced folder could re-include the session store or a
 * protected folder. Applied where a write lands in a sync (or replaces a file).
 */
/** A name the file system opens as `.megaignore` (folded; on Windows also with trailing dots/spaces or a ":stream"). */
export function isIgnoreFileName(name: string): boolean {
  return [name, cloudNameOf(name)].some((n) => fold(normSegment(n)) === '.megaignore');
}

/** The recovery key file's name in each language of MEGA's web app (webclient lang key 20830). */
const RECOVERY_KEY_NAMES = [
  'MEGA-RECOVERYKEY', 'MEGA-RETTUNGSSCHLUESSEL', 'MEGA-CLÉdeRÉCUPÉRATION', 'MEGA-CLAVEDERECUPERACION', 'MEGA-CHAVEDERECUPERACAO',
  'MEGA-CHIAVEDIRECUPERO', 'MEGA-HERSTELSLEUTEL', 'MEGA-KLUCZODZYSKIWANIA', 'MEGA-CHEIEDERECUPERARE', 'MEGA-KUNCIPEMULIHAN',
  'MEGA-KURTARMA-ANAHTARI', 'CHIAKHOAPHUCHOI-MEGA', 'MEGA-КЛЮЧ-ВОССТАНОВЛЕНИЯ', 'MEGA-คีย์การกู้คืน', 'MEGA-回復キー',
  'MEGA-恢复密钥', 'MEGA-還原金鑰', 'مفتاح الاستعادة-MEGA',
].map((n) => n.normalize('NFC').toLowerCase());

/** A recovery key file by name (a browser may add " (1)" before .txt; versions too). */
export function isRecoveryKeyName(name: string): boolean {
  const n = name.replace(/#\d{10}$/, '').normalize('NFC').toLowerCase();
  return n.endsWith('.txt') && RECOVERY_KEY_NAMES.some((k) => n.startsWith(k));
}

/** The cloud name the SDK gives a local name (LocalPath::toName): NFC, `%xx` escapes decoded. */
export function cloudNameOf(local: string): string {
  // MEGA lists names NFC (a decoded letter may compose with a mark after it).
  return decodeLocalName(local).normalize('NFC');
}

/** The name the SDK uploads (and its sync rules compare): NFC first, then `%xx` decoded - not NFC again. */
export function decodeLocalName(local: string): string {
  const n = local.normalize('NFC');
  if (n === '%2e%2e') return '..';
  if (n === '%2e') return '.';
  return n.replace(/%([0-7][0-9a-f])/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

export function assertNotIgnoreFile(target: string): void {
  if (isIgnoreFileName(basename(target))) {
    throw new ValidationError(`Refusing to write ${target}: a .megaignore file decides what a MEGA sync carries.`);
  }
}

/** Refuse a local path INSIDE any protected folder (not "above" one). */
export function assertNotInsideProtected(abs: string): void {
  assertNotConfigDir(abs);
  assertNotTrustRoot(abs);
  assertNotWriteRoot(abs);
}

/** A WRITE into one of the write-only roots (host configuration, the connector's code). */
function assertNotWriteRoot(abs: string): void {
  insideAny(abs, currentWriteRoots(), 'Refusing to write into an app configuration folder or this connector\'s own folder - a file placed there would decide what runs at the next start.');
}

function insideAny(abs: string, roots: readonly string[], message: string): void {
  if (roots.length === 0) return;
  for (const candidate of spellingsOf(abs)) {
    for (const root of roots) {
      if (
        isAtOrUnder(normWinPath(candidate), root) ||
        isAtOrUnder(normWinPath(candidate), realpathBestEffort(root)) ||
        onDiskAtOrUnder(candidate, root)
      ) {
        throw new ValidationError(message);
      }
    }
  }
}

/**
 * Every protected directory — session store or trust root — that lies BELOW
 * `abs`: strictly below it, or (`inclusive`) at it as well.
 *
 * assertLocalPath only looks UP from a path. A transfer that creates or merges a
 * whole tree writes below its destination too, so a destination ABOVE a protected
 * directory reaches into it just the same — a cloud folder named like the data
 * directory, downloaded with merge into the data directory's parent, lands inside
 * it. Not filtered by existence, like every refusal path: a directory the transfer
 * itself creates is the case that matters.
 */
function protectedBelow(abs: string, inclusive: boolean): string[] {
  const forms = [...new Set([abs, resolve(abs)].flatMap(spellingsOf))].map(normWinPath);
  const roots = [...trustRoots, ...currentWriteRoots(), ...sessionStoreRoots()].flatMap((r) => [r, realpathBestEffort(r)]);
  const hits = new Set<string>();
  for (const root of roots) {
    for (const f of forms) {
      const below = isAtOrUnder(root, f) || onDiskAtOrUnder(root, f);
      const same = fold(root) === fold(f) || sameOnDisk(root, f);
      if (below && (inclusive || !same)) hits.add(root);
    }
  }
  return [...hits];
}

/**
 * Refuse a download whose result could land in a protected directory.
 *
 * `name` is the cloud node's name, so the download writes `<localDir>/<name>` and
 * (for a folder) everything below it. That target must not be inside a protected
 * directory, nor above one. When the name is not known before the download (a
 * public link), anything directly in `localDir` could be the target, so every
 * protected directory below `localDir` counts.
 */
export function assertDownloadTarget(localDir: string, name: string | null): void {
  if (name === null || name === '') return assertTargetBelow(localDir, null);
  // `name#<10 digits>` addresses a previous VERSION of `name`, and the download is
  // written under the plain name, so both spellings are checked.
  const version = name.match(/^(.+)#\d{10}$/);
  for (const n of version ? [name, version[1] as string] : [name]) assertTargetBelow(localDir, n);
}

/**
 * Symlinks below `abs` leading into or above a protected directory: MEGAcmd follows them when
 * merging a download into an existing folder. Bounded like storeCopiesIn.
 */
function protectedViaSymlinks(abs: string): string[] {
  const roots = [...trustRoots, ...currentWriteRoots(), ...sessionStoreRoots()].flatMap((r) => [r, realpathBestEffort(r)]);
  // By text and by disk: a firmlink spelling (/System/Volumes/Data/...) is the same folder.
  return linksBelow(abs)
    .filter(({ real }) => roots.some((r) => isAtOrUnder(real, r) || isAtOrUnder(r, real) || onDiskAtOrUnder(real, r) || onDiskAtOrUnder(r, real)))
    .map(({ link, real }) => `${link} -> ${real}`);
}

/** Every symlink below `abs` and where it leads, following links into folders (bounded like storeCopiesIn). */
export function linksBelow(abs: string): { link: string; real: string }[] {
  const out: { link: string; real: string }[] = [];
  const stack = [normWinPath(abs)];
  const seen = new Set<string>();
  let visited = 0;
  while (stack.length > 0 && ++visited <= STORE_WALK_MAX_DIRS) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const child = join(dir, e.name);
      if (e.isSymbolicLink()) {
        const real = realpathBestEffort(child);
        // A merge follows links inside the target too: walk it, once per folder so a loop ends.
        try {
          if (statSync(real).isDirectory() && !seen.has(real)) {
            seen.add(real);
            stack.push(real);
          }
        } catch {
          // Dangling: nothing is written through it.
        }
        out.push({ link: child, real });
      } else if (e.isDirectory()) {
        stack.push(child);
      }
    }
  }
  return out;
}

function assertTargetBelow(localDir: string, name: string | null): void {
  const target = name !== null ? join(localDir, name) : localDir;
  if (name !== null) {
    assertNotConfigDir(target);
    assertNotTrustRoot(target);
    // (Only through a link at the name: MEGAcmd does not write into "/" itself.)
    if (holdsDataVolume(target)) throw new ValidationError(`Refusing to download "${name}" into ${localDir}: ${target} holds the whole data volume (every home folder).`);
  }
  assertNotWriteRoot(target);
  const below = [...protectedBelow(target, name !== null), ...protectedViaSymlinks(target)];
  if (below.length > 0) {
    throw new ValidationError(
      `Refusing to download ${name !== null ? `"${name}" ` : ''}into ${localDir}: the download could write into a directory MEGAcmd or this connector depends on (${below.join(', ')}). Choose a different destination folder${name !== null ? '' : ', such as a subfolder'}.`,
    );
  }
}

/**
 * Refuse an upload source that MEGAcmd would expand as a glob AFTER approval.
 *
 * `put` runs glob(3) on any local path that does not exist and contains "*" or
 * "?", so the files it uploads are not the ones the preview named — and the
 * expansion never passes through assertLocalPath, so it could reach the session
 * store. A path that exists is taken literally, so a real file named "a?.txt" still
 * uploads.
 */
export function assertNoLocalGlob(lp: string, field = 'localPath'): string {
  if (/[*?]/.test(lp) && !existsSync(lp)) {
    throw new ValidationError(
      `${field} contains "*" or "?" and does not exist: MEGAcmd would expand it as a pattern after you approve, so the preview could not show what is uploaded. List the files explicitly.`,
    );
  }
  return lp;
}

/** Refuse a local folder that contains a protected directory (or a symlink to one). */
export function assertNoProtectedWithin(lp: string, what: string): void {
  assertNotWriteRoot(lp);
  const below = [...protectedBelow(lp, false), ...protectedViaSymlinks(lp)];
  if (below.length > 0) {
    throw new ValidationError(
      `Refusing to ${what} ${lp}: it contains a directory MEGAcmd or this connector depends on (${below.join(', ')}), and changes from the cloud would be written into it. Choose a folder that does not contain it.`,
    );
  }
}

/**
 * Store-named folders below `abs` (symlinks not followed): a backup or second install may hold
 * a live session. Stops after STORE_WALK_MAX_DIRS folders (`complete` false).
 */
const STORE_WALK_MAX_DIRS = 20_000;
export function storeCopiesIn(abs: string): { found: string[]; complete: boolean } {
  const found: string[] = [];
  const stack = [normWinPath(abs)];
  let visited = 0;
  let complete = true;
  while (stack.length > 0) {
    if (++visited > STORE_WALK_MAX_DIRS) return { found, complete: false };
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      // Gone since: nothing there. Unreadable (permissions): not searched, the rest still is.
      if (isUnreadable(e)) complete = false;
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = join(dir, e.name);
      if (isStoreName(e.name)) found.push(child);
      else stack.push(child);
    }
  }
  return { found, complete };
}

function isUnreadable(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM';
}

/** Files named .megaignore inside local `lps` (bounded like storeCopiesIn). */
export function ignoreFilesIn(lps: readonly string[]): { found: string[]; complete: boolean } {
  const found: string[] = [];
  let visited = 0;
  let complete = true;
  for (const lp of lps) {
    let isDir = false;
    try {
      isDir = statSync(lp).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const stack = [normWinPath(lp)];
    while (stack.length > 0) {
      if (++visited > STORE_WALK_MAX_DIRS) return { found, complete: false };
      const dir = stack.pop() as string;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        if (isUnreadable(e)) complete = false;
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory()) stack.push(join(dir, e.name));
        else if (isIgnoreFileName(e.name)) found.push(join(dir, e.name));
      }
    }
  }
  return { found, complete };
}

export function storeCopiesWithin(abs: string): string[] {
  return storeCopiesIn(abs).found;
}

/**
 * Every session store inside `abs` (all, not the first: on Windows the real one is
 * executable-relative). Missing roots are dropped; the refusal path does not drop them.
 */
export function sessionStoresWithin(abs: string, binDir?: string | null): string[] {
  // Canonicalize as thoroughly as the refusal path does. An advisory that a
  // non-canonical-but-ordinary spelling silently switches off is worse than none.
  const forms = [...new Set([abs, resolve(abs)].flatMap(spellingsOf))];
  // Keyed by realpath: sessionStoreRoots() deliberately holds two spellings of
  // every root (raw + realpath, so a symlinked /tmp cannot hide one), and both
  // match when the tree above them is itself symlinked — one store, listed twice.
  const hits = new Map<string, string>();
  for (const root of sessionStoreRoots(binDir)) {
    // The store ITSELF is refused upstream by assertLocalPath.
    if (forms.some((f) => fold(root) === fold(f) || sameOnDisk(root, f))) continue;
    if (forms.some((f) => isAtOrUnder(root, f) || onDiskAtOrUnder(root, f)) && existsSync(root)) {
      hits.set(fold(realpathBestEffort(root)), root);
    }
  }
  for (const copy of storeCopiesWithin(abs)) hits.set(fold(realpathBestEffort(copy)), copy);
  return [...hits.values()];
}

function rejectNul(p: string): void {
  if (p.includes(String.fromCharCode(0))) throw new ValidationError('Path contains a NUL byte.');
}

/**
 * Refuse a double quote in any value that reaches MEGAcmd's argv.
 *
 * An argv array is NOT the boundary it looks like here. The mega-* client
 * re-serializes argv into ONE command string for the server, wrapping any element
 * containing whitespace in double quotes WITHOUT escaping the quotes already
 * inside it; the server then re-tokenizes. A quote therefore always corrupts the
 * command, in one of two ways — both confirmed against MEGAclient 2.5.2:
 *
 *   SPLIT (quote + whitespace) — the element ends its own quoting early and the
 *   remainder becomes additional arguments, which MEGAcmd parses as FLAGS:
 *     ['find', '--pattern=zzz" --type=d zzz', '/']
 *       -> pattern is `zzz"`, `--type=d` is applied as a LIVE flag
 *
 *   ABSORB (quote alone) — the quote opens a region that swallows the NEXT
 *   element, so a flag the caller passed silently disappears:
 *     ['find', '/nosuchzz"', '--show-handles']
 *       -> server looked for `/nosuchzz" --show-handles`
 *
 * Either way the executed command stops matching the previewed one, which is the
 * property the whole confirm gate rests on. Rejected rather than escaped because
 * no escaping form exists: `\"` is not unescaped and `""` splits too (verified).
 *
 * No carve-out for a lone quote: ABSORB is exactly that case. The cost is nil —
 * a quote-bearing name is not addressable through this client anyway, so refusing
 * it replaces a silent operation on the WRONG node with a clear error.
 */
function rejectArgvQuote(v: string, field: string): void {
  if (v.includes('"')) {
    throw new ValidationError(
      `${field} must not contain a double quote - MEGAcmd cannot address such a value: it would re-parse the command and operate on a different target.`,
    );
  }
  // The server-side tokenizer also treats a SINGLE quote at the start of a word as
  // quoting and strips it, and the client only adds double quotes around values
  // that contain a space. So `'-a` reaches the parser as `-a`: a flag that no
  // leading-"-" check ever saw. Paths are absolute and cannot start with one.
  if (v.trimStart().startsWith("'")) {
    throw new ValidationError(
      `${field} must not start with a single quote - MEGAcmd would strip it and could read the rest as an option.`,
    );
  }
}

/** rejectArgvQuote for a value we must never echo back (a link password). */
export function assertSecret(v: string, field: string): string {
  rejectNul(v);
  rejectArgvQuote(v, field);
  return v;
}

/**
 * Validate a MEGA cloud path. Requiring a leading "/" both matches MEGA's
 * absolute-path model and guarantees the value cannot be parsed as a CLI flag
 * (it never starts with "-"), neutralizing flag-injection from model input.
 */
export function assertRemotePath(p: string, field = 'remotePath'): string {
  rejectNul(p);
  // MEGA finds a child by its NFC name (a Kelvin sign or NFD reaches "/Kids"): check that spelling.
  const t = p.trim().normalize('NFC');
  if (t === '') throw new ValidationError(`${field} is empty.`);
  if (!t.startsWith('/')) {
    throw new ValidationError(`${field} must be an absolute MEGA path starting with "/".`);
  }
  // MEGAcmd unescapes "\ " and "\\" when it resolves a remote path, so a backslash
  // makes the node it acts on differ from the path every check here looked at.
  if (t.includes('\\')) {
    throw new ValidationError(`${field} must not contain a backslash - MEGAcmd reads it as an escape, so it would resolve a different path.`);
  }
  // MEGAcmd resolves "." and "..", so it would act on another node than the preview names.
  if (t.split('/').some((seg) => seg === '.' || seg === '..')) {
    throw new ValidationError(`${field} must not contain "." or ".." segments - MEGAcmd resolves them, so it would act on a different path.`);
  }
  // An empty segment is read differently by mkdir (literal) and put/mv (falls back to the
  // parent), and MEGAcmd reads a leading "//Name" as "/Name".
  if (t.replace(/^\/\/(?:bin|in|from)(?=\/|$)/, '').includes('//')) {
    throw new ValidationError(`${field} must not contain an empty segment ("//").`);
  }
  rejectControls(t, field);
  rejectArgvQuote(t, field);
  return t;
}

/** A path written INTO: no `name#<10 digits>` segment either (put/mv/cp read it as a version). */
export function assertRemoteDest(p: string, field = 'remotePath'): string {
  return assertNoHandleName(assertNoVersionName(assertRemotePath(p, field), field), field);
}

/**
 * MEGAcmd reads "H:<8 characters>" as a node handle, and, when no node has it, as a
 * name: a pinned handle that vanished mid-run would then act on such a node instead.
 */
export function assertNoHandleName(p: string, field = 'remotePath'): string {
  if (p.split('/').some((seg) => /^H:[A-Za-z0-9_-]{8}$/.test(seg))) {
    throw new ValidationError(`${field} must not name an item "H:" and 8 characters - MEGAcmd reads that as a node handle.`);
  }
  return p;
}

/**
 * A source placed under its own name (get, cp, mv): MEGAcmd resolves `name#<10 digits>` as a
 * version (getNodesMatching), which lands under that version's name, not the one checked.
 */
export function assertNoVersionName(p: string, field = 'remotePath'): string {
  if (p.split('/').some((seg) => /#\d{10}$/.test(seg))) {
    throw new ValidationError(`${field} must not contain a name ending in "#" and 10 digits - MEGAcmd reads that as a file version, which keeps its own name.`);
  }
  return p;
}

/** Control characters in a path could forge preview lines; such names are left to usePcre. */
function rejectControls(p: string, field: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(p)) {
    throw new ValidationError(`${field} must not contain line breaks or other control characters.`);
  }
  if (/\p{Cs}/u.test(p)) throw new ValidationError(`${field} holds a broken Unicode character (a lone surrogate).`);
}

export function assertOptionalRemotePath(p: string | undefined, field = 'remotePath'): string | undefined {
  return p === undefined ? undefined : assertRemotePath(p, field);
}

/**
 * Validate a free-form positional argument (attribute name/value, contact email,
 * transfer tag, sync id, link, …). Rejects empty, NUL, and a leading "-" so a
 * model-supplied value can never be parsed as a CLI flag (flag-injection guard,
 * the same property assertRemotePath/assertLocalPath give paths). execFile
 * already prevents shell metacharacters; this closes the argv-flag gap.
 */
export function assertNoFlag(v: string, field: string): string {
  rejectNul(v);
  // Ids, tags, names and links never legitimately hold control characters, and
  // MEGAcmd drops or splits on several of them.
  if (/[\x00-\x1f\x7f]/.test(v)) throw new ValidationError(`${field} must not contain control characters.`);
  const t = v.trim();
  if (t === '') throw new ValidationError(`${field} is empty.`);
  if (t.startsWith('-')) throw new ValidationError(`${field} must not start with "-".`);
  // A leading "-" is not the only way into the flag parser: see rejectArgvQuote.
  rejectArgvQuote(t, field);
  return t;
}

/**
 * Validate a value embedded in a single `--flag=<v>` argv token, so unlike
 * assertNoFlag a leading "-" is harmless and allowed (globs like "-*.tmp", periods
 * like "-1d"). Rejects NUL and empty — the invariant every other free-text field
 * holds, and the one that keeps the confirmed value equal to the executed one (a
 * NUL truncates the C string at exec).
 *
 * Being one argv element is NOT on its own sufficient to contain the value: see
 * rejectArgvQuote, which is what actually holds the `--flag=<v>` token together.
 */
export function assertFlagValue(v: string, field: string): string {
  rejectNul(v);
  const t = v.trim();
  if (t === '') throw new ValidationError(`${field} is empty.`);
  rejectArgvQuote(t, field);
  return t;
}

/**
 * Validate a MEGAcmd time/size CONSTRAINT value, e.g. "-30d", "+1m12d3h",
 * "-3d+1h" (mtime) or "-100K", "-4M+100K" (size). Unlike assertNoFlag, a leading
 * "-" is ALLOWED and required for the common "within the last N" queries: the
 * value is always embedded in a single `--mtime=<v>` / `--size=<v>` argv token,
 * so a leading "-" can never be parsed as a separate flag (no injection surface).
 * We whitelist the constraint charset (signs, digits, single-letter units) so a
 * NUL / space / shell-metacharacter is still rejected.
 */
export function assertConstraint(v: string, field: string): string {
  rejectNul(v);
  const t = v.trim();
  if (t === '') throw new ValidationError(`${field} is empty.`);
  if (!isConstraintFormat(t)) {
    throw new ValidationError(
      `${field} has an invalid format. Use signed number+unit forms, e.g. "-30d", "+1m12d3h", "-3d+1h" (time) or "-100K", "-4M+100K" (size).`,
    );
  }
  return t;
}

/**
 * A LINEAR scan, deliberately not a regex.
 *
 * The previous `/^[+-]?\d+[A-Za-z]?([+-]?\d+[A-Za-z]?)*$/` backtracks
 * exponentially on a long run of digits followed by one invalid character: the
 * optional sign and optional unit make "1111…" splittable into groups in 2^n
 * ways, and every split has to be tried before the match can fail. Measured on
 * this machine: 22 digits 101 ms, 26 digits 184 ms, 30 digits 2926 ms. mega_find
 * is annotated readOnlyHint, so most clients auto-approve it — one call with a
 * 40-digit value would wedge the single-threaded server for the session.
 *
 * Grammar (unchanged): an optional leading sign, then one or more groups of
 * digits with an optional one-letter unit, each group optionally sign-separated.
 * The scan never revisits a character, so it is O(n) by construction.
 */
function isConstraintFormat(t: string): boolean {
  let i = 0;
  let groups = 0;
  if (t[i] === '+' || t[i] === '-') i++;
  while (i < t.length) {
    const digitsFrom = i;
    for (let d = t[i]; d !== undefined && d >= '0' && d <= '9'; d = t[++i]);
    if (i === digitsFrom) return false; // every group must start with digits
    const c = t[i];
    if (c !== undefined && ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'))) i++; // unit
    groups++;
    const s = t[i];
    if (s === '+' || s === '-') {
      // A separator must actually separate: a dangling sign ("-7d+") is invalid.
      const next = t[i + 1];
      if (next === undefined || next < '0' || next > '9') return false;
      i++;
    }
  }
  return groups > 0;
}

/**
 * Refuse a MEGAcmd native wildcard in a value the confirmation preview presents
 * as ONE node.
 *
 * `*` and `?` are expanded SERVER-SIDE, after approval, by MEGAcmd's shared path
 * resolver — verified read-only against MEGAclient 2.5.2: `du /Excel*` reports
 * both /Excel and /Excel2. So `mega_rm({remotePath:"/Excel*"})` previewed the
 * singular "This will PERMANENTLY delete /Excel* and all its contents." and then
 * deleted two trees; `"/*"` would take every top-level node behind that same one
 * line. The set is also re-resolved after approval, so anything created between
 * the two calls is swept in — exactly the TOCTOU that pcreGate's handle pinning
 * exists to close.
 *
 * Refused rather than expanded here because the supported way to act on many
 * nodes already exists and is safe: usePcre enumerates the matches, shows them in
 * the preview, and executes against pinned <H:...> handles.
 */
export function assertNoWildcard(v: string, field: string): string {
  if (/[*?]/.test(v)) {
    throw new ValidationError(
      `${field} must not contain a wildcard ("*" or "?"): MEGAcmd expands it AFTER you approve, so the preview could not show what would be affected. Use usePcre=true to act on many nodes - it lists the matches first and operates on those exact nodes.`,
    );
  }
  return v;
}

/**
 * Resolve a local filesystem path to an absolute path. Resolving guarantees the
 * argument never begins with "-" (so it cannot be parsed as a flag) and removes
 * ambiguity about the working directory.
 *
 * Resolving does NOT make it a safe argv element on its own — a local path is
 * passed as a bare positional token, so rejectArgvQuote applies here exactly as it
 * does to remote paths. Checked on the RESOLVED form, since that is what reaches
 * argv. (A quote is not a legal Windows filename character, but it is on posix,
 * and the value is model-supplied on every platform.)
 */
export function assertLocalPath(p: string, field = 'localPath'): string {
  rejectNul(p);
  const t = p.trim();
  if (t === '') throw new ValidationError(`${field} is empty.`);
  // Trim before resolve: leading whitespace would otherwise re-root an absolute
  // path under cwd (resolve('  /x') -> '<cwd>/  /x').
  const abs = shortFirmlinkSpelling(resolve(t));
  rejectControls(abs, field);
  rejectArgvQuote(abs, field);
  assertNotDataVolumeRoot(abs);
  assertNotConfigDir(abs);
  assertNotTrustRoot(abs);
  return abs;
}

/**
 * macOS's data volume root (and the folders above it) holds every home folder under another
 * spelling; /.vol, /.nofollow and /.resolve name any folder by other means. All refused.
 */
function assertNotDataVolumeRoot(abs: string): void {
  if (process.platform === 'win32') return;
  const spellings = spellingsOf(abs);
  // Paths that name another process's files (/dev/fd, /proc/self) or a folder by other means.
  if (spellings.some((s) => /^\/(?:dev|proc)(?:\/|$)/.test(s) || (process.platform === 'darwin' && /^\/\.(?:vol|nofollow|resolve)(?:\/|$)/i.test(s)))) {
    throw new ValidationError(`${abs} uses a special path form; use the folder's ordinary path.`);
  }
  if (holdsDataVolume(abs, spellings)) {
    throw new ValidationError(`${abs} holds the whole data volume (every home folder); choose a folder inside it, such as /Users/<name>/Documents.`);
  }
}

/** macOS: /System, /System/Volumes or /System/Volumes/Data, which hold every home folder under another spelling. */
function holdsDataVolume(abs: string, spellings: readonly string[] = spellingsOf(abs)): boolean {
  if (process.platform !== 'darwin') return false;
  const roots = ['/System', '/System/Volumes', '/System/Volumes/Data'];
  return spellings.some((s) => roots.some((r) => fold(r) === fold(s).replace(/(.)\/+$/, '$1') || sameOnDisk(r, s)));
}

/**
 * Refuse a sync or backup of a folder that contains a session store.
 *
 * Unlike mega_put, these keep uploading the whole tree for as long as they run,
 * and an exclusion added afterwards races the first scan — so the store cannot be
 * left out reliably. A two-way sync could also write into the live store.
 */
export function assertNoStoreWithin(lp: string, what: string, binDir?: string | null): string[] {
  const stores = sessionStoresWithin(lp, binDir);
  if (stores.length === 0) {
    // A note for the preview when the search for copies elsewhere stopped early.
    return storeCopiesIn(lp).complete
      ? []
      : [`(Could not search ${lp} completely - too many subfolders, or folders that cannot be read - for copies of a MEGAcmd session store (.megaCmd).)`];
  }
  throw new ValidationError(
    `Refusing to ${what} ${lp}: it contains the MEGAcmd session store (${stores.join(', ')}), which holds this ` +
      "account's MASTER KEY, and a periodic backup cannot leave it out (MEGA's scheduled copies have no exclusion " +
      'rules). Use mega_sync_add, which leaves it out, or mega_put, which uploads the folder without it.',
  );
}

/** A .megaignore rule a two-way sync gets, and what it is for (for the preview). */
export interface SyncExclusion {
  rule: string;
  label: string;
  /** The excluded path below the sync root, in cloud names ("" for a name rule). */
  rel: string;
}

/** A path as a POSIX extended regex matching only itself (`]` and `}` are literal there). */
function regexOfPath(p: string): string {
  return p.replace(/[\\.[()*+?{|^$]/g, '\\$&').replace(/[ \t\v\f]/g, '[$&]');
}

/**
 * Root .megaignore rules for a two-way sync of `lp` (SDK syncfilter.cpp): store folders by
 * name at any depth, each protected folder or store copy by path. Syncs skip symlinks.
 */
export function syncExclusions(lp: string, binDir?: string | null): SyncExclusion[] {
  assertNotWriteRoot(lp);
  const out: SyncExclusion[] = [];
  const stores = sessionStoresWithin(lp, binDir);
  // Always: a copy in a folder that could not be searched (permissions) is covered too.
  out.push({ rule: '-dng:.megacmd*', label: '.megaCmd folders at any depth (the MEGAcmd session store, and any copy of it)', rel: '' });
  const paths = new Map<string, SyncExclusion>();
  for (const target of [...stores, ...protectedBelow(lp, false)]) {
    const rel = relativeWithin(lp, target);
    if (rel === null) {
      throw new ValidationError(`Refusing to sync ${lp}: ${target} is inside it, but its path relative to ${lp} cannot be worked out to leave it out. Use the usual spelling of the folder.`);
    }
    if (!rel) continue;
    // Rules are matched against cloud names, so each part is written in that form.
    // (As the SDK compares rules: decoded, not normalized again - a non-NFC result is refused below.)
    const segs = rel.split('/').map((seg) => decodeLocalName(seg));
    // (A decoded name that is not NFC would not match the rule MEGA normalizes.)
    if (segs.some((seg) => /[\r\n/]/.test(seg) || seg === '.' || seg === '..' || seg !== seg.normalize('NFC'))) {
      throw new ValidationError(`Refusing to sync ${lp}: ${target} is inside it and its path cannot be written as an exclusion rule. Choose a folder that does not contain it.`);
    }
    // A store directly in lp is already covered by the name rule.
    if (segs.length === 1 && isStoreName(segs[0] as string)) continue;
    const cloudRel = segs.join('/');
    // Wildcard characters or outer spaces (the SDK trims a pattern): a regex rule matching only this path.
    const literal = segs.every((seg) => !/[*?[\]\\]/.test(seg) && seg === seg.trim());
    const rule = literal ? `-apg:${cloudRel}` : `-apr:${regexOfPath(cloudRel)}`;
    // Keyed by exact spelling: a configured and an on-disk spelling that differ by a non-ASCII
    // letter's case each get a rule (the SDK folds ASCII only).
    if (!paths.has(cloudRel)) paths.set(cloudRel, { rule, label: rel, rel: cloudRel });
  }
  out.push(...paths.values());
  return out;
}

/** How the file system spells `abs` (case included), resolving links; a missing tail kept as given. */
export function onDiskSpelling(abs: string): string {
  return realpathBestEffort(abs);
}

/** `target`'s path below `lp`, "/"-separated ("" for lp itself), or null if no spelling lines up. */
export function relativeWithin(lp: string, target: string): string | null {
  for (const base of spellingsOf(lp)) {
    for (const t of [target, ...spellingsOf(target)]) {
      const rel = relative(normWinPath(base), normWinPath(t));
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return rel.split(sep).join('/');
    }
  }
  // Spellings that differ as text (a macOS firmlink): find the target's ancestor that IS lp on disk.
  for (const t of [target, ...spellingsOf(target)]) {
    for (let a = t; dirname(a) !== a; a = dirname(a)) {
      if (sameOnDisk(lp, a)) return relative(a, t).split(sep).join('/');
    }
  }
  return null;
}

/** One `put` of a plan: `sources` go INTO the cloud folder `dest`. */
export interface UploadStep {
  dest: string;
  sources: string[];
}

export interface UploadPlan {
  /** In execution order: a folder's step precedes the steps of its subfolders. */
  steps: UploadStep[];
  /** Local paths left out because they are (or lead into) a session store. */
  excluded: string[];
  /** Sources too large to search completely for a copy of a store elsewhere. */
  unchecked: string[];
  /** Symlinks inside a rebuilt folder, left out as a whole-folder upload leaves them. */
  links: string[];
}

/** A cloud path below `parent`, joined as text: posix.join would turn "//bin/x" into "/bin/x". */
export function joinRemote(parent: string, name: string): string {
  if (!name) return parent;
  return `${parent.replace(/\/+$/, '')}/${name}`;
}

/**
 * Plan an upload of `lps` into the cloud folder `rp` that leaves every MEGAcmd
 * session store behind.
 *
 * MEGAcmd `put` has no exclude option, so a folder that contains a store is not
 * uploaded whole. Instead the walk goes down the path to the store only: at each
 * level, every sibling is uploaded whole into the matching cloud folder, and the
 * store itself is skipped. The cloud tree comes out as `put` would have built it,
 * minus the store. Folders that contain no store are uploaded whole, unchanged.
 *
 * A symlink is never descended into (a link back up the tree would loop); it is
 * left out when its target is, or contains, a store.
 *
 * `name` (a single item only) is the cloud name of the uploaded item instead of
 * its local one.
 */
export function planUpload(lps: string[], rp: string, binDir?: string | null, name?: string): UploadPlan {
  // The live stores and every store-named folder inside what is uploaded. statSync follows
  // links, as MEGAcmd uploads what a source path leads to.
  const isDir = (p: string) => {
    try {
      return statSync(normWinPath(p)).isDirectory();
    } catch {
      return false;
    }
  };
  const folders = lps.filter(isDir);
  const walks = folders.map((lp) => ({ lp, ...storeCopiesIn(lp) }));
  const stores = [...sessionStoreRoots(binDir).filter((r) => existsSync(r)), ...walks.flatMap((w) => w.found)].map((r) =>
    realpathBestEffort(r),
  );
  const containsStore = (p: string): boolean => {
    const real = realpathBestEffort(normWinPath(p));
    return stores.some((st) => !(fold(st) === fold(real) || sameOnDisk(st, p)) && (isAtOrUnder(st, real) || onDiskAtOrUnder(st, p)));
  };

  const direct: string[] = [];
  const steps: UploadStep[] = [];
  const excluded: string[] = [];
  const links: string[] = [];

  const split = (dir: string, remoteParent: string, as?: string): void => {
    const listed = realpathBestEffort(normWinPath(dir));
    // The name MEGA gives a whole-folder upload (`%xx` decoded, NFC), so a rebuilt tree lands where the preview says.
    const step: UploadStep = { dest: joinRemote(remoteParent, as ?? cloudNameOf(basename(normWinPath(dir)))), sources: [] };
    steps.push(step);
    let names: string[];
    try {
      names = readdirSync(listed).sort();
    } catch {
      throw new ValidationError(`Could not list ${dir} to leave the MEGAcmd session store out of the upload.`);
    }
    for (const name of names) {
      const child = join(listed, name);
      let isLink = false;
      try {
        isLink = lstatSync(child).isSymbolicLink();
      } catch {
        // Vanished since the listing: nothing to upload.
        continue;
      }
      if (isStoreName(name) || pathHitsSessionStore(child) || (isLink && containsStore(child))) {
        excluded.push(child);
        continue;
      }
      // Left out, as a whole-folder upload leaves it: as a source of its own MEGAcmd would follow
      // it into what the store search did not look at.
      if (isLink) {
        links.push(child);
        continue;
      }
      // Either way the name reaches argv: as a source, or as part of a cloud folder.
      rejectArgvQuote(child, `"${name}" inside ${dir}`);
      // (Below "/", the data volume holds the store under another spelling: rebuilt down to it.)
      if (containsStore(child) || holdsDataVolume(child)) split(child, step.dest);
      else step.sources.push(child);
    }
  };

  const folderSet = new Set(folders);
  for (const lp of lps) {
    if (folderSet.has(lp) && (sessionStoresWithin(lp, binDir).length > 0 || containsStore(lp))) split(lp, rp, name);
    else direct.push(lp);
  }
  if (direct.length > 0) steps.unshift({ dest: rp, sources: direct });
  // A rebuilt folder's cloud path comes from LOCAL names (decoded: "%2e%2e" is ".."), and MEGAcmd
  // unescapes a backslash and reads `name#<10 digits>` as a file version when it resolves the
  // destination - so it must be a plain path below rp, or it could land somewhere else.
  for (const step of steps) {
    if (step.dest === rp) continue;
    let plain = !step.dest.includes('\\') && !/#\d{10}(\/|$)/.test(step.dest) && (rp === '/' ? step.dest.startsWith('/') : step.dest.startsWith(`${rp.replace(/\/+$/, '')}/`));
    try {
      plain &&= assertRemotePath(step.dest) === step.dest;
    } catch {
      plain = false;
    }
    if (!plain) {
      throw new ValidationError(
        `Cannot upload around the session store here: the folder name in ${step.dest} would be read differently by MEGAcmd. Upload the subfolders individually instead.`,
      );
    }
  }
  return { steps, excluded, links, unchecked: walks.filter((w) => !w.complete).map((w) => w.lp) };
}

/**
 * Can the MEGAcmd glob `segment` ("*" = any run, "?" = one character) match a
 * session-store name — `.megaCmd` itself or a `.megaCmd_<suffix>`? Case-folded,
 * like the local guard.
 *
 * For the suffix variant only a DOT-FREE suffix is considered. Any suffix at all
 * would make every pattern that starts with "*" match (`*.txt` matches
 * `.megaCmd_x.txt`), refusing ordinary requests to guard a name that needs an
 * unusual MEGACMD_WORKING_FOLDER_SUFFIX to exist at all.
 */
export function globCanMatchStoreName(segment: string): boolean {
  // A run of "*" matches what one does: collapsed, the work stays linear.
  const g = fold(segment).replace(/\*+/g, '*');
  // Positions in `g` reachable so far; a "*" may also match nothing.
  const close = (states: Set<number>): Set<number> => {
    const out = new Set(states);
    for (const i of states) for (let j = i; g[j] === '*'; j++) out.add(j + 1);
    return out;
  };
  const step = (states: Set<number>, ch: string): Set<number> => {
    const next = new Set<number>();
    for (const i of states) {
      if (g[i] === '*') next.add(i);
      else if (g[i] === '?' || g[i] === ch) next.add(i + 1);
    }
    return close(next);
  };
  let states = close(new Set([0]));
  for (const ch of '.megacmd') states = step(states, ch);
  if (states.has(g.length)) return true;
  // "*" and "?" can always stand for dot-free characters, so only a literal dot in
  // what remains after `.megacmd_` rules out a dot-free suffix.
  return [...step(states, '_')].some((i) => !g.slice(i).includes('.'));
}

/**
 * Refuse a CLOUD path that names a copy of the session store.
 *
 * The local guard cannot see a store that was uploaded earlier (by an old version
 * of this connector, the MEGA desktop app, or anything else): in the cloud it is
 * just a folder called `.megaCmd`. Reading, copying, moving, sharing or publishing
 * it would hand the account master key on all the same, so any segment with that
 * name is refused — and so is a wildcard segment that MEGAcmd could expand to it.
 */
export function assertNotStoreCopy(p: string, field = 'remotePath'): string {
  const why = storeCopyIn(p);
  if (why === 'name') {
    throw new ValidationError(
      `${field} is inside a copy of the MEGAcmd session store (.megaCmd), which holds this account's MASTER KEY. No tool reads, copies, moves, shares or publishes it.`,
    );
  }
  if (why === 'wildcard') {
    throw new ValidationError(
      `${field} contains a wildcard that could match a copy of the MEGAcmd session store (.megaCmd), which holds this account's MASTER KEY. Use a more specific pattern or the exact path.`,
    );
  }
  return p;
}

/**
 * Does `p` pass through a session-store copy: by name, or through a wildcard that
 * could expand to one? Segments are split on both separators (a local Windows path
 * reaches MEGAcmd too), and an incoming-share root `<email>:<name>` is judged by
 * its `<name>`, which is what it is downloaded and resolved as.
 */
export function storeCopyIn(p: string): 'name' | 'wildcard' | null {
  const names = p.split(/[\\/]/).flatMap((segment) => (segment.includes(':') ? [segment, segment.slice(segment.indexOf(':') + 1)] : [segment]));
  // A real store name anywhere wins over a glob-like segment met earlier: a folder
  // literally named "*" must not hide the `.megaCmd` below it.
  if (names.some((name) => isStoreName(name))) return 'name';
  if (names.some((name) => /[*?]/.test(name) && globCanMatchStoreName(name))) return 'wildcard';
  return null;
}
