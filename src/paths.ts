import { resolve, sep, dirname, basename, join } from 'node:path';
import { homedir } from 'node:os';
import { realpathSync, existsSync, readdirSync, lstatSync, statSync } from 'node:fs';

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
 *  named ".MEGACMD", which hitsSessionStore() refuses on every platform anyway. */
function fold(p: string): string {
  return p.toLowerCase();
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

/** `child` IS `parent` or lies under it, by on-disk identity (needs `parent` to exist). */
function onDiskAtOrUnder(child: string, parent: string, chain: Set<string> = diskChain(child)): boolean {
  const id = diskId(parent);
  return id !== null && chain.has(id);
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

export function publishMegacmdBinDir(dir: string | null, roots: readonly string[] = []): void {
  publishedBinDir = dir;
  trustRoots = [...new Set([...(dir ? [dir] : []), ...roots].filter(Boolean).map((p) => resolve(p)))];
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
  const uid = process.getuid?.();
  if (uid !== undefined) add(`/tmp/megacmd-${uid}`);
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

/** .megaCmd, plus the MEGACMD_WORKING_FOLDER_SUFFIX variant .megaCmd_<suffix>. */
function isStoreName(name: string): boolean {
  const s = fold(name);
  return s === '.megacmd' || s.startsWith('.megacmd_');
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
  if (trustRoots.length === 0) return;
  for (const candidate of spellingsOf(abs)) {
    for (const root of trustRoots) {
      if (
        isAtOrUnder(normWinPath(candidate), root) ||
        isAtOrUnder(normWinPath(candidate), realpathBestEffort(root)) ||
        onDiskAtOrUnder(candidate, root)
      ) {
        throw new ValidationError(
          "Refusing to read or write inside the MEGAcmd program directory or this connector's data directory - a file placed there would be loaded by MEGAcmd or by the connector itself.",
        );
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
  const roots = [...trustRoots, ...sessionStoreRoots()].flatMap((r) => [r, realpathBestEffort(r)]);
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

function assertTargetBelow(localDir: string, name: string | null): void {
  const target = name !== null ? join(localDir, name) : localDir;
  if (name !== null) {
    assertNotConfigDir(target);
    assertNotTrustRoot(target);
  }
  const below = protectedBelow(target, name !== null);
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

/**
 * Refuse a TWO-WAY sync of a folder that contains a protected directory: cloud
 * changes are written back into the local tree, below the sync root.
 */
export function assertNoProtectedWithin(lp: string, what: string): void {
  const below = protectedBelow(lp, false);
  if (below.length > 0) {
    throw new ValidationError(
      `Refusing to ${what} ${lp}: it contains a directory MEGAcmd or this connector depends on (${below.join(', ')}), and changes from the cloud would be written into it. Choose a folder that does not contain it.`,
    );
  }
}

/**
 * EVERY session store contained INSIDE `abs` — for tools that read a path
 * recursively (upload / sync / backup). Backing up `$HOME` is legitimate, so this
 * does not refuse by itself: mega_put uploads such a folder WITHOUT the store
 * (planUpload), and sync/backup, which cannot leave it out, refuse it
 * (assertNoStoreWithin). Warning and allowing was not enough: once uploaded, the
 * copy is an ordinary cloud file that mega_cat could read back into the model.
 *
 * All of them, not the first: sessionStoreRoots() lists $HOME/.megaCmd first and
 * unconditionally, but on Windows the real store is executable-relative
 * (%LOCALAPPDATA%\MEGAcmd\.megaCmd on a stock install) and $HOME/.megaCmd does not
 * exist at all — so returning the first match named a directory holding nothing
 * while staying silent about the one holding the master key.
 *
 * Roots that do not exist are dropped: the concern is material this read would
 * actually carry away, and an absent directory carries none. The REFUSAL
 * path deliberately does not filter that way — a download destination inside a
 * not-yet-created store must still be refused.
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
  const t = p.trim();
  if (t === '') throw new ValidationError(`${field} is empty.`);
  if (!t.startsWith('/')) {
    throw new ValidationError(`${field} must be an absolute MEGA path starting with "/".`);
  }
  // MEGAcmd unescapes "\ " and "\\" when it resolves a remote path, so a backslash
  // makes the node it acts on differ from the path every check here looked at.
  if (t.includes('\\')) {
    throw new ValidationError(`${field} must not contain a backslash - MEGAcmd reads it as an escape, so it would resolve a different path.`);
  }
  rejectArgvQuote(t, field);
  return t;
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
  const abs = resolve(t);
  rejectArgvQuote(abs, field);
  assertNotConfigDir(abs);
  assertNotTrustRoot(abs);
  return abs;
}

/**
 * Refuse a sync or backup of a folder that contains a session store.
 *
 * Unlike mega_put, these keep uploading the whole tree for as long as they run,
 * and an exclusion added afterwards races the first scan — so the store cannot be
 * left out reliably. A two-way sync could also write into the live store.
 */
export function assertNoStoreWithin(lp: string, what: string, binDir?: string | null): void {
  const stores = sessionStoresWithin(lp, binDir);
  if (stores.length === 0) return;
  throw new ValidationError(
    `Refusing to ${what} ${lp}: it contains the MEGAcmd session store (${stores.join(', ')}), which holds this ` +
      "account's MASTER KEY, and a continuous sync/backup cannot reliably leave it out. Choose a folder that does " +
      'not contain it, or use mega_put, which uploads a folder without the session store.',
  );
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
}

function joinRemote(parent: string, name: string): string {
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
 */
export function planUpload(lps: string[], rp: string, binDir?: string | null): UploadPlan {
  const stores = sessionStoreRoots(binDir)
    .filter((r) => existsSync(r))
    .map((r) => realpathBestEffort(r));
  const containsStore = (p: string): boolean => {
    const real = realpathBestEffort(normWinPath(p));
    return stores.some((st) => !(fold(st) === fold(real) || sameOnDisk(st, p)) && (isAtOrUnder(st, real) || onDiskAtOrUnder(st, p)));
  };

  const direct: string[] = [];
  const steps: UploadStep[] = [];
  const excluded: string[] = [];

  const split = (dir: string, remoteParent: string): void => {
    const listed = realpathBestEffort(normWinPath(dir));
    const step: UploadStep = { dest: joinRemote(remoteParent, basename(normWinPath(dir))), sources: [] };
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
      // Either way the name reaches argv: as a source, or as part of a cloud folder.
      rejectArgvQuote(child, `"${name}" inside ${dir}`);
      if (!isLink && containsStore(child)) split(child, step.dest);
      else step.sources.push(child);
    }
  };

  for (const lp of lps) {
    if (sessionStoresWithin(lp, binDir).length > 0 || containsStore(lp)) split(lp, rp);
    else direct.push(lp);
  }
  if (direct.length > 0) steps.unshift({ dest: rp, sources: direct });
  // A rebuilt folder's cloud path comes from LOCAL names, and MEGAcmd unescapes a
  // backslash and reads `name#<10 digits>` as a file version when it resolves the
  // destination - so it could land somewhere other than the folder mkdir made.
  for (const step of steps) {
    if (step.dest !== rp && (step.dest.includes('\\') || /#\d{10}(\/|$)/.test(step.dest))) {
      throw new ValidationError(
        `Cannot upload around the session store here: the folder name in ${step.dest} would be read differently by MEGAcmd. Upload the subfolders individually instead.`,
      );
    }
  }
  return { steps, excluded };
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
function globCanMatchStoreName(segment: string): boolean {
  const g = fold(segment);
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
 * Refuse listing INCOMING shares by pattern while contact details are not exposed.
 *
 * MEGAcmd matches a path that starts with "//f" plus a wildcard (or a PCRE) against
 * `//from/<sharer-email>:<folder>`, so such a listing enumerates the email address
 * of everyone who shared a folder with the user - the same data mega_share list
 * and mega_mount only reveal after a confirmation. A specific in-share path is
 * fine: it names an address the caller already has.
 */
export function assertNoInshareEnumeration(path: string | undefined, pattern: boolean, exposeContacts: boolean): void {
  if (exposeContacts || !path) return;
  // Any "//" root other than the rubbish bin and inbox may be resolved against
  // //from/<email>:<folder>, and MEGAcmd skips leading blanks and control bytes,
  // so neither may be used to step around the check.
  const p = path.replace(/^[\x00-\x20]+/, '');
  if (!p.startsWith('//') || p.startsWith('//bin/') || p.startsWith('//in/')) return;
  if (pattern || /[*?]/.test(p)) {
    throw new ValidationError(
      'Listing incoming shares by pattern reveals the email addresses of the people who shared them. Use mega_mount (it asks first), or turn on the "Expose contact tools" setting.',
    );
  }
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
