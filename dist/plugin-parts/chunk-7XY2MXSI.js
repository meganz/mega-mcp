import {
  __export
} from "./chunk-WQ2VWL36.js";

// src/tools/helpers.ts
var helpers_exports = {};
__export(helpers_exports, {
  PLAN_MAX: () => PLAN_MAX,
  assertNoFoldTwinBelow: () => assertNoFoldTwinBelow,
  assertNoNestedIgnoreFile: () => assertNoNestedIgnoreFile,
  assertNoNestedLocalIgnoreFile: () => assertNoNestedLocalIgnoreFile,
  assertNoPendingIgnoreUpload: () => assertNoPendingIgnoreUpload,
  assertNoStoreCopyBelow: () => assertNoStoreCopyBelow,
  assertNoStoreCopyBelowMany: () => assertNoStoreCopyBelowMany,
  assertNoWritersReach: () => assertNoWritersReach,
  assertSyncedLanding: () => assertSyncedLanding,
  backupFolderLines: () => backupFolderLines,
  backupFoldersWithinLines: () => backupFoldersWithinLines,
  backupLocalRoots: () => backupLocalRoots,
  backupNamesOf: () => backupNamesOf,
  backupRotationLines: () => backupRotationLines,
  backupRotationLinesAt: () => backupRotationLinesAt,
  carryUnconfirmedWrites: () => carryUnconfirmedWrites,
  checkConfirm: () => checkConfirm,
  childNames: () => childNames,
  chunkArgs: () => chunkArgs,
  contentDigest: () => contentDigest,
  contentDigestMany: () => contentDigestMany,
  destinationNotes: () => destinationNotes,
  downloadedIntoLines: () => downloadedIntoLines,
  ensureRemoteFolder: () => ensureRemoteFolder,
  executableDownloadNote: () => executableDownloadNote,
  folderStillAt: () => folderStillAt,
  guardRun: () => guardRun,
  ignoreFilesBelow: () => ignoreFilesBelow,
  inSyncedLocalFolder: () => inSyncedLocalFolder,
  landingsOf: () => landingsOf,
  listedLines: () => listedLines,
  localMirrorOf: () => localMirrorOf,
  localNamesOf: () => localNamesOf,
  movedIntoSyncedLines: () => movedIntoSyncedLines,
  noteDownload: () => noteDownload,
  noteDownloadIgnores: () => noteDownloadIgnores,
  noteKeyCopy: () => noteKeyCopy,
  noteSessionChange: () => noteSessionChange,
  noteUnconfirmedWrite: () => noteUnconfirmedWrite,
  noteUploadIgnores: () => noteUploadIgnores,
  ownExportLink: () => ownExportLink,
  pcreGate: () => pcreGate,
  pcreMatchPreview: () => pcreMatchPreview,
  previewSafe: () => previewSafe,
  recoveryKeyLines: () => recoveryKeyLines,
  recoveryKeyLinesBelow: () => recoveryKeyLinesBelow,
  remoteKind: () => remoteKind,
  rootIgnoreFile: () => rootIgnoreFile,
  runBulk: () => runBulk,
  runPerHandle: () => runPerHandle,
  runToResult: () => runToResult,
  sameNamed: () => sameNamed,
  sameNamedMany: () => sameNamedMany,
  secretBinding: () => secretBinding,
  sharedBelowNotes: () => sharedBelowNotes,
  syncById: () => syncById,
  syncFollowLines: () => syncFollowLines,
  syncLocalRoots: () => syncLocalRoots,
  syncRootsBelowCloud: () => syncRootsBelowCloud,
  syncSnapshot: () => syncSnapshot,
  syncedLocalLines: () => syncedLocalLines,
  syncedSourceNotes: () => syncedSourceNotes,
  syncedWithinLines: () => syncedWithinLines,
  unconfirmedWriteLines: () => unconfirmedWriteLines,
  unconfirmedWritesIn: () => unconfirmedWritesIn,
  withWriteLock: () => withWriteLock,
  writableShareLines: () => writableShareLines
});
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readdirSync as readdirSync2, existsSync as existsSync2 } from "node:fs";
import { posix, join as joinLocal, dirname as dirnameLocal, basename as basenameLocal, sep as sepLocal, relative as relative2 } from "node:path";

// src/mcpResult.ts
function build(text, structured, isError) {
  const result = { content: [{ type: "text", text }] };
  if (structured) {
    result.structuredContent = { message: text, ...structured };
  }
  if (isError) result.isError = true;
  return result;
}
function ok(text, structured) {
  return build(text, structured, false);
}
function err(text, structured) {
  return build(text, structured, true);
}

// src/paths.ts
import { resolve, sep, dirname, basename, join, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { realpathSync, existsSync, readdirSync, lstatSync, statSync } from "node:fs";
var ValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
};
var isWin = process.platform === "win32";
var SEG_SPLIT = isWin ? /[\\/]+/ : /\//;
function fold(p) {
  return p.normalize("NFC").toUpperCase().toLowerCase().toUpperCase().toLowerCase().normalize("NFC");
}
function foldName(name) {
  return fold(name);
}
function normSegment(s) {
  if (!isWin || s === "" || /^\.+$/.test(s) || /^[A-Za-z]:$/.test(s)) return s;
  const cut = s.indexOf(":");
  return (cut === -1 ? s : s.slice(0, cut)).replace(/[. ]+$/, "");
}
function normWinPath(p) {
  if (!isWin) return p;
  return p.split(/([\\/]+)/).map((part, i) => i % 2 === 0 ? normSegment(part) : part).join("");
}
function isAtOrUnder(child, parent) {
  const c = fold(child);
  const p = fold(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}
var newSeen = () => ({ ids: /* @__PURE__ */ new Map(), reals: /* @__PURE__ */ new Map() });
function diskId(p, seen) {
  const known = seen?.ids.get(p);
  if (known !== void 0) return known;
  let id;
  try {
    const st = statSync(p, { bigint: true });
    id = `${st.dev}:${st.ino}`;
  } catch {
    id = null;
  }
  seen?.ids.set(p, id);
  return id;
}
function diskChain(p, seen) {
  const ids = /* @__PURE__ */ new Set();
  let cur = resolve(p);
  for (; ; ) {
    const id = diskId(cur, seen);
    if (id) ids.add(id);
    const parent = dirname(cur);
    if (parent === cur) return ids;
    cur = parent;
  }
}
function onDiskAtOrUnder(child, parent, chain = diskChain(child), seen) {
  const id = diskId(parent, seen);
  if (id !== null) return chain.has(id);
  const rest = [];
  let base = resolve(parent);
  for (; ; ) {
    const up = dirname(base);
    if (up === base) return false;
    rest.unshift(basename(base));
    base = up;
    const baseId = diskId(base, seen);
    if (baseId === null) continue;
    if (!chain.has(baseId)) return false;
    const below = [];
    for (let c = resolve(child); ; ) {
      if (diskId(c, seen) === baseId) return below.length >= rest.length && rest.every((r, i) => fold(r) === fold(below[i]));
      const cUp = dirname(c);
      if (cUp === c) return false;
      below.unshift(basename(c));
      c = cUp;
    }
  }
}
function localAtOrUnder(child, parent) {
  const parents = [parent, realpathBestEffort(parent)];
  return spellingsOf(resolve(child)).some((c) => parents.some((p) => isAtOrUnder(normWinPath(c), p)) || onDiskAtOrUnder(c, parent));
}
function shortFirmlinkSpelling(abs) {
  if (process.platform !== "darwin") return abs;
  const m = abs.match(/^\/System\/Volumes\/Data(\/.+)$/i);
  if (!m) return abs;
  const short = m[1];
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
function sameOnDisk(a, b) {
  const id = diskId(a);
  return id !== null && id === diskId(b);
}
var publishedBinDir = null;
var trustRoots = [];
var writeRootsOf = () => [];
function publishMegacmdBinDir(dir, roots = [], writeOnly = []) {
  publishedBinDir = dir;
  trustRoots = [...new Set([...dir ? [dir] : [], ...roots].filter(Boolean).map((p) => resolve(appBundleOf(p))))];
  writeRootsOf = typeof writeOnly === "function" ? writeOnly : () => writeOnly;
}
function currentWriteRoots() {
  return [...new Set(writeRootsOf().filter(Boolean).map((p) => resolve(p)))];
}
function appBundleOf(p) {
  const m = p.match(/^(.*?\.app)(?:[\\/]|$)/i);
  return m ? m[1] : p;
}
function homeIsDir() {
  try {
    const home = homedir();
    return home !== "" && statSync(home).isDirectory();
  } catch {
    return false;
  }
}
function sessionStoreRoots(binDir) {
  binDir ??= publishedBinDir;
  const roots = /* @__PURE__ */ new Set();
  const add = (p) => {
    roots.add(p);
    roots.add(realpathBestEffort(p));
  };
  const suffix = process.env.MEGACMD_WORKING_FOLDER_SUFFIX?.trim();
  const names = [".megaCmd", ...suffix ? [`.megaCmd_${suffix}`] : []];
  for (const name of names) add(resolve(homedir(), name));
  const uid = process.getuid?.();
  if (uid !== void 0) {
    const fallback = `/tmp/megacmd-${uid}`;
    if (!homeIsDir() || existsSync(fallback)) add(fallback);
  }
  if (isWin && binDir) for (const name of names) add(resolve(binDir, name));
  return [...roots];
}
function hitsSessionStore(rawAbs) {
  const abs = normWinPath(rawAbs);
  for (const segment of abs.split(SEG_SPLIT)) {
    if (isStoreName(segment)) return true;
    if (fold(segment) === "megacmd.mac") return true;
  }
  const chain = diskChain(abs);
  return sessionStoreRoots().some((r) => isAtOrUnder(abs, r) || onDiskAtOrUnder(abs, r, chain));
}
function localSpellings(name) {
  if (name === ".") return ["%2e"];
  if (name === "..") return ["%2e%2e"];
  const esc = (bad) => Array.from(name, (c) => c.length === 1 && c.charCodeAt(0) < 128 && bad(c) ? `%${c.charCodeAt(0).toString(16).padStart(2, "0")}` : c).join("");
  const strict = esc((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || '\\/:?"<>|*'.includes(c));
  const dots = strict.replace(/\.+$/, (m) => "%2e".repeat(m.length));
  return [.../* @__PURE__ */ new Set([name, esc((c) => c === "/" || c === "\0"), esc((c) => c === "/" || c === ":" || c === "\0"), strict, dots])];
}
function isStoreName(name) {
  if (name[0] !== "." && name[0] !== "%") return false;
  return [name, cloudNameOf(name)].some((n) => fold(n).startsWith(".megacmd"));
}
function realpathBestEffort(abs, seen) {
  let head = abs;
  const tail = [];
  for (; ; ) {
    let real = seen?.reals.get(head);
    if (real === void 0) {
      try {
        real = realpathSync.native(head).replace(/^\\\\\?\\/, "");
      } catch {
        real = null;
      }
      seen?.reals.set(head, real);
    }
    if (real !== null) return tail.length ? join(real, ...tail) : real;
    const parent = dirname(head);
    if (parent === head) return abs;
    tail.unshift(basename(head));
    head = parent;
  }
}
function spellingsOf(abs) {
  const folded = normWinPath(abs);
  const real = realpathBestEffort(abs);
  const realOfFolded = realpathBestEffort(folded);
  return [.../* @__PURE__ */ new Set([abs, folded, real, realOfFolded, normWinPath(realOfFolded)])];
}
function assertNotConfigDir(abs) {
  if (pathHitsSessionStore(abs)) {
    throw new ValidationError("Refusing to access the MEGAcmd configuration directory.");
  }
}
function pathHitsSessionStore(abs) {
  return spellingsOf(abs).some(hitsSessionStore);
}
function assertNotTrustRoot(abs) {
  insideAny(abs, trustRoots, "Refusing to read or write inside the MEGAcmd program directory or this connector's data directory - a file placed there would be loaded by MEGAcmd or by the connector itself.");
}
function isIgnoreFileName(name) {
  if (name[0] !== "." && name[0] !== "%") return false;
  return [name, cloudNameOf(name)].some((n) => fold(normSegment(n)) === ".megaignore");
}
var RECOVERY_KEY_NAMES = [
  "MEGA-RECOVERYKEY",
  "MEGA-RETTUNGSSCHLUESSEL",
  "MEGA-CL\xC9deR\xC9CUP\xC9RATION",
  "MEGA-CLAVEDERECUPERACION",
  "MEGA-CHAVEDERECUPERACAO",
  "MEGA-CHIAVEDIRECUPERO",
  "MEGA-HERSTELSLEUTEL",
  "MEGA-KLUCZODZYSKIWANIA",
  "MEGA-CHEIEDERECUPERARE",
  "MEGA-KUNCIPEMULIHAN",
  "MEGA-KURTARMA-ANAHTARI",
  "CHIAKHOAPHUCHOI-MEGA",
  "MEGA-\u041A\u041B\u042E\u0427-\u0412\u041E\u0421\u0421\u0422\u0410\u041D\u041E\u0412\u041B\u0415\u041D\u0418\u042F",
  "MEGA-\u0E04\u0E35\u0E22\u0E4C\u0E01\u0E32\u0E23\u0E01\u0E39\u0E49\u0E04\u0E37\u0E19",
  "MEGA-\u56DE\u5FA9\u30AD\u30FC",
  "MEGA-\u6062\u590D\u5BC6\u94A5",
  "MEGA-\u9084\u539F\u91D1\u9470",
  "\u0645\u0641\u062A\u0627\u062D \u0627\u0644\u0627\u0633\u062A\u0639\u0627\u062F\u0629-MEGA"
].map((n) => n.normalize("NFC").toLowerCase());
function isRecoveryKeyName(name) {
  const n = name.replace(/#\d{10}$/, "").normalize("NFC").toLowerCase();
  return n.endsWith(".txt") && RECOVERY_KEY_NAMES.some((k) => n.startsWith(k));
}
function cloudNameOf(local) {
  return decodeLocalName(local).normalize("NFC");
}
function decodeLocalName(local) {
  const n = local.normalize("NFC");
  if (n === "%2e%2e") return "..";
  if (n === "%2e") return ".";
  return n.replace(/%([0-7][0-9a-f])/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
function assertNotIgnoreFile(target) {
  if (isIgnoreFileName(basename(target))) {
    throw new ValidationError(`Refusing to write ${target}: a .megaignore file decides what a MEGA sync carries.`);
  }
}
function assertNotInsideProtected(abs) {
  assertNotConfigDir(abs);
  assertNotTrustRoot(abs);
  assertNotWriteRoot(abs);
}
function assertNotWriteRoot(abs) {
  insideAny(abs, currentWriteRoots(), `Refusing to write into an app configuration folder, this connector's own folder or a place Node.js is started from (its folder, or a file named "node" where the apps look for it) - a file placed there would decide what runs at the next start.`);
}
function insideAny(abs, roots, message) {
  if (roots.length === 0) return;
  const seen = newSeen();
  const reals = roots.map((r) => realpathBestEffort(r, seen));
  for (const candidate of spellingsOf(abs)) {
    const c = normWinPath(candidate);
    const chain = diskChain(candidate, seen);
    roots.forEach((root, i) => {
      if (isAtOrUnder(c, root) || isAtOrUnder(c, reals[i]) || onDiskAtOrUnder(candidate, root, chain, seen)) {
        throw new ValidationError(message);
      }
    });
  }
}
function protectedBelow(abs, inclusive) {
  const forms = [...new Set([abs, resolve(abs)].flatMap(spellingsOf))].map(normWinPath);
  const seen = newSeen();
  const roots = [...new Set([...trustRoots, ...currentWriteRoots(), ...sessionStoreRoots()].flatMap((r) => [r, realpathBestEffort(r, seen)]))];
  const hits = /* @__PURE__ */ new Set();
  const formIds = forms.map((f) => diskId(f, seen));
  for (const root of roots) {
    let chain = null;
    let rootId;
    forms.forEach((f, i) => {
      let below = isAtOrUnder(root, f);
      if (!below) {
        chain = chain ?? diskChain(root, seen);
        const id = formIds[i] ?? null;
        below = id !== null ? chain.has(id) : onDiskAtOrUnder(root, f, chain, seen);
      }
      if (!below) return;
      if (rootId === void 0) rootId = diskId(root, seen);
      const same = fold(root) === fold(f) || rootId !== null && rootId === formIds[i];
      if (inclusive || !same) hits.add(root);
    });
  }
  return [...hits];
}
function assertDownloadTarget(localDir, name) {
  if (name === null || name === "") return assertTargetBelow(localDir, null);
  const version = name.match(/^(.+)#\d{10}$/);
  for (const n of version ? [name, version[1]] : [name]) assertTargetBelow(localDir, n);
}
function protectedViaSymlinks(abs) {
  const links = linksBelow(abs);
  if (links.length === 0) return [];
  const seen = newSeen();
  const roots = [...new Set([...trustRoots, ...currentWriteRoots(), ...sessionStoreRoots()].flatMap((r) => [r, realpathBestEffort(r, seen)]))];
  const rootChains = /* @__PURE__ */ new Map();
  const chainOf = (r) => {
    let c = rootChains.get(r);
    if (!c) rootChains.set(r, c = diskChain(r, seen));
    return c;
  };
  return links.filter(({ real }) => {
    const realChain = diskChain(real, seen);
    return roots.some((r) => isAtOrUnder(real, r) || isAtOrUnder(r, real) || onDiskAtOrUnder(real, r, realChain, seen) || onDiskAtOrUnder(r, real, chainOf(r), seen));
  }).map(({ link, real }) => `${link} -> ${real}`);
}
function linksBelow(abs) {
  const out = [];
  const stack = [normWinPath(abs)];
  const seen = /* @__PURE__ */ new Set();
  let visited = 0;
  while (stack.length > 0 && ++visited <= STORE_WALK_MAX_DIRS) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const child = join(dir, e.name);
      if (e.isSymbolicLink()) {
        const real = realpathBestEffort(child);
        try {
          if (statSync(real).isDirectory() && !seen.has(real)) {
            seen.add(real);
            stack.push(real);
          }
        } catch {
        }
        out.push({ link: child, real });
      } else if (e.isDirectory()) {
        stack.push(child);
      }
    }
  }
  return out;
}
function assertTargetBelow(localDir, name) {
  const target = name !== null ? join(localDir, name) : localDir;
  if (name !== null) {
    assertNotConfigDir(target);
    assertNotTrustRoot(target);
    if (holdsDataVolume(target)) throw new ValidationError(`Refusing to download "${name}" into ${localDir}: ${target} holds the whole data volume (every home folder).`);
  }
  assertNotWriteRoot(target);
  const below = [...protectedBelow(target, name !== null), ...protectedViaSymlinks(target)];
  if (below.length > 0) {
    throw new ValidationError(
      `Refusing to download ${name !== null ? `"${name}" ` : ""}into ${localDir}: the download could write into a directory MEGAcmd or this connector depends on (${below.join(", ")}). Choose a different destination folder${name !== null ? "" : ", such as a subfolder"}.`
    );
  }
}
function assertNoLocalGlob(lp, field = "localPath") {
  if (/[*?]/.test(lp) && !existsSync(lp)) {
    throw new ValidationError(
      `${field} contains "*" or "?" and does not exist: MEGAcmd would expand it as a pattern after you approve, so the preview could not show what is uploaded. List the files explicitly.`
    );
  }
  return lp;
}
var STORE_WALK_MAX_DIRS = 2e4;
function storeCopiesIn(abs) {
  const found = [];
  const stack = [normWinPath(abs)];
  let visited = 0;
  let complete = true;
  while (stack.length > 0) {
    if (++visited > STORE_WALK_MAX_DIRS) return { found, complete: false };
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
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
function isUnreadable(e) {
  const code = e.code;
  return code === "EACCES" || code === "EPERM";
}
function ignoreFilesIn(lps) {
  const found = [];
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
      const dir = stack.pop();
      let entries;
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
function storeCopiesWithin(abs) {
  return storeCopiesIn(abs).found;
}
function sessionStoresWithin(abs, binDir, opts = {}) {
  const forms = [...new Set([abs, resolve(abs)].flatMap(spellingsOf))];
  const hits = /* @__PURE__ */ new Map();
  for (const root of sessionStoreRoots(binDir)) {
    if (forms.some((f) => fold(root) === fold(f) || sameOnDisk(root, f))) continue;
    if (forms.some((f) => isAtOrUnder(root, f) || onDiskAtOrUnder(root, f)) && existsSync(root)) {
      hits.set(fold(realpathBestEffort(root)), root);
    }
  }
  if (opts.walk !== false) for (const copy of storeCopiesWithin(abs)) hits.set(fold(realpathBestEffort(copy)), copy);
  return [...hits.values()];
}
function rejectNul(p) {
  if (p.includes(String.fromCharCode(0))) throw new ValidationError("Path contains a NUL byte.");
}
function rejectArgvQuote(v, field) {
  if (v.includes('"')) {
    throw new ValidationError(
      `${field} must not contain a double quote - MEGAcmd cannot address such a value: it would re-parse the command and operate on a different target.`
    );
  }
  if (v.trimStart().startsWith("'")) {
    throw new ValidationError(
      `${field} must not start with a single quote - MEGAcmd would strip it and could read the rest as an option.`
    );
  }
}
function assertSecret(v, field) {
  rejectNul(v);
  rejectArgvQuote(v, field);
  return v;
}
function assertRemotePath(p, field = "remotePath") {
  rejectNul(p);
  const t = p.trim().normalize("NFC");
  if (t === "") throw new ValidationError(`${field} is empty.`);
  if (!t.startsWith("/")) {
    throw new ValidationError(`${field} must be an absolute MEGA path starting with "/".`);
  }
  if (t.includes("\\")) {
    throw new ValidationError(`${field} must not contain a backslash - MEGAcmd reads it as an escape, so it would resolve a different path.`);
  }
  if (t.split("/").some((seg) => seg === "." || seg === "..")) {
    throw new ValidationError(`${field} must not contain "." or ".." segments - MEGAcmd resolves them, so it would act on a different path.`);
  }
  if (t.replace(/^\/\/(?:bin|in|from)(?=\/|$)/, "").includes("//")) {
    throw new ValidationError(`${field} must not contain an empty segment ("//").`);
  }
  rejectControls(t, field);
  rejectArgvQuote(t, field);
  return t;
}
function assertRemoteDest(p, field = "remotePath") {
  return assertNoHandleName(assertNoVersionName(assertRemotePath(p, field), field), field);
}
function assertNoHandleName(p, field = "remotePath") {
  if (p.split("/").some((seg) => /^H:[A-Za-z0-9_-]{8}$/.test(seg))) {
    throw new ValidationError(`${field} must not name an item "H:" and 8 characters - MEGAcmd reads that as a node handle.`);
  }
  return p;
}
function assertNoVersionName(p, field = "remotePath") {
  if (p.split("/").some((seg) => /#\d{10}$/.test(seg))) {
    throw new ValidationError(`${field} must not contain a name ending in "#" and 10 digits - MEGAcmd reads that as a file version, which keeps its own name.`);
  }
  return p;
}
function rejectControls(p, field) {
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(p)) {
    throw new ValidationError(`${field} must not contain line breaks or other control characters.`);
  }
  if (new RegExp("\\p{Cs}", "u").test(p)) throw new ValidationError(`${field} holds a broken Unicode character (a lone surrogate).`);
}
function assertOptionalRemotePath(p, field = "remotePath") {
  return p === void 0 ? void 0 : assertRemotePath(p, field);
}
function assertNoFlag(v, field) {
  rejectNul(v);
  if (/[\x00-\x1f\x7f]/.test(v)) throw new ValidationError(`${field} must not contain control characters.`);
  const t = v.trim();
  if (t === "") throw new ValidationError(`${field} is empty.`);
  if (t.startsWith("-")) throw new ValidationError(`${field} must not start with "-".`);
  rejectArgvQuote(t, field);
  return t;
}
function assertFlagValue(v, field) {
  rejectNul(v);
  const t = v.trim();
  if (t === "") throw new ValidationError(`${field} is empty.`);
  rejectArgvQuote(t, field);
  return t;
}
function assertConstraint(v, field) {
  rejectNul(v);
  const t = v.trim();
  if (t === "") throw new ValidationError(`${field} is empty.`);
  if (!isConstraintFormat(t)) {
    throw new ValidationError(
      `${field} has an invalid format. Use signed number+unit forms, e.g. "-30d", "+1m12d3h", "-3d+1h" (time) or "-100K", "-4M+100K" (size).`
    );
  }
  return t;
}
function isConstraintFormat(t) {
  let i = 0;
  let groups = 0;
  if (t[i] === "+" || t[i] === "-") i++;
  while (i < t.length) {
    const digitsFrom = i;
    for (let d = t[i]; d !== void 0 && d >= "0" && d <= "9"; d = t[++i]) ;
    if (i === digitsFrom) return false;
    const c = t[i];
    if (c !== void 0 && (c >= "A" && c <= "Z" || c >= "a" && c <= "z")) i++;
    groups++;
    const s = t[i];
    if (s === "+" || s === "-") {
      const next = t[i + 1];
      if (next === void 0 || next < "0" || next > "9") return false;
      i++;
    }
  }
  return groups > 0;
}
function assertNoWildcard(v, field) {
  if (/[*?]/.test(v)) {
    throw new ValidationError(
      `${field} must not contain a wildcard ("*" or "?"): MEGAcmd expands it AFTER you approve, so the preview could not show what would be affected. Use usePcre=true to act on many nodes - it lists the matches first and operates on those exact nodes.`
    );
  }
  return v;
}
function assertLocalPath(p, field = "localPath") {
  rejectNul(p);
  const t = p.trim();
  if (t === "") throw new ValidationError(`${field} is empty.`);
  const abs = shortFirmlinkSpelling(resolve(t));
  rejectControls(abs, field);
  rejectArgvQuote(abs, field);
  assertNotDataVolumeRoot(abs);
  assertNotConfigDir(abs);
  assertNotTrustRoot(abs);
  return abs;
}
function assertNotDataVolumeRoot(abs) {
  if (process.platform === "win32") return;
  const spellings = spellingsOf(abs);
  if (spellings.some((s) => /^\/(?:dev|proc)(?:\/|$)/.test(s) || process.platform === "darwin" && /^\/\.(?:vol|nofollow|resolve)(?:\/|$)/i.test(s))) {
    throw new ValidationError(`${abs} uses a special path form; use the folder's ordinary path.`);
  }
  if (holdsDataVolume(abs, spellings)) {
    throw new ValidationError(`${abs} holds the whole data volume (every home folder); choose a folder inside it, such as /Users/<name>/Documents.`);
  }
}
function holdsDataVolume(abs, spellings = spellingsOf(abs)) {
  if (process.platform !== "darwin") return false;
  const roots = ["/System", "/System/Volumes", "/System/Volumes/Data"];
  return spellings.some((s) => roots.some((r) => fold(r) === fold(s).replace(/(.)\/+$/, "$1") || sameOnDisk(r, s)));
}
function assertNoStoreWithin(lp, what, binDir) {
  const stores = sessionStoresWithin(lp, binDir);
  if (stores.length === 0) {
    return storeCopiesIn(lp).complete ? [] : [`(Could not search ${lp} completely - too many subfolders, or folders that cannot be read - for copies of a MEGAcmd session store (.megaCmd).)`];
  }
  throw new ValidationError(
    `Refusing to ${what} ${lp}: it contains the MEGAcmd session store (${stores.join(", ")}), which holds this account's MASTER KEY, and a periodic backup cannot leave it out (MEGA's scheduled copies have no exclusion rules). Use mega_sync_add, which leaves it out, or mega_put, which uploads the folder without it.`
  );
}
function regexOfPath(p) {
  return p.replace(/[\\.[()*+?{|^$]/g, "\\$&").replace(/[ \t\v\f]/g, "[$&]");
}
function syncExclusions(lp, binDir) {
  assertNotWriteRoot(lp);
  const out = [];
  const stores = sessionStoresWithin(lp, binDir);
  out.push({ rule: "-dng:.megacmd*", label: ".megaCmd folders at any depth (the MEGAcmd session store, and any copy of it)", rel: "" });
  const paths = /* @__PURE__ */ new Map();
  for (const target of [...stores, ...protectedBelow(lp, false)]) {
    const rel = relativeWithin(lp, target);
    if (rel === null) {
      throw new ValidationError(`Refusing to sync ${lp}: ${target} is inside it, but its path relative to ${lp} cannot be worked out to leave it out. Use the usual spelling of the folder.`);
    }
    if (!rel) continue;
    const segs = rel.split("/").map((seg) => decodeLocalName(seg));
    if (segs.some((seg) => /[\r\n/]/.test(seg) || seg === "." || seg === ".." || seg !== seg.normalize("NFC"))) {
      throw new ValidationError(`Refusing to sync ${lp}: ${target} is inside it and its path cannot be written as an exclusion rule. Choose a folder that does not contain it.`);
    }
    if (segs.length === 1 && isStoreName(segs[0])) continue;
    const cloudRel = segs.join("/");
    const literal = segs.every((seg) => !/[*?[\]\\]/.test(seg) && seg === seg.trim());
    const rule = literal ? `-apg:${cloudRel}` : `-apr:${regexOfPath(cloudRel)}`;
    if (!paths.has(cloudRel)) paths.set(cloudRel, { rule, label: rel, rel: cloudRel });
  }
  out.push(...paths.values());
  return out;
}
function onDiskSpelling(abs) {
  return realpathBestEffort(abs);
}
function relativeWithin(lp, target) {
  for (const base of spellingsOf(lp)) {
    for (const t of [target, ...spellingsOf(target)]) {
      const rel = relative(normWinPath(base), normWinPath(t));
      if (rel === "" || !rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
    }
  }
  for (const t of [target, ...spellingsOf(target)]) {
    for (let a = t; dirname(a) !== a; a = dirname(a)) {
      if (sameOnDisk(lp, a)) return relative(a, t).split(sep).join("/");
    }
  }
  return null;
}
function joinRemote(parent, name) {
  if (!name) return parent;
  return `${parent.replace(/\/+$/, "")}/${name}`;
}
function planUpload(lps, rp, binDir, name) {
  const isDir = (p) => {
    try {
      return statSync(normWinPath(p)).isDirectory();
    } catch {
      return false;
    }
  };
  const folders = lps.filter(isDir);
  const walks = folders.map((lp) => ({ lp, ...storeCopiesIn(lp) }));
  const stores = [...sessionStoreRoots(binDir).filter((r) => existsSync(r)), ...walks.flatMap((w) => w.found)].map(
    (r) => realpathBestEffort(r)
  );
  const containsStore = (p) => {
    const real = realpathBestEffort(normWinPath(p));
    return stores.some((st) => !(fold(st) === fold(real) || sameOnDisk(st, p)) && (isAtOrUnder(st, real) || onDiskAtOrUnder(st, p)));
  };
  const direct = [];
  const steps = [];
  const excluded = [];
  const links = [];
  const split = (dir, remoteParent, as) => {
    const listed = realpathBestEffort(normWinPath(dir));
    const step = { dest: joinRemote(remoteParent, as ?? cloudNameOf(basename(normWinPath(dir)))), sources: [] };
    steps.push(step);
    let names;
    try {
      names = readdirSync(listed).sort();
    } catch {
      throw new ValidationError(`Could not list ${dir} to leave the MEGAcmd session store out of the upload.`);
    }
    for (const name2 of names) {
      const child = join(listed, name2);
      let isLink = false;
      try {
        isLink = lstatSync(child).isSymbolicLink();
      } catch {
        continue;
      }
      if (isStoreName(name2) || pathHitsSessionStore(child) || isLink && containsStore(child)) {
        excluded.push(child);
        continue;
      }
      if (isLink) {
        links.push(child);
        continue;
      }
      rejectArgvQuote(child, `"${name2}" inside ${dir}`);
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
  for (const step of steps) {
    if (step.dest === rp) continue;
    let plain = !step.dest.includes("\\") && !/#\d{10}(\/|$)/.test(step.dest) && (rp === "/" ? step.dest.startsWith("/") : step.dest.startsWith(`${rp.replace(/\/+$/, "")}/`));
    try {
      plain &&= assertRemotePath(step.dest) === step.dest;
    } catch {
      plain = false;
    }
    if (!plain) {
      throw new ValidationError(
        `Cannot upload around the session store here: the folder name in ${step.dest} would be read differently by MEGAcmd. Upload the subfolders individually instead.`
      );
    }
  }
  return { steps, excluded, links, unchecked: walks.filter((w) => !w.complete).map((w) => w.lp) };
}
function globCanMatchStoreName(segment) {
  const g = fold(segment).replace(/\*+/g, "*");
  const close = (states2) => {
    const out = new Set(states2);
    for (const i of states2) for (let j = i; g[j] === "*"; j++) out.add(j + 1);
    return out;
  };
  const step = (states2, ch) => {
    const next = /* @__PURE__ */ new Set();
    for (const i of states2) {
      if (g[i] === "*") next.add(i);
      else if (g[i] === "?" || g[i] === ch) next.add(i + 1);
    }
    return close(next);
  };
  let states = close(/* @__PURE__ */ new Set([0]));
  for (const ch of ".megacmd") states = step(states, ch);
  if (states.has(g.length)) return true;
  return [...step(states, "_")].some((i) => !g.slice(i).includes("."));
}
function assertNotStoreCopy(p, field = "remotePath") {
  const why = storeCopyIn(p);
  if (why === "name") {
    throw new ValidationError(
      `${field} is inside a copy of the MEGAcmd session store (.megaCmd), which holds this account's MASTER KEY. No tool reads, copies, moves, shares or publishes it.`
    );
  }
  if (why === "wildcard") {
    throw new ValidationError(
      `${field} contains a wildcard that could match a copy of the MEGAcmd session store (.megaCmd), which holds this account's MASTER KEY. Use a more specific pattern or the exact path.`
    );
  }
  return p;
}
function storeCopyIn(p) {
  const names = p.split(/[\\/]/).flatMap((segment) => segment.includes(":") ? [segment, segment.slice(segment.indexOf(":") + 1)] : [segment]);
  if (names.some((name) => isStoreName(name))) return "name";
  if (names.some((name) => /[*?]/.test(name) && globCanMatchStoreName(name))) return "wildcard";
  return null;
}

// src/parsers/exportLink.ts
function parseExportLink(raw) {
  const mega = raw.match(/https?:\/\/mega\.nz\/\S+/i);
  if (mega) return mega[0];
  const any = raw.match(/https?:\/\/\S+/i);
  return any?.[0];
}
function parseCreatedLink(raw, path) {
  if (path !== void 0) {
    const prefix = `Exported ${path.startsWith("//from/") ? path.slice("//from/".length) : path}: `;
    const i = raw.indexOf(prefix);
    return i === 0 || i > 0 && raw[i - 1] === "\n" ? raw.slice(i + prefix.length).split(/\s/)[0] : void 0;
  }
  const from = raw.search(/^Exported /m);
  if (from < 0) return void 0;
  const head = raw.slice(from).split(/\r?\n {2,}AuthToken = /)[0];
  const at = head.lastIndexOf(": https://");
  return at < 0 ? void 0 : head.slice(at + 2).split(/\s/)[0];
}

// src/errors.ts
var ExitCode = {
  OK: 0,
  EARGS: 51,
  INVALIDEMAIL: 52,
  NOTFOUND: 53,
  INVALIDSTATE: 54,
  INVALIDTYPE: 55,
  NOTPERMITTED: 56,
  NOTLOGGEDIN: 57,
  NOFETCH: 58,
  EUNEXPECTED: 59,
  REQCONFIRM: 60,
  REQSTRING: 61,
  EXISTS: 64,
  REQRESTART: 71
};
var MESSAGES = {
  [ExitCode.EARGS]: "Invalid arguments.",
  [ExitCode.INVALIDEMAIL]: "Invalid email address.",
  [ExitCode.NOTFOUND]: "Not found.",
  [ExitCode.INVALIDSTATE]: "Invalid state for this operation.",
  [ExitCode.INVALIDTYPE]: "Invalid node type for this operation.",
  [ExitCode.NOTPERMITTED]: "Not permitted.",
  [ExitCode.NOTLOGGEDIN]: "Not logged in. Log in out-of-band in the MEGAcmd interactive shell (login <email>), then retry \u2014 call mega_whoami for the exact command.",
  [ExitCode.NOFETCH]: "Account not yet fetched; try again shortly.",
  [ExitCode.EUNEXPECTED]: "Unexpected error.",
  [ExitCode.REQCONFIRM]: "Confirmation required (internal \u2014 the wrapper passes -f, so this should not surface).",
  [ExitCode.REQSTRING]: "Additional input required.",
  [ExitCode.EXISTS]: "Already exists.",
  [ExitCode.REQRESTART]: "MEGAcmd requires a restart."
};
function stripPrefix(line) {
  return line.replace(/^\[[^\]]*\]\s*/, "").trim();
}
function firstStderrLine(stderr) {
  for (const raw of stderr.split(/\r?\n/)) {
    const s = stripPrefix(raw);
    if (s) return s;
  }
  return "";
}
function redact(text) {
  return text.replace(/\bsession\b[^\n]*/gi, "session [redacted]").replace(/([#!])[A-Za-z0-9_-]{16,}/g, "$1[redacted]").replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]");
}
function classifyExit(result) {
  if (result.maxBufferExceeded) {
    return "Output too large to return. Narrow the request (a more specific path or pattern).";
  }
  if (result.timedOut) {
    return "The MEGAcmd command timed out. The server may be busy or still starting; a transfer may also still be running in MEGAcmd (see mega_transfers). Try again shortly.";
  }
  if (result.spawnError === "INTEGRITY_FAILED") {
    return "The MEGAcmd found on this computer failed its signature check (it is not the program MEGA signed), so it was not run. Remove it and reinstall MEGAcmd from https://mega.io/cmd.";
  }
  if (result.spawnError) {
    return "MEGAcmd is not available. Run the `megacmd_setup` tool to download it, or install MEGAcmd / set the MEGAcmd directory in the extension settings.";
  }
  if (result.code === ExitCode.OK) return "";
  const known = MESSAGES[result.code];
  const detail = redact(firstStderrLine(result.stderr)).slice(0, 200);
  if (known) return detail && result.code !== ExitCode.NOTLOGGEDIN ? `${known} (${detail})` : known;
  return detail ? `MEGAcmd error (${detail}).` : `MEGAcmd error (exit ${result.code}).`;
}

// src/tools/helpers.ts
var PLAN_MAX = 200;
function listedLines(items, line = (i) => `  ${i}`) {
  const shown = items.slice(0, PLAN_MAX).map(line);
  return items.length > PLAN_MAX ? [...shown, `  ...and ${items.length - PLAN_MAX} more (all ${items.length} are included).`] : shown;
}
async function pcreMatchPreview(rt, pattern, max = PLAN_MAX) {
  if (!pattern.startsWith("/")) {
    return { ok: false, error: 'A pattern must start with "/": MEGAcmd matches each part of the path separately, so write /Docs/.*\\.pdf (not ^/Docs/...).' };
  }
  const r = await rt.run("find", [pattern, "--use-pcre", "--show-handles"], { maxBuffer: 128 * 1024 * 1024 });
  if (r.code !== 0) return { ok: false, error: classifyExit(r) };
  const only = await rt.run("find", [pattern, "--use-pcre", "--print-only-handles"], { maxBuffer: 128 * 1024 * 1024 });
  if (only.code !== 0) return { ok: false, error: classifyExit(only) };
  const entries = [];
  for (const raw of r.stdout.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const m = raw.match(/^(.+) <(H:[A-Za-z0-9_-]+)>$/);
    if (!m) return { ok: false, error: UNLISTABLE };
    const shown2 = m[1];
    const spelled = shown2.startsWith("/") ? shown2 : /^[^/:\s]+@[^/:\s]+:/.test(shown2) ? `//from/${shown2}` : null;
    if (spelled === null) return { ok: false, error: UNLISTABLE };
    const path = spelled.normalize("NFC");
    entries.push({ path, handle: m[2] });
  }
  const authoritative = [];
  for (const raw of only.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!/^H:[A-Za-z0-9_-]+$/.test(line)) return { ok: false, error: UNLISTABLE };
    authoritative.push(line);
  }
  if (!sameMultiset(entries.map((e) => e.handle), authoritative)) return { ok: false, error: UNLISTABLE };
  const top = topmost(entries);
  const root = top.find((e) => /^(?:\/|\/\/(?:bin|in))\/?$/.test(e.path));
  if (root) return { ok: false, error: `The pattern matches the root ${root.path} itself; match the items inside it instead (for example ${root.path === "/" ? "" : root.path}/.*).` };
  const handles = top.map((e) => e.handle);
  const shown = top.slice(0, max).map((e) => `${e.path} <${e.handle}>`).join("\n");
  const hiddenBy = /* @__PURE__ */ new Map();
  for (const e of top.slice(max)) hiddenBy.set(posix.dirname(e.path), (hiddenBy.get(posix.dirname(e.path)) ?? 0) + 1);
  const hidden = [...hiddenBy].sort((a, b) => b[1] - a[1]);
  const hiddenText = hidden.slice(0, 20).map(([dir, n]) => `${n} in ${dir}`).join(", ") + (hidden.length > 20 ? `, and ${hidden.length - 20} more folders` : "");
  const note = (top.length > max ? `
...(${top.length} total; showing first ${max}. Not listed: ${hiddenText})` : "") + (top.length < new Set(entries.map((e) => e.handle)).size ? "\n(Matched folders are acted on as a whole, together with everything inside them.)" : "");
  return { ok: true, count: top.length, handles, paths: entries.map((e) => e.path), topPaths: top.map((e) => e.path), text: (shown || "(no matches)") + note, allHandles: entries.map((e) => e.handle) };
}
async function recheckPcrePlan(rt, pattern, plan, checkPath) {
  const now = await pcreMatchPreview(rt, pattern);
  if (!now.ok) return now.error;
  if (plan.contents !== void 0 && handlesDigest(now.allHandles) !== plan.contents) {
    return "What the matched folders hold changed after the preview (an item moved in or out). Nothing was run; preview again.";
  }
  const pathOf = new Map(now.handles.map((h, i) => [h, now.topPaths[i]]));
  for (let i = 0; i < plan.handles.length; i++) {
    if (pathOf.get(plan.handles[i]) !== plan.paths[i]) {
      return `${plan.paths[i]} changed (renamed or moved) after the preview. Nothing was run; preview again.`;
    }
  }
  const tops = new Set(now.topPaths);
  for (const p of now.paths) checkPath(p, tops.has(p));
  return null;
}
var SECRET_KEY = randomBytes(32);
function secretBinding(secret) {
  if (secret === void 0 || secret === "") return null;
  return createHmac("sha256", SECRET_KEY).update(secret).digest("hex");
}
function localNamesOf(remotePath) {
  const base = posix.basename(remotePath.replace(/(.)\/+$/, "$1"));
  return [...new Set((base.includes(":") ? [base, base.slice(base.indexOf(":") + 1)] : [base]).flatMap(localSpellings))];
}
var UNLISTABLE = "A matching node has a name this preview cannot list unambiguously (for example one containing a line break). Narrow the pattern so it does not match that node, or rename it first.";
function topmost(entries) {
  const seen = /* @__PURE__ */ new Set();
  const unique = entries.filter((e) => seen.has(e.handle) ? false : (seen.add(e.handle), true));
  const paths = unique.map((e) => e.path.replace(/\/+$/, ""));
  const matched = new Set(paths);
  return unique.filter((_, i) => {
    let a = paths[i];
    for (let cut = a.lastIndexOf("/"); cut >= 0; cut = a.lastIndexOf("/")) {
      a = a.slice(0, cut);
      if (matched.has(a)) return false;
    }
    return true;
  });
}
function sameMultiset(a, b) {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}
function handlesDigest(handles) {
  return createHash("sha256").update([...handles].sort().join("\n")).digest("hex");
}
var pcrePlans = /* @__PURE__ */ new Map();
function stashPcrePlan(token, handles, paths, bound, contents, ttlMs = 12e4) {
  const now = Date.now();
  for (const [t, p] of pcrePlans) if (p.expires < now) pcrePlans.delete(t);
  pcrePlans.set(token, { handles, paths, bound, contents, expires: now + ttlMs });
}
function takePcrePlan(token) {
  const p = pcrePlans.get(token);
  if (!p) return null;
  pcrePlans.delete(token);
  return p.expires < Date.now() ? null : p;
}
async function pcreGate(rt, action, normArgs, confirm, pattern, summaryFor, checkPath, opts = {}) {
  const extra = async (tops) => opts.extraLines ? await opts.extraLines(tops) : [];
  if (!confirm) {
    const prev = await pcreMatchPreview(rt, pattern);
    if (!prev.ok) return { proceed: false, result: err(prev.error) };
    const tops = new Set(prev.topPaths);
    if (checkPath) for (const p of prev.paths) checkPath(p, tops.has(p));
    const lines = summaryFor(prev.count, prev.text, prev.topPaths).split("\n");
    lines.splice(1, 0, `  (pattern: ${pattern})`);
    const added = await extra(prev.topPaths);
    const gate2 = checkConfirm(rt, action, normArgs, void 0, [...lines, ...added]);
    const tok = gate2.structuredContent?.confirmToken;
    if (tok) stashPcrePlan(tok, prev.handles, prev.topPaths, added.join("\n"), opts.bindContents ? handlesDigest(prev.allHandles) : void 0);
    return { proceed: false, result: gate2 };
  }
  const gate = checkConfirm(rt, action, normArgs, confirm, "");
  if (gate) return { proceed: false, result: gate };
  const plan = takePcrePlan(confirm);
  if (!plan) {
    return { proceed: false, result: err('The PCRE preview expired. Re-run without "confirm" to get a fresh preview, then confirm.') };
  }
  if (opts.recheckNames || opts.extraLines || opts.bindContents) {
    const changed = await recheckPcrePlan(rt, pattern, plan, checkPath ?? (() => {
    }));
    if (changed) return { proceed: false, result: err(changed) };
  }
  if ((await extra(plan.paths)).join("\n") !== plan.bound) {
    return { proceed: false, result: err("Something changed in the matched folders after the preview (an item placed in them, say). Nothing was run; preview again.") };
  }
  return { proceed: true, handles: plan.handles, paths: plan.paths };
}
async function runPerHandle(rt, cmd, handles, argvFor) {
  let done = 0;
  let failed = 0;
  for (const h of handles) {
    const r = await rt.run(cmd, argvFor(h));
    if (r.code === 0) done++;
    else failed++;
  }
  return { done, failed };
}
async function runBulk(rt, cmd, sources, trailingArgv, chunkSize = 2e3) {
  let done = 0;
  let failed = 0;
  for (const chunk of chunkArgs(sources, chunkSize, trailingArgv)) {
    const r = await rt.run(cmd, [...chunk, ...trailingArgv]).catch((e) => {
      if (e instanceof ValidationError) return null;
      throw e;
    });
    if (r?.code === 0) done += chunk.length;
    else failed += chunk.length;
  }
  return { done, failed };
}
async function assertNoStoreCopyBelowMany(rt, paths) {
  if (paths.length === 1) return assertNoStoreCopyBelow(rt, paths[0]);
  for (const chunk of chunkArgs(paths)) {
    const r = await rt.run("find", [...chunk, "--type=d"]);
    if (r.code !== 0) {
      for (const p of chunk) await assertNoStoreCopyBelow(rt, p);
      continue;
    }
    const hit = r.stdout.split(/\r?\n/).map((l) => l.trim()).find((line) => storeCopyIn(line) === "name");
    if (hit) {
      const src = chunk.find((p) => hit === p || hit.startsWith(`${p.replace(/\/+$/, "")}/`)) ?? chunk.join(", ");
      throw new ValidationError(
        `${src} contains a copy of the MEGAcmd session store (${hit}), which holds this account's MASTER KEY, so it is not copied, moved, downloaded, shared or published. Delete that .megaCmd folder from the cloud first.`
      );
    }
  }
}
async function assertNoStoreCopyBelow(rt, remotePath) {
  const r = await rt.run("find", [remotePath, "--type=d"]);
  if (r.code === ExitCode.NOTFOUND || r.spawnError) return;
  if (r.code !== 0) throw new ValidationError(`Could not check ${remotePath} for a copy of the MEGAcmd session store: ${classifyExit(r)}`);
  if (r.stdout.split(/\r?\n/).some((line) => storeCopyIn(line.trim()) === "name")) {
    throw new ValidationError(
      `${remotePath} contains a copy of the MEGAcmd session store (.megaCmd), which holds this account's MASTER KEY, so it is not copied, moved, downloaded, shared or published. Delete that .megaCmd folder from the cloud first.`
    );
  }
}
async function assertNoFoldTwinBelow(rt, remotePath, excludedRels) {
  if (excludedRels.length === 0) return;
  const r = await rt.run("find", [remotePath], { maxBuffer: 128 * 1024 * 1024 });
  if (r.code === ExitCode.NOTFOUND || r.spawnError) return;
  if (r.code !== 0) throw new ValidationError(`Could not check ${remotePath} for folders named like the ones this sync leaves out: ${classifyExit(r)}`);
  const prefixes = /* @__PURE__ */ new Map();
  for (const rel of excludedRels) {
    const segs = rel.split("/");
    for (let i = 1; i <= segs.length; i++) prefixes.set(foldName(segs.slice(0, i).join("/")), segs.slice(0, i).join("/"));
  }
  const base = remotePath.replace(/(.)\/+$/, "$1");
  const shown = base.startsWith("//from/") ? base.slice("//from/".length) : base;
  const lead = shown === "/" ? "/" : `${shown}/`;
  const asciiFold = (s) => s.normalize("NFC").replace(/[A-Z]/g, (c) => c.toLowerCase());
  for (const raw of r.stdout.split(/\r?\n/)) {
    const p = raw.trim();
    if (!p.startsWith(lead)) continue;
    const rel = p.slice(lead.length);
    const exact = prefixes.get(foldName(rel));
    if (exact !== void 0 && asciiFold(rel) !== asciiFold(exact)) {
      throw new ValidationError(
        `${remotePath} holds ${p}, which this computer treats as the same folder as ${exact} - a folder the sync must leave out - but MEGA's sync rules would not see it that way. Rename or remove it in the cloud before syncing.`
      );
    }
  }
}
function sharePathOf(line) {
  const i = Math.max(line.lastIndexOf(", shared"), line.lastIndexOf(", (still pending)"));
  return i > 0 ? line.slice(0, i) : null;
}
function exportPathOf(line) {
  const i = openingBracket(line);
  return i > 0 && line.slice(i).includes("exported") ? line.slice(0, i).replace(/ $/, "") : null;
}
async function sharedBelowNotes(rt, cloudPath) {
  const p = cloudPath.replace(/(.)\/+$/, "$1");
  if (p.startsWith("//from/")) return [];
  const root = (p.match(/^\/\/(?:bin|in)(?=\/|$)/) ?? ["/"])[0];
  const shared = await listedPaths(rt, "share", root, sharePathOf);
  const exported = await listedPaths(rt, "export", root, exportPathOf);
  if (!shared || !exported) return [`(Could not check whether folders inside ${p} are shared or have a public link.)`];
  const inside = (set) => [...set].filter((x) => x !== p && under(x, p)).sort();
  return [
    ...inside(shared).map((x) => `${x}, inside ${p}, is shared with other people: what lands there is visible to them.`),
    ...inside(exported).map((x) => `${x}, inside ${p}, has a public link: what lands there is visible to anyone with the link.`)
  ];
}
async function destinationNotes(rt, dst, opts = {}) {
  const notes = [];
  const replaced = opts.overwrite === "delete" ? `${dst} is an existing FILE: it will be REPLACED, and it and all its older versions are deleted for good (not kept as a version, not in the Rubbish Bin).` : `${dst} is an existing FILE: it will be REPLACED (kept as an older version only while file versioning is on).`;
  const mirror = await localMirrorOf(rt, dst);
  if (mirror === void 0) notes.push("(Could not check whether the destination is in a synced folder.)");
  else if (mirror) {
    notes.push(`${dst} is in a synced folder: what is placed there is also written to this computer, at ${mirror}.`);
    const exec = await executableDownloadNote(rt);
    if (exec) notes.push(exec);
    if (opts.backups !== false) {
      for (const n of await backedUpLines(rt, mirror)) if (!notes.includes(n)) notes.push(n);
    }
  }
  if (dst.startsWith("//from/")) {
    const out = [`${dst} is a folder someone else shared with you: its owner, and anyone they share it with, will see what is placed there.`, ...notes];
    if (opts.overwrite && await remoteKind(rt, dst) === "file") out.push(replaced);
    return out;
  }
  const root = (dst.match(/^\/\/(?:bin|in)(?=\/|$)/) ?? ["/"])[0];
  const chain = ancestorsOf(dst);
  const shared = await listedPaths(rt, "share", root, sharePathOf);
  const exported = await listedPaths(rt, "export", root, exportPathOf);
  if (!shared || !exported) notes.push("(Could not check whether the destination is shared or has a public link.)");
  const sharedAt = shared && chain.find((p) => shared.has(p));
  const linkedAt = exported && chain.find((p) => exported.has(p));
  const self = dst.replace(/(.)\/+$/, "$1");
  const subject = (at) => at === self ? dst : `${dst} is inside ${at}, which`;
  if (sharedAt) notes.push(`${subject(sharedAt)} is shared with other people: they will be able to see what is placed there.`);
  if (linkedAt) notes.push(`${subject(linkedAt)} has a public link: anyone with the link will be able to see what is placed there.`);
  if (opts.overwrite && await remoteKind(rt, dst) === "file") notes.push(replaced);
  return notes;
}
async function sameNamed(rt, path) {
  const r = await rt.run("du", [`--path-display-size=${path.length + 2}`, path]);
  if (r.code === ExitCode.NOTFOUND) return { count: 0, lines: [] };
  if (r.code !== 0) return { count: -1, lines: [`(Could not check how many items are named ${path}.)`] };
  let count = 0;
  for (const line of r.stdout.split(/\r?\n/).slice(1)) {
    if (/^-+$/.test(line.trim())) break;
    if (!line.trim()) continue;
    if (!/:\s+[\d.]+(?:\s*[A-Za-z]+)?\s*$/.test(line)) return { count: -1, lines: [`(Could not check how many items are named ${path}.)`] };
    count++;
  }
  return { count, lines: sameNameLines(path, count) };
}
function sameNameLines(path, count) {
  return count > 1 ? [`Note: ${count} items are named ${path} - this acts on ALL of them.`] : [];
}
async function sameNamedMany(rt, paths) {
  const counts = paths.map(() => null);
  if (paths.length > 1) {
    let at = 0;
    for (const chunk of chunkArgs(paths)) {
      const width = Math.max(...chunk.map((p) => p.length)) + 2;
      const r = await rt.run("du", [`--path-display-size=${width}`, ...chunk]);
      if (r.code === 0) {
        const lines = r.stdout.split(/\r?\n/);
        chunk.forEach((p, i) => {
          const n = lines.filter((l) => l.startsWith(`${p}:`) && /^\s+[\d.]+(?:\s*[A-Za-z]+)?\s*$/.test(l.slice(p.length + 1))).length;
          if (n > 0) counts[at + i] = n;
        });
      }
      at += chunk.length;
    }
  }
  const out = [];
  for (let i = 0; i < paths.length; i++) {
    const n = counts[i];
    out.push(n === null || n === void 0 ? await sameNamed(rt, paths[i]) : { count: n, lines: sameNameLines(paths[i], n) });
  }
  return out;
}
async function executableDownloadNote(rt) {
  if (process.platform === "win32") return null;
  const r = await rt.run("permissions", ["--files"]);
  const m = r.stdout.match(/Default files permissions:\s*([0-7]{3})/);
  if (m && /[1357]/.test(m[1])) {
    return `Downloaded files will be EXECUTABLE: MEGAcmd's file permissions are ${m[1]} (a file in a folder on PATH could then run in place of a program).`;
  }
  return null;
}
var SYNC_SEP = ";;MEGA-MCP;;";
async function syncRowsIntact(rt, listed, args) {
  const r = await rt.run("sync", [...args, `--col-separator=${SYNC_SEP}`]);
  const lines = (t) => t.split(/\r?\n/).filter((l) => l.trim() !== "").length;
  return r.code === 0 && lines(r.stdout) === lines(listed);
}
async function syncPairs(rt, unrunnable = null) {
  const r = await rt.run("sync", ["--output-cols=LOCALPATH,REMOTEPATH,RUN_STATE", `--col-separator=${SYNC_SEP}`]);
  if (r.spawnError) return r.spawnError === "NO_MEGACMD" ? unrunnable : null;
  if (r.code !== 0) return r.code === ExitCode.NOTFOUND ? [] : null;
  if (!await syncRowsIntact(rt, r.stdout, ["--output-cols=RUN_STATE"])) return null;
  const out = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.trim() === "" || line === `LOCALPATH${SYNC_SEP}REMOTEPATH${SYNC_SEP}RUN_STATE`) continue;
    const parts = line.split(SYNC_SEP);
    if (parts.length === 1) continue;
    if (parts.length !== 3) return null;
    const remote = parts[1].replace(/(.)\/+$/, "$1").normalize("NFC");
    out.push({ local: parts[0], remote: remote.startsWith("/") ? remote : `//from/${remote}`, running: parts[2].trim().toLowerCase() === "running" });
  }
  return out;
}
async function syncById(rt, id) {
  const r = await rt.run("sync", ["--show-handles", "--output-cols=ID,LOCALPATH,REMOTEHANDLE,REMOTEPATH,RUN_STATE", `--col-separator=${SYNC_SEP}`]);
  if (r.code === ExitCode.NOTFOUND) return null;
  if (r.code !== 0) return void 0;
  if (!await syncRowsIntact(rt, r.stdout, ["--show-handles", "--output-cols=ID,RUN_STATE"])) return void 0;
  let found = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    const parts = line.split(SYNC_SEP);
    if (parts.length === 1 || parts[0] === "ID") continue;
    if (parts.length !== 5) return void 0;
    const [sid, local, handle, remote, state] = parts.map((p, i) => i === 1 || i === 3 ? p : p.trim());
    if (sid !== id && local !== id) continue;
    if (found) return void 0;
    const h = handle.match(/^<(H:[A-Za-z0-9_-]{8})>$/)?.[1];
    if (!h) return void 0;
    const rp = remote.replace(/(.)\/+$/, "$1").normalize("NFC");
    found = { local, remote: rp.startsWith("/") ? rp : `//from/${rp}`, handle: h, running: state.toLowerCase() === "running" };
  }
  return found;
}
async function folderStillAt(rt, path, handle) {
  if (/^(?:\/|\/\/(?:bin|in))$/.test(path)) return true;
  const top = path.match(/^\/\/from\/[^/:]+:([^/]+)$/)?.[1];
  const r = await rt.run("find", [path, "--type=d", "--print-only-handles", `--pattern=${top ?? posix.basename(path)}`]);
  if (r.code !== 0) return false;
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() === handle;
}
async function localMirrorOf(rt, cloudPath) {
  return mirrorIn(await syncPairs(rt), cloudPath);
}
function mirrorIn(pairs, cloudPath) {
  if (!pairs) return void 0;
  const p = cloudPath.replace(/(.)\/+$/, "$1");
  for (const { local, remote } of pairs) {
    if (p === remote) return local;
    const prefix = remote === "/" ? "/" : `${remote}/`;
    if (p.startsWith(prefix)) return localOfCloud(local, p.slice(prefix.length).split("/"));
  }
  return null;
}
function localOfCloud(root, parts) {
  let cur = root;
  for (const part of parts) {
    const direct = joinLocal(cur, part);
    if (existsSync2(direct)) {
      cur = direct;
      continue;
    }
    let match;
    try {
      match = readdirSync2(cur).find((e) => cloudNameOf(e) === part.normalize("NFC"));
    } catch {
      match = void 0;
    }
    cur = joinLocal(cur, match ?? part);
  }
  return cur;
}
async function syncedSourceNotes(rt, paths, what) {
  const pairs = await syncPairs(rt, []);
  const lines = [];
  for (const p of paths) {
    const mirror = mirrorIn(pairs, p);
    if (mirror === void 0) {
      throw new ValidationError(`Could not read MEGAcmd's list of syncs, so whether ${what === "removed" ? "removing" : "moving"} ${p} also changes a folder on this computer is unknown. Nothing was run; try again.`);
    }
    if (!mirror) continue;
    if (isIgnoreFileName(posix.basename(p))) {
      throw new ValidationError(`${p} holds the rules of a synced folder (${mirror}); it is not ${what} through this tool.`);
    }
    try {
      assertDownloadTarget(dirnameLocal(mirror), basenameLocal(mirror));
    } catch {
      throw new ValidationError(
        `${p} is in a synced folder: this would also change ${mirror} on this computer, which is, holds or is inside a folder MEGAcmd, this connector or the app depends on. Nothing was run.`
      );
    }
    lines.push(`${p} is in a synced folder: it is also ${what} on this computer, at ${mirror}.`);
  }
  return listedLines(lines, (l) => l);
}
async function ignoreFilesBelow(rt, path) {
  const hits = [];
  let unchecked = false;
  for (const pattern of [".??????????*", "%2e*"]) {
    const r = await rt.run("find", [path, "--type=f", `--pattern=${pattern}`]);
    if (r.spawnError === "NO_MEGACMD") return null;
    if (r.spawnError) {
      unchecked = true;
      continue;
    }
    if (r.code === ExitCode.NOTFOUND) continue;
    if (r.code !== 0) unchecked = true;
    else hits.push(...r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && isIgnoreFileName(posix.basename(l))));
  }
  return { hits, unchecked };
}
async function assertNoNestedIgnoreFile(rt, remotePath) {
  const r = await ignoreFilesBelow(rt, remotePath);
  if (!r) return;
  if (r.unchecked) throw new ValidationError(`Could not check ${remotePath} for .megaignore files before syncing it.`);
  const base = remotePath.replace(/(.)\/+$/, "$1");
  const shown = base.startsWith("//from/") ? base.slice("//from/".length) : base;
  const hit = r.hits.find((l) => posix.dirname(l) !== shown);
  if (hit) throw new ValidationError(`${remotePath} holds ${hit}; a .megaignore below the root of a sync decides what it carries there, so remove it in the cloud before syncing.`);
}
async function syncRootsBelowCloud(rt, cloudPath) {
  const pairs = await syncPairs(rt, []);
  if (!pairs) return null;
  const p = cloudPath.replace(/(.)\/+$/, "$1");
  return pairs.filter((x) => x.remote !== p && under(x.remote, p)).map((x) => `${x.remote} <-> ${x.local}`);
}
async function syncLocalRoots(rt) {
  const pairs = await syncPairs(rt, []);
  return pairs ? pairs.map((p) => p.local) : null;
}
async function syncFollowLines(rt, sources, dst) {
  const pairs = await syncPairs(rt);
  const backups = await backupPairs(rt);
  const lines = /* @__PURE__ */ new Set();
  if (!pairs) lines.add("(Could not check whether a sync follows what is moved.)");
  if (!backups) lines.add("(Could not check whether a periodic backup follows what is moved.)");
  const bare = (p) => p.split("/").map((seg) => seg.trimEnd()).join("/");
  const tree = (p) => p.match(/^\/\/from\/[^/:]+/)?.[0] ?? "/";
  for (const raw of sources) {
    const src = raw.replace(/(.)\/+$/, "$1");
    for (const p of pairs ?? []) {
      if (!under(p.remote, src)) continue;
      if (tree(src) !== tree(dst)) {
        lines.add(`${p.remote} is two-way synced with ${p.local} on this computer: moved into ${dst}, it is copied and the original deleted, so that sync stops.`);
        continue;
      }
      lines.add(`${p.remote} is two-way synced with ${p.local} on this computer: the sync follows it into ${dst}, and what is saved there later goes there too.`);
      const writers = await writableAround(rt, dst);
      if (writers === null) throw new ValidationError(`Could not check who else can write into ${dst}. Nothing was run.`);
      for (const w of writers.filter((w2) => under(dst.replace(/(.)\/+$/, "$1"), w2))) {
        assertUnknownLandingSafe(p.local, `${w} can be written by other people, and what they add to the moved sync folder`);
      }
    }
    for (const b of backups ?? []) {
      if (b.remote !== null && under(bare(b.remote), bare(src))) lines.add(`${b.remote} receives periodic backups of ${b.local} from this computer: later backups follow it into ${dst}.`);
    }
  }
  return [...lines];
}
async function assertSyncedLanding(rt, cloudDir, names, inside = {}) {
  const mirror = await localMirrorOf(rt, cloudDir);
  if (mirror === void 0) {
    throw new ValidationError(`Could not read MEGAcmd's list of syncs, so whether ${cloudDir} is written to this computer (and where) is unknown. Nothing was run; try again.`);
  }
  if (!mirror) return;
  const listedHit = (inside.listed ?? []).find((p) => isIgnoreFileName(posix.basename(p)));
  if (listedHit) throw new ValidationError(`${listedHit} is a .megaignore, and in a two-way synced folder one decides what the sync carries, so it is not placed in ${cloudDir}.`);
  for (const src of inside.cloud ?? []) {
    await assertNoPendingIgnoreUpload(rt, src, `place ${src} in a synced folder`);
    const r = await ignoreFilesBelow(rt, src);
    if (!r || r.unchecked) throw new ValidationError(`Could not check ${src} for a .megaignore before placing it in a synced folder.`);
    const hit = r.hits[0];
    if (hit) throw new ValidationError(`${src} holds ${hit}, and in a two-way synced folder a .megaignore decides what the sync carries, so it is not placed in ${cloudDir}.`);
  }
  if (inside.local && inside.local.length > 0) {
    const r = ignoreFilesIn(inside.local);
    if (r.found.length > 0) throw new ValidationError(`${r.found[0]} is a .megaignore, and in a two-way synced folder one decides what the sync carries, so it is not uploaded into ${cloudDir}.`);
    if (!r.complete) throw new ValidationError(`Too many folders to search for a .megaignore before uploading into the synced folder ${cloudDir}; upload smaller folders.`);
  }
  if (names === "self") {
    assertNotIgnoreFile(mirror);
    for (const n of localSpellings(basenameLocal(mirror))) assertDownloadTarget(dirnameLocal(mirror), n);
  } else if (names === "unknown") {
    assertUnknownLandingSafe(mirror, `What arrives in ${cloudDir}`);
  } else {
    for (const name of names.flatMap(localSpellings)) {
      assertNotIgnoreFile(joinLocal(mirror, name));
      assertDownloadTarget(mirror, name);
    }
  }
}
async function transfersRunning(rt) {
  const r = await rt.run("transfers", ["--summary"]);
  if (r.spawnError === "NO_MEGACMD") return { downloads: 0, uploads: 0 };
  const row = r.code === 0 ? r.stdout.split(/\r?\n/)[1] ?? "" : "";
  const num = (from, to) => /^\s*\d+\s*$/.test(row.slice(from, to)) ? Number(row.slice(from, to)) : NaN;
  return { downloads: num(0, 16), uploads: num(53, 69) };
}
var expectedCloudIgnores = /* @__PURE__ */ new Set();
var unknownUploads = /* @__PURE__ */ new Set();
var expectedLocalIgnores = /* @__PURE__ */ new Set();
var unknownDownloads = /* @__PURE__ */ new Set();
function landingsOf(ld, name) {
  return localSpellings(name).map((n) => joinLocal(ld, n));
}
var ignoreDownloads = /* @__PURE__ */ new Set();
function noteUploadIgnores(files, unknownDirs) {
  for (const f of files) expectedCloudIgnores.add(f.replace(/(.)\/+$/, "$1"));
  for (const d of unknownDirs) unknownUploads.add(d.replace(/(.)\/+$/, "$1"));
}
function noteDownloadIgnores(files, unknownDirs, into = []) {
  for (const f of files) expectedLocalIgnores.add(f);
  if (files.length > 0) for (const d of into) ignoreDownloads.add(d);
  for (const d of unknownDirs) {
    unknownDownloads.add(d);
    ignoreDownloads.add(d);
  }
}
async function assertNoPendingIgnoreUpload(rt, rp, then = `sync ${rp}`) {
  const root = rp.replace(/(.)\/+$/, "$1");
  for (const f of [...expectedCloudIgnores]) {
    if (!under(f, root)) continue;
    const kind = await remoteKind(rt, f);
    if (kind === "file") continue;
    if (kind === "unknown" || await remoteKind(rt, posix.dirname(f)) !== "folder" || (await transfersRunning(rt)).uploads !== 0) {
      throw new ValidationError(`An upload from this session puts ${f} (a .megaignore) into ${rp} and it may still arrive (mega_transfers); ${then} once uploads have finished.`);
    }
  }
  if (unknownUploads.size > 0 && (await transfersRunning(rt)).uploads !== 0) {
    throw new ValidationError(`An upload of this session whose contents were not all checked may still be running (mega_transfers); ${then} once it has finished.`);
  }
}
var downloadedInto = /* @__PURE__ */ new Set();
function noteDownload(localDir) {
  downloadedInto.add(localDir);
}
function downloadedIntoLines(sources) {
  if (downloadedInto.size === 0) return [];
  const within = (a, b) => a === b || a.startsWith(b.endsWith(sepLocal) ? b : b + sepLocal);
  const real = sources.map((lp) => onDiskSpelling(lp));
  const hits = [...downloadedInto].filter((d) => {
    const rd = onDiskSpelling(d);
    return real.some((r) => within(rd, r) || within(r, rd));
  });
  return hits.length > 0 ? ["Downloaded into earlier in this session (what is uploaded may include it):", ...listedLines(hits.sort())] : [];
}
async function assertNoNestedLocalIgnoreFile(rt, lp) {
  const near = (d) => localAtOrUnder(d, lp) || localAtOrUnder(lp, d);
  for (const f of [...expectedLocalIgnores]) {
    if (!localAtOrUnder(f, lp)) continue;
    if (existsSync2(f)) {
      throw new ValidationError(`${f} is a .megaignore a download of this session put ${localAtOrUnder(lp, dirnameLocal(f)) ? "at the root of" : "below"} ${lp}; it would decide what the sync carries. Remove it (or check it yourself) before syncing.`);
    }
    if (!existsSync2(dirnameLocal(f)) || (await transfersRunning(rt)).downloads !== 0) {
      throw new ValidationError(`A download of this session puts ${f} (a .megaignore) below ${lp} and it may still arrive (mega_transfers); sync ${lp} once downloads have finished.`);
    }
  }
  const pending = [...unknownDownloads].filter(near);
  if (pending.length > 0 && (await transfersRunning(rt)).downloads !== 0) {
    throw new ValidationError(`A download into ${pending[0]} may still be running (mega_transfers); sync ${lp} once it has finished.`);
  }
  const nested = (found) => found.filter((f) => relative2(lp, dirnameLocal(f)) !== "");
  for (const d of ignoreDownloads) {
    if (!near(d)) continue;
    if (localAtOrUnder(lp, d) && rootIgnoreFile(lp)) {
      throw new ValidationError(`${rootIgnoreFile(lp)} may have been downloaded earlier in this session; as the root rules of the sync it decides what is carried. Remove it (or check it yourself) before syncing ${lp}.`);
    }
    const where = localAtOrUnder(d, lp) ? d : lp;
    const r = ignoreFilesIn([where]);
    const hit2 = nested(r.found)[0] ?? (r.complete ? null : where);
    if (hit2) throw new ValidationError(`${hit2} holds a .megaignore downloaded earlier in this session; below the root of a sync it decides what the sync carries, so ${lp} is not synced. Remove it first.`);
  }
  const hit = nested(ignoreFilesIn([lp]).found)[0];
  if (hit) throw new ValidationError(`${hit} is a .megaignore below the root of ${lp}; it would decide what the sync carries there, so ${lp} is not synced. Remove it first.`);
}
function assertUnknownLandingSafe(local, what) {
  let copy;
  try {
    assertNotInsideProtected(local);
    assertDownloadTarget(local, null);
    const r = storeCopiesIn(local);
    copy = r.found[0] ? `${r.found[0]}, a copy of MEGAcmd's session store` : r.complete ? void 0 : "folders that could not all be searched for a copy of MEGAcmd's session store";
  } catch {
    copy = void 0;
    throw new ValidationError(`${what} is written by a two-way sync to ${local} on this computer, which is, holds or is inside a folder MEGAcmd, this connector or the app depends on. Nothing was run.`);
  }
  if (copy) throw new ValidationError(`${what} is written by a two-way sync to ${local} on this computer, which holds ${copy}. Nothing was run.`);
}
async function writableAround(rt, cloudPath, atOrBelow = false) {
  const p = cloudPath.replace(/(.)\/+$/, "$1");
  const share = p.match(/^\/\/from\/[^/]+/)?.[0];
  if (share) return [share];
  const root = (p.match(/^\/\/(?:bin|in)(?=\/|$)/) ?? ["/"])[0];
  const out = [];
  const near = (w) => !atOrBelow && under(p, w) || under(w, p);
  for (const cmd of ["share", "export"]) {
    const r = await rt.run(cmd, cmd === "share" ? ["-p", root] : [root]);
    if (r.spawnError === "NO_MEGACMD" || r.code === ExitCode.NOTFOUND) continue;
    if (r.spawnError) return null;
    if (r.code !== 0) return null;
    for (const raw of r.stdout.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line.trim() || /^\s/.test(raw)) continue;
      const path = cmd === "share" ? sharePathOf(line) : exportPathOf(line);
      if (!path || !path.startsWith("/")) return null;
      const w = path.replace(/(.)\/+$/, "$1").normalize("NFC");
      if (!near(w)) continue;
      const writable = cmd === "share" ? !/\(read access\)(?:\[UNVERIFIED\])?$/.test(line) : /\bAuth(?:Token|Key)\b/.test(line);
      if (writable) out.push(w);
    }
  }
  return out;
}
async function assertNoWritersReach(rt, rp, lp) {
  const writers = await writableAround(rt, rp);
  if (writers === null) throw new ValidationError(`Could not check who else can write into ${rp}. Nothing was run.`);
  const root = rp.replace(/(.)\/+$/, "$1");
  for (const w of writers) {
    const local = under(root, w) ? lp : localOfCloud(lp, w.slice(root === "/" ? 1 : root.length + 1).split("/"));
    assertUnknownLandingSafe(local, `${w} can be written by other people, and what they add there`);
  }
}
function rootIgnoreFile(lp) {
  try {
    const n = readdirSync2(lp).find((e) => isIgnoreFileName(e));
    return n ? joinLocal(lp, n) : null;
  } catch {
    return null;
  }
}
async function movedIntoSyncedLines(rt, sources, d, into) {
  const mirror = await localMirrorOf(rt, d);
  if (mirror === void 0) return ["(Could not check whether the destination is in a synced folder.)"];
  if (!mirror) return [];
  const lines = [];
  for (const raw of sources) {
    const src = raw.replace(/(.)\/+$/, "$1");
    const local = into ? localOfCloud(mirror, [posix.basename(src).replace(/^[^:]*:/, "")]) : mirror;
    const writers = await writableAround(rt, src, true);
    if (writers === null) throw new ValidationError(`Could not check who else can write into ${src}. Nothing was run.`);
    for (const w of writers) {
      assertUnknownLandingSafe(w === src ? local : localOfCloud(local, w.slice(src.length + 1).split("/")), `${w} can be written by other people, and moved into the synced folder, what they add`);
    }
    const self = await destinationNotes(rt, src);
    const own = self.filter((n) => n.startsWith(`${src} is shared with other people`) || n.startsWith(`${src} has a public link`));
    for (const n of [...own, ...await sharedBelowNotes(rt, src)]) {
      lines.push(`Moved into the synced folder ${mirror}: ${n}`);
    }
  }
  return lines;
}
async function inSyncedLocalFolder(rt, localPath) {
  const pairs = await syncPairs(rt);
  if (!pairs) return void 0;
  return pairs.some(({ local }) => localAtOrUnder(localPath, local));
}
function chunkArgs(items, maxCount = 2e3, others) {
  const cost = (a) => Buffer.byteLength(a) + (process.platform === "win32" ? 8 : 4);
  const maxBytes = others ? 7600 - others.reduce((n, a) => n + cost(a), 0) : 6e3;
  const out = [];
  for (let i = 0; i < items.length; ) {
    let j = i;
    let bytes = 0;
    while (j < items.length && j - i < maxCount && (j === i || bytes + cost(items[j]) <= maxBytes)) {
      bytes += cost(items[j]);
      j++;
    }
    out.push(items.slice(i, j));
    i = j;
  }
  return out;
}
async function childNames(rt, dir) {
  const r = await rt.run("ls", [dir]);
  if (r.code !== 0) return null;
  return new Set(r.stdout.split(/\r?\n/).filter((l) => l !== ""));
}
var unconfirmedWrites = [];
var keyCopies = [];
function noteKeyCopy(from, to, shownAs = from) {
  const path = to.replace(/(.)\/+$/, "$1");
  if (!isRecoveryKeyName(posix.basename(from.replace(/(.)\/+$/, "$1"))) || isRecoveryKeyName(posix.basename(path)) || keyCopies.some((k) => k.path === path)) return;
  if (keyCopies.length >= MAX_TRACKED) {
    trackingIncomplete = true;
    return;
  }
  keyCopies.push({ path, source: shownAs });
}
var MAX_TRACKED = 2e4;
var trackingIncomplete = false;
function noteUnconfirmedWrite(entries) {
  for (const e of entries) {
    if (unconfirmedWrites.length >= MAX_TRACKED) {
      trackingIncomplete = true;
      return;
    }
    unconfirmedWrites.push({ path: e.path, source: e.source });
  }
}
var under = (p, folder) => {
  const f = folder.replace(/(.)\/+$/, "$1");
  return p === f || p.startsWith(f === "/" ? "/" : `${f}/`);
};
function unconfirmedWritesIn(folder) {
  const f = folder.replace(/(.)\/+$/, "$1");
  const hits = unconfirmedWrites.filter((w) => under(w.path, f) || under(f, w.path)).map(
    (w) => under(w.path, f) ? w.source ? `${w.path} (a copy of ${w.source})` : w.path : `${f} is inside ${w.path}${w.source ? `, a copy of ${w.source}` : ""}`
  );
  return [...new Set(hits)];
}
function carryUnconfirmedWrites(from, to, move) {
  const f = from.replace(/(.)\/+$/, "$1");
  for (const w of [...unconfirmedWrites]) {
    if (!under(w.path, f)) continue;
    const moved = to.replace(/(.)\/+$/, "$1") + w.path.slice(f.length);
    if (move) w.path = moved;
    else noteUnconfirmedWrite([{ path: moved, source: w.source }]);
  }
  for (const k of [...keyCopies]) {
    if (!under(k.path, f)) continue;
    const moved = to.replace(/(.)\/+$/, "$1") + k.path.slice(f.length);
    if (move) k.path = moved;
    else if (!keyCopies.some((x) => x.path === moved)) keyCopies.push({ path: moved, source: k.source });
  }
  for (const c of [...sessionChanges]) {
    if (!under(c.path, f)) continue;
    const moved = to.replace(/(.)\/+$/, "$1") + c.path.slice(f.length);
    if (move) c.path = moved;
    else noteSessionChange(moved, c.what);
  }
  for (const e of [...expectedCloudIgnores]) {
    if (under(e, f)) expectedCloudIgnores.add(to.replace(/(.)\/+$/, "$1") + e.slice(f.length));
  }
}
var sessionChanges = [];
function noteSessionChange(path, what) {
  if (sessionChanges.length >= MAX_TRACKED) {
    trackingIncomplete = true;
    return;
  }
  sessionChanges.push({ path: path.replace(/(.)\/+$/, "$1"), what });
}
function unconfirmedWriteLines(folders) {
  const list = typeof folders === "string" ? [folders] : folders;
  const hits = [...new Set(list.flatMap((f) => unconfirmedWritesIn(f)))];
  const changed = [
    ...new Set(
      list.flatMap((raw) => {
        const f = raw.replace(/(.)\/+$/, "$1");
        return sessionChanges.filter((c) => under(c.path, f) || under(f, c.path)).map((c) => `${c.path}: ${c.what}`);
      })
    )
  ];
  return [
    ...hits.length > 0 ? ["Placed in it earlier in this session without a confirmation:", ...listedLines(hits)] : [],
    ...changed.length > 0 ? ["Changed in it earlier in this session:", ...listedLines(changed)] : [],
    ...trackingIncomplete ? ["(More was placed in private folders without a confirmation than this session can track: check the contents before sharing.)"] : []
  ];
}
function recoveryKeyLines(paths, found = []) {
  const hits = new Set(found);
  for (const raw of paths) {
    const p = raw.replace(/(.)\/+$/, "$1");
    if (isRecoveryKeyName(posix.basename(p))) hits.add(p);
    for (const w of unconfirmedWrites) {
      if (w.source && isRecoveryKeyName(posix.basename(w.source)) && (under(w.path, p) || under(p, w.path))) hits.add(`${w.path} (a copy of ${w.source})`);
    }
    for (const k of keyCopies) if (under(k.path, p) || under(p, k.path)) hits.add(`${k.path} (a copy of ${k.source})`);
  }
  return hits.size > 0 ? ["Named like MEGA's recovery key file, which holds the account's master key:", ...listedLines([...hits])] : [];
}
async function recoveryKeyLinesBelow(rt, paths) {
  const found = [];
  let unchecked = false;
  for (const chunk of chunkArgs(paths)) {
    for (const pattern of ["????-*", "*-????*"]) {
      const r = await rt.run("find", [...chunk, "--type=f", `--pattern=${pattern}`], { maxBuffer: 128 * 1024 * 1024 });
      if (r.spawnError === "NO_MEGACMD") continue;
      if (r.spawnError || r.code !== 0 && r.code !== ExitCode.NOTFOUND) unchecked = true;
      for (const line of r.stdout.split(/\r?\n/).map((l) => l.trim())) {
        if (line && isRecoveryKeyName(posix.basename(line))) found.push(line.startsWith("/") ? line : `//from/${line}`);
      }
    }
  }
  return [...recoveryKeyLines(paths, found), ...unchecked ? ["(Could not check everything inside for MEGA's recovery key file.)"] : []];
}
async function remoteKind(rt, path) {
  const r = await rt.run("find", [path, "--type=d", "--print-only-handles"]);
  if (r.code === ExitCode.NOTFOUND) return "missing";
  if (r.code !== 0) return "unknown";
  return r.stdout.trim() ? "folder" : "file";
}
function ancestorsOf(p) {
  const special = p.match(/^(\/\/(?:bin|in))(?=\/|$)/)?.[1];
  const base = special ?? "";
  const parts = p.slice(base.length).replace(/\/+$/, "").split("/").filter(Boolean);
  return [special ?? "/", ...parts.map((_, i) => `${base}/${parts.slice(0, i + 1).join("/")}`)];
}
async function listedPaths(rt, cmd, root, pathOf) {
  const r = await rt.run(cmd, cmd === "share" ? ["-p", root] : [root]);
  if (r.spawnError) return null;
  if (r.code === ExitCode.NOTFOUND) return /* @__PURE__ */ new Set();
  if (r.code !== 0) return null;
  const paths = /* @__PURE__ */ new Set();
  for (const raw of r.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\s/.test(raw)) continue;
    const p = line.startsWith("/") ? pathOf(line) : null;
    if (!p) return null;
    paths.add(p.replace(/(.)\/+$/, "$1").normalize("NFC"));
  }
  return paths;
}
function ownExportLink(stdout, path) {
  const p = path.replace(/(.)\/+$/, "$1");
  const shown = p.startsWith("//from/") ? p.slice("//from/".length) : p;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const i = openingBracket(line);
    if (i > 0 && line.slice(0, i).replace(/ $/, "") === shown && line.slice(i).includes("exported")) return parseExportLink(line.slice(i))?.replace(/\)+$/, "") ?? null;
  }
  return null;
}
async function syncedWithinLines(rt, targets, what) {
  const pairs = await syncPairs(rt);
  const backups = await backupPairs(rt);
  const list = typeof targets === "string" ? [targets] : targets;
  const lines = /* @__PURE__ */ new Set();
  if (!pairs) lines.add(`(Could not check whether ${list.length === 1 ? list[0] : "these"} is synced with this computer.)`);
  if (!backups) lines.add(`(Could not check whether a periodic backup writes into ${list.length === 1 ? list[0] : "these"}.)`);
  for (const raw of list) {
    const t = raw.replace(/(.)\/+$/, "$1");
    for (const p of pairs ?? []) {
      if (under(p.remote, t) || under(t, p.remote)) lines.add(`${p.remote} is two-way synced with ${p.local} on this computer: what is saved there later is ${what} too.`);
    }
    const bare = (p) => p.split("/").map((seg) => seg.trimEnd()).join("/");
    for (const b of backups ?? []) {
      if (b.remote !== null && under(bare(b.remote), bare(t))) lines.add(`${b.remote} receives periodic backups of ${b.local} from this computer: later backups are ${what} too.`);
    }
  }
  return [...lines];
}
async function writableShareLines(rt, targets, email, instead = "share it read-only instead") {
  const pairs = await syncPairs(rt);
  if (!pairs) throw new ValidationError(`Could not read MEGAcmd's list of syncs, so whether what ${email} adds is written to this computer is unknown. Nothing was run.`);
  const lines = /* @__PURE__ */ new Set();
  for (const raw of targets) {
    const t = raw.replace(/(.)\/+$/, "$1");
    for (const p of pairs) {
      const local = under(p.remote, t) ? p.local : under(t, p.remote) ? mirrorIn([p], t) : null;
      if (!local) continue;
      assertUnknownLandingSafe(local, `What ${email} adds to ${t} (${instead})`);
      lines.add(`${email} can add files to ${t}: the two-way sync writes them to ${local} on this computer.`);
    }
    for (const l of await backupFoldersWithinLines(rt, t, `${email} can add items to`)) lines.add(l);
  }
  return [...lines];
}
async function backupFoldersWithinLines(rt, folder, what) {
  const backups = await backupPairs(rt);
  if (!backups) return [`(Could not check whether a periodic backup keeps its copies in ${folder}.)`];
  const bare = (p) => p.replace(/(.)\/+$/, "$1").split("/").map((seg) => seg.trimEnd()).join("/").normalize("NFC");
  return backups.filter((b) => b.remote !== null && under(bare(b.remote), bare(folder))).map((b) => `${what} ${b.remote}, where the periodic backup of ${b.local} keeps its copies: an item named like ${backupNamesOf(b.local)[0]}_bk_<date> there counts as one of them, and beyond the kept count the oldest are DELETED for good by the next backup run.`);
}
async function backupRotationLines(rt, parent, names) {
  return backupRotationLinesAt(rt, names.map((n) => joinRemote(parent, n)));
}
function backupNamesOf(local) {
  let aux = local;
  let found = aux.search(/[/\\][^/\\]*$/);
  while (aux.length > 0 && found === aux.length - 1) {
    aux = aux.slice(0, Math.max(found - 1, 0));
    found = aux.search(/[/\\][^/\\]*$/);
  }
  return [...new Set([aux.slice(found + 1), basenameLocal(local)].filter((n) => n !== "").map((n) => n.normalize("NFC")))];
}
async function backupRotationLinesAt(rt, paths) {
  const named = paths.map((p) => p.replace(/(.)\/+$/, "$1")).filter((p) => posix.basename(p).includes("_bk_"));
  if (named.length === 0) return [];
  const backups = await backupPairs(rt);
  if (!backups) return ["(Could not check whether the destination is a periodic backup's folder.)"];
  const bare = (p) => p.split("/").map((seg) => seg.trimEnd()).join("/").normalize("NFC");
  const lines = [];
  for (const b of backups) {
    if (b.remote === null) continue;
    const bases = backupNamesOf(b.local);
    for (const p of named.filter((p2) => bare(posix.dirname(p2)) === bare(b.remote) && bases.some((base) => posix.basename(p2).normalize("NFC").startsWith(base)))) {
      lines.push(`${p} would count as a backup copy of ${b.local}: beyond the kept count, the oldest are DELETED for good by the next backup run.`);
    }
  }
  return lines;
}
async function backupFolderLines(rt, folder) {
  const backups = await backupPairs(rt);
  if (!backups) return ["(Could not check whether the destination is a periodic backup's folder.)"];
  const bare = (p) => p.replace(/(.)\/+$/, "$1").split("/").map((seg) => seg.trimEnd()).join("/").normalize("NFC");
  return backups.filter((b) => b.remote !== null && bare(b.remote) === bare(folder)).map((b) => `${folder} is where the periodic backup of ${b.local} keeps its copies: an item named like ${backupNamesOf(b.local)[0]}_bk_<date> counts as one of them, and beyond the kept count the oldest are DELETED for good by the next backup run.`);
}
async function backupLocalRoots(rt) {
  const r = await backupPairs(rt, []);
  return r ? r.map((b) => b.local) : null;
}
async function syncSnapshot(rt) {
  return JSON.stringify([await syncPairs(rt, []), await backupPairs(rt, [])]);
}
async function backupPairs(rt, unrunnable = null) {
  const width = 4096;
  const r = await rt.run("backup", [`--path-display-size=${width}`]);
  if (r.spawnError) return r.spawnError === "NO_MEGACMD" ? unrunnable : null;
  if (r.code !== 0) return r.code === ExitCode.NOTFOUND ? [] : null;
  const out = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.trim() === "" || /^\s/.test(line) || line.startsWith("TAG") || line.startsWith("BACKUP not found")) continue;
    const cells = line.split(/ {64,}/);
    if (cells.length !== 3 || !/^-?\d+ /.test(cells[0])) return null;
    const local = cells[0].replace(/^-?\d+ +/, "");
    const remote = cells[1].trimEnd();
    if (remote === "INVALIDPATH") {
      out.push({ local, remote: null });
      continue;
    }
    if (!remote.startsWith("/") && !remote.includes(":")) return null;
    out.push({ local, remote: (remote.startsWith("/") ? remote : `//from/${remote}`).normalize("NFC") });
  }
  return out;
}
async function contentDigest(rt, path) {
  const r = await rt.run("find", [path, "--print-only-handles"], { maxBuffer: 128 * 1024 * 1024 });
  if (r.code === ExitCode.NOTFOUND) return "missing";
  if (r.spawnError === "NO_MEGACMD") return "unavailable";
  if (r.code !== 0) throw new ValidationError(`Could not list what ${path} holds: ${classifyExit(r)}. Nothing was run.`);
  const handles = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).sort();
  return createHash("sha256").update(handles.join("\n")).digest("hex");
}
async function syncedLocalLines(rt, localPath) {
  return [...await twoWaySyncedLines(rt, localPath), ...await backedUpLines(rt, localPath)];
}
async function twoWaySyncedLines(rt, localPath) {
  const pairs = await syncPairs(rt);
  if (!pairs) return [`(Could not check whether ${localPath} is in a two-way synced folder.)`];
  const pair = pairs.find((p) => localAtOrUnder(localPath, p.local));
  if (!pair) return [];
  const rel = relativeWithin(onDiskSpelling(pair.local), onDiskSpelling(localPath));
  if (rel === null) {
    throw new ValidationError(`${localPath} is in the two-way synced folder ${pair.local}, but where in it could not be worked out, so where the sync uploads it is unknown. Use the usual spelling of the folder.`);
  }
  const cloud = rel ? joinRemote(pair.remote, rel.split("/").map(cloudNameOf).join("/")) : pair.remote;
  const notes = (await destinationNotes(rt, cloud)).filter((n) => !n.includes(" is in a synced folder: "));
  return [`${localPath} is in a two-way synced folder: what is downloaded there is also uploaded to ${cloud}.`, ...notes, ...await sharedBelowNotes(rt, cloud)];
}
async function backedUpLines(rt, localPath) {
  const backups = await backupPairs(rt);
  if (!backups) return [`(Could not check whether ${localPath} is backed up periodically.)`];
  const lines = [];
  const bare = (p) => p.split(/([\\/])/).map((seg) => seg.trimEnd()).join("");
  for (const b of backups.filter((b2) => localAtOrUnder(localPath, b2.local) || localAtOrUnder(bare(localPath), b2.local))) {
    if (b.remote === null) continue;
    lines.push(`${localPath} is backed up periodically to ${b.remote}: the next backup uploads what arrives there.`);
    const notes = await remoteKind(rt, b.remote) === "missing" ? [`(Could not check whether ${b.remote} - as MEGAcmd lists it - is shared or has a public link.)`] : await destinationNotes(rt, b.remote, { backups: false });
    for (const n of notes) if (!lines.includes(n)) lines.push(n);
  }
  return lines;
}
async function contentDigestMany(rt, paths) {
  if (paths.length === 1) return contentDigest(rt, paths[0]);
  const handles = [];
  for (const chunk of chunkArgs(paths)) {
    const r = await rt.run("find", [...chunk, "--print-only-handles"], { maxBuffer: 128 * 1024 * 1024 });
    if (r.code !== 0) return (await Promise.all(paths.map((p) => contentDigest(rt, p)))).join(",");
    handles.push(...r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  }
  return createHash("sha256").update(handles.sort().join("\n")).digest("hex");
}
var writeChain = Promise.resolve();
function withWriteLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => void 0,
    () => void 0
  );
  return run;
}
function openingBracket(line) {
  if (!line.endsWith(")")) return -1;
  let depth = 0;
  for (let i = line.length - 1; i >= 0; i--) {
    if (line[i] === ")") depth++;
    else if (line[i] === "(" && --depth === 0) return i;
  }
  return -1;
}
async function ensureRemoteFolder(rt, path) {
  if (path.startsWith("//")) return "error";
  const target = path.replace(/(.)\/+$/, "$1");
  const r = await rt.run("mkdir", ["-p", target]);
  if (r.code === 0) return "folder";
  const leaf = target.slice(target.lastIndexOf("/") + 1);
  const names = `(?:${escapeRegExp(leaf)}|${escapeRegExp(target)})`;
  const line = (kind) => new RegExp(`(?:^|\\s)${kind} already exists: ${names}\\]?\\s*$`, "m");
  if (line("Folder").test(r.stderr)) return "folder";
  if (line("File").test(r.stderr)) return "file";
  return "error";
}
function escapeRegExp(v) {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function guardRun(fn) {
  return fn().catch(
    (e) => e instanceof ValidationError ? err(e.message) : err(`Internal error: ${e instanceof Error ? e.message : String(e)}`)
  );
}
async function runToResult(rt, cmd, args, onSuccess) {
  const r = await rt.run(cmd, args);
  if (r.code !== 0) return err(classifyExit(r), { ok: false, code: r.code });
  return onSuccess(r);
}
var CONTROL_ESCAPES = {
  "\n": "\\n",
  "\r": "\\r",
  "	": "\\t",
  "\x1B": "\\e"
};
function previewSafe(v) {
  return v.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, (c) => {
    const code = c.codePointAt(0);
    return CONTROL_ESCAPES[c] ?? (code <= 255 ? `\\x${code.toString(16).padStart(2, "0")}` : code <= 65535 ? `\\u${code.toString(16).padStart(4, "0")}` : `\\u{${code.toString(16)}}`);
  });
}
function checkConfirm(rt, action, normArgs, confirm, rawSummary) {
  const summary = Array.isArray(rawSummary) ? rawSummary.map(previewSafe).join("\n") : previewSafe(rawSummary);
  if (!confirm) {
    const token = rt.confirm.issue(action, normArgs);
    return ok(
      `${summary}

This action requires confirmation. To proceed, call ${action} again with "confirm" set to:
${token}`,
      { requiresConfirmation: true, confirmToken: token, summary }
    );
  }
  if (!rt.confirm.consume(action, normArgs, confirm)) {
    return err(
      'Confirmation token is invalid or expired. Re-run the tool without "confirm" to get a fresh token, then confirm.'
    );
  }
  return null;
}

export {
  ExitCode,
  redact,
  classifyExit,
  ValidationError,
  localAtOrUnder,
  publishMegacmdBinDir,
  isIgnoreFileName,
  isRecoveryKeyName,
  cloudNameOf,
  decodeLocalName,
  assertNotIgnoreFile,
  assertDownloadTarget,
  linksBelow,
  assertNoLocalGlob,
  storeCopiesIn,
  ignoreFilesIn,
  assertSecret,
  assertRemotePath,
  assertRemoteDest,
  assertNoHandleName,
  assertNoVersionName,
  assertOptionalRemotePath,
  assertNoFlag,
  assertFlagValue,
  assertConstraint,
  assertNoWildcard,
  assertLocalPath,
  assertNoStoreWithin,
  syncExclusions,
  onDiskSpelling,
  joinRemote,
  planUpload,
  globCanMatchStoreName,
  assertNotStoreCopy,
  storeCopyIn,
  ok,
  err,
  parseExportLink,
  parseCreatedLink,
  listedLines,
  pcreMatchPreview,
  secretBinding,
  localNamesOf,
  pcreGate,
  runPerHandle,
  runBulk,
  assertNoStoreCopyBelowMany,
  assertNoStoreCopyBelow,
  assertNoFoldTwinBelow,
  sharedBelowNotes,
  destinationNotes,
  sameNamed,
  sameNamedMany,
  executableDownloadNote,
  syncById,
  folderStillAt,
  syncedSourceNotes,
  ignoreFilesBelow,
  assertNoNestedIgnoreFile,
  syncRootsBelowCloud,
  syncLocalRoots,
  syncFollowLines,
  assertSyncedLanding,
  landingsOf,
  noteUploadIgnores,
  noteDownloadIgnores,
  assertNoPendingIgnoreUpload,
  noteDownload,
  downloadedIntoLines,
  assertNoNestedLocalIgnoreFile,
  assertNoWritersReach,
  rootIgnoreFile,
  movedIntoSyncedLines,
  inSyncedLocalFolder,
  chunkArgs,
  childNames,
  noteKeyCopy,
  noteUnconfirmedWrite,
  carryUnconfirmedWrites,
  noteSessionChange,
  unconfirmedWriteLines,
  recoveryKeyLines,
  recoveryKeyLinesBelow,
  remoteKind,
  ownExportLink,
  syncedWithinLines,
  writableShareLines,
  backupFoldersWithinLines,
  backupRotationLines,
  backupNamesOf,
  backupRotationLinesAt,
  backupFolderLines,
  backupLocalRoots,
  syncSnapshot,
  contentDigest,
  syncedLocalLines,
  contentDigestMany,
  withWriteLock,
  ensureRemoteFolder,
  guardRun,
  runToResult,
  previewSafe,
  checkConfirm,
  helpers_exports
};
