import {
  external_exports
} from "./chunk-DHDCAI5Q.js";
import {
  ExitCode,
  ValidationError,
  assertDownloadTarget,
  assertFlagValue,
  assertLocalPath,
  assertNoFlag,
  assertNoHandleName,
  assertNoLocalGlob,
  assertNoStoreCopyBelow,
  assertNoStoreCopyBelowMany,
  assertNoVersionName,
  assertNoWildcard,
  assertNotIgnoreFile,
  assertNotStoreCopy,
  assertOptionalRemotePath,
  assertRemoteDest,
  assertRemotePath,
  assertSecret,
  assertSyncedLanding,
  backupFoldersWithinLines,
  backupLocalRoots,
  backupRotationLines,
  backupRotationLinesAt,
  carryUnconfirmedWrites,
  checkConfirm,
  childNames,
  chunkArgs,
  classifyExit,
  cloudNameOf,
  contentDigest,
  contentDigestMany,
  decodeLocalName,
  destinationNotes,
  downloadedIntoLines,
  ensureRemoteFolder,
  err,
  executableDownloadNote,
  guardRun,
  ignoreFilesBelow,
  ignoreFilesIn,
  inSyncedLocalFolder,
  isIgnoreFileName,
  isRecoveryKeyName,
  joinRemote,
  landingsOf,
  linksBelow,
  listedLines,
  localAtOrUnder,
  localNamesOf,
  movedIntoSyncedLines,
  noteDownload,
  noteDownloadIgnores,
  noteKeyCopy,
  noteSessionChange,
  noteUnconfirmedWrite,
  noteUploadIgnores,
  ok,
  onDiskSpelling,
  ownExportLink,
  parseCreatedLink,
  parseExportLink,
  pcreGate,
  pcreMatchPreview,
  planUpload,
  previewSafe,
  recoveryKeyLines,
  recoveryKeyLinesBelow,
  remoteKind,
  runBulk,
  runPerHandle,
  runToResult,
  sameNamed,
  sameNamedMany,
  secretBinding,
  sharedBelowNotes,
  storeCopiesIn,
  storeCopyIn,
  syncFollowLines,
  syncLocalRoots,
  syncRootsBelowCloud,
  syncSnapshot,
  syncedLocalLines,
  syncedSourceNotes,
  syncedWithinLines,
  unconfirmedWriteLines,
  withWriteLock,
  writableShareLines
} from "./chunk-7XY2MXSI.js";
import {
  __export
} from "./chunk-WQ2VWL36.js";

// src/tools/mutate.ts
var mutate_exports = {};
__export(mutate_exports, {
  registerMutate: () => registerMutate
});
import { posix, basename, dirname, join as joinLocal, relative, sep } from "node:path";
import { statSync, lstatSync, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync } from "node:fs";

// src/argv.ts
function serializeLikeClient(words) {
  return words.map((w) => w.includes(" ") || w === "" ? `"${w}"` : w).join(" ");
}
function splitLikeServer(line) {
  const words = [];
  const n = line.length;
  const at = (k) => k < n ? line[k] : "\0";
  let i = 0;
  for (; ; ) {
    while (i < n && line.charCodeAt(i) > 0 && line.charCodeAt(i) <= 32) i++;
    if (at(i) === "\0") break;
    const c = at(i);
    if (c === '"' || c === "'") {
      i++;
      let w = i;
      let word = "";
      for (; ; ) {
        const ch = at(i);
        if (ch === c || ch === "\\" || ch === "\0") {
          word += line.slice(w, i);
          if (ch === "\0") break;
          i++;
          if (ch === c) break;
          w = i - 1;
        } else {
          i++;
        }
      }
      words.push(word);
    } else {
      while (at(i) === " ") i++;
      const w = i;
      let prev = i;
      while (at(i) !== "\0" && !(at(i) === " " && at(prev) !== "\\")) {
        if (at(i) === '"' && at(i + 1) !== "\0") {
          do {
            i++;
          } while (at(i) !== '"' && at(i + 1) !== "\0");
        }
        prev = i;
        i++;
      }
      words.push(line.slice(w, i));
    }
  }
  return words;
}
function survivesRoundTrip(words) {
  const back = splitLikeServer(serializeLikeClient(words));
  return back.length === words.length && back.every((w, i) => w === words[i]);
}
function isPublicLink(link) {
  return link.startsWith("http") && (link.includes("#") || link.includes("/file/") || link.includes("/folder/"));
}

// src/tools/mutate.ts
var PUT_CHUNK = 200;
function assertPublicLink(link) {
  if (!isPublicLink(link)) {
    throw new ValidationError("link must be a MEGA public link (https://mega.nz/file/... or /folder/...). For a path in your account, use remotePath.");
  }
  return link;
}
function uploadName(name, lps, rp) {
  if (lps.length !== 1) throw new ValidationError("name works with a single item only.");
  const n = assertNoFlag(name, "name").normalize("NFC");
  if (n === "" || n === "." || n === ".." || /[\\/]/.test(n) || /#\d{10}$/.test(n) || /^H:[A-Za-z0-9_-]{8}$/.test(n)) {
    throw new ValidationError('name must be a plain file or folder name, without "/".');
  }
  if (decodeLocalName(n) !== n.normalize("NFC")) throw new ValidationError("name may not contain %-escapes such as %2e.");
  assertNotStoreCopy(`${rp.replace(/\/+$/, "")}/${n}`);
  return n;
}
async function versionTarget(rt, src, d) {
  if (posix.dirname(src).split("/").some((seg) => /#\d{10}$/.test(seg))) {
    throw new ValidationError("src may name a file version only in its last part.");
  }
  const plain = versionPlainName(posix.basename(src)) ?? void 0;
  if (plain === void 0) return d;
  if (/#\d{10}$/.test(plain)) throw new ValidationError("src names a version of a name that itself reads as a version.");
  const kind = await remoteKind(rt, d);
  if (kind === "unknown") throw new ValidationError(`Could not check what ${d} is; nothing was copied.`);
  const target = kind === "folder" ? joinRemote(d, plain.normalize("NFC")) : d.replace(/(.)\/+$/, "$1");
  if (await remoteKind(rt, target) === "folder") {
    throw new ValidationError(`${target} is a folder: a file version is copied or moved onto a file name. Choose another dst.`);
  }
  if (target === joinRemote(posix.dirname(src), plain.normalize("NFC"))) {
    throw new ValidationError(`${target} is the file this version belongs to: copying onto it would delete it and all its versions for good. Copy the version to another name (or folder) instead.`);
  }
  return target;
}
async function assertOneDestination(rt, d) {
  assertNoWildcard(d, "dst");
  const same = await sameNamed(rt, d);
  if (same.count > 1) {
    throw new ValidationError(`${same.count} items are named ${d} (there, or in a same-named folder above it); MEGAcmd would write to the first one only. Rename or move one first.`);
  }
  if (same.count < 0) throw new ValidationError(`Could not check how many items are named ${d}; nothing was run.`);
}
function versionPlainName(name) {
  const m = name.match(/^(.+)#\d{10}$/);
  return m && Buffer.byteLength(name) > 12 ? m[1] : null;
}
function isLocalDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
function treeOf(p) {
  return p.match(/^\/\/from\/[^/:]+/)?.[0] ?? "/";
}
async function crossTreeCollisions(rt, sources, d, dKind) {
  const cross = sources.filter((s) => treeOf(s) !== treeOf(d));
  if (cross.length === 0) return [];
  if (dKind !== "folder") {
    throw new ValidationError(`${cross[0]} and ${d} are in different trees (your drive and a share to you): such a move cannot rename or replace. Move it into an existing folder, then rename it there.`);
  }
  const listed = await childNames(rt, d);
  if (!listed) return [`(Could not check what is in ${d}.)`];
  const here = new Set([...listed].map((n) => n.normalize("NFC")));
  const lines = [];
  for (const s of cross) {
    const n = posix.basename(s).normalize("NFC");
    if (here.has(n) && (await remoteKind(rt, joinRemote(d, n)) !== "folder" || await fileNamedIn(rt, d, n))) {
      lines.push(`${joinRemote(d, n)} already exists: the moved item becomes its new version (the current one is kept as an older version only while file versioning is on); if the two have the same content, nothing is copied and ${s} is deleted for good together with all its older versions.`);
    }
  }
  return lines;
}
async function fileNamedIn(rt, d, n) {
  const r = await rt.run("find", [d, `--pattern=${n}`, "--type=f"]);
  if (r.code !== 0) return r.code !== ExitCode.NOTFOUND;
  return r.stdout.split(/\r?\n/).some((l) => {
    const shown = l.trim() === "" ? "" : l;
    const p = shown.startsWith("/") || shown === "" ? shown : `//from/${shown}`;
    return p !== "" && posix.dirname(p) === d.replace(/(.)\/+$/, "$1") && posix.basename(p).normalize("NFC") === n;
  });
}
function assertImageFile(path) {
  const head = Buffer.alloc(12);
  let n = 0;
  try {
    if (!statSync(path).isFile()) throw new ValidationError(`${path} is not a regular file, so it is not used as a thumbnail.`);
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError(`${path} cannot be read, so it is not used as a thumbnail.`);
  }
  try {
    const fd = openSync(path, "r");
    try {
      n = readSync(fd, head, 0, 12, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new ValidationError(`${path} cannot be read, so it is not used as a thumbnail.`);
  }
  const b = head.subarray(0, n);
  const isImage = b[0] === 255 && b[1] === 216 && b[2] === 255 || b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || b.subarray(0, 4).toString("latin1") === "GIF8" || b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
  if (!isImage) throw new ValidationError(`${path} is not a JPEG, PNG, GIF or WebP image, so it is not used as a thumbnail.`);
}
function assertNoRepeats(list) {
  const seen = /* @__PURE__ */ new Set();
  for (const p of list) {
    if (seen.has(p)) throw new ValidationError(`${p} is listed more than once in srcs; list each item once.`);
    seen.add(p);
  }
}
async function putChunk(rt, args) {
  try {
    return (await rt.run("put", args)).code;
  } catch (e) {
    if (e instanceof ValidationError) return null;
    throw e;
  }
}
async function putChunked(rt, putOpts, lps, dest, background) {
  const chunks = chunkArgs(lps, 2e3, [...putOpts, dest]);
  if (chunks.length === 1) {
    return runToResult(rt, "put", [...putOpts, ...lps, dest], () => ok(`Uploaded ${lps.length} item(s) -> ${dest}.`, { localPaths: lps, remotePath: dest, background }));
  }
  let failed = 0;
  for (const chunk of chunks) if (await putChunk(rt, [...putOpts, ...chunk, dest]) !== 0) failed += chunk.length;
  return (failed ? err : ok)(`Uploaded ${lps.length - failed}/${lps.length} item(s) -> ${dest}${failed ? `; ${failed} in batches that reported an error (some of those may have been uploaded)` : ""}.`, { localPaths: lps, remotePath: dest, background, failed });
}
function registerMutate(server, rt) {
  server.registerTool(
    "mega_mkdir",
    {
      title: "MEGA: make folder",
      description: "Create a MEGA cloud folder (parents created as needed). Asks for confirmation only when the new folder's place is shared, publicly linked or invited to, someone else's shared folder, in a two-way synced folder (the preview names where it is written on this computer), or cannot be checked; otherwise it runs at once.",
      inputSchema: {
        remotePath: external_exports.string().describe("Absolute MEGA path to create."),
        confirm: external_exports.string().optional().describe("Confirmation token, when the first call asked for one.")
      },
      annotations: { title: "MEGA: make folder", destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ remotePath, confirm }) => guardRun(async () => {
      const rp = assertNoHandleName(assertRemotePath(remotePath));
      if (/^\/\/(?:in|from)(?:\/|$)/.test(rp) || rp === "//bin") {
        throw new ValidationError("mega_mkdir cannot create folders under //in or //from (MEGAcmd would create them in the Cloud Drive instead).");
      }
      if (storeCopyIn(rp) === "name") assertNotStoreCopy(rp);
      await assertSyncedLanding(rt, rp, "self");
      const made = [];
      for (let p = rp; p !== "/" && p !== "//bin" && p !== posix.dirname(p); p = posix.dirname(p)) made.push(p);
      const notes = [...await destinationNotes(rt, rp), ...await backupRotationLinesAt(rt, made)];
      if (notes.length > 0) {
        const gate = checkConfirm(rt, "mega_mkdir", { remotePath: rp, notes }, confirm, [`This will create the folder ${rp}.`, ...notes]);
        if (gate) return gate;
      } else {
        noteUnconfirmedWrite([{ path: rp, source: null }]);
      }
      return runToResult(rt, "mkdir", ["-p", rp], () => ok(`Created folder ${rp}.`, { remotePath: rp }));
    })
  );
  server.registerTool(
    "mega_cp",
    {
      title: "MEGA: copy",
      description: `Copy MEGA cloud node(s) to another cloud path. Bulk-capable: pass "srcs" (a list) or "src"+usePcre (a pattern) to copy many nodes in one call - do NOT loop this tool per file; several items need an existing destination folder. Asks for confirmation only when the destination is shared, publicly linked or invited to, someone else's shared folder, in a two-way synced folder (the preview names where it is written on this computer), or cannot be checked, or when the copy would replace a file or become the new version of a same-named file; the preview says which. Otherwise the copy runs at once.`,
      inputSchema: {
        src: external_exports.string().optional().describe('A single source path; OR a PCRE pattern (with usePcre). Native "*"/"?" wildcards are not accepted - use usePcre.'),
        srcs: external_exports.array(external_exports.string()).optional().describe("An explicit list of source paths to copy together."),
        dst: external_exports.string().describe("Destination: an existing folder to copy into, or (single src) the new name."),
        usePcre: external_exports.boolean().default(false).describe('Interpret "src" as a PCRE pattern and copy EVERY match. It starts with "/" and each part of the path is matched on its own, e.g. /Docs/.*\\.pdf$.'),
        confirm: external_exports.string().optional().describe("Confirmation token, when the first call asked for one.")
      },
      // Destructive: a copy onto an existing file REPLACES it (MEGAcmd copies, then
      // removes the old target) - that case always asks first.
      annotations: { title: "MEGA: copy", destructiveHint: true, openWorldHint: true }
    },
    async ({ src, srcs, dst, usePcre, confirm }) => guardRun(async () => {
      let d = assertRemoteDest(dst, "dst");
      let list = null;
      let single = null;
      let pattern = null;
      let matches = null;
      const check = (p) => assertNotStoreCopy(p, "A matched node");
      if (srcs && srcs.length > 0) {
        list = srcs.map((s, i) => assertNotStoreCopy(assertNoVersionName(assertNoWildcard(assertRemotePath(s, `srcs[${i}]`), `srcs[${i}]`), `srcs[${i}]`), `srcs[${i}]`));
        assertNoRepeats(list);
        await assertNoStoreCopyBelowMany(rt, list);
      } else if (usePcre) {
        if (!src) throw new ValidationError('usePcre requires "src" (the PCRE pattern).');
        pattern = assertNoFlag(src, "src");
        const prev = await pcreMatchPreview(rt, pattern);
        if (!prev.ok) return err(prev.error);
        for (const p of prev.paths) check(p);
        matches = { handles: prev.handles, topPaths: prev.topPaths, paths: prev.paths };
      } else {
        if (!src) throw new ValidationError('Provide "src" (a path or pattern) or "srcs" (a list).');
        single = assertNotStoreCopy(assertNoWildcard(assertRemotePath(src, "src"), "src"), "src");
        await assertNoStoreCopyBelow(rt, single);
        d = await versionTarget(rt, single, d);
      }
      const sources = list ?? (matches ? matches.topPaths : [single]);
      await assertOneDestination(rt, d);
      const landName = (p) => {
        const b = posix.basename(p);
        return posix.dirname(p) === "//from" && b.includes(":") ? b.slice(b.indexOf(":") + 1) : b;
      };
      const names = sources.map((p) => landName(p).normalize("NFC"));
      const kind = await remoteKind(rt, d);
      if (sources.length > 1 && kind !== "folder") {
        throw new ValidationError(`Copying several items needs an existing destination folder; ${d} is ${kind === "file" ? "a file" : kind === "missing" ? "missing" : "not known to be a folder"}.`);
      }
      const replaces = kind === "file";
      const listed = kind === "folder" ? await childNames(rt, d) : /* @__PURE__ */ new Set();
      const existing = listed && new Set([...listed].map((n) => n.normalize("NFC")));
      const collisions = [];
      if (existing) {
        for (const n of names) if (existing.has(n) && (await remoteKind(rt, joinRemote(d, n)) !== "folder" || await fileNamedIn(rt, d, n))) collisions.push(n);
      }
      await assertSyncedLanding(rt, d, kind === "folder" ? names : "self", matches ? { listed: matches.paths } : { cloud: sources });
      const only = sources.length === 1 ? sources[0] : null;
      const interim = kind !== "folder" && only !== null && posix.dirname(only) !== posix.dirname(d) && await remoteKind(rt, matches ? matches.handles[0] ?? only : only) !== "file";
      if (interim) await assertSyncedLanding(rt, posix.dirname(d), names);
      const notes = [
        ...await destinationNotes(rt, d),
        // A name a periodic backup's rotation counts as one of its copies (and may delete).
        ...kind === "folder" ? await backupRotationLines(rt, d, names) : await backupRotationLinesAt(rt, [d]),
        // Copying the recovery key file (or a copy of it) asks first, wherever it goes.
        ...matches ? recoveryKeyLines(matches.paths) : await recoveryKeyLinesBelow(rt, sources),
        ...kind === "unknown" ? [`(Could not check what is at ${d}: a file there would be REPLACED, with all its versions deleted for good.)`] : !existing ? [`(Could not check what is in ${d}.)`] : [],
        ...replaces ? [`${d} is an existing FILE: it will be REPLACED, and it and all its older versions are deleted for good (not kept as a version, not in the Rubbish Bin).`] : [],
        ...collisions.map((n) => `${joinRemote(d, n)} already exists: the copy becomes its new version (the current one is kept as an older version only while file versioning is on).`)
      ];
      const risky = notes.length > 0;
      const destOf = (p) => kind === "folder" ? joinRemote(d, landName(p)) : d;
      let handles = null;
      if (risky) {
        if (pattern !== null) {
          const g = await pcreGate(
            rt,
            "mega_cp",
            { src: pattern, usePcre: true, dst: d, notes },
            confirm,
            pattern,
            (n, t) => [`This will copy ${n} node(s) matching the pattern to ${d}:`, t, ...notes].join("\n"),
            check,
            // By handle under the checked names; unconfirmed writes in matched folders are named.
            { recheckNames: true, extraLines: (tops) => unconfirmedWriteLines(tops), bindContents: true }
          );
          if (!g.proceed) return g.result;
          handles = g.handles;
        } else {
          const same = list ? await sameNamedMany(rt, list) : [await sameNamed(rt, single)];
          const placed = unconfirmedWriteLines(sources);
          const summary = list ? [`This will copy ${list.length} item(s) to ${d}:`, ...notes, ...listedLines(list), ...same.flatMap((x) => x.lines), ...placed] : [`This will copy ${single} to ${d}.`, ...same.flatMap((x) => x.lines), ...notes, ...placed];
          const contents = await contentDigestMany(rt, sources);
          const gate = checkConfirm(rt, "mega_cp", { srcs: list, src: single, dst: d, items: same.map((x) => x.count), notes, placed, contents }, confirm, summary);
          if (gate) return gate;
        }
      } else {
        handles = matches ? matches.handles : null;
        noteUnconfirmedWrite(sources.map((p) => ({ path: destOf(p), source: p })));
      }
      for (const p of sources) {
        carryUnconfirmedWrites(p, destOf(p), false);
        noteKeyCopy(p, destOf(p));
      }
      if (interim && only !== null) carryUnconfirmedWrites(only, joinRemote(posix.dirname(d), names[0]), false);
      const failNote = (failed) => failed ? `; ${failed} in batches that reported an error (some of those may have been copied)` : "";
      if (pattern !== null) {
        const hs = handles ?? [];
        if (hs.length === 0) return ok("No matching nodes to copy.", { dst: d, copied: 0 });
        const { done, failed } = await runBulk(rt, "cp", hs, [d]);
        return ok(`Copied ${done}/${hs.length} node(s) to ${d}${failNote(failed)}.`, { dst: d, copied: done, failed });
      }
      if (list) {
        const { done, failed } = await runBulk(rt, "cp", list, [d]);
        return ok(`Copied ${done}/${list.length} item(s) to ${d}${failNote(failed)}.`, { dst: d, copied: done, failed });
      }
      return runToResult(rt, "cp", [single, d], () => ok(`Copied ${single} -> ${d}.`, { src: single, dst: d }));
    })
  );
  server.registerTool(
    "mega_mv",
    {
      title: "MEGA: move/rename",
      description: 'Move or rename MEGA cloud node(s). Bulk-capable: pass "srcs" (an explicit list) or "src"+usePcre (a pattern) to move many nodes in ONE confirmed operation \u2014 do NOT loop this tool per file. Requires confirmation.',
      inputSchema: {
        src: external_exports.string().optional().describe('A single source path; OR a PCRE pattern (with usePcre). Native "*"/"?" wildcards are not accepted - use usePcre, which lists the matches before you confirm.'),
        srcs: external_exports.array(external_exports.string()).optional().describe("An explicit list of source paths to move together in one confirmed operation. Use for arbitrary selections that are not a single pattern."),
        dst: external_exports.string().describe("Destination: an existing folder to move into, or (single src) the new name."),
        usePcre: external_exports.boolean().default(false).describe('Interpret "src" as a PCRE pattern and move EVERY match. It starts with "/" and each part of the path is matched on its own, e.g. /Docs/.*\\.pdf$.'),
        confirm: external_exports.string().optional().describe("Confirmation token from the first call.")
      },
      annotations: { title: "MEGA: move/rename", destructiveHint: true, openWorldHint: true }
    },
    async ({ src, dst, srcs, usePcre, confirm }) => guardRun(async () => {
      let d = assertRemoteDest(dst, "dst");
      if (srcs && srcs.length > 0) {
        const list = srcs.map((s2, i) => assertNotStoreCopy(assertNoVersionName(assertNoWildcard(assertRemotePath(s2, `srcs[${i}]`), `srcs[${i}]`), `srcs[${i}]`), `srcs[${i}]`));
        assertNoRepeats(list);
        if (!confirm) await assertNoStoreCopyBelowMany(rt, list);
        await assertOneDestination(rt, d);
        const dKind = await remoteKind(rt, d);
        if (list.length > 1 && dKind !== "folder") throw new ValidationError(`Moving several items needs an existing destination folder; ${d} is ${dKind === "file" ? "a file" : dKind === "missing" ? "missing" : "not known to be a folder"}.`);
        await assertSyncedLanding(rt, d, dKind === "folder" ? list.map((p) => posix.basename(p)) : "self", { cloud: list });
        if (dKind !== "folder" && list.some((p) => posix.dirname(p) !== posix.dirname(d))) await assertSyncedLanding(rt, posix.dirname(d), list.map((p) => posix.basename(p)));
        const notes2 = await destinationNotes(rt, d, { overwrite: list.length === 1 ? "delete" : void 0 });
        const same2 = await sameNamedMany(rt, list);
        const local2 = [
          ...await syncedSourceNotes(rt, list, "moved"),
          ...await syncFollowLines(rt, list, d),
          ...await crossTreeCollisions(rt, list, d, dKind),
          ...await movedIntoSyncedLines(rt, list, d, dKind === "folder"),
          ...await recoveryKeyLinesBelow(rt, list),
          ...dKind === "folder" ? await backupRotationLines(rt, d, list.map((p) => posix.basename(p))) : await backupRotationLines(rt, posix.dirname(d), [posix.basename(d)]),
          ...dKind === "unknown" ? [`(Could not check what is at ${d}: a file there would be REPLACED, with all its versions deleted for good.)`] : []
        ];
        const placed2 = unconfirmedWriteLines(list);
        const summary = [`This will move ${list.length} item(s) to ${d}:`, ...notes2, ...listedLines(list), ...same2.flatMap((x) => x.lines), ...local2, ...placed2];
        const replaces2 = list.length === 1 && await remoteKind(rt, d) === "file";
        const contents2 = await contentDigestMany(rt, list);
        const gate2 = checkConfirm(rt, "mega_mv", { srcs: list, dst: d, items: same2.map((x) => x.count), replaces: replaces2, local: local2, placed: placed2, notes: notes2, contents: contents2 }, confirm, summary);
        if (gate2) return gate2;
        await assertNoStoreCopyBelowMany(rt, list);
        const { done, failed } = await runBulk(rt, "mv", list, [d]);
        for (const p of list) {
          const to = dKind === "folder" ? joinRemote(d, posix.basename(p)) : d;
          carryUnconfirmedWrites(p, to, failed === 0);
          noteKeyCopy(p, to);
          if (failed && dKind !== "folder" && posix.dirname(p) !== posix.dirname(d)) carryUnconfirmedWrites(p, joinRemote(posix.dirname(d), posix.basename(p)), false);
        }
        return ok(`Moved ${done}/${list.length} item(s) to ${d}${failed ? `; ${failed} failed` : ""}.`, { dst: d, moved: done, failed });
      }
      if (usePcre) {
        if (!src) throw new ValidationError('usePcre requires "src" (the PCRE pattern).');
        const pattern = assertNoFlag(src, "src");
        await assertOneDestination(rt, d);
        const pcreNotes = await destinationNotes(rt, d);
        const dKind = await remoteKind(rt, d);
        const dstIsFile = !confirm && dKind === "file";
        const listedAll = [];
        const g = await pcreGate(
          rt,
          "mega_mv",
          { src: pattern, usePcre: true, dst: d, notes: pcreNotes, dKind },
          confirm,
          pattern,
          (n, t) => {
            if (n > 1 && dKind !== "folder") throw new ValidationError(`Moving several items needs an existing destination folder; ${d} is ${dKind === "file" ? "a file" : dKind === "missing" ? "missing" : "not known to be a folder"}.`);
            return [`This will move ${n} node(s) matching the pattern to ${d}:`, t, ...pcreNotes, ...n === 1 && dstIsFile ? [`${d} is an existing FILE: it will be REPLACED, and it and all its older versions are deleted for good (not kept as a version, not in the Rubbish Bin).`] : []].join("\n");
          },
          (p, topmost) => {
            assertNotStoreCopy(p, "A matched node");
            listedAll.push(p);
            if (topmost && isIgnoreFileName(posix.basename(p))) {
              throw new ValidationError(`${p} is a .megaignore file (the rules of a sync); it is not moved by pattern.`);
            }
          },
          {
            // Moved by handle under the names checked here; what they hold is bound.
            recheckNames: true,
            bindContents: true,
            extraLines: async (tops) => [
              ...await syncedSourceNotes(rt, tops, "moved"),
              ...await syncFollowLines(rt, tops, d),
              ...await crossTreeCollisions(rt, tops, d, dKind),
              ...await movedIntoSyncedLines(rt, tops, d, dKind === "folder"),
              ...recoveryKeyLines(listedAll),
              ...dKind === "folder" ? await backupRotationLines(rt, d, tops.map((p) => posix.basename(p))) : await backupRotationLines(rt, posix.dirname(d), [posix.basename(d)]),
              ...dKind === "unknown" ? [`(Could not check what is at ${d}: a file there would be REPLACED, with all its versions deleted for good.)`] : [],
              ...unconfirmedWriteLines(tops)
            ]
          }
        );
        if (!g.proceed) return g.result;
        if (g.handles.length > 1 && dKind !== "folder") throw new ValidationError(`Moving several items needs an existing destination folder; ${d} is not one.`);
        await assertSyncedLanding(rt, d, dKind === "folder" ? g.paths.map((p) => posix.basename(p)) : "self", { listed: listedAll });
        if (dKind !== "folder" && g.paths.some((p) => posix.dirname(p) !== posix.dirname(d))) await assertSyncedLanding(rt, posix.dirname(d), g.paths.map((p) => posix.basename(p)));
        if (g.handles.length === 0) return ok("No matching nodes to move.", { dst: d, moved: 0 });
        const { done, failed } = await runBulk(rt, "mv", g.handles, [d]);
        for (const p of g.paths) {
          const to = dKind === "folder" ? joinRemote(d, posix.basename(p)) : d;
          carryUnconfirmedWrites(p, to, failed === 0);
          noteKeyCopy(p, to);
          if (failed && dKind !== "folder" && posix.dirname(p) !== posix.dirname(d)) carryUnconfirmedWrites(p, joinRemote(posix.dirname(d), posix.basename(p)), false);
        }
        return ok(`Moved ${done}/${g.handles.length} node(s) to ${d}${failed ? `; ${failed} failed` : ""}.`, { dst: d, moved: done, failed });
      }
      if (!src) throw new ValidationError('Provide "src" (a path or pattern) or "srcs" (a list).');
      const s = assertNotStoreCopy(assertNoWildcard(assertRemotePath(src, "src"), "src"), "src");
      if (s.split("/").some((seg) => /#\d{10}$/.test(seg))) {
        throw new ValidationError("An older file version cannot be moved; copy it with mega_cp instead (it lands under the file's name).");
      }
      if (!confirm) await assertNoStoreCopyBelow(rt, s);
      await assertOneDestination(rt, d);
      const notes = await destinationNotes(rt, d, { overwrite: "delete" });
      const same = await sameNamed(rt, s);
      const dKindSingle = await remoteKind(rt, d);
      const replaces = dKindSingle === "file";
      await assertSyncedLanding(rt, d, dKindSingle === "folder" ? [posix.basename(s)] : "self", { cloud: [s] });
      if (dKindSingle !== "folder" && posix.dirname(s) !== posix.dirname(d)) await assertSyncedLanding(rt, posix.dirname(d), [posix.basename(s)]);
      const local = [
        ...await syncedSourceNotes(rt, [s], "moved"),
        ...await syncFollowLines(rt, [s], d),
        ...await crossTreeCollisions(rt, [s], d, dKindSingle),
        ...await movedIntoSyncedLines(rt, [s], d, dKindSingle === "folder"),
        ...await recoveryKeyLinesBelow(rt, [s]),
        ...dKindSingle === "folder" ? await backupRotationLines(rt, d, [posix.basename(s)]) : await backupRotationLines(rt, posix.dirname(d), [posix.basename(d)]),
        ...dKindSingle === "unknown" ? [`(Could not check what is at ${d}: a file there would be REPLACED, with all its versions deleted for good.)`] : []
      ];
      const placed = unconfirmedWriteLines(s);
      const contents = await contentDigest(rt, s);
      const gate = checkConfirm(rt, "mega_mv", { src: s, dst: d, items: same.count, replaces, local, placed, notes, into: dKindSingle === "folder", contents }, confirm, [`This will move/rename ${s} to ${d}.`, ...same.lines, ...notes, ...local, ...placed]);
      if (gate) return gate;
      await assertNoStoreCopyBelow(rt, s);
      const moved = await rt.run("mv", [s, d]);
      carryUnconfirmedWrites(s, dKindSingle === "folder" ? joinRemote(d, posix.basename(s)) : d, moved.code === 0);
      noteKeyCopy(s, dKindSingle === "folder" ? joinRemote(d, posix.basename(s)) : d);
      if (moved.code !== 0 && dKindSingle !== "folder" && posix.dirname(s) !== posix.dirname(d)) carryUnconfirmedWrites(s, joinRemote(posix.dirname(d), posix.basename(s)), false);
      if (moved.code !== 0) return err(classifyExit(moved), { ok: false, code: moved.code });
      return ok(`Moved ${s} -> ${d}.`, { src: s, dst: d });
    })
  );
  server.registerTool(
    "mega_put",
    {
      title: "MEGA: upload",
      description: "Upload one or more local files/folders into a MEGA cloud folder. Each item keeps its own name inside remotePath unless `name` is given. Requires confirmation; the preview lists the cloud path each item will get.",
      inputSchema: {
        localPath: external_exports.string().optional().describe("A single local file/folder to upload."),
        localPaths: external_exports.array(external_exports.string()).optional().describe("Multiple local files/folders to upload."),
        remotePath: external_exports.string().describe('Destination FOLDER (absolute MEGA path), created if missing. Items go inside it: uploading ~/Photos to "/Backup" gives /Backup/Photos.'),
        name: external_exports.string().optional().describe('Upload a single item under this name inside remotePath (remotePath "/Docs" + name "report-2026.pdf" gives /Docs/report-2026.pdf). An existing file with that name is replaced (as a new version); an existing folder is refused.'),
        background: external_exports.boolean().default(false).describe("Queue the upload in the background (do not wait for it to finish)."),
        confirm: external_exports.string().optional().describe("Confirmation token from the first call.")
      },
      annotations: { title: "MEGA: upload", destructiveHint: true, openWorldHint: true }
    },
    async ({ localPath, localPaths, remotePath, name, background, confirm }) => guardRun(async () => {
      const raw = [...localPaths ?? [], ...localPath ? [localPath] : []];
      if (raw.length === 0) throw new ValidationError("Provide localPath or localPaths.");
      const lps = raw.map((p) => assertNoLocalGlob(assertLocalPath(p)));
      const rp = assertNotStoreCopy(assertNoWildcard(assertRemoteDest(remotePath), "remotePath"));
      const as = name === void 0 ? void 0 : uploadName(name, lps, rp);
      if (rp.startsWith("//") && await remoteKind(rt, rp) !== "folder") {
        throw new ValidationError(`${rp} is not an existing folder; under //from, //in or //bin, upload into an existing folder only.`);
      }
      const cloudName = (lp) => {
        const n = cloudNameOf(basename(lp));
        if (n === "." || n === ".." || n.includes("/")) throw new ValidationError(`${lp} would be uploaded under the name "${n}"; rename it first.`);
        return n;
      };
      const cloudPath = (lp) => `${rp.replace(/\/+$/, "")}/${as ?? cloudName(lp)}`;
      const landNames = (lp) => {
        const n = as ?? cloudName(lp);
        if (n !== "") return [n];
        try {
          return readdirSync(lp).map((e) => cloudNameOf(e));
        } catch {
          throw new ValidationError(`Could not list ${lp} to check where its contents land.`);
        }
      };
      let replaces = false;
      if (as !== void 0) {
        const target2 = cloudPath(lps[0]);
        const kind = await remoteKind(rt, target2);
        let isDir = false;
        try {
          isDir = statSync(lps[0]).isDirectory();
        } catch {
        }
        if (kind === "unknown") return err(`Could not check what is at ${target2}.`, { remotePath: target2 });
        if (kind === "folder" || kind === "file" && isDir) {
          return err(`${target2} already exists as a ${kind}; choose another name.`, { remotePath: target2 });
        }
        replaces = kind === "file";
      }
      const plan = planUpload(lps, rp, await rt.getBinDir(), as);
      await assertSyncedLanding(rt, rp, lps.map((p) => as ?? cloudName(p)), { local: lps });
      if (isIgnoreFileName(posix.basename(rp))) await assertSyncedLanding(rt, posix.dirname(rp), [posix.basename(rp)]);
      const notes = await destinationNotes(rt, as === void 0 ? rp : cloudPath(lps[0]), { overwrite: "version" });
      const landing = [];
      if (as === void 0) {
        const near = await syncRootsBelowCloud(rt, rp);
        if (near === null) throw new ValidationError(`Could not read MEGAcmd's list of syncs, so whether uploading into ${rp} reaches a synced folder is unknown.`);
        for (const lp of lps.filter((p) => isLocalDir(p) && near.length > 0)) {
          const t = joinRemote(rp, cloudName(lp));
          const roots = await syncRootsBelowCloud(rt, t);
          if (roots === null) throw new ValidationError(`Could not read MEGAcmd's list of syncs, so whether uploading into ${t} reaches a synced folder is unknown.`);
          if (roots.length > 0) throw new ValidationError(`${t} holds the cloud side of a two-way sync (${roots[0]}): the upload would be merged into it and written to this computer. Upload into that synced folder directly, or elsewhere.`);
          let inside;
          try {
            inside = readdirSync(lp).map((e) => cloudNameOf(e));
          } catch {
            throw new ValidationError(`Could not list ${lp} to check where its contents land.`);
          }
          await assertSyncedLanding(rt, t, inside, { local: [lp] });
        }
        const here = await childNames(rt, rp);
        if (!here && await remoteKind(rt, rp) !== "missing") landing.push(`(Could not check what is already in ${rp}.)`);
        for (const n of lps.flatMap(landNames)) {
          if (!here?.has(n)) continue;
          const t = joinRemote(rp, n);
          const kind = /[\\*?]/.test(n) ? "unknown" : await remoteKind(rt, t);
          const isFolder = kind !== "file";
          landing.push(kind === "folder" ? `${t} already exists: the upload is merged INTO that folder.` : kind === "file" ? `${t} already exists: the upload becomes its new version (the current one is kept as an older version only while file versioning is on).` : `${t} already exists (could not check whether it is a file or a folder).`);
          const deep = isFolder ? [...await sharedBelowNotes(rt, t), ...await backupFoldersWithinLines(rt, t, "The upload is merged into")] : [];
          for (const x of [...await destinationNotes(rt, t), ...deep]) if (!landing.includes(x)) landing.push(x);
        }
      }
      const downloaded = downloadedIntoLines(lps);
      const keyNamed = lps.filter((lp) => isRecoveryKeyName(basename(lp)));
      const made = [];
      for (let p = rp.replace(/(.)\/+$/, "$1"); !/^(?:\/|\/\/(?:bin|in|from))$/.test(p) && p !== posix.dirname(p); p = posix.dirname(p)) made.push(p);
      const rebuilt = plan.steps.filter((st) => st.dest !== rp).flatMap((st) => st.sources.map((src) => joinRemote(st.dest, cloudNameOf(basename(src)))));
      const rotation = await backupRotationLinesAt(rt, [...lps.flatMap(landNames).map((n) => joinRemote(rp, n)), ...made, ...rebuilt]);
      const keyLines = keyNamed.length > 0 ? ["Named like MEGA's recovery key file, which holds the account's master key:", ...listedLines(keyNamed)] : [];
      const summary = [
        ...notes,
        ...landing.filter((x) => !notes.includes(x)),
        ...downloaded,
        ...keyLines,
        ...rotation,
        `This will upload ${lps.length} item(s) into the folder ${rp} (created if missing)${background ? ", in the background" : ""}:`,
        ...listedLines(lps, (p) => `  ${p}  ->  ${cloudPath(p)}`),
        ...plan.excluded.length > 0 ? [
          "",
          "Left out: the MEGAcmd session store, which holds this account's MASTER KEY:",
          ...plan.excluded.map((p) => `  ${p}`)
        ] : [],
        ...plan.unchecked.length > 0 ? ["", `(Could not search completely - too many subfolders, or folders that cannot be read - for other copies of a MEGAcmd session store (.megaCmd): ${plan.unchecked.join(", ")}.)`] : [],
        ...plan.links.length > 0 ? ["", "Not uploaded: symbolic links inside the folders rebuilt around it (a whole-folder upload skips them too):", ...listedLines(plan.links, (p) => `  ${p}`)] : []
      ];
      const gate = checkConfirm(rt, "mega_put", { localPaths: lps, remotePath: rp, name: as ?? null, replaces, background, landing, notes, excluded: plan.excluded, unchecked: plan.unchecked, links: plan.links, steps: plan.steps.map((st) => st.dest), downloaded, keyNamed, rotation }, confirm, summary);
      if (gate) return gate;
      for (const lp of keyNamed) noteKeyCopy(`/${basename(lp)}`, cloudPath(lp), lp);
      noteSessionChange(as === void 0 ? rp : cloudPath(lps[0]), `an upload of ${lps.length} item(s) from this computer (it may still be running)`);
      const expectIgnores = [];
      const uncheckedUploads = [];
      for (const lp of lps) {
        const t = cloudPath(lp);
        if (!isLocalDir(lp)) {
          if (isIgnoreFileName(posix.basename(t))) expectIgnores.push(t);
          continue;
        }
        const found = ignoreFilesIn([lp]);
        for (const f of found.found) expectIgnores.push(joinRemote(t, relative(lp, f).split(sep).map(cloudNameOf).join("/")));
        if (!found.complete) uncheckedUploads.push(t);
      }
      noteUploadIgnores(expectIgnores, uncheckedUploads);
      const putOpts = ["-c", ...background ? ["-q"] : []];
      const untouched = plan.excluded.length === 0 && plan.steps.length === 1 && plan.steps[0].dest === rp;
      const dest = as === void 0 ? rp : cloudPath(lps[0]);
      if (rp.startsWith("//")) {
        if (!untouched) return err(`Cannot rebuild folders under ${rp}; upload into a regular folder, or upload a subfolder that does not contain the session store.`, { remotePath: rp });
        return putChunked(rt, putOpts, lps, dest, background);
      }
      const target = await ensureRemoteFolder(rt, rp);
      if (target === "error") return err(`Could not create the destination folder ${rp}.`, { remotePath: rp });
      if (as !== void 0 && target === "file") return err(`${rp} is a file, not a folder.`, { remotePath: rp });
      if (target === "file") {
        if (!untouched) return err(`${rp} is a file, not a folder.`, { remotePath: rp });
        return runToResult(rt, "put", [...putOpts, ...lps, rp], () => ok(`Uploaded ${lps.length} item(s) -> ${rp}.`, { localPaths: lps, remotePath: rp, background }));
      }
      if (untouched) {
        return putChunked(rt, putOpts, lps, dest, background);
      }
      let failed = 0;
      for (const step of plan.steps) {
        if (step.dest !== rp && await ensureRemoteFolder(rt, step.dest) !== "folder") {
          failed += Math.max(step.sources.length, 1);
          continue;
        }
        for (const chunk of chunkArgs(step.sources, PUT_CHUNK, [...putOpts, step.dest])) {
          if (await putChunk(rt, [...putOpts, ...chunk, step.dest]) !== 0) failed += chunk.length;
        }
      }
      return (failed ? err : ok)(
        `Uploaded ${lps.length} item(s) -> ${rp}, leaving out the MEGAcmd session store (${plan.excluded.join(", ")})${failed ? `; ${failed} item(s) failed` : ""}.`,
        { localPaths: lps, remotePath: rp, background, excluded: plan.excluded, failed }
      );
    })
  );
  server.registerTool(
    "mega_get",
    {
      title: "MEGA: download",
      description: "Download a MEGA cloud file/folder (by path or by public link) to a local directory. A previous file version (`name#<10 digits>`, as mega_ls showVersions lists it) is saved as <localDir>/<name>. Requires confirmation.",
      inputSchema: {
        remotePath: external_exports.string().optional().describe("Absolute MEGA path to download (a PCRE pattern when usePcre=true)."),
        link: external_exports.string().optional().describe("A MEGA public link to download (instead of remotePath)."),
        localDir: external_exports.string().describe("Local folder to download into (created if missing)."),
        password: external_exports.string().optional().describe("Password for a password-protected link."),
        background: external_exports.boolean().default(false).describe("Queue the download in the background."),
        ignoreQuotaWarn: external_exports.boolean().default(false).describe("Proceed despite a transfer-quota warning."),
        merge: external_exports.boolean().default(false).describe("Download a folder's CONTENTS straight into localDir, next to what is already there, instead of into <localDir>/<folder name> (an existing folder of that name is downloaded into)."),
        usePcre: external_exports.boolean().default(false).describe('Interpret remotePath as a PCRE pattern (downloads every match). It starts with "/" and each part of the path is matched on its own, e.g. /Docs/.*\\.pdf$.'),
        confirm: external_exports.string().optional().describe("Confirmation token from the first call.")
      },
      annotations: { title: "MEGA: download", destructiveHint: true, openWorldHint: true }
    },
    async ({ remotePath, link, localDir, password, background, ignoreQuotaWarn, merge, usePcre, confirm }) => guardRun(async () => {
      const ld = assertLocalPath(localDir, "localDir");
      if (password !== void 0) assertSecret(password, "password");
      const isLink = link !== void 0 && link !== "";
      const transferOpts = [
        ...background ? ["-q"] : [],
        ...merge ? ["-m"] : [],
        ...ignoreQuotaWarn ? ["--ignore-quota-warn"] : []
      ];
      const ldMissing = !existsSync(ld);
      const snapshot = ldMissing ? "" : await syncSnapshot(rt);
      const syncRoots = ldMissing ? [] : await syncLocalRoots(rt);
      if (syncRoots === null) throw new ValidationError(`Could not read MEGAcmd's list of syncs, so whether downloading into ${ld} reaches a synced folder is unknown.`);
      const backupRoots = ldMissing ? [] : await backupLocalRoots(rt);
      if (backupRoots === null) throw new ValidationError(`Could not read MEGAcmd's list of backups, so whether downloading into ${ld} reaches a backed-up folder is unknown.`);
      const watched = [...syncRoots, ...backupRoots];
      const roots = watched.filter((r) => localAtOrUnder(r, ld) && !localAtOrUnder(ld, r));
      const assertSyncsUnchanged = async (synced2) => {
        if (ldMissing && existsSync(ld)) throw new ValidationError(`${ld} was created since the preview. Nothing was run; preview again.`);
        if (!ldMissing && await syncSnapshot(rt) !== snapshot) throw new ValidationError("The syncs or backups on this computer changed since the preview. Nothing was run; preview again.");
        if (JSON.stringify(await syncedLocalLines(rt, ld)) !== JSON.stringify(synced2)) {
          throw new ValidationError(`Who can see where ${ld} is uploaded changed since the preview. Nothing was run; preview again.`);
        }
      };
      const assertNoSyncRootAt = (name) => {
        const at = name === null ? ld : joinLocal(ld, name);
        const linkAt = name !== null && isSymlink(at) ? [{ link: at, real: onDiskSpelling(at) }] : [];
        const viaLink = () => watched.length > 0 && existsSync(at) ? [...linkAt, ...linksBelow(at)].find(({ link: link2, real }) => !(link2 !== at && localAtOrUnder(real, at)) && watched.some((r) => localAtOrUnder(real, r) || localAtOrUnder(r, real))) : void 0;
        const hit = roots.find((r) => name === null || localAtOrUnder(r, at)) ?? viaLink()?.link;
        if (hit) throw new ValidationError(`${at} is, holds or links to ${hit}, which MEGAcmd syncs or backs up: the download could land in it and be uploaded. Download into a folder without one.`);
      };
      if (!ldMissing && !statSync(ld).isDirectory()) throw new ValidationError(`localDir ${ld} is a file, not a folder.`);
      const ignoreFileCheck = (name, ldSynced2) => {
        if (isIgnoreFileName(name) && ldSynced2 !== false) assertNotIgnoreFile(joinLocal(ld, name));
      };
      const created = ldMissing ? " (created)" : "";
      const makeLd = () => {
        if (ldMissing && !existsSync(ld)) mkdirSync(ld, { recursive: true });
      };
      if (usePcre && !isLink) {
        if (remotePath === void 0 || remotePath === "") {
          throw new ValidationError("Provide remotePath (a PCRE pattern) when usePcre=true.");
        }
        const rp = assertNoFlag(remotePath, "remotePath");
        const ldSynced2 = await inSyncedLocalFolder(rt, ld);
        const execNote2 = await executableDownloadNote(rt);
        const synced2 = await syncedLocalLines(rt, ld);
        let carriesIgnoreFile = false;
        const matched = [];
        const gateAndRun2 = async () => {
          const g = await pcreGate(
            rt,
            "mega_get",
            { remotePath: rp, localDir: ld, usePcre: true, background, ignoreQuotaWarn, merge, exec: execNote2, synced: synced2 },
            confirm,
            rp,
            (n, t) => `This will download ${n} node(s) matching the pattern into ${ld}${created}${merge ? ", each folder's contents straight into it (merged with what is there)" : ""}${background ? ", in the background" : ""}${ignoreQuotaWarn ? ", ignoring a transfer-quota warning" : ""}:
${t}${execNote2 ? `
${execNote2}` : ""}${synced2.map((l) => `
${previewSafe(l)}`).join("")}`,
            (p, topmost) => {
              assertNotStoreCopy(p, "A matched node");
              matched.push(p);
              if (isIgnoreFileName(posix.basename(p))) carriesIgnoreFile = true;
              if (!topmost) {
                ignoreFileCheck(posix.basename(p), ldSynced2);
                return;
              }
              if (ldMissing) assertDownloadTarget(dirname(ld), basename(ld));
              else if (merge) assertDownloadTarget(ld, null);
              else for (const name of localNamesOf(p)) assertDownloadTarget(ld, name);
              if (merge) assertNoSyncRootAt(null);
              else for (const name of localNamesOf(p)) assertNoSyncRootAt(name);
              for (const name of localNamesOf(p)) ignoreFileCheck(name, ldSynced2);
            },
            // Each node lands under its CURRENT name, so names are checked again.
            // What was placed in the matches unconfirmed (a renamed copy, say) is named and bound.
            { recheckNames: true, bindContents: true, extraLines: (tops) => [...unconfirmedWriteLines(tops), ...recoveryKeyLines(matched)] }
          );
          if (!g.proceed) return g.result;
          if (g.handles.length === 0) return ok("No matching nodes to download.", { downloaded: 0, localDir: ld });
          if (merge) {
            for (const [i, t] of g.paths.entries()) if (await remoteKind(rt, g.handles[i] ?? t) !== "folder") throw new ValidationError(`${t} is not a folder; merge applies to folders, so download files without merge.`);
          }
          await assertSyncsUnchanged(synced2);
          makeLd();
          const expect = [];
          const into = /* @__PURE__ */ new Set();
          for (const p of matched.filter((x) => isIgnoreFileName(posix.basename(x)))) {
            const top = g.paths.find((t) => p === t || p.startsWith(`${t}/`)) ?? p;
            const rel = p === top ? [] : p.slice(top.length + 1).split("/");
            const topName = posix.dirname(top) === "//from" ? posix.basename(top).replace(/^[^:]*:/, "") : posix.basename(top);
            expect.push(merge && p !== top ? joinLocal(ld, ...rel) : joinLocal(ld, topName, ...rel));
            if (p !== top) for (const d of merge ? [ld] : landingsOf(ld, topName)) into.add(d);
          }
          noteDownloadIgnores(expect, carriesIgnoreFile && expect.length === 0 ? [ld] : [], [...into]);
          noteDownload(ld);
          const ldArg = onDiskSpelling(ld);
          const { done, failed } = await runPerHandle(rt, "get", g.handles, (h) => [...transferOpts, h, ldArg]);
          return ok(`Downloaded ${done} node(s)${failed ? `; ${failed} failed` : ""} into ${ld}.`, { downloaded: done, failed, localDir: ld });
        };
        return confirm ? withWriteLock(gateAndRun2) : gateAndRun2();
      }
      const source = isLink ? assertPublicLink(assertNoFlag(link, "link")) : remotePath !== void 0 && remotePath !== "" ? assertNotStoreCopy(assertNoWildcard(assertRemotePath(remotePath), "remotePath")) : "";
      if (!source) throw new ValidationError("Provide remotePath or link.");
      if (!isLink && /^(?:\/|\/\/(?:bin|in))\/?$/.test(source)) throw new ValidationError(`${source} is a root; download the folders inside it instead.`);
      const versionOf = isLink ? null : versionPlainName(posix.basename(source));
      if (!isLink && posix.dirname(source).split("/").some((seg) => /#\d{10}$/.test(seg))) {
        throw new ValidationError("remotePath may name a file version only in its last part.");
      }
      if (versionOf !== null && merge) throw new ValidationError("merge applies to folders; a file version is downloaded as a file.");
      if (merge && !isLink && await remoteKind(rt, source) !== "folder") throw new ValidationError("merge applies to folders; download a file without merge (or the source could not be checked).");
      if (merge && isLink && /\/file\/|#!/.test(source)) throw new ValidationError("merge applies to folder links; download a file link without merge.");
      const versionTarget2 = versionOf === null ? null : joinLocal(ld, versionOf);
      if (versionTarget2 && existsSync(versionTarget2) && statSync(versionTarget2).isDirectory()) {
        throw new ValidationError(`${versionTarget2} is a folder; download the version into another localDir.`);
      }
      if (ldMissing) assertDownloadTarget(dirname(ld), basename(ld));
      else if (isLink || merge) assertDownloadTarget(ld, null);
      else for (const name of localNamesOf(source)) assertDownloadTarget(ld, name);
      const landingNames = versionOf === null ? localNamesOf(source) : [versionOf];
      if (isLink || merge) assertNoSyncRootAt(null);
      else for (const name of landingNames) assertNoSyncRootAt(name);
      const ldSynced = isLink ? false : await inSyncedLocalFolder(rt, ld);
      let innerHits = [];
      let innerUnchecked = false;
      const innerIgnoreFiles = async () => {
        const r = await ignoreFilesBelow(rt, source);
        innerUnchecked = r?.unchecked ?? false;
        if (innerUnchecked && ldSynced !== false) throw new ValidationError(`Could not check ${source} for .megaignore files before downloading it into a synced folder.`);
        innerHits = r?.hits ?? [];
        if (innerHits.length > 0 && ldSynced !== false) {
          throw new ValidationError(`Refusing to download ${source} into ${ld}: it holds ${innerHits[0]}${innerHits.length > 1 ? ` and ${innerHits.length - 1} more` : ""}, and in a synced folder a .megaignore decides what the sync carries.`);
        }
      };
      if (!isLink) {
        for (const name of landingNames) ignoreFileCheck(name, ldSynced);
        if (versionOf === null) await innerIgnoreFiles();
      }
      if (!isLink && !confirm) await assertNoStoreCopyBelow(rt, source);
      const execNote = await executableDownloadNote(rt);
      const synced = await syncedLocalLines(rt, ld);
      const copies = isLink && synced.length > 0 ? storeCopiesIn(ld) : { found: [], complete: true };
      if (copies.found.length > 0 || !copies.complete) {
        throw new ValidationError(`${ld} is in a synced folder and ${copies.found[0] ? `holds ${copies.found[0]}, a copy of MEGAcmd's session store` : "could not be searched completely for copies of MEGAcmd's session store"}; what a link holds is not known before it arrives, so it is not downloaded there.`);
      }
      const gateAndRun = async () => {
        const placed = isLink ? [] : [...unconfirmedWriteLines(source), ...await recoveryKeyLinesBelow(rt, [source])];
        const same = isLink ? { count: 1, lines: [] } : await sameNamed(rt, source);
        const gate = checkConfirm(
          rt,
          "mega_get",
          {
            source,
            localDir: ld,
            isLink,
            background,
            ignoreQuotaWarn,
            merge,
            password: secretBinding(password),
            items: same.count,
            exec: execNote,
            synced,
            // Downloaded into a sync, it is uploaded again: bound like a copy to that place.
            contents: synced.length > 0 && !isLink ? await contentDigest(rt, source) : null,
            placed
          },
          confirm,
          [
            ...placed,
            `This will download ${isLink ? `the link ${source}` : source} into ${ld}${created}${versionTarget2 ? `, saved as ${versionTarget2}` : ""}${merge ? " - its contents straight into that folder, merged with what is already there" : ""}${background ? ", in the background" : ""}${ignoreQuotaWarn ? ", ignoring a transfer-quota warning" : ""}.`,
            ...same.lines,
            ...execNote ? [execNote] : [],
            ...synced
          ]
        );
        if (gate) return gate;
        await assertSyncsUnchanged(synced);
        if (!isLink) await assertNoStoreCopyBelow(rt, source);
        if (synced.length > 0 && !isLink && versionOf === null) await innerIgnoreFiles();
        makeLd();
        if (isLink || innerUnchecked) noteDownloadIgnores([], [ld]);
        else {
          const shown = source.replace(/(.)\/+$/, "$1");
          const name = versionTarget2 ? null : posix.dirname(shown) === "//from" ? posix.basename(shown).replace(/^[^:]*:/, "") : posix.basename(shown);
          const inside = (h) => (h.startsWith("/") ? h : `//from/${h}`).slice(shown.length + 1).split("/");
          noteDownloadIgnores(
            [
              ...versionTarget2 && isIgnoreFileName(posix.basename(versionTarget2)) ? [versionTarget2] : [],
              ...name && isIgnoreFileName(name) ? [joinLocal(ld, name)] : [],
              ...innerHits.filter((h) => h !== shown).map((h) => merge || !name ? joinLocal(ld, ...inside(h)) : joinLocal(ld, name, ...inside(h)))
            ],
            [],
            // The folder holding ones inside it is searched before a sync too (ld itself when merged).
            innerHits.some((h) => h !== shown) ? merge || !name ? [ld] : landingsOf(ld, name) : []
          );
        }
        noteDownload(ld);
        const ldArg = onDiskSpelling(ld);
        const args = [...transferOpts, ...password ? [`--password=${password}`] : [], source, versionTarget2 ? joinLocal(ldArg, basename(versionTarget2)) : ldArg];
        return runToResult(rt, "get", args, () => ok(`Downloaded into ${ld}.`, { source, localDir: ld, isLink }));
      };
      return confirm ? withWriteLock(gateAndRun) : gateAndRun();
    })
  );
  server.registerTool(
    "mega_thumbnail",
    {
      title: "MEGA: thumbnail",
      description: `Download a cloud file's thumbnail to a local path (action="download"), or set the node's thumbnail from a local image (action="set"). Requires confirmation.`,
      inputSchema: {
        remotePath: external_exports.string().describe("Absolute MEGA path to the file."),
        localPath: external_exports.string().describe("Local path: destination (download) or source image (set)."),
        action: external_exports.enum(["download", "set"]).default("download").describe("Download the thumbnail, or set it from the local image."),
        confirm: external_exports.string().optional().describe("Confirmation token from the first call.")
      },
      annotations: { title: "MEGA: thumbnail", destructiveHint: true, openWorldHint: true }
    },
    async ({ remotePath, localPath, action, confirm }) => guardRun(async () => {
      const rp = assertNoWildcard(assertRemotePath(remotePath), "remotePath");
      const lp = assertLocalPath(localPath);
      if (action !== "set") {
        assertDownloadTarget(dirname(lp), basename(lp));
        assertNotIgnoreFile(lp);
      }
      const replaces = action !== "set" && (existsSync(lp) || isSymlink(lp));
      if (action === "set") assertImageFile(lp);
      const notes = action === "set" ? await destinationNotes(rt, rp) : [];
      const execNote = action !== "set" ? await executableDownloadNote(rt) : null;
      const synced = action !== "set" ? await syncedLocalLines(rt, dirname(lp)) : [];
      const summary = action === "set" ? [`This will set the thumbnail of ${rp} from ${lp}.`, ...notes] : [`This will write the thumbnail of ${rp} to ${lp}${replaces ? " - REPLACING the file that is there now" : ""}.`, ...execNote ? [execNote] : [], ...synced];
      const gate = checkConfirm(rt, "mega_thumbnail", { remotePath: rp, localPath: lp, action, replaces, exec: execNote, notes, synced }, confirm, summary);
      if (gate) return gate;
      if (action === "set") noteSessionChange(rp, `its thumbnail was set from ${lp}`);
      else noteDownload(dirname(lp));
      const args = action === "set" ? ["-s", rp, lp] : [rp, lp];
      return runToResult(
        rt,
        "thumbnail",
        args,
        () => ok(action === "set" ? `Set thumbnail of ${rp} from ${lp}.` : `Thumbnail for ${rp} saved to ${lp}.`, { remotePath: rp, localPath: lp, action })
      );
    })
  );
}

// src/tools/dangerous.ts
var dangerous_exports = {};
__export(dangerous_exports, {
  describeExpiry: () => describeExpiry,
  registerDangerous: () => registerDangerous
});
import { posix as posix2 } from "node:path";
var SHARE_LEVEL = { read: "0", readwrite: "1", full: "2", owner: "3" };
function isSessionHandle(id) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return false;
  const bytes = Buffer.from(id, "base64url");
  return bytes.length === 8 && !bytes.every((b) => b === 255) && bytes.toString("base64url") === id;
}
async function currentSessionId(rt) {
  const r = await rt.run("whoami", ["-l"]);
  if (r.code !== 0) return null;
  const lines = r.stdout.split(/\r?\n/);
  const ids = /* @__PURE__ */ new Set();
  lines.forEach((line, i) => {
    if (!/^\s*\* Current Session\s*$/.test(line)) return;
    const m = (lines[i + 1] ?? "").match(/^\s*Session ID:\s*([A-Za-z0-9_-]{11})\s*$/);
    ids.add(m ? m[1] : "");
  });
  return ids.size === 1 && !ids.has("") ? [...ids][0] : null;
}
function withoutKey(link) {
  const modern = link.match(/^(.*\/(?:file|folder)\/[^#/]+)#/);
  if (modern) return modern[1];
  const legacy = link.match(/^(.*#F?![^!]+)!/);
  if (legacy) return legacy[1];
  return link.replace(/#.*$/, "");
}
function isPasswordProtected(link) {
  return !!link && link.includes("#P!");
}
function describeExpiry(expire) {
  if (!/^(?:\d{1,6}[ymdhMs])+$/.test(expire)) {
    throw new ValidationError('expire must be numbers each followed by a unit: y (years), m (months), d (days), h (hours), M (minutes) or s (seconds), e.g. "7d" or "1m2d".');
  }
  const units = [["y", "year"], ["m", "month"], ["d", "day"], ["h", "hour"], ["M", "minute"], ["s", "second"]];
  const value = /* @__PURE__ */ new Map();
  for (const [, n, u] of expire.matchAll(/(\d+)([ymdhMs])/g)) value.set(u, Number(n));
  return units.filter(([u]) => value.has(u)).map(([u, word]) => `${value.get(u)} ${word}${value.get(u) === 1 ? "" : "s"}`).join(" ");
}
function exportOptionLines(megaHosted, password, expire) {
  return [
    ...megaHosted ? ["The folder key will also be shared with MEGA (MEGA-hosted / S4)."] : [],
    ...password ? ["The link will be password-protected."] : [],
    ...expire ? [`The link will expire after ${describeExpiry(expire)} ("${expire}").`] : []
  ];
}
function registerDangerous(server, rt) {
  server.registerTool(
    "mega_logout",
    {
      title: "MEGA: log out",
      description: "Log out of the current MEGA session on this machine (invalidates it server-side). Requires confirmation. Log back in out-of-band afterward.",
      inputSchema: { confirm: external_exports.string().optional().describe("Confirmation token from the first call.") },
      // Destructive: ends this login on the server; the user has to log in again.
      annotations: { title: "MEGA: log out", destructiveHint: true, openWorldHint: true }
    },
    async ({ confirm }) => guardRun(async () => {
      const gate = checkConfirm(rt, "mega_logout", {}, confirm, "This will log out the current MEGA session on this machine (you can log in again afterward).");
      if (gate) return gate;
      return runToResult(rt, "logout", [], () => ok("Logged out of MEGA.", { loggedOut: true }));
    })
  );
  server.registerTool(
    "mega_killsession",
    {
      title: "MEGA: close other sessions",
      description: "Close other MEGA login sessions on this account (the current session is kept). By default closes ALL other sessions; optionally pass a specific sessionId (not this computer's own session - mega_logout does that). Requires confirmation.",
      inputSchema: {
        sessionId: external_exports.string().optional().describe("A specific session ID to close (from mega_sessions when account details are enabled, or from the user). Omit to close all other sessions."),
        confirm: external_exports.string().optional().describe("Confirmation token from the first call.")
      },
      annotations: { title: "MEGA: close other sessions", destructiveHint: true, openWorldHint: true }
    },
    async ({ sessionId, confirm }) => guardRun(async () => {
      const sid = sessionId === void 0 ? void 0 : assertNoFlag(sessionId, "sessionId");
      if (sid !== void 0 && /\s/.test(sid)) {
        throw new ValidationError("sessionId must be a single non-empty token.");
      }
      if (sid !== void 0 && !isSessionHandle(sid)) {
        throw new ValidationError("sessionId must be a session handle (11 characters, as listed by MEGA). To close all other sessions, omit sessionId.");
      }
      const current = sid ? await currentSessionId(rt) : null;
      if (sid && current === sid) {
        throw new ValidationError(`Session ${sid} is this computer's own session; closing it would log MEGAcmd out here. Use mega_logout for that.`);
      }
      const summary = sid ? current ? `This will close MEGA session ${sid} (not this computer's own session, which is kept).` : `This will close MEGA session ${sid}. (Could not check whether it is this computer's own session - if it is, MEGAcmd is logged out here and its syncs stop.)` : "This will close ALL other MEGA login sessions on this account (the current session is kept).";
      const gate = checkConfirm(rt, "mega_killsession", { sessionId: sid ?? null, current }, confirm, summary);
      if (gate) return gate;
      const args = sid ? [sid] : ["-a"];
      return runToResult(
        rt,
        "killsession",
        args,
        () => ok(sid ? `Closed session ${sid}.` : "Closed all other sessions.", { sessionId: sid ?? null, all: !sid })
      );
    })
  );
  server.registerTool(
    "mega_rm",
    {
      title: "MEGA: delete",
      description: "Permanently delete a MEGA cloud node (recursive). Requires confirmation.",
      inputSchema: {
        remotePath: external_exports.string().describe("Absolute MEGA path to delete (a PCRE pattern when usePcre=true)."),
        usePcre: external_exports.boolean().default(false).describe('Interpret remotePath as a PCRE pattern and delete EVERY match. It starts with "/" and each part of the path is matched on its own, e.g. /Docs/.*\\.pdf$.'),
        confirm: external_exports.string().optional().describe("Confirmation token from the first call.")
      },
      annotations: { title: "MEGA: delete", destructiveHint: true, openWorldHint: true }
    },
    async ({ remotePath, usePcre, confirm }) => guardRun(async () => {
      if (usePcre) {
        const rp2 = assertNoFlag(remotePath, "remotePath");
        const g = await pcreGate(
          rt,
          "mega_rm",
          { remotePath: rp2, usePcre: true },
          confirm,
          rp2,
          (n, t) => `This will PERMANENTLY delete ${n} node(s) matching the pattern, AND ALL THEIR CONTENTS (recursive):
${t}`,
          void 0,
          // A match in a two-way synced folder is deleted on this computer too.
          { extraLines: (tops) => syncedSourceNotes(rt, tops, "removed"), bindContents: true }
        );
        if (!g.proceed) return g.result;
        if (g.handles.length === 0) return ok("No matching nodes to delete.", { deleted: 0 });
        const { done, failed } = await runPerHandle(rt, "rm", g.handles, (h) => ["-r", "-f", h]);
        return ok(`Deleted ${done} node(s)${failed ? `; ${failed} failed` : ""}.`, { deleted: done, failed });
      }
      const rp = assertNoWildcard(assertRemotePath(remotePath), "remotePath");
      if (posix2.dirname(rp).split("/").some((seg) => /#\d{10}$/.test(seg))) {
        throw new ValidationError("remotePath may name a file version only in its last part.");
      }
      const ver = posix2.basename(rp).match(/^(.+)#(\d{10})$/);
      if (ver) {
        const file = joinRemote(posix2.dirname(rp), ver[1]);
        if ((await sameNamed(rt, file)).count !== 1 || await remoteKind(rt, file) !== "file") {
          throw new ValidationError(`Deleting one version needs exactly one FILE named ${file}.`);
        }
        const ls = await rt.run("ls", ["-l", "--versions", "--show-handles", file]);
        if (ls.code !== 0) throw new ValidationError(`Could not list the versions of ${file}: ${classifyExit(ls)}`);
        const lines = ls.stdout.split(/\r?\n/);
        const from = lines.findIndex((l) => l.startsWith("Versions of "));
        const own = from < 0 ? [] : lines.slice(from + 1);
        const end = own.findIndex((l) => l.trim() === "" || l.startsWith("Versions of "));
        const versions = (end < 0 ? own : own.slice(0, end)).map((l) => l.match(/\s(H:[A-Za-z0-9_-]+)\s.*#(\d{10})\s*$/)).filter((m) => m !== null).map((m) => ({ handle: m[1], time: m[2] }));
        const hits = versions.map((v, i) => ({ ...v, current: i === 0 })).filter((v) => v.time === ver[2]);
        if (hits.length !== 1 || hits[0].current) {
          throw new ValidationError(
            hits.some((h) => h.current) ? `${rp} has the time of the CURRENT ${file} (a restored version keeps its time), so it cannot be deleted on its own here. Use the MEGA app, or delete the file with its plain path.` : `${rp} is not one older version of ${file}.`
          );
        }
        const handle = hits[0].handle;
        const vgate = checkConfirm(rt, "mega_rm", { remotePath: rp, olderVersion: handle }, confirm, [
          `This will PERMANENTLY delete one older version of ${file} (${rp}); the current file and its other versions stay.`
        ]);
        if (vgate) return vgate;
        return runToResult(rt, "rm", ["-f", handle], () => ok(`Deleted the older version ${rp}.`, { remotePath: rp, deleted: true }));
      }
      const same = await sameNamed(rt, rp);
      const local = await syncedSourceNotes(rt, [rp], "removed");
      const contents = await contentDigest(rt, rp);
      const gate = checkConfirm(rt, "mega_rm", { remotePath: rp, items: same.count, local, contents }, confirm, [`This will PERMANENTLY delete ${rp} and all its contents.`, ...same.lines, ...local]);
      if (gate) return gate;
      return runToResult(rt, "rm", ["-r", "-f", rp], () => ok(`Deleted ${rp}.`, { remotePath: rp, deleted: true }));
    })
  );
  server.registerTool(
    "mega_deleteversions",
    {
      title: "MEGA: delete versions",
      description: "Delete prior file-version history, for a single path or (with all=true) the entire account. Requires confirmation.",
      inputSchema: {
        remotePath: external_exports.string().optional().describe("Absolute MEGA path whose versions to delete."),
        all: external_exports.boolean().default(false).describe("Delete version history for the whole account."),
        confirm: external_exports.string().optional().describe("Confirmation token from the first call.")
      },
      annotations: { title: "MEGA: delete versions", destructiveHint: true, openWorldHint: true }
    },
    async ({ remotePath, all, confirm }) => guardRun(async () => {
      const rp = assertOptionalRemotePath(remotePath);
      if (rp) assertNoVersionName(assertNoWildcard(rp, "remotePath"));
      if (!all && !rp) throw new ValidationError("Provide a remotePath, or set all=true to clear the whole account.");
      const summary = all ? "This will delete ALL prior file versions across the entire account." : `This will delete prior file versions of ${rp} (of every file inside it, if it is a folder).`;
      const same = rp && !all ? await sameNamed(rt, rp) : { count: 0, lines: [] };
      const contents = rp && !all ? await contentDigest(rt, rp) : null;
      const gate = checkConfirm(rt, "mega_deleteversions", { remotePath: rp ?? null, all, items: same.count, contents }, confirm, [summary, ...same.lines]);
      if (gate) return gate;
      const args = all ? ["-f", "--all"] : ["-f", rp];
      return runToResult(rt, "deleteversions", args, () => ok(summary.replace(/^This will /, "Done: "), { all, remotePath: rp }));
    })
  );
  server.registerTool(
    "mega_export",
    {
      title: "MEGA: public link",
      description: 'Manage a public link for a MEGA node. action="create" makes a public link (confirm), "delete" removes it (confirm), "status" shows current state (read-only). Create options: writable (anyone with the link can upload), megaHosted (S4), password, expire.',
      inputSchema: {
        remotePath: external_exports.string().describe("Absolute MEGA path."),
        action: external_exports.enum(["create", "delete", "status"]).describe('What to do with the public link. "status" says whether there is one, without its key; "create" (asks first) returns the full link, also an existing one.'),
        writable: external_exports.boolean().default(false).describe("Create a WRITABLE folder link \u2014 anyone with the link can upload into the folder."),
        megaHosted: external_exports.boolean().default(false).describe("Share the folder share-key with MEGA (for S4 access)."),
        password: external_exports.string().optional().describe("Password-protect the link."),
        expire: external_exports.string().optional().describe('Expiry delay: numbers each followed by a unit - y (years), m (MONTHS), d (days), h (hours), M (minutes), s (seconds). E.g. "7d", "1m" (one month), "30M" (30 minutes).'),
        usePcre: external_exports.boolean().default(false).describe('Interpret remotePath as a PCRE pattern (affects every match). It starts with "/" and each part of the path is matched on its own, e.g. /Docs/.*\\.pdf$.'),
        confirm: external_exports.string().optional().describe("Confirmation token (create/delete only).")
      },
      annotations: { title: "MEGA: public link", destructiveHint: true, openWorldHint: true }
    },
    async ({ remotePath, action, writable, megaHosted, password, expire, usePcre, confirm }) => guardRun(async () => {
      if (action === "status") {
        const rp2 = usePcre ? assertNoFlag(remotePath, "remotePath") : assertRemotePath(remotePath);
        const r = await rt.run("export", [...usePcre ? ["--use-pcre"] : [], rp2]);
        if (r.code !== 0) return err(classifyExit(r), { ok: false, code: r.code });
        const link = usePcre ? parseExportLink(r.stdout)?.replace(/\)+$/, "") ?? null : ownExportLink(r.stdout, rp2);
        if (!link) return ok(`No public link for ${rp2}.`, { remotePath: rp2, link: null });
        try {
          if (usePcre) {
            const m = await pcreMatchPreview(rt, rp2);
            if (!m.ok) return err(m.error, { remotePath: rp2 });
            for (const p of m.paths) assertNotStoreCopy(p, "A matched node");
          } else {
            assertNotStoreCopy(rp2);
            await assertNoStoreCopyBelow(rt, rp2);
          }
        } catch (e) {
          if (!(e instanceof ValidationError)) throw e;
          return err(
            `${rp2} has a public link, but it is (or holds) a copy of the MEGAcmd session store, which carries this account's login, so the link is not shown. Remove it with action "delete". (${e.message})`,
            { remotePath: rp2, link: null, withheld: true }
          );
        }
        const shown = withoutKey(link);
        return ok(
          `${rp2} has a public link: ${shown}#... (its key is not shown here - with it, the link opens even where a password was set on it elsewhere). To get the full link, use action "create", which asks the user first and returns the existing link.`,
          { remotePath: rp2, link: shown, keyHidden: true }
        );
      }
      if (action === "create") {
        if (password !== void 0) assertSecret(password, "password");
        const exp = expire === void 0 ? void 0 : assertFlagValue(expire, "expire");
        if (exp !== void 0) describeExpiry(exp);
        const note = writable ? " These are WRITABLE links \u2014 anyone with the URL can UPLOAD into the folder." : "";
        const publish = async (node, path) => {
          const r2 = await rt.run("export", createArgs(node));
          if (r2.code === ExitCode.EXISTS) return "failed";
          const withdraw = async () => {
            const c = (await rt.run("export", ["-d", node])).code;
            return c === 0 ? "unprotected" : c === ExitCode.INVALIDSTATE ? "failed" : "still-public";
          };
          if (r2.code !== 0) return password || exp ? withdraw() : "failed";
          if (password && !isPasswordProtected(parseCreatedLink(r2.stdout, path))) return withdraw();
          return "ok";
        };
        const createArgs = (node) => [
          "-a",
          "-f",
          ...writable ? ["--writable"] : [],
          ...megaHosted ? ["--mega-hosted"] : [],
          ...password ? [`--password=${password}`] : [],
          ...exp ? [`--expire=${exp}`] : [],
          node
        ];
        if (usePcre) {
          const rp3 = assertNoFlag(remotePath, "remotePath");
          const listedAll = [];
          const g = await pcreGate(
            rt,
            "mega_export:create",
            { remotePath: rp3, writable, megaHosted, password: secretBinding(password), expire: expire ?? null, usePcre: true },
            confirm,
            rp3,
            (n, t) => [`This will create PUBLIC links for ${n} node(s) that anyone with the URL can access.${note}`, ...exportOptionLines(megaHosted, password, exp).map(previewSafe), t].join("\n"),
            (p) => {
              assertNotStoreCopy(p, "A matched node");
              listedAll.push(p);
            },
            {
              extraLines: async (tops) => [
                ...unconfirmedWriteLines(tops),
                ...recoveryKeyLines(listedAll),
                ...await syncedWithinLines(rt, tops, "published"),
                ...writable ? await writableShareLines(rt, tops, "anyone with the writable link", "make a read-only link instead") : []
              ],
              bindContents: true
            }
          );
          if (!g.proceed) return g.result;
          if (g.handles.length === 0) return ok("No matching nodes.", { created: 0 });
          let done = 0;
          let failed = 0;
          let unprotected = 0;
          const stillPublic = [];
          for (const [i, h] of g.handles.entries()) {
            const outcome = await publish(h, g.paths[i] ?? "");
            if (outcome === "ok") done++;
            else if (outcome === "unprotected") unprotected++;
            else if (outcome === "still-public") stillPublic.push(h);
            else failed++;
          }
          return (failed || unprotected || stillPublic.length ? err : ok)(
            `Created ${done} public link(s)${failed ? `; ${failed} failed` : ""}${unprotected ? `; ${unprotected} withdrawn because MEGA would not apply the password or expiry (that needs a Pro account)` : ""}${stillPublic.length ? `; ${stillPublic.length} could NOT be withdrawn and are public WITHOUT a password (${stillPublic.join(", ")}) - remove them with action "delete"` : ""}.`,
            { created: done, failed, unprotected, stillPublic }
          );
        }
        const rp2 = assertNotStoreCopy(assertNoVersionName(assertNoWildcard(assertRemotePath(remotePath), "remotePath")));
        if (!confirm) await assertNoStoreCopyBelow(rt, rp2);
        const same2 = await sameNamed(rt, rp2);
        if (password && same2.count > 1) {
          throw new ValidationError(`${same2.count} items are named ${rp2}; a password-protected link is made for one item at a time. Use usePcre to pick them.`);
        }
        const placed = [
          ...unconfirmedWriteLines(rp2),
          ...await recoveryKeyLinesBelow(rt, [rp2]),
          ...await syncedWithinLines(rt, rp2, "published"),
          // An upload key lets anyone with the link add files: a sync brings them to this computer.
          ...writable ? await writableShareLines(rt, [rp2], "anyone with the writable link", "make a read-only link instead") : []
        ];
        const contents = await contentDigest(rt, rp2);
        const existing = same2.count <= 1 ? ownExportLink((await rt.run("export", [rp2])).stdout, rp2) : null;
        if (existing && (password || exp || writable || megaHosted)) {
          throw new ValidationError(`${rp2} already has a public link, and MEGA cannot add options to it. Remove it (action "delete") and create it again with those options.`);
        }
        const gate2 = checkConfirm(
          rt,
          "mega_export:create",
          { remotePath: rp2, writable, megaHosted, password: secretBinding(password), expire: expire ?? null, items: same2.count, placed, existing: existing !== null, contents },
          confirm,
          existing ? [
            `${rp2} already has a public link. Confirming shows it in full, with its key: anyone who gets it can open ${rp2} (also where a password was set on the link elsewhere).`,
            ...placed
          ] : [
            `This will create a PUBLIC link for ${rp2} that anyone with the URL can access.${writable ? " This is a WRITABLE link \u2014 anyone with the URL can UPLOAD into the folder." : ""}`,
            ...exportOptionLines(megaHosted, password, exp),
            ...same2.lines,
            ...placed
          ]
        );
        if (gate2) return gate2;
        await assertNoStoreCopyBelow(rt, rp2);
        if (existing) {
          const now = ownExportLink((await rt.run("export", [rp2])).stdout, rp2);
          if (!now) return err(`${rp2} no longer has a public link.`, { remotePath: rp2 });
          return ok(`Public link for ${rp2}:
${now}`, { remotePath: rp2, link: now, existing: true });
        }
        const r = await rt.run("export", createArgs(rp2));
        if (r.code !== 0) {
          const made = exp || password ? ownExportLink((await rt.run("export", [rp2])).stdout, rp2) : null;
          if (made && (exp || !isPasswordProtected(made))) {
            const gone = (await rt.run("export", ["-d", rp2])).code === 0;
            const what = exp ? "without the expiry" : "without the password";
            return err(`${classifyExit(r)} ${gone ? `The link MEGA made ${what} was removed again.` : `The link MEGA made ${what} could NOT be removed: ${rp2} is public now. Remove it with action "delete".`}`, { ok: false, code: r.code, withdrawn: gone });
          }
          return err(classifyExit(r), { ok: false, code: r.code });
        }
        const link = parseCreatedLink(r.stdout);
        if (password && !isPasswordProtected(link)) {
          if ((await rt.run("export", ["-d", rp2])).code !== 0) {
            return err(
              `MEGA created the link for ${rp2} WITHOUT a password (password-protected links need a Pro account), and removing it again FAILED: ${rp2} is public now, without a password. Remove the link with action "delete".`,
              { remotePath: rp2, unprotected: true, withdrawn: false }
            );
          }
          return err(
            `MEGA created the link for ${rp2} WITHOUT a password (password-protected links need a Pro account), so it was removed again. Nothing is published.`,
            { remotePath: rp2, unprotected: true }
          );
        }
        return ok(link ? `Public link created for ${rp2}:
${link}` : `Public link created for ${rp2}.`, { remotePath: rp2, link, writable });
      }
      if (usePcre) {
        const rp2 = assertNoFlag(remotePath, "remotePath");
        const g = await pcreGate(rt, "mega_export:delete", { remotePath: rp2, usePcre: true }, confirm, rp2, (n, t) => `This will remove the public link from ${n} node(s):
${t}`);
        if (!g.proceed) return g.result;
        if (g.handles.length === 0) return ok("No matching nodes.", { removed: 0 });
        const { done, failed } = await runPerHandle(rt, "export", g.handles, (h) => ["-d", h]);
        return ok(`Removed ${done} public link(s)${failed ? `; ${failed} failed` : ""}.`, { removed: done, failed });
      }
      const rp = assertNoWildcard(assertRemotePath(remotePath), "remotePath");
      const same = await sameNamed(rt, rp);
      const gate = checkConfirm(rt, "mega_export:delete", { remotePath: rp, items: same.count }, confirm, [`This will remove the public link for ${rp}.`, ...same.lines]);
      if (gate) return gate;
      return runToResult(rt, "export", ["-d", rp], () => ok(`Public link removed for ${rp}.`, { remotePath: rp }));
    })
  );
  server.registerTool(
    "mega_share",
    {
      title: "MEGA: share",
      description: 'Manage user shares of a MEGA folder. action="add" grants access to a user (confirm), "remove" revokes it (confirm), "list" shows current shares (read-only, set pending=true to include pending shares). Level "owner" grants full owner access.',
      inputSchema: {
        remotePath: external_exports.string().optional().describe("Absolute MEGA folder path (required for add/remove)."),
        action: external_exports.enum(["add", "remove", "list"]).describe("Share operation."),
        withEmail: external_exports.string().email().optional().describe("User email (required for add/remove)."),
        level: external_exports.enum(["read", "readwrite", "full", "owner"]).optional().describe('Access level for add (default read). "owner" gives full owner access.'),
        pending: external_exports.boolean().default(false).describe("When listing, also show pending shares."),
        usePcre: external_exports.boolean().default(false).describe('Interpret remotePath as a PCRE pattern (affects every match). It starts with "/" and each part of the path is matched on its own, e.g. /Docs/.*\\.pdf$.'),
        confirm: external_exports.string().optional().describe("Confirmation token (add/remove only).")
      },
      annotations: { title: "MEGA: share", destructiveHint: true, openWorldHint: true }
    },
    async ({ remotePath, action, withEmail, level, pending, usePcre, confirm }) => guardRun(async () => {
      if (action === "list") {
        const rp2 = usePcre && remotePath ? assertNoFlag(remotePath, "remotePath") : assertOptionalRemotePath(remotePath);
        const args = [...pending ? ["-p"] : [], ...usePcre && rp2 ? ["--use-pcre"] : [], ...rp2 ? [rp2] : []];
        return runToResult(rt, "share", args, (r) => ok(r.stdout.trim().slice(0, 4e3) || "(no shares)", { remotePath: rp2 ?? null, pending }));
      }
      if (!withEmail) throw new ValidationError("withEmail is required for add/remove.");
      if (action === "add") {
        const lvl = SHARE_LEVEL[level ?? "read"];
        const addArgs = (node) => ["-a", `--with=${withEmail}`, `--level=${lvl}`, node];
        if (usePcre) {
          const rp3 = assertNoFlag(remotePath ?? "", "remotePath");
          const listedAll = [];
          const g = await pcreGate(
            rt,
            "mega_share:add",
            { remotePath: rp3, withEmail, level: level ?? "read", usePcre: true },
            confirm,
            rp3,
            (n, t) => `This will share ${n} node(s) with ${withEmail} (${level ?? "read"} access):
${t}`,
            (p) => {
              assertNotStoreCopy(p, "A matched node");
              listedAll.push(p);
            },
            {
              extraLines: async (tops) => [...unconfirmedWriteLines(tops), ...recoveryKeyLines(listedAll), ...await syncedWithinLines(rt, tops, "shared"), ...lvl === "0" ? [] : await writableShareLines(rt, tops, withEmail)],
              bindContents: true
            }
          );
          if (!g.proceed) return g.result;
          if (g.handles.length === 0) return ok("No matching nodes.", { shared: 0 });
          const { done, failed } = await runPerHandle(rt, "share", g.handles, addArgs);
          return ok(`Shared ${done} node(s) with ${withEmail}${failed ? `; ${failed} failed` : ""}.`, { withEmail, shared: done, failed });
        }
        const rp2 = assertNotStoreCopy(assertNoVersionName(assertNoWildcard(assertRemotePath(remotePath ?? "", "remotePath"), "remotePath")));
        if (!confirm) await assertNoStoreCopyBelow(rt, rp2);
        const same2 = await sameNamed(rt, rp2);
        const placed = [...unconfirmedWriteLines(rp2), ...await recoveryKeyLinesBelow(rt, [rp2]), ...await syncedWithinLines(rt, rp2, "shared"), ...lvl === "0" ? [] : await writableShareLines(rt, [rp2], withEmail)];
        const contents = await contentDigest(rt, rp2);
        const gate2 = checkConfirm(rt, "mega_share:add", { remotePath: rp2, withEmail, level: level ?? "read", items: same2.count, placed, contents }, confirm, [`This will share ${rp2} with ${withEmail} (${level ?? "read"} access).`, ...same2.lines, ...placed]);
        if (gate2) return gate2;
        await assertNoStoreCopyBelow(rt, rp2);
        return runToResult(rt, "share", addArgs(rp2), () => ok(`Shared ${rp2} with ${withEmail} (${level ?? "read"}).`, { remotePath: rp2, withEmail, level: level ?? "read" }));
      }
      const rmArgs = (node) => ["-d", `--with=${withEmail}`, node];
      if (usePcre) {
        const rp2 = assertNoFlag(remotePath ?? "", "remotePath");
        const g = await pcreGate(rt, "mega_share:remove", { remotePath: rp2, withEmail, usePcre: true }, confirm, rp2, (n, t) => `This will revoke ${withEmail}'s access to ${n} node(s):
${t}`);
        if (!g.proceed) return g.result;
        if (g.handles.length === 0) return ok("No matching nodes.", { revoked: 0 });
        const { done, failed } = await runPerHandle(rt, "share", g.handles, rmArgs);
        return ok(`Revoked ${withEmail}'s access to ${done} node(s)${failed ? `; ${failed} failed` : ""}.`, { withEmail, revoked: done, failed });
      }
      const rp = assertNoWildcard(assertRemotePath(remotePath ?? "", "remotePath"), "remotePath");
      const same = await sameNamed(rt, rp);
      const gate = checkConfirm(rt, "mega_share:remove", { remotePath: rp, withEmail, items: same.count }, confirm, [`This will revoke ${withEmail}'s access to ${rp}.`, ...same.lines]);
      if (gate) return gate;
      return runToResult(rt, "share", rmArgs(rp), () => ok(`Revoked ${withEmail}'s access to ${rp}.`, { remotePath: rp, withEmail }));
    })
  );
}

export {
  survivesRoundTrip,
  isPublicLink,
  registerMutate,
  mutate_exports,
  registerDangerous,
  dangerous_exports
};
