import { resolve, sep, dirname, basename, join } from 'node:path';
import { homedir } from 'node:os';
import { realpathSync, existsSync } from 'node:fs';

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
  // No separate $HOME root: Node's homedir() reads HOME then getpwuid, exactly as
  // MEGAcmd's homeDirPath() does, so the two cannot disagree.
  add(resolve(homedir(), '.megaCmd'));
  // getuid() is undefined on win32 — the same platform with no /tmp fallback.
  const uid = process.getuid?.();
  if (uid !== undefined) add(`/tmp/megacmd-${uid}`);
  // win32 only: on posix the store is under $HOME wherever the binary lives, so
  // deriving a root from the install dir would invent one that never exists.
  if (isWin && binDir) add(resolve(binDir, '.megaCmd'));
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
    const s = segment.toLowerCase();
    // .megaCmd, plus the MEGACMD_WORKING_FOLDER_SUFFIX variant .megaCmd_<suffix>.
    if (s === '.megacmd' || s.startsWith('.megacmd_')) return true;
    // macOS runtimeDirPath(): the command socket. No session material, but writing
    // there can hijack the channel to the running server. Name-only, since backing
    // up ~/Library/Caches carries away nothing but a socket.
    if (s === 'megacmd.mac') return true;
  }
  return sessionStoreRoots().some((r) => isAtOrUnder(abs, r));
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
  for (const candidate of spellingsOf(abs)) {
    if (hitsSessionStore(candidate)) {
      throw new ValidationError('Refusing to access the MEGAcmd configuration directory.');
    }
  }
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
      if (isAtOrUnder(normWinPath(candidate), root) || isAtOrUnder(normWinPath(candidate), realpathBestEffort(root))) {
        throw new ValidationError(
          'Refusing to read or write inside the MEGAcmd program directory - a file placed there would be loaded by the MEGAcmd process itself.',
        );
      }
    }
  }
}

/**
 * EVERY session store contained INSIDE `abs` — for tools that read a path
 * recursively (upload / sync / backup). Warns rather than refuses: backing up
 * `$HOME` is legitimate, and MEGA encrypts uploads under this same account's master
 * key, so the copy only becomes a disclosure once that folder is exported or shared.
 * That is the user's call, so it feeds the confirmation preview.
 *
 * All of them, not the first: sessionStoreRoots() lists $HOME/.megaCmd first and
 * unconditionally, but on Windows the real store is executable-relative
 * (%LOCALAPPDATA%\MEGAcmd\.megaCmd on a stock install) and $HOME/.megaCmd does not
 * exist at all — so returning the first match named a directory holding nothing
 * while staying silent about the one holding the master key.
 *
 * Roots that do not exist are dropped: the warning is about material this read
 * would actually carry away, and an absent directory carries none. The REFUSAL
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
    // The store ITSELF is refused upstream, never warned about.
    if (forms.some((f) => fold(root) === fold(f))) continue;
    if (forms.some((f) => isAtOrUnder(root, f)) && existsSync(root)) {
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

/** Preview text for a recursive read that carries the session store along, else ''. */
export function sessionStoreWarning(
  paths: string[],
  opts: { twoWay?: boolean; binDir?: string | null } = {},
): string {
  const { twoWay = false, binDir } = opts;
  // Arrow, not a bare reference: Array.map would pass the index as `binDir`.
  const found = paths.flatMap((p) => sessionStoresWithin(p, binDir));
  const stores = [...new Set(found)];
  if (stores.length === 0) return '';
  const names = stores.map((s) => basename(s)).join('","');
  const lines = [
    `WARNING: this includes the MEGAcmd session store (${stores.join(', ')}), which holds this`,
    "account's MASTER KEY - it cannot be rotated, and changing your password does not replace it.",
    'Anyone you later share or export this folder to could read it.',
  ];
  if (twoWay) lines.push('A two-way sync can also WRITE into the live store and break your login.');
  lines.push(`Exclude it first: mega_sync_ignore(action="add-exclusion", filters=["${names}"]).`);
  return `\n\n${lines.join('\n')}`;
}
