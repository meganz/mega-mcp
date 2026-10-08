import { z } from 'zod';
import { ExitCode, classifyExit } from '../errors.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from '../runtime.js';
import { ok, err } from '../mcpResult.js';
import { posix, basename, dirname, join as joinLocal, relative, sep } from 'node:path';
import { statSync, lstatSync, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { isIgnoreFileName, assertRemotePath, assertLocalPath, assertNoFlag, assertSecret, assertNoWildcard, assertNotStoreCopy, assertDownloadTarget, assertNoLocalGlob, planUpload, storeCopyIn, storeCopiesIn, assertRemoteDest, assertNoVersionName, assertNoHandleName, assertNotIgnoreFile, foldName, joinRemote, localAtOrUnder, cloudNameOf, decodeLocalName, linksBelow, onDiskSpelling, ignoreFilesIn, isRecoveryKeyName, ValidationError } from '../paths.js';
import { syncLocalRoots, syncRootsBelowCloud, noteUploadIgnores, noteDownloadIgnores, landingsOf, noteDownload, downloadedIntoLines, backupLocalRoots, syncSnapshot, sharedBelowNotes, ignoreFilesBelow, withWriteLock, syncFollowLines, noteSessionChange, contentDigest, contentDigestMany, syncedLocalLines, guardRun, runToResult, checkConfirm, previewSafe, pcreGate, pcreMatchPreview, runPerHandle, runBulk, listedLines, ensureRemoteFolder, secretBinding, localNamesOf, assertNoStoreCopyBelow, assertNoStoreCopyBelowMany, destinationNotes, remoteKind, sameNamed, sameNamedMany, executableDownloadNote, childNames, assertSyncedLanding, noteUnconfirmedWrite, unconfirmedWriteLines, recoveryKeyLines, recoveryKeyLinesBelow, carryUnconfirmedWrites, noteKeyCopy, syncedSourceNotes, movedIntoSyncedLines, backupRotationLines, backupRotationLinesAt, backupFoldersWithinLines, chunkArgs, inSyncedLocalFolder } from './helpers.js';
import { isPublicLink } from '../argv.js';

/** Sources per `put` when a folder is uploaded piecewise around the session store. */
const PUT_CHUNK = 200;

/**
 * MEGAcmd's own test for "this is a link". Anything else `get`/`import` resolve as
 * a cloud PATH - wildcards and H:handles included - so a value that fails it would
 * skip every check a remote path gets.
 */
function assertPublicLink(link: string): string {
  if (!isPublicLink(link)) {
    throw new ValidationError('link must be a MEGA public link (https://mega.nz/file/... or /folder/...). For a path in your account, use remotePath.');
  }
  return link;
}

/**
 * The cloud name for mega_put's `name`: one plain name (no path), for one item.
 * Refused where MEGAcmd would read it as something else - a path, a version
 * (`name#<10 digits>`), or a copy of the session store.
 */
function uploadName(name: string, lps: string[], rp: string): string {
  if (lps.length !== 1) throw new ValidationError('name works with a single item only.');
  // MEGA finds a child by its NFC name: every check must see that spelling.
  const n = assertNoFlag(name, 'name').normalize('NFC');
  if (n === '' || n === '.' || n === '..' || /[\\/]/.test(n) || /#\d{10}$/.test(n) || /^H:[A-Za-z0-9_-]{8}$/.test(n)) {
    throw new ValidationError('name must be a plain file or folder name, without "/".');
  }
  // MEGA decodes `%xx` in an upload's name: the checks would see another name than MEGA writes.
  if (decodeLocalName(n) !== n.normalize('NFC')) throw new ValidationError('name may not contain %-escapes such as %2e.');
  assertNotStoreCopy(`${rp.replace(/\/+$/, '')}/${n}`);
  return n;
}

/**
 * A source naming a file version lands under that version's own name, so it gets an explicit
 * target (<dst>/<plain name> when dst is a folder). Returns the destination to use.
 */
async function versionTarget(rt: Runtime, src: string, d: string): Promise<string> {
  if (posix.dirname(src).split('/').some((seg) => /#\d{10}$/.test(seg))) {
    throw new ValidationError('src may name a file version only in its last part.');
  }
  const plain = versionPlainName(posix.basename(src)) ?? undefined;
  if (plain === undefined) return d;
  if (/#\d{10}$/.test(plain)) throw new ValidationError('src names a version of a name that itself reads as a version.');
  const kind = await remoteKind(rt, d);
  if (kind === 'unknown') throw new ValidationError(`Could not check what ${d} is; nothing was copied.`);
  const target = kind === 'folder' ? joinRemote(d, plain.normalize('NFC')) : d.replace(/(.)\/+$/, '$1');
  if ((await remoteKind(rt, target)) === 'folder') {
    throw new ValidationError(`${target} is a folder: a file version is copied or moved onto a file name. Choose another dst.`);
  }
  // Onto its own file MEGAcmd would delete that file with ALL its versions, this one included.
  if (target === joinRemote(posix.dirname(src), plain.normalize('NFC'))) {
    throw new ValidationError(`${target} is the file this version belongs to: copying onto it would delete it and all its versions for good. Copy the version to another name (or folder) instead.`);
  }
  return target;
}

/**
 * cp/mv resolve the destination as ONE node (the first of that name), while the checks match
 * every same-named node: refuse where what was checked could differ from what is written.
 */
async function assertOneDestination(rt: Runtime, d: string): Promise<void> {
  assertNoWildcard(d, 'dst');
  const same = await sameNamed(rt, d);
  if (same.count > 1) {
    throw new ValidationError(`${same.count} items are named ${d} (there, or in a same-named folder above it); MEGAcmd would write to the first one only. Rename or move one first.`);
  }
  if (same.count < 0) throw new ValidationError(`Could not check how many items are named ${d}; nothing was run.`);
}

/** The plain name of a version name `name#<10 digits>`, as MEGAcmd reads one (more than 12 bytes), or null. */
function versionPlainName(name: string): string | null {
  const m = name.match(/^(.+)#\d{10}$/);
  return m && Buffer.byteLength(name) > 12 ? (m[1] as string) : null;
}

function isLocalDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The account tree a cloud path is in: yours, or one person's share to you. */
function treeOf(p: string): string {
  // Shares from the same person move between each other like one tree (SDK checkmove).
  return p.match(/^\/\/from\/[^/:]+/)?.[0] ?? '/';
}

/**
 * A move between trees (yours and a share to you) is a copy and a delete, and the
 * copy becomes the new version of a same-named FILE there (MEGA SDK moveNode).
 */
async function crossTreeCollisions(rt: Runtime, sources: readonly string[], d: string, dKind: string): Promise<string[]> {
  const cross = sources.filter((s) => treeOf(s) !== treeOf(d));
  if (cross.length === 0) return [];
  // MEGAcmd renames (or removes a replaced file) after the move, by the old handle: the copy keeps its name.
  if (dKind !== 'folder') {
    throw new ValidationError(`${cross[0]} and ${d} are in different trees (your drive and a share to you): such a move cannot rename or replace. Move it into an existing folder, then rename it there.`);
  }
  const listed = await childNames(rt, d);
  if (!listed) return [`(Could not check what is in ${d}.)`];
  const here = new Set([...listed].map((n) => n.normalize('NFC')));
  const lines: string[] = [];
  for (const s of cross) {
    const n = posix.basename(s).normalize('NFC');
    if (here.has(n) && ((await remoteKind(rt, joinRemote(d, n))) !== 'folder' || (await fileNamedIn(rt, d, n)))) {
      // (MEGA copies across trees, then deletes the source: with identical content it copies nothing.)
      lines.push(`${joinRemote(d, n)} already exists: the moved item becomes its new version (the current one is kept as an older version only while file versioning is on); if the two have the same content, nothing is copied and ${s} is deleted for good together with all its older versions.`);
    }
  }
  return lines;
}

/** Is there a FILE named `n` directly in cloud folder `d`? (Unknown counts as yes.) */
async function fileNamedIn(rt: Runtime, d: string, n: string): Promise<boolean> {
  const r = await rt.run('find', [d, `--pattern=${n}`, '--type=f']);
  if (r.code !== 0) return r.code !== ExitCode.NOTFOUND;
  return r.stdout.split(/\r?\n/).some((l) => {
    // As printed (not trimmed: a name may end in a space). Someone else's share is "<email>:<share>/...".
    const shown = l.trim() === '' ? '' : l;
    const p = shown.startsWith('/') || shown === '' ? shown : `//from/${shown}`;
    return p !== '' && posix.dirname(p) === d.replace(/(.)\/+$/, '$1') && posix.basename(p).normalize('NFC') === n;
  });
}

/** Refuse anything but a JPEG, PNG, GIF or WebP image (by its first bytes). */
function assertImageFile(path: string): void {
  const head = Buffer.alloc(12);
  let n = 0;
  // Only a regular file is opened: a FIFO or device would block the server until written to.
  try {
    if (!statSync(path).isFile()) throw new ValidationError(`${path} is not a regular file, so it is not used as a thumbnail.`);
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError(`${path} cannot be read, so it is not used as a thumbnail.`);
  }
  try {
    const fd = openSync(path, 'r');
    try {
      n = readSync(fd, head, 0, 12, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Unreadable here (MEGAcmd may still read it): not used, as it cannot be checked.
    throw new ValidationError(`${path} cannot be read, so it is not used as a thumbnail.`);
  }
  const b = head.subarray(0, n);
  const isImage =
    (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    b.subarray(0, 4).toString('latin1') === 'GIF8' ||
    (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP');
  if (!isImage) throw new ValidationError(`${path} is not a JPEG, PNG, GIF or WebP image, so it is not used as a thumbnail.`);
}

/** A list naming one item twice would only repeat its lines (and push the rest of the preview down). */
function assertNoRepeats(list: readonly string[]): void {
  const seen = new Set<string>();
  for (const p of list) {
    if (seen.has(p)) throw new ValidationError(`${p} is listed more than once in srcs; list each item once.`);
    seen.add(p);
  }
}

/** One put; a command line the gate refuses (still too long) counts as a failed chunk. */
async function putChunk(rt: Runtime, args: string[]): Promise<number | null> {
  try {
    return (await rt.run('put', args)).code;
  } catch (e) {
    if (e instanceof ValidationError) return null;
    throw e;
  }
}

/** One plain put of many items, split so each command line fits (see chunkArgs). */
async function putChunked(rt: Runtime, putOpts: string[], lps: string[], dest: string, background: boolean) {
  const chunks = chunkArgs(lps, 2000, [...putOpts, dest]);
  if (chunks.length === 1) {
    return runToResult(rt, 'put', [...putOpts, ...lps, dest], () => ok(`Uploaded ${lps.length} item(s) -> ${dest}.`, { localPaths: lps, remotePath: dest, background }));
  }
  let failed = 0;
  for (const chunk of chunks) if ((await putChunk(rt, [...putOpts, ...chunk, dest])) !== 0) failed += chunk.length;
  return (failed ? err : ok)(`Uploaded ${lps.length - failed}/${lps.length} item(s) -> ${dest}${failed ? `; ${failed} in batches that reported an error (some of those may have been uploaded)` : ''}.`, { localPaths: lps, remotePath: dest, background, failed });
}

export function registerMutate(server: McpServer, rt: Runtime): void {
  // mega_mkdir — create a folder (idempotent with -p). Auto-allow.
  server.registerTool(
    'mega_mkdir',
    {
      title: 'MEGA: make folder',
      description:
        'Create a MEGA cloud folder (parents created as needed). Asks for confirmation only when the new folder\'s place is shared, publicly linked or invited to, someone else\'s shared folder, in a two-way synced folder (the preview names where it is written on this computer), or cannot be checked; otherwise it runs at once.',
      inputSchema: {
        remotePath: z.string().describe('Absolute MEGA path to create.'),
        confirm: z.string().optional().describe('Confirmation token, when the first call asked for one.'),
      },
      annotations: { title: 'MEGA: make folder', destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ remotePath, confirm }) =>
      guardRun(async () => {
        // mkdir walks the path by literal names (no wildcards), so a "*" in a new
        // folder's name is just a character: only a real .megaCmd name is refused.
        // A folder named H:<handle> is where a vanished pinned handle would resolve to.
        const rp = assertNoHandleName(assertRemotePath(remotePath));
        // mkdir knows only the //bin root: "//in/x" or "//from/..." would land in the Cloud Drive.
        if (/^\/\/(?:in|from)(?:\/|$)/.test(rp) || rp === '//bin') {
          throw new ValidationError('mega_mkdir cannot create folders under //in or //from (MEGAcmd would create them in the Cloud Drive instead).');
        }
        if (storeCopyIn(rp) === 'name') assertNotStoreCopy(rp);
        // A folder name is content too: inside a share or linked folder it needs approval.
        await assertSyncedLanding(rt, rp, 'self');
        // Each folder -p makes is a name a periodic backup's rotation may count as one of its copies.
        const made: string[] = [];
        for (let p = rp; p !== '/' && p !== '//bin' && p !== posix.dirname(p); p = posix.dirname(p)) made.push(p);
        const notes = [...(await destinationNotes(rt, rp)), ...(await backupRotationLinesAt(rt, made))];
        if (notes.length > 0) {
          // The notes are bound: a link added after the preview voids the token.
          const gate = checkConfirm(rt, 'mega_mkdir', { remotePath: rp, notes }, confirm, [`This will create the folder ${rp}.`, ...notes]);
          if (gate) return gate;
        } else {
          noteUnconfirmedWrite([{ path: rp, source: null }]);
        }
        return runToResult(rt, 'mkdir', ['-p', rp], () => ok(`Created folder ${rp}.`, { remotePath: rp }));
      }),
  );

  // mega_cp — copy within the cloud. Asks first only when the copy reaches other people or
  // replaces or versions a file; a copy between private folders runs at once, like mkdir.
  server.registerTool(
    'mega_cp',
    {
      title: 'MEGA: copy',
      description:
        'Copy MEGA cloud node(s) to another cloud path. Bulk-capable: pass "srcs" (a list) or "src"+usePcre (a pattern) to copy many nodes in one call - do NOT loop this tool per file; several items need an existing destination folder. Asks for confirmation only when the destination is shared, publicly linked or invited to, someone else\'s shared folder, in a two-way synced folder (the preview names where it is written on this computer), or cannot be checked, or when the copy would replace a file or become the new version of a same-named file; the preview says which. Otherwise the copy runs at once.',
      inputSchema: {
        src: z
          .string()
          .optional()
          .describe('A single source path; OR a PCRE pattern (with usePcre). Native "*"/"?" wildcards are not accepted - use usePcre.'),
        srcs: z.array(z.string()).optional().describe('An explicit list of source paths to copy together.'),
        dst: z.string().describe('Destination: an existing folder to copy into, or (single src) the new name.'),
        usePcre: z.boolean().default(false).describe('Interpret "src" as a PCRE pattern and copy EVERY match. It starts with "/" and each part of the path is matched on its own, e.g. /Docs/.*\\.pdf$.'),
        confirm: z.string().optional().describe('Confirmation token, when the first call asked for one.'),
      },
      // Destructive: a copy onto an existing file REPLACES it (MEGAcmd copies, then
      // removes the old target) - that case always asks first.
      annotations: { title: 'MEGA: copy', destructiveHint: true, openWorldHint: true },
    },
    async ({ src, srcs, dst, usePcre, confirm }) =>
      guardRun(async () => {
        let d = assertRemoteDest(dst, 'dst');
        // Sources first, so a refusal runs nothing.
        let list: string[] | null = null;
        let single: string | null = null;
        let pattern: string | null = null;
        let matches: { handles: string[]; topPaths: string[]; paths: string[] } | null = null;
        const check = (p: string) => assertNotStoreCopy(p, 'A matched node');
        if (srcs && srcs.length > 0) {
          list = srcs.map((s, i) => assertNotStoreCopy(assertNoVersionName(assertNoWildcard(assertRemotePath(s, `srcs[${i}]`), `srcs[${i}]`), `srcs[${i}]`), `srcs[${i}]`));
          assertNoRepeats(list);
          await assertNoStoreCopyBelowMany(rt, list);
        } else if (usePcre) {
          if (!src) throw new ValidationError('usePcre requires "src" (the PCRE pattern).');
          pattern = assertNoFlag(src, 'src');
          const prev = await pcreMatchPreview(rt, pattern);
          if (!prev.ok) return err(prev.error);
          for (const p of prev.paths) check(p);
          matches = { handles: prev.handles, topPaths: prev.topPaths, paths: prev.paths };
        } else {
          if (!src) throw new ValidationError('Provide "src" (a path or pattern) or "srcs" (a list).');
          single = assertNotStoreCopy(assertNoWildcard(assertRemotePath(src, 'src'), 'src'), 'src');
          await assertNoStoreCopyBelow(rt, single);
          d = await versionTarget(rt, single, d);
        }
        const sources = list ?? (matches ? matches.topPaths : [single as string]);
        await assertOneDestination(rt, d);
        // A copy keeps its name; the root of someone else's share ("<email>:<name>") lands as <name>.
        const landName = (p: string) => {
          const b = posix.basename(p);
          return posix.dirname(p) === '//from' && b.includes(':') ? b.slice(b.indexOf(':') + 1) : b;
        };
        // MEGA matches names NFC-normalized; a pattern match is listed as stored.
        const names = sources.map((p) => landName(p).normalize('NFC'));

        // Several items need a folder (else MEGAcmd replaces or renames); one item onto a file
        // replaces it; a name already in the folder becomes that file's new version.
        const kind = await remoteKind(rt, d);
        if (sources.length > 1 && kind !== 'folder') {
          throw new ValidationError(`Copying several items needs an existing destination folder; ${d} is ${kind === 'file' ? 'a file' : kind === 'missing' ? 'missing' : 'not known to be a folder'}.`);
        }
        const replaces = kind === 'file';
        const listed = kind === 'folder' ? await childNames(rt, d) : new Set<string>();
        const existing = listed && new Set([...listed].map((n) => n.normalize('NFC')));
        const collisions: string[] = [];
        // A same-named FILE (even beside a same-named folder) takes the copy as a new version;
        // a same-named folder alone just gets a sibling.
        if (existing) for (const n of names) if (existing.has(n) && ((await remoteKind(rt, joinRemote(d, n))) !== 'folder' || (await fileNamedIn(rt, d, n)))) collisions.push(n);
        // Where a sync writes these on this computer gets the download checks.
        await assertSyncedLanding(rt, d, kind === 'folder' ? names : 'self', matches ? { listed: matches.paths } : { cloud: sources });
        // A FOLDER copied to a new name in another folder lands under its own name first, then is renamed.
        const only = sources.length === 1 ? (sources[0] as string) : null;
        const interim = kind !== 'folder' && only !== null && posix.dirname(only) !== posix.dirname(d) && (await remoteKind(rt, matches ? (matches.handles[0] ?? only) : only)) !== 'file';
        if (interim) await assertSyncedLanding(rt, posix.dirname(d), names);
        const notes = [
          ...(await destinationNotes(rt, d)),
          // A name a periodic backup's rotation counts as one of its copies (and may delete).
          ...(kind === 'folder' ? await backupRotationLines(rt, d, names) : await backupRotationLinesAt(rt, [d])),
          // Copying the recovery key file (or a copy of it) asks first, wherever it goes.
          ...(matches ? recoveryKeyLines(matches.paths) : await recoveryKeyLinesBelow(rt, sources)),
          ...(kind === 'unknown' ? [`(Could not check what is at ${d}: a file there would be REPLACED, with all its versions deleted for good.)`] : !existing ? [`(Could not check what is in ${d}.)`] : []),
          ...(replaces ? [`${d} is an existing FILE: it will be REPLACED, and it and all its older versions are deleted for good (not kept as a version, not in the Rubbish Bin).`] : []),
          ...collisions.map((n) => `${joinRemote(d, n)} already exists: the copy becomes its new version (the current one is kept as an older version only while file versioning is on).`),
        ];
        const risky = notes.length > 0;
        const destOf = (p: string) => (kind === 'folder' ? joinRemote(d, landName(p)) : d);

        let handles: string[] | null = null;
        if (risky) {
          if (pattern !== null) {
            const g = await pcreGate(
              rt,
              'mega_cp',
              { src: pattern, usePcre: true, dst: d, notes },
              confirm,
              pattern,
              (n, t) => [`This will copy ${n} node(s) matching the pattern to ${d}:`, t, ...notes].join('\n'),
              check,
              // By handle under the checked names; unconfirmed writes in matched folders are named.
              { recheckNames: true, extraLines: (tops) => unconfirmedWriteLines(tops), bindContents: true },
            );
            if (!g.proceed) return g.result;
            handles = g.handles;
          } else {
            const same = list ? await sameNamedMany(rt, list) : [await sameNamed(rt, single as string)];
            const placed = unconfirmedWriteLines(sources);
            const summary = list
              ? [`This will copy ${list.length} item(s) to ${d}:`, ...notes, ...listedLines(list), ...same.flatMap((x) => x.lines), ...placed]
              : [`This will copy ${single} to ${d}.`, ...same.flatMap((x) => x.lines), ...notes, ...placed];
            // Bind what the sources hold: anything moved in after the preview would go along unseen.
            const contents = await contentDigestMany(rt, sources);
            const gate = checkConfirm(rt, 'mega_cp', { srcs: list, src: single, dst: d, items: same.map((x) => x.count), notes, placed, contents }, confirm, summary);
            if (gate) return gate;
          }
        } else {
          handles = matches ? matches.handles : null;
          noteUnconfirmedWrite(sources.map((p) => ({ path: destOf(p), source: p })));
        }
        // What was placed unconfirmed inside a copied folder is in the copy too; a renamed recovery key is still one.
        for (const p of sources) {
          carryUnconfirmedWrites(p, destOf(p), false);
          noteKeyCopy(p, destOf(p));
        }
        // (Copied under its own name first: if the rename fails, the copy stays there.)
        if (interim && only !== null) carryUnconfirmedWrites(only, joinRemote(posix.dirname(d), names[0] as string), false);

        const failNote = (failed: number) => (failed ? `; ${failed} in batches that reported an error (some of those may have been copied)` : '');
        if (pattern !== null) {
          const hs = handles ?? [];
          if (hs.length === 0) return ok('No matching nodes to copy.', { dst: d, copied: 0 });
          const { done, failed } = await runBulk(rt, 'cp', hs, [d]);
          return ok(`Copied ${done}/${hs.length} node(s) to ${d}${failNote(failed)}.`, { dst: d, copied: done, failed });
        }
        if (list) {
          const { done, failed } = await runBulk(rt, 'cp', list, [d]);
          return ok(`Copied ${done}/${list.length} item(s) to ${d}${failNote(failed)}.`, { dst: d, copied: done, failed });
        }
        return runToResult(rt, 'cp', [single as string, d], () => ok(`Copied ${single} -> ${d}.`, { src: single, dst: d }));
      }),
  );

  // mega_mv — move/rename, bulk-capable (relocates/overwrites). Confirm-gated.
  // Three modes, all confirmed ONCE and executed in as few calls as possible:
  //   • srcs[]      — an explicit list, moved together in one multi-source `mv`.
  //   • src+usePcre — a PCRE pattern: matches are enumerated + pinned by HANDLE
  //                   at preview (TOCTOU-safe), then moved in one multi-source
  //                   `mv` on those handles.
  //   • src         — a single path, the classic single move/rename. A native
  //                   `*`/`?` wildcard is refused here: MEGAcmd expands it
  //                   server-side AFTER approval, so the preview would name one
  //                   node while N were moved. Use srcs[] or usePcre instead.
  server.registerTool(
    'mega_mv',
    {
      title: 'MEGA: move/rename',
      description:
        'Move or rename MEGA cloud node(s). Bulk-capable: pass "srcs" (an explicit list) or "src"+usePcre (a pattern) to move many nodes in ONE confirmed operation — do NOT loop this tool per file. Requires confirmation.',
      inputSchema: {
        src: z
          .string()
          .optional()
          .describe('A single source path; OR a PCRE pattern (with usePcre). Native "*"/"?" wildcards are not accepted - use usePcre, which lists the matches before you confirm.'),
        srcs: z
          .array(z.string())
          .optional()
          .describe('An explicit list of source paths to move together in one confirmed operation. Use for arbitrary selections that are not a single pattern.'),
        dst: z.string().describe('Destination: an existing folder to move into, or (single src) the new name.'),
        usePcre: z.boolean().default(false).describe('Interpret "src" as a PCRE pattern and move EVERY match. It starts with "/" and each part of the path is matched on its own, e.g. /Docs/.*\\.pdf$.'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: move/rename', destructiveHint: true, openWorldHint: true },
    },
    async ({ src, dst, srcs, usePcre, confirm }) =>
      guardRun(async () => {
        let d = assertRemoteDest(dst, 'dst');

        // Mode 1: explicit list -> one multi-source `mv src1 src2 … dst`.
        if (srcs && srcs.length > 0) {
          const list = srcs.map((s, i) => assertNotStoreCopy(assertNoVersionName(assertNoWildcard(assertRemotePath(s, `srcs[${i}]`), `srcs[${i}]`), `srcs[${i}]`), `srcs[${i}]`));
          assertNoRepeats(list);
          // Refusals first; the destination notes only matter for a request that can run.
          if (!confirm) await assertNoStoreCopyBelowMany(rt, list);
          await assertOneDestination(rt, d);
          // Several sources need an existing folder, or MEGAcmd would replace or rename it.
          const dKind = await remoteKind(rt, d);
          if (list.length > 1 && dKind !== 'folder') throw new ValidationError(`Moving several items needs an existing destination folder; ${d} is ${dKind === 'file' ? 'a file' : dKind === 'missing' ? 'missing' : 'not known to be a folder'}.`);
          await assertSyncedLanding(rt, d, dKind === 'folder' ? list.map((p) => posix.basename(p)) : 'self', { cloud: list });
          // To a new name (or onto a file) MEGAcmd moves under the source's own name first, then renames.
          if (dKind !== 'folder' && list.some((p) => posix.dirname(p) !== posix.dirname(d))) await assertSyncedLanding(rt, posix.dirname(d), list.map((p) => posix.basename(p)));
          // One source onto an existing FILE replaces it (MEGAcmd wants a folder only for several).
          const notes = await destinationNotes(rt, d, { overwrite: list.length === 1 ? 'delete' : undefined });
          const same = await sameNamedMany(rt, list);
          // Out of a synced folder, the move happens locally too; unconfirmed writes go along.
          const local = [
            ...(await syncedSourceNotes(rt, list, 'moved')),
            ...(await syncFollowLines(rt, list, d)),
            ...(await crossTreeCollisions(rt, list, d, dKind)),
            ...(await movedIntoSyncedLines(rt, list, d, dKind === 'folder')),
            ...(await recoveryKeyLinesBelow(rt, list)),
            ...(dKind === 'folder' ? await backupRotationLines(rt, d, list.map((p) => posix.basename(p))) : await backupRotationLines(rt, posix.dirname(d), [posix.basename(d)])),
            ...(dKind === 'unknown' ? [`(Could not check what is at ${d}: a file there would be REPLACED, with all its versions deleted for good.)`] : []),
          ];
          const placed = unconfirmedWriteLines(list);
          const summary = [`This will move ${list.length} item(s) to ${d}:`, ...notes, ...listedLines(list), ...same.flatMap((x) => x.lines), ...local, ...placed];
          const replaces = list.length === 1 && (await remoteKind(rt, d)) === 'file';
          const contents = await contentDigestMany(rt, list);
          const gate = checkConfirm(rt, 'mega_mv', { srcs: list, dst: d, items: same.map((x) => x.count), replaces, local, placed, notes, contents }, confirm, summary);
          if (gate) return gate;
          await assertNoStoreCopyBelowMany(rt, list);
          const { done, failed } = await runBulk(rt, 'mv', list, [d]);
          // A failed batch may have moved some items: keep the records at both places.
          for (const p of list) {
            const to = dKind === 'folder' ? joinRemote(d, posix.basename(p)) : d;
            carryUnconfirmedWrites(p, to, failed === 0);
            noteKeyCopy(p, to);
            if (failed && dKind !== 'folder' && posix.dirname(p) !== posix.dirname(d)) carryUnconfirmedWrites(p, joinRemote(posix.dirname(d), posix.basename(p)), false);
          }
          return ok(`Moved ${done}/${list.length} item(s) to ${d}${failed ? `; ${failed} failed` : ''}.`, { dst: d, moved: done, failed });
        }

        // Mode 2: PCRE pattern -> enumerate + pin handles (TOCTOU-safe preview),
        // then move the pinned set in one multi-source `mv`.
        if (usePcre) {
          if (!src) throw new ValidationError('usePcre requires "src" (the PCRE pattern).');
          const pattern = assertNoFlag(src, 'src');
          await assertOneDestination(rt, d);
          const pcreNotes = await destinationNotes(rt, d);
          // A single match onto an existing FILE replaces it; several need a folder.
          const dKind = await remoteKind(rt, d);
          const dstIsFile = !confirm && dKind === 'file';
          // Every node the pattern lists (matches and what they hold), by the names MEGAcmd printed.
          const listedAll: string[] = [];
          const g = await pcreGate(
            rt,
            'mega_mv',
            { src: pattern, usePcre: true, dst: d, notes: pcreNotes, dKind },
            confirm,
            pattern,
            (n, t) => {
              if (n > 1 && dKind !== 'folder') throw new ValidationError(`Moving several items needs an existing destination folder; ${d} is ${dKind === 'file' ? 'a file' : dKind === 'missing' ? 'missing' : 'not known to be a folder'}.`);
              return [`This will move ${n} node(s) matching the pattern to ${d}:`, t, ...pcreNotes, ...(n === 1 && dstIsFile ? [`${d} is an existing FILE: it will be REPLACED, and it and all its older versions are deleted for good (not kept as a version, not in the Rubbish Bin).`] : [])].join('\n');
            },
            (p, topmost) => {
              assertNotStoreCopy(p, 'A matched node');
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
                ...(await syncedSourceNotes(rt, tops, 'moved')),
                ...(await syncFollowLines(rt, tops, d)),
                ...(await crossTreeCollisions(rt, tops, d, dKind)),
                ...(await movedIntoSyncedLines(rt, tops, d, dKind === 'folder')),
                ...recoveryKeyLines(listedAll),
                ...(dKind === 'folder' ? await backupRotationLines(rt, d, tops.map((p) => posix.basename(p))) : await backupRotationLines(rt, posix.dirname(d), [posix.basename(d)])),
                ...(dKind === 'unknown' ? [`(Could not check what is at ${d}: a file there would be REPLACED, with all its versions deleted for good.)`] : []),
                ...unconfirmedWriteLines(tops),
              ],
            },
          );
          if (!g.proceed) return g.result;
          if (g.handles.length > 1 && dKind !== 'folder') throw new ValidationError(`Moving several items needs an existing destination folder; ${d} is not one.`);
          await assertSyncedLanding(rt, d, dKind === 'folder' ? g.paths.map((p) => posix.basename(p)) : 'self', { listed: listedAll });
          if (dKind !== 'folder' && g.paths.some((p) => posix.dirname(p) !== posix.dirname(d))) await assertSyncedLanding(rt, posix.dirname(d), g.paths.map((p) => posix.basename(p)));
          if (g.handles.length === 0) return ok('No matching nodes to move.', { dst: d, moved: 0 });
          const { done, failed } = await runBulk(rt, 'mv', g.handles, [d]);
          for (const p of g.paths) {
            const to = dKind === 'folder' ? joinRemote(d, posix.basename(p)) : d;
            carryUnconfirmedWrites(p, to, failed === 0);
            noteKeyCopy(p, to);
            if (failed && dKind !== 'folder' && posix.dirname(p) !== posix.dirname(d)) carryUnconfirmedWrites(p, joinRemote(posix.dirname(d), posix.basename(p)), false);
          }
          return ok(`Moved ${done}/${g.handles.length} node(s) to ${d}${failed ? `; ${failed} failed` : ''}.`, { dst: d, moved: done, failed });
        }

        // Mode 3: a single path. A native wildcard is NOT accepted here: MEGAcmd
        // would expand it server-side after approval, so the preview would name
        // one node while N were moved. Modes 1 and 2 are the supported bulk paths
        // and both enumerate before confirming.
        if (!src) throw new ValidationError('Provide "src" (a path or pattern) or "srcs" (a list).');
        const s = assertNotStoreCopy(assertNoWildcard(assertRemotePath(src, 'src'), 'src'), 'src');
        // MEGAcmd 2.6.0 fails to move an older version out of its history; copying one works.
        if (s.split('/').some((seg) => /#\d{10}$/.test(seg))) {
          throw new ValidationError('An older file version cannot be moved; copy it with mega_cp instead (it lands under the file\'s name).');
        }
        if (!confirm) await assertNoStoreCopyBelow(rt, s);
        await assertOneDestination(rt, d);
        const notes = await destinationNotes(rt, d, { overwrite: 'delete' });
        const same = await sameNamed(rt, s);
        const dKindSingle = await remoteKind(rt, d);
        const replaces = dKindSingle === 'file';
        await assertSyncedLanding(rt, d, dKindSingle === 'folder' ? [posix.basename(s)] : 'self', { cloud: [s] });
        // To a new name (or onto a file) MEGAcmd moves under the source's own name first, then renames.
        if (dKindSingle !== 'folder' && posix.dirname(s) !== posix.dirname(d)) await assertSyncedLanding(rt, posix.dirname(d), [posix.basename(s)]);
        const local = [
          ...(await syncedSourceNotes(rt, [s], 'moved')),
          ...(await syncFollowLines(rt, [s], d)),
          ...(await crossTreeCollisions(rt, [s], d, dKindSingle)),
          ...(await movedIntoSyncedLines(rt, [s], d, dKindSingle === 'folder')),
          ...(await recoveryKeyLinesBelow(rt, [s])),
          ...(dKindSingle === 'folder' ? await backupRotationLines(rt, d, [posix.basename(s)]) : await backupRotationLines(rt, posix.dirname(d), [posix.basename(d)])),
          ...(dKindSingle === 'unknown' ? [`(Could not check what is at ${d}: a file there would be REPLACED, with all its versions deleted for good.)`] : []),
        ];
        const placed = unconfirmedWriteLines(s);
        const contents = await contentDigest(rt, s);
        const gate = checkConfirm(rt, 'mega_mv', { src: s, dst: d, items: same.count, replaces, local, placed, notes, into: dKindSingle === 'folder', contents }, confirm, [`This will move/rename ${s} to ${d}.`, ...same.lines, ...notes, ...local, ...placed]);
        if (gate) return gate;
        await assertNoStoreCopyBelow(rt, s);
        const moved = await rt.run('mv', [s, d]);
        // A move whose rename failed may still have moved the node (under its own name, when
        // the new name is in another folder): keep the records at every place it may be.
        carryUnconfirmedWrites(s, dKindSingle === 'folder' ? joinRemote(d, posix.basename(s)) : d, moved.code === 0);
        noteKeyCopy(s, dKindSingle === 'folder' ? joinRemote(d, posix.basename(s)) : d);
        if (moved.code !== 0 && dKindSingle !== 'folder' && posix.dirname(s) !== posix.dirname(d)) carryUnconfirmedWrites(s, joinRemote(posix.dirname(d), posix.basename(s)), false);
        if (moved.code !== 0) return err(classifyExit(moved), { ok: false, code: moved.code });
        return ok(`Moved ${s} -> ${d}.`, { src: s, dst: d });
      }),
  );

  // mega_put — upload local -> cloud (mutates the account). Confirm-gated.
  server.registerTool(
    'mega_put',
    {
      title: 'MEGA: upload',
      description:
        'Upload one or more local files/folders into a MEGA cloud folder. Each item keeps its own name inside remotePath unless `name` is given. Requires confirmation; the preview lists the cloud path each item will get.',
      inputSchema: {
        localPath: z.string().optional().describe('A single local file/folder to upload.'),
        localPaths: z.array(z.string()).optional().describe('Multiple local files/folders to upload.'),
        remotePath: z.string().describe('Destination FOLDER (absolute MEGA path), created if missing. Items go inside it: uploading ~/Photos to "/Backup" gives /Backup/Photos.'),
        name: z
          .string()
          .optional()
          .describe('Upload a single item under this name inside remotePath (remotePath "/Docs" + name "report-2026.pdf" gives /Docs/report-2026.pdf). An existing file with that name is replaced (as a new version); an existing folder is refused.'),
        background: z.boolean().default(false).describe('Queue the upload in the background (do not wait for it to finish).'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: upload', destructiveHint: true, openWorldHint: true },
    },
    async ({ localPath, localPaths, remotePath, name, background, confirm }) =>
      guardRun(async () => {
        const raw = [...(localPaths ?? []), ...(localPath ? [localPath] : [])];
        if (raw.length === 0) throw new ValidationError('Provide localPath or localPaths.');
        const lps = raw.map((p) => assertNoLocalGlob(assertLocalPath(p)));
        // Resolved literally by MEGAcmd, listed as a pattern by the checks: no wildcards.
        const rp = assertNotStoreCopy(assertNoWildcard(assertRemoteDest(remotePath), 'remotePath'));
        const as = name === undefined ? undefined : uploadName(name, lps, rp);
        // Under //from or //in rp cannot be created first, and MEGAcmd reads a missing last part as a
        // NEW NAME (the upload would become rp itself): only an existing folder is uploaded into.
        if (rp.startsWith('//') && (await remoteKind(rt, rp)) !== 'folder') {
          throw new ValidationError(`${rp} is not an existing folder; under //from, //in or //bin, upload into an existing folder only.`);
        }
        // The SDK names an upload by its local name with `%xx` escapes decoded.
        const cloudName = (lp: string) => {
          const n = cloudNameOf(basename(lp));
          if (n === '.' || n === '..' || n.includes('/')) throw new ValidationError(`${lp} would be uploaded under the name "${n}"; rename it first.`);
          return n;
        };
        const cloudPath = (lp: string) => `${rp.replace(/\/+$/, '')}/${as ?? cloudName(lp)}`;
        // A filesystem root ("/", "C:\\") has no name: what it holds lands in rp directly, each by its own name.
        const landNames = (lp: string): string[] => {
          const n = as ?? cloudName(lp);
          if (n !== '') return [n];
          try {
            return readdirSync(lp).map((e) => cloudNameOf(e));
          } catch {
            throw new ValidationError(`Could not list ${lp} to check where its contents land.`);
          }
        };
        // With a new name, what is already at that path decides what happens:
        // nothing - uploaded under it; a file - replaced by a single file; a folder
        // - refused, since MEGAcmd would put the item INSIDE it instead.
        let replaces = false;
        if (as !== undefined) {
          const target = cloudPath(lps[0]!);
          const kind = await remoteKind(rt, target);
          let isDir = false;
          try {
            isDir = statSync(lps[0]!).isDirectory();
          } catch {
            // Missing locally: MEGAcmd reports that itself.
          }
          if (kind === 'unknown') return err(`Could not check what is at ${target}.`, { remotePath: target });
          if (kind === 'folder' || (kind === 'file' && isDir)) {
            return err(`${target} already exists as a ${kind}; choose another name.`, { remotePath: target });
          }
          replaces = kind === 'file';
        }
        // A folder holding the session store is uploaded WITHOUT it (see planUpload).
        // Planned again on the confirmed call, so the store is left out of what is
        // actually uploaded, not only of what the preview showed.
        const plan = planUpload(lps, rp, await rt.getBinDir(), as);
        // The preview MUST name what leaves the machine: it is the only human
        // checkpoint here, and "upload 1 item(s)" gives nothing to refuse on.
        // Built as LINES so checkConfirm escapes each path on its own — a newline
        // inside one must not be able to forge an extra line here.
        await assertSyncedLanding(rt, rp, lps.map((p) => as ?? cloudName(p)), { local: lps });
        // A file put onto a synced .megaignore would rewrite the sync's rules.
        if (isIgnoreFileName(posix.basename(rp))) await assertSyncedLanding(rt, posix.dirname(rp), [posix.basename(rp)]);
        const notes = await destinationNotes(rt, as === undefined ? rp : cloudPath(lps[0]!), { overwrite: 'version' });
        // Without `name`, a name already in rp gets no new node: a folder merges INTO it (shared
        // or linked as it is), a file becomes its new version. Bound into the token.
        const landing: string[] = [];
        if (as === undefined) {
          // Where each local folder lands, whether or not that folder exists yet: by path, so a
          // listing that cannot be read never skips the checks. A folder upload merges at every
          // depth, so a sync's cloud side AT or BELOW it would write the upload to this computer.
          const near = await syncRootsBelowCloud(rt, rp);
          if (near === null) throw new ValidationError(`Could not read MEGAcmd's list of syncs, so whether uploading into ${rp} reaches a synced folder is unknown.`);
          // (Only folders a sync's cloud side lies in or below need the per-folder checks.)
          for (const lp of lps.filter((p) => isLocalDir(p) && near.length > 0)) {
            const t = joinRemote(rp, cloudName(lp));
            const roots = await syncRootsBelowCloud(rt, t);
            if (roots === null) throw new ValidationError(`Could not read MEGAcmd's list of syncs, so whether uploading into ${t} reaches a synced folder is unknown.`);
            if (roots.length > 0) throw new ValidationError(`${t} holds the cloud side of a two-way sync (${roots[0]}): the upload would be merged into it and written to this computer. Upload into that synced folder directly, or elsewhere.`);
            let inside: string[];
            try {
              inside = readdirSync(lp).map((e) => cloudNameOf(e));
            } catch {
              throw new ValidationError(`Could not list ${lp} to check where its contents land.`);
            }
            // t IS a sync's cloud side (or inside one): what lp holds lands in that local folder.
            await assertSyncedLanding(rt, t, inside, { local: [lp] });
          }
          // A name already in rp gets no new node: a folder merges INTO it, a file becomes its new version.
          const here = await childNames(rt, rp);
          if (!here && (await remoteKind(rt, rp)) !== 'missing') landing.push(`(Could not check what is already in ${rp}.)`);
          for (const n of lps.flatMap(landNames)) {
            if (!here?.has(n)) continue;
            const t = joinRemote(rp, n);
            // MEGAcmd reads "\\", "*" and "?" in a path as escapes and wildcards: such a name is not looked up.
            const kind = /[\\*?]/.test(n) ? 'unknown' : await remoteKind(rt, t);
            const isFolder = kind !== 'file';
            landing.push(kind === 'folder' ? `${t} already exists: the upload is merged INTO that folder.` : kind === 'file' ? `${t} already exists: the upload becomes its new version (the current one is kept as an older version only while file versioning is on).` : `${t} already exists (could not check whether it is a file or a folder).`);
            // Merged at every depth: shared or linked folders inside it are reached too, and backups' copy folders.
            const deep = isFolder ? [...(await sharedBelowNotes(rt, t)), ...(await backupFoldersWithinLines(rt, t, 'The upload is merged into'))] : [];
            for (const x of [...(await destinationNotes(rt, t)), ...deep]) if (!landing.includes(x)) landing.push(x);
          }
        }
        // Changed by a download since (or before) this preview: named, and the token binds it.
        const downloaded = downloadedIntoLines(lps);
        // MEGA's web client saves the recovery key file under this name (often in Downloads).
        const keyNamed = lps.filter((lp) => isRecoveryKeyName(basename(lp)));
        // What lands in rp (and rp, with the folders -c makes) under a name a periodic backup counts as its copy.
        const made: string[] = [];
        for (let p = rp.replace(/(.)\/+$/, '$1'); !/^(?:\/|\/\/(?:bin|in|from))$/.test(p) && p !== posix.dirname(p); p = posix.dirname(p)) made.push(p);
        // (Folders rebuilt around the store land their items by name too.)
        const rebuilt = plan.steps.filter((st) => st.dest !== rp).flatMap((st) => st.sources.map((src) => joinRemote(st.dest, cloudNameOf(basename(src)))));
        const rotation = await backupRotationLinesAt(rt, [...lps.flatMap(landNames).map((n) => joinRemote(rp, n)), ...made, ...rebuilt]);
        const keyLines = keyNamed.length > 0 ? ["Named like MEGA's recovery key file, which holds the account's master key:", ...listedLines(keyNamed)] : [];
        const summary = [
          ...notes,
          ...landing.filter((x) => !notes.includes(x)),
          ...downloaded,
          ...keyLines,
          ...rotation,
          `This will upload ${lps.length} item(s) into the folder ${rp} (created if missing)${background ? ', in the background' : ''}:`,
          ...listedLines(lps, (p) => `  ${p}  ->  ${cloudPath(p)}`),
          ...(plan.excluded.length > 0
            ? [
                '',
                "Left out: the MEGAcmd session store, which holds this account's MASTER KEY:",
                ...plan.excluded.map((p) => `  ${p}`),
              ]
            : []),
          ...(plan.unchecked.length > 0
            ? ['', `(Could not search completely - too many subfolders, or folders that cannot be read - for other copies of a MEGAcmd session store (.megaCmd): ${plan.unchecked.join(', ')}.)`]
            : []),
          ...(plan.links.length > 0
            ? ['', 'Not uploaded: symbolic links inside the folders rebuilt around it (a whole-folder upload skips them too):', ...listedLines(plan.links, (p) => `  ${p}`)]
            : []),
        ];
        // `replaces` is bound too: the confirmed call re-checks the target, and a
        // file that appeared (or went) since the preview no longer matches it.
        const gate = checkConfirm(rt, 'mega_put', { localPaths: lps, remotePath: rp, name: as ?? null, replaces, background, landing, notes, excluded: plan.excluded, unchecked: plan.unchecked, links: plan.links, steps: plan.steps.map((st) => st.dest), downloaded, keyNamed, rotation }, confirm, summary);
        if (gate) return gate;
        // Under another name it is still the key: later shares and links of where it lands say so.
        for (const lp of keyNamed) noteKeyCopy(`/${basename(lp)}`, cloudPath(lp), lp);
        // An upload can outlive this call: named when the folder is later shared or published.
        noteSessionChange(as === undefined ? rp : cloudPath(lps[0]!), `an upload of ${lps.length} item(s) from this computer (it may still be running)`);
        // Still on its way (in the background, or after the client call timed out), a .megaignore could
        // reach a sync started meanwhile: where it lands is recorded, and such a sync waits for it.
        const expectIgnores: string[] = [];
        const uncheckedUploads: string[] = [];
        for (const lp of lps) {
          const t = cloudPath(lp);
          if (!isLocalDir(lp)) {
            if (isIgnoreFileName(posix.basename(t))) expectIgnores.push(t);
            continue;
          }
          const found = ignoreFilesIn([lp]);
          for (const f of found.found) expectIgnores.push(joinRemote(t, relative(lp, f).split(sep).map(cloudNameOf).join('/')));
          if (!found.complete) uncheckedUploads.push(t);
        }
        noteUploadIgnores(expectIgnores, uncheckedUploads);
        const putOpts = ['-c', ...(background ? ['-q'] : [])];
        const untouched = plan.excluded.length === 0 && plan.steps.length === 1 && plan.steps[0]!.dest === rp;
        // rp must exist as a FOLDER before anything is put into it. With -c and a
        // missing destination MEGAcmd creates only its PARENT and uploads under
        // rp's last name instead, so the same request built a different tree
        // depending on whether rp already existed.
        // A special root (//from/<email>:<share>, //in) cannot be created, only used:
        // an untouched plan goes there as one plain put, a rebuilt tree cannot.
        // With a new name, an untouched plan is one put to <rp>/<name>: MEGAcmd
        // uploads under that name when nothing is there, and replaces a file.
        const dest = as === undefined ? rp : cloudPath(lps[0]!);
        if (rp.startsWith('//')) {
          if (!untouched) return err(`Cannot rebuild folders under ${rp}; upload into a regular folder, or upload a subfolder that does not contain the session store.`, { remotePath: rp });
          return putChunked(rt, putOpts, lps, dest, background);
        }
        const target = await ensureRemoteFolder(rt, rp);
        if (target === 'error') return err(`Could not create the destination folder ${rp}.`, { remotePath: rp });
        if (as !== undefined && target === 'file') return err(`${rp} is a file, not a folder.`, { remotePath: rp });
        if (target === 'file') {
          // A file at rp: MEGAcmd replaces it with a single local file (a new
          // version) and refuses anything else. Never with the store left out.
          if (!untouched) return err(`${rp} is a file, not a folder.`, { remotePath: rp });
          return runToResult(rt, 'put', [...putOpts, ...lps, rp], () => ok(`Uploaded ${lps.length} item(s) -> ${rp}.`, { localPaths: lps, remotePath: rp, background }));
        }
        // Only an untouched plan (everything in one put to rp) runs as a plain put;
        // anything else runs step by step, so the store is never a source.
        if (untouched) {
          return putChunked(rt, putOpts, lps, dest, background);
        }
        let failed = 0;
        for (const step of plan.steps) {
          // Each rebuilt folder must exist before its put, for the same reason as
          // rp above - the same shape a whole-folder put would have produced.
          if (step.dest !== rp && (await ensureRemoteFolder(rt, step.dest)) !== 'folder') {
            failed += Math.max(step.sources.length, 1);
            continue;
          }
          // No per-item retry on failure (unlike runBulk): re-running a put could
          // upload again the items of the chunk that did succeed.
          for (const chunk of chunkArgs(step.sources, PUT_CHUNK, [...putOpts, step.dest])) {
            if ((await putChunk(rt, [...putOpts, ...chunk, step.dest])) !== 0) failed += chunk.length;
          }
        }
        return (failed ? err : ok)(
          `Uploaded ${lps.length} item(s) -> ${rp}, leaving out the MEGAcmd session store (${plan.excluded.join(', ')})${failed ? `; ${failed} item(s) failed` : ''}.`,
          { localPaths: lps, remotePath: rp, background, excluded: plan.excluded, failed },
        );
      }),
  );

  // mega_get — download cloud -> local disk (data egress). Confirm-gated. Can
  // download an account path or a public link (optionally password-protected).
  server.registerTool(
    'mega_get',
    {
      title: 'MEGA: download',
      description:
        'Download a MEGA cloud file/folder (by path or by public link) to a local directory. A previous file version (`name#<10 digits>`, as mega_ls showVersions lists it) is saved as <localDir>/<name>. Requires confirmation.',
      inputSchema: {
        remotePath: z.string().optional().describe('Absolute MEGA path to download (a PCRE pattern when usePcre=true).'),
        link: z.string().optional().describe('A MEGA public link to download (instead of remotePath).'),
        localDir: z.string().describe('Local folder to download into (created if missing).'),
        password: z.string().optional().describe('Password for a password-protected link.'),
        background: z.boolean().default(false).describe('Queue the download in the background.'),
        ignoreQuotaWarn: z.boolean().default(false).describe('Proceed despite a transfer-quota warning.'),
        merge: z.boolean().default(false).describe('Download a folder\'s CONTENTS straight into localDir, next to what is already there, instead of into <localDir>/<folder name> (an existing folder of that name is downloaded into).'),
        usePcre: z.boolean().default(false).describe('Interpret remotePath as a PCRE pattern (downloads every match). It starts with "/" and each part of the path is matched on its own, e.g. /Docs/.*\\.pdf$.'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: download', destructiveHint: true, openWorldHint: true },
    },
    async ({ remotePath, link, localDir, password, background, ignoreQuotaWarn, merge, usePcre, confirm }) =>
      guardRun(async () => {
        const ld = assertLocalPath(localDir, 'localDir');
        if (password !== undefined) assertSecret(password, 'password');
        const isLink = link !== undefined && link !== '';
        const transferOpts = [
          ...(background ? ['-q'] : []),
          ...(merge ? ['-m'] : []),
          ...(ignoreQuotaWarn ? ['--ignore-quota-warn'] : []),
        ];

        // A localDir that does not exist yet would not be downloaded INTO: MEGAcmd
        // saves the item itself under that name (measured on 2.6.0: a folder's
        // contents land straight in localDir, a file becomes localDir). It is
        // created first instead, after the same check as any landing place.
        const ldMissing = !existsSync(ld);
        // An existing same-named folder is downloaded INTO (merge or not): one that is or holds a
        // two-way sync's folder would upload what lands there, unseen by this preview.
        // Folders a sync or a scheduled backup uploads from: a download landing in one below ld
        // would be uploaded with none of the synced-download notes.
        // On confirmation, under the write lock: no sync or backup was added, moved or removed since the checks.
        // (Taken FIRST, so nothing added while the lists below are read goes unnoticed. A missing ld holds
        // no synced folder, and MEGAcmd cannot sync a missing folder.)
        const snapshot = ldMissing ? '' : await syncSnapshot(rt);
        const syncRoots = ldMissing ? [] : await syncLocalRoots(rt);
        if (syncRoots === null) throw new ValidationError(`Could not read MEGAcmd's list of syncs, so whether downloading into ${ld} reaches a synced folder is unknown.`);
        const backupRoots = ldMissing ? [] : await backupLocalRoots(rt);
        if (backupRoots === null) throw new ValidationError(`Could not read MEGAcmd's list of backups, so whether downloading into ${ld} reaches a backed-up folder is unknown.`);
        const watched = [...syncRoots, ...backupRoots];
        const roots = watched.filter((r) => localAtOrUnder(r, ld) && !localAtOrUnder(ld, r));
        // (Also who sees where the sync uploads it: a share made while the download waited for the lock.)
        const assertSyncsUnchanged = async (synced: readonly string[]) => {
          // A localDir missing at the checks holds nothing they saw: one that appeared since could be synced.
          if (ldMissing && existsSync(ld)) throw new ValidationError(`${ld} was created since the preview. Nothing was run; preview again.`);
          if (!ldMissing && (await syncSnapshot(rt)) !== snapshot) throw new ValidationError('The syncs or backups on this computer changed since the preview. Nothing was run; preview again.');
          // (Asked even when ld is missing or was not synced: a sync or backup added ABOVE it counts.)
          if (JSON.stringify(await syncedLocalLines(rt, ld)) !== JSON.stringify(synced)) {
            throw new ValidationError(`Who can see where ${ld} is uploaded changed since the preview. Nothing was run; preview again.`);
          }
        };
        const assertNoSyncRootAt = (name: string | null) => {
          const at = name === null ? ld : joinLocal(ld, name);
          // A symlink there, or inside it, is followed too: one leading into (or above) a watched folder
          // counts, unless it stays inside the landing itself.
          const linkAt = name !== null && isSymlink(at) ? [{ link: at, real: onDiskSpelling(at) }] : [];
          const viaLink = () =>
            watched.length > 0 && existsSync(at)
              ? [...linkAt, ...linksBelow(at)].find(({ link, real }) => !(link !== at && localAtOrUnder(real, at)) && watched.some((r) => localAtOrUnder(real, r) || localAtOrUnder(r, real)))
              : undefined;
          const hit = roots.find((r) => name === null || localAtOrUnder(r, at)) ?? viaLink()?.link;
          if (hit) throw new ValidationError(`${at} is, holds or links to ${hit}, which MEGAcmd syncs or backs up: the download could land in it and be uploaded. Download into a folder without one.`);
        };
        // MEGAcmd would write over (or beside) a FILE localDir; the checks look at <localDir>/<name>.
        if (!ldMissing && !statSync(ld).isDirectory()) throw new ValidationError(`localDir ${ld} is a file, not a folder.`);
        // A .megaignore is refused only where a sync would read it (looked up after validation).
        const ignoreFileCheck = (name: string, ldSynced: boolean | undefined) => {
          if (isIgnoreFileName(name) && ldSynced !== false) assertNotIgnoreFile(joinLocal(ld, name));
        };
        const created = ldMissing ? ' (created)' : '';
        const makeLd = () => {
          if (ldMissing && !existsSync(ld)) mkdirSync(ld, { recursive: true });
        };
        // PCRE (remote-path pattern only): download each matched node by HANDLE,
        // resolved at preview time — never re-evaluate the pattern at execution.
        if (usePcre && !isLink) {
          if (remotePath === undefined || remotePath === '') {
            throw new ValidationError('Provide remotePath (a PCRE pattern) when usePcre=true.');
          }
          const rp = assertNoFlag(remotePath, 'remotePath');
          const ldSynced = await inSyncedLocalFolder(rt, ld);
          const execNote = await executableDownloadNote(rt);
          // Downloaded into a synced folder, it is uploaded again, to the cloud side.
          const synced = await syncedLocalLines(rt, ld);
          // Confirming a download into a sync: what was bound is checked and the download
          // runs with no copy or move in between (they wait for the write lock).
          let carriesIgnoreFile = false;
          const matched: string[] = [];
          const gateAndRun = async () => {
            const g = await pcreGate(
              rt,
              'mega_get',
              { remotePath: rp, localDir: ld, usePcre: true, background, ignoreQuotaWarn, merge, exec: execNote, synced },
              confirm,
              rp,
              (n, t) =>
                `This will download ${n} node(s) matching the pattern into ${ld}${created}${merge ? ', each folder\'s contents straight into it (merged with what is there)' : ''}${background ? ', in the background' : ''}${ignoreQuotaWarn ? ', ignoring a transfer-quota warning' : ''}:\n${t}${execNote ? `\n${execNote}` : ''}${synced.map((l) => `\n${previewSafe(l)}`).join('')}`,
              (p, topmost) => {
                // Every match is checked for a store copy; where it lands matters only
                // for the topmost ones - the rest land inside them.
                assertNotStoreCopy(p, 'A matched node');
                matched.push(p);
                if (isIgnoreFileName(posix.basename(p))) carriesIgnoreFile = true;
                // A .megaignore inside a match's contents lands in the synced folder too.
                if (!topmost) {
                  ignoreFileCheck(posix.basename(p), ldSynced);
                  return;
                }
                if (ldMissing) assertDownloadTarget(dirname(ld), basename(ld));
                else if (merge) assertDownloadTarget(ld, null);
                else for (const name of localNamesOf(p)) assertDownloadTarget(ld, name);
                if (merge) assertNoSyncRootAt(null);
                else for (const name of localNamesOf(p)) assertNoSyncRootAt(name);
                for (const name of localNamesOf(p)) ignoreFileCheck(name, ldSynced);
              },
              // Each node lands under its CURRENT name, so names are checked again.
              // What was placed in the matches unconfirmed (a renamed copy, say) is named and bound.
              { recheckNames: true, bindContents: true, extraLines: (tops) => [...unconfirmedWriteLines(tops), ...recoveryKeyLines(matched)] },
            );
            if (!g.proceed) return g.result;
            if (g.handles.length === 0) return ok('No matching nodes to download.', { downloaded: 0, localDir: ld });
            // Merged, a FILE would be saved beside localDir under a renamed name nothing checked.
            // (By the pinned handle: a path holding "*" or "?" would be read as a pattern.)
            if (merge) for (const [i, t] of g.paths.entries()) if ((await remoteKind(rt, g.handles[i] ?? t)) !== 'folder') throw new ValidationError(`${t} is not a folder; merge applies to folders, so download files without merge.`);
            await assertSyncsUnchanged(synced);
            makeLd();
            // Where each matched .megaignore lands (its top match is downloaded INTO ld, or merged).
            const expect: string[] = [];
            const into = new Set<string>();
            for (const p of matched.filter((x) => isIgnoreFileName(posix.basename(x)))) {
              const top = g.paths.find((t) => p === t || p.startsWith(`${t}/`)) ?? p;
              const rel = p === top ? [] : p.slice(top.length + 1).split('/');
              // (The top folder of a share lands under its name after "email:".)
              const topName = posix.dirname(top) === '//from' ? posix.basename(top).replace(/^[^:]*:/, '') : posix.basename(top);
              expect.push(merge && p !== top ? joinLocal(ld, ...rel) : joinLocal(ld, topName, ...rel));
              // The folder it lands in is searched before a sync too (ld itself when merged).
              if (p !== top) for (const d of merge ? [ld] : landingsOf(ld, topName)) into.add(d);
            }
            noteDownloadIgnores(expect, carriesIgnoreFile && expect.length === 0 ? [ld] : [], [...into]);
            noteDownload(ld);
            // ld as spelled on disk: MEGA checks a folder's case on open, and a mismatch saves under "<name> (1)".
            const ldArg = onDiskSpelling(ld);
            const { done, failed } = await runPerHandle(rt, 'get', g.handles, (h) => [...transferOpts, h, ldArg]);
            return ok(`Downloaded ${done} node(s)${failed ? `; ${failed} failed` : ''} into ${ld}.`, { downloaded: done, failed, localDir: ld });
          };
          // Each node lands under its name at fetch time: no rename by another tool in between.
          return confirm ? withWriteLock(gateAndRun) : gateAndRun();
        }

        // Single path or public link.
        const source = isLink
          ? assertPublicLink(assertNoFlag(link as string, 'link'))
          : remotePath !== undefined && remotePath !== ''
            ? assertNotStoreCopy(assertNoWildcard(assertRemotePath(remotePath), 'remotePath'))
            : '';
        if (!source) throw new ValidationError('Provide remotePath or link.');
        // A root has no name of its own: MEGA would save it under a placeholder the checks never saw.
        if (!isLink && /^(?:\/|\/\/(?:bin|in))\/?$/.test(source)) throw new ValidationError(`${source} is a root; download the folders inside it instead.`);
        // A version (`name#<10 digits>`) keeps its own name: save it explicitly under the plain name.
        const versionOf = isLink ? null : versionPlainName(posix.basename(source));
        if (!isLink && posix.dirname(source).split('/').some((seg) => /#\d{10}$/.test(seg))) {
          throw new ValidationError('remotePath may name a file version only in its last part.');
        }
        if (versionOf !== null && merge) throw new ValidationError('merge applies to folders; a file version is downloaded as a file.');
        // Merged, a FILE would be saved beside localDir under a renamed name nothing checked.
        if (merge && !isLink && (await remoteKind(rt, source)) !== 'folder') throw new ValidationError('merge applies to folders; download a file without merge (or the source could not be checked).');
        // A merged FILE link would be saved beside localDir, under a name nothing checked.
        if (merge && isLink && /\/file\/|#!/.test(source)) throw new ValidationError('merge applies to folder links; download a file link without merge.');
        const versionTarget = versionOf === null ? null : joinLocal(ld, versionOf);
        // Onto an existing folder MEGAcmd would download INTO it, under the version's name.
        if (versionTarget && existsSync(versionTarget) && statSync(versionTarget).isDirectory()) {
          throw new ValidationError(`${versionTarget} is a folder; download the version into another localDir.`);
        }
        // localDir alone is not where the data lands: `<localDir>/<node name>` is.
        // A link's node name is unknown until it is fetched, and a MERGED folder
        // writes its CONTENTS straight into localDir (measured on MEGAcmd 2.6.0:
        // `get -m /x/mg dir` put mg/new.txt at dir/new.txt), so both of those
        // check everything directly in localDir instead.
        if (ldMissing) assertDownloadTarget(dirname(ld), basename(ld));
        else if (isLink || merge) assertDownloadTarget(ld, null);
        else for (const name of localNamesOf(source)) assertDownloadTarget(ld, name);
        const landingNames = versionOf === null ? localNamesOf(source) : [versionOf];
        if (isLink || merge) assertNoSyncRootAt(null);
        else for (const name of landingNames) assertNoSyncRootAt(name);
        const ldSynced = isLink ? false : await inSyncedLocalFolder(rt, ld);
        // A .megaignore inside a downloaded folder would become a sync rule file ("." + 10 chars).
        let innerHits: string[] = [];
        let innerUnchecked = false;
        const innerIgnoreFiles = async (): Promise<void> => {
          // No runnable MEGAcmd at all (null): the download cannot run either, and says so.
          const r = await ignoreFilesBelow(rt, source);
          innerUnchecked = r?.unchecked ?? false;
          if (innerUnchecked && ldSynced !== false) throw new ValidationError(`Could not check ${source} for .megaignore files before downloading it into a synced folder.`);
          innerHits = r?.hits ?? [];
          if (innerHits.length > 0 && ldSynced !== false) {
            throw new ValidationError(`Refusing to download ${source} into ${ld}: it holds ${innerHits[0]}${innerHits.length > 1 ? ` and ${innerHits.length - 1} more` : ''}, and in a synced folder a .megaignore decides what the sync carries.`);
          }
        };
        if (!isLink) {
          for (const name of landingNames) ignoreFileCheck(name, ldSynced);
          if (versionOf === null) await innerIgnoreFiles();
        }
        if (!isLink && !confirm) await assertNoStoreCopyBelow(rt, source);
        const execNote = await executableDownloadNote(rt);
        const synced = await syncedLocalLines(rt, ld);
        // A .megaignore in a link could bring a .megaCmd copy below ld back into the sync.
        const copies = isLink && synced.length > 0 ? storeCopiesIn(ld) : { found: [], complete: true };
        if (copies.found.length > 0 || !copies.complete) {
          throw new ValidationError(`${ld} is in a synced folder and ${copies.found[0] ? `holds ${copies.found[0]}, a copy of MEGAcmd's session store` : 'could not be searched completely for copies of MEGAcmd\'s session store'}; what a link holds is not known before it arrives, so it is not downloaded there.`);
        }
        const gateAndRun = async () => {
          // What was copied in unconfirmed (a renamed recovery key file, say) is named and bound.
          const placed = isLink ? [] : [...unconfirmedWriteLines(source), ...(await recoveryKeyLinesBelow(rt, [source]))];
          // MEGAcmd downloads EVERY item with this name (a link names one node).
          const same = isLink ? { count: 1, lines: [] as string[] } : await sameNamed(rt, source);
          // The password is a secret: bound as an HMAC (secretBinding), never stored.
          const gate = checkConfirm(
            rt,
            'mega_get',
            {
              source, localDir: ld, isLink, background, ignoreQuotaWarn, merge, password: secretBinding(password), items: same.count, exec: execNote, synced,
              // Downloaded into a sync, it is uploaded again: bound like a copy to that place.
              contents: synced.length > 0 && !isLink ? await contentDigest(rt, source) : null,
              placed,
            },
            confirm,
            [
              ...placed,
              `This will download ${isLink ? `the link ${source}` : source} into ${ld}${created}${versionTarget ? `, saved as ${versionTarget}` : ''}${merge ? ' - its contents straight into that folder, merged with what is already there' : ''}${background ? ', in the background' : ''}${ignoreQuotaWarn ? ', ignoring a transfer-quota warning' : ''}.`,
              ...same.lines,
              ...(execNote ? [execNote] : []),
              ...synced,
            ],
          );
          if (gate) return gate;
          await assertSyncsUnchanged(synced);
          if (!isLink) await assertNoStoreCopyBelow(rt, source);
          // Into a sync: searched again under the write lock (a rename since the preview counts).
          if (synced.length > 0 && !isLink && versionOf === null) await innerIgnoreFiles();
          makeLd();
          // Where a .megaignore it carries lands (a link's contents are unknown: its folder is watched).
          if (isLink || innerUnchecked) noteDownloadIgnores([], [ld]);
          else {
            const shown = source.replace(/(.)\/+$/, '$1');
            // Only the top folder of someone else's share lands under its name after "email:".
            const name = versionTarget ? null : posix.dirname(shown) === '//from' ? posix.basename(shown).replace(/^[^:]*:/, '') : posix.basename(shown);
            const inside = (h: string) => (h.startsWith('/') ? h : `//from/${h}`).slice(shown.length + 1).split('/');
            noteDownloadIgnores(
              [
                ...(versionTarget && isIgnoreFileName(posix.basename(versionTarget)) ? [versionTarget] : []),
                ...(name && isIgnoreFileName(name) ? [joinLocal(ld, name)] : []),
                ...innerHits.filter((h) => h !== shown).map((h) => (merge || !name ? joinLocal(ld, ...inside(h)) : joinLocal(ld, name, ...inside(h)))),
              ],
              [],
              // The folder holding ones inside it is searched before a sync too (ld itself when merged).
              innerHits.some((h) => h !== shown) ? (merge || !name ? [ld] : landingsOf(ld, name)) : [],
            );
          }
          noteDownload(ld);
          // ld as spelled on disk: MEGA checks a folder's case on open, and a mismatch saves under "<name> (1)".
          const ldArg = onDiskSpelling(ld);
          const args = [...transferOpts, ...(password ? [`--password=${password}`] : []), source, versionTarget ? joinLocal(ldArg, basename(versionTarget)) : ldArg];
          return runToResult(rt, 'get', args, () => ok(`Downloaded into ${ld}.`, { source, localDir: ld, isLink }));
        };
        // Like a pattern download: no sync or copy starts between the checks and the download being
        // recorded (a background one returns at once, so holding the lock costs nothing).
        return confirm ? withWriteLock(gateAndRun) : gateAndRun();
      }),
  );

  // mega_thumbnail — download OR set a node's thumbnail. Both touch disk/the
  // node; confirm-gated.
  server.registerTool(
    'mega_thumbnail',
    {
      title: 'MEGA: thumbnail',
      description:
        "Download a cloud file's thumbnail to a local path (action=\"download\"), or set the node's thumbnail from a local image (action=\"set\"). Requires confirmation.",
      inputSchema: {
        remotePath: z.string().describe('Absolute MEGA path to the file.'),
        localPath: z.string().describe('Local path: destination (download) or source image (set).'),
        action: z.enum(['download', 'set']).default('download').describe('Download the thumbnail, or set it from the local image.'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: thumbnail', destructiveHint: true, openWorldHint: true },
    },
    async ({ remotePath, localPath, action, confirm }) =>
      guardRun(async () => {
        const rp = assertNoWildcard(assertRemotePath(remotePath), 'remotePath');
        const lp = assertLocalPath(localPath);
        // A download writes lp: the same landing checks as mega_get.
        if (action !== 'set') {
          assertDownloadTarget(dirname(lp), basename(lp));
          // It deletes and rewrites the file: never a sync's rules.
          assertNotIgnoreFile(lp);
        }
        // MEGAcmd deletes an existing file there and writes the image in its place.
        // (A dangling symlink is replaced too: lstat, not exists.)
        const replaces = action !== 'set' && (existsSync(lp) || isSymlink(lp));
        // MEGA does not check a thumbnail is an image, and anyone who can open the node reads it:
        // only an image is sent, and the preview says who sees it.
        if (action === 'set') assertImageFile(lp);
        const notes = action === 'set' ? await destinationNotes(rt, rp) : [];
        const execNote = action !== 'set' ? await executableDownloadNote(rt) : null;
        const synced = action !== 'set' ? await syncedLocalLines(rt, dirname(lp)) : [];
        const summary =
          action === 'set'
            ? [`This will set the thumbnail of ${rp} from ${lp}.`, ...notes]
            : [`This will write the thumbnail of ${rp} to ${lp}${replaces ? ' - REPLACING the file that is there now' : ''}.`, ...(execNote ? [execNote] : []), ...synced];
        const gate = checkConfirm(rt, 'mega_thumbnail', { remotePath: rp, localPath: lp, action, replaces, exec: execNote, notes, synced }, confirm, summary);
        if (gate) return gate;
        if (action === 'set') noteSessionChange(rp, `its thumbnail was set from ${lp}`);
        else noteDownload(dirname(lp));
        const args = action === 'set' ? ['-s', rp, lp] : [rp, lp];
        return runToResult(rt, 'thumbnail', args, () =>
          ok(action === 'set' ? `Set thumbnail of ${rp} from ${lp}.` : `Thumbnail for ${rp} saved to ${lp}.`, { remotePath: rp, localPath: lp, action }),
        );
      }),
  );
}
