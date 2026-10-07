import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from '../runtime.js';
import { ok, err } from '../mcpResult.js';
import { posix, basename, dirname } from 'node:path';
import { statSync, existsSync, mkdirSync } from 'node:fs';
import { assertRemotePath, assertLocalPath, assertNoFlag, assertSecret, assertNoWildcard, assertNotStoreCopy, assertDownloadTarget, assertNoLocalGlob, planUpload, storeCopyIn, ValidationError } from '../paths.js';
import { guardRun, runToResult, checkConfirm, pcreGate, runPerHandle, runBulk, assertPlanSize, ensureRemoteFolder, secretBinding, localNamesOf, assertNoStoreCopyBelow, destinationNotes, remoteKind } from './helpers.js';
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
  const n = assertNoFlag(name, 'name');
  if (n === '' || n === '.' || n === '..' || /[\\/]/.test(n) || /#\d{10}$/.test(n)) {
    throw new ValidationError('name must be a plain file or folder name, without "/".');
  }
  assertNotStoreCopy(`${rp.replace(/\/+$/, '')}/${n}`);
  return n;
}

export function registerMutate(server: McpServer, rt: Runtime): void {
  // mega_mkdir — create a folder (idempotent with -p). Auto-allow.
  server.registerTool(
    'mega_mkdir',
    {
      title: 'MEGA: make folder',
      description: 'Create a MEGA cloud folder (parents created as needed).',
      inputSchema: { remotePath: z.string().describe('Absolute MEGA path to create.') },
      annotations: { title: 'MEGA: make folder', destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ remotePath }) =>
      guardRun(async () => {
        // mkdir walks the path by literal names (no wildcards), so a "*" in a new
        // folder's name is just a character: only a real .megaCmd name is refused.
        const rp = assertRemotePath(remotePath);
        if (storeCopyIn(rp) === 'name') assertNotStoreCopy(rp);
        return runToResult(rt, 'mkdir', ['-p', rp], () => ok(`Created folder ${rp}.`, { remotePath: rp }));
      }),
  );

  // mega_cp — copy within the cloud. Non-destructive, but confirm-gated: a copy
  // into a folder other people can reach (a share, or a folder with a public link)
  // discloses the source exactly as mega_share / mega_export would, and those are
  // gated. The preview names both ends, so a wildcard source is refused.
  server.registerTool(
    'mega_cp',
    {
      title: 'MEGA: copy',
      description:
        'Copy a MEGA cloud node to another cloud path. A copy onto an existing file replaces it, and a copy into a shared or publicly linked folder becomes visible to its viewers; the preview says which. Requires confirmation.',
      inputSchema: {
        src: z.string().describe('Source absolute MEGA path.'),
        dst: z.string().describe('Destination absolute MEGA path.'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      // Destructive: a copy onto an existing file REPLACES it (MEGAcmd copies, then
      // removes the old target).
      annotations: { title: 'MEGA: copy', destructiveHint: true, openWorldHint: true },
    },
    async ({ src, dst, confirm }) =>
      guardRun(async () => {
        const s = assertNotStoreCopy(assertNoWildcard(assertRemotePath(src, 'src'), 'src'), 'src');
        const d = assertRemotePath(dst, 'dst');
        if (!confirm) await assertNoStoreCopyBelow(rt, s);
        const notes = confirm ? [] : await destinationNotes(rt, d, { overwrite: true });
        const gate = checkConfirm(rt, 'mega_cp', { src: s, dst: d }, confirm, [`This will copy ${s} to ${d}.`, ...notes]);
        if (gate) return gate;
        await assertNoStoreCopyBelow(rt, s);
        return runToResult(rt, 'cp', [s, d], () => ok(`Copied ${s} -> ${d}.`, { src: s, dst: d }));
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
        usePcre: z.boolean().default(false).describe('Interpret "src" as a PCRE pattern and move EVERY match.'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: move/rename', destructiveHint: true, openWorldHint: true },
    },
    async ({ src, dst, srcs, usePcre, confirm }) =>
      guardRun(async () => {
        const d = assertRemotePath(dst, 'dst');

        // Mode 1: explicit list -> one multi-source `mv src1 src2 … dst`.
        if (srcs && srcs.length > 0) {
          assertPlanSize(srcs.length, 'items');
          const list = srcs.map((s, i) => assertNotStoreCopy(assertNoWildcard(assertRemotePath(s, `srcs[${i}]`), `srcs[${i}]`), `srcs[${i}]`));
          // Refusals first; the destination notes only matter for a request that can run.
          if (!confirm) for (const p of list) await assertNoStoreCopyBelow(rt, p);
          const notes = confirm ? [] : await destinationNotes(rt, d);
          const summary = [`This will move ${list.length} item(s) to ${d}:`, ...list.map((p) => `  ${p}`), ...notes];
          const gate = checkConfirm(rt, 'mega_mv', { srcs: list, dst: d }, confirm, summary);
          if (gate) return gate;
          for (const p of list) await assertNoStoreCopyBelow(rt, p);
          const { done, failed } = await runBulk(rt, 'mv', list, [d]);
          return ok(`Moved ${done}/${list.length} item(s) to ${d}${failed ? `; ${failed} failed` : ''}.`, { dst: d, moved: done, failed });
        }

        // Mode 2: PCRE pattern -> enumerate + pin handles (TOCTOU-safe preview),
        // then move the pinned set in one multi-source `mv`.
        if (usePcre) {
          if (!src) throw new ValidationError('usePcre requires "src" (the PCRE pattern).');
          const pattern = assertNoFlag(src, 'src');
          const pcreNotes = confirm ? [] : await destinationNotes(rt, d);
          const g = await pcreGate(
            rt,
            'mega_mv',
            { src: pattern, usePcre: true, dst: d },
            confirm,
            pattern,
            (n, t) => [`This will move ${n} node(s) matching the pattern to ${d}:`, t, ...pcreNotes].join('\n'),
            (p) => assertNotStoreCopy(p, 'A matched node'),
          );
          if (!g.proceed) return g.result;
          if (g.handles.length === 0) return ok('No matching nodes to move.', { dst: d, moved: 0 });
          const { done, failed } = await runBulk(rt, 'mv', g.handles, [d]);
          return ok(`Moved ${done}/${g.handles.length} node(s) to ${d}${failed ? `; ${failed} failed` : ''}.`, { dst: d, moved: done, failed });
        }

        // Mode 3: a single path. A native wildcard is NOT accepted here: MEGAcmd
        // would expand it server-side after approval, so the preview would name
        // one node while N were moved. Modes 1 and 2 are the supported bulk paths
        // and both enumerate before confirming.
        if (!src) throw new ValidationError('Provide "src" (a path or pattern) or "srcs" (a list).');
        const s = assertNotStoreCopy(assertNoWildcard(assertRemotePath(src, 'src'), 'src'), 'src');
        if (!confirm) await assertNoStoreCopyBelow(rt, s);
        const notes = confirm ? [] : await destinationNotes(rt, d, { overwrite: true });
        const gate = checkConfirm(rt, 'mega_mv', { src: s, dst: d }, confirm, [`This will move/rename ${s} to ${d}.`, ...notes]);
        if (gate) return gate;
        await assertNoStoreCopyBelow(rt, s);
        return runToResult(rt, 'mv', [s, d], () => ok(`Moved ${s} -> ${d}.`, { src: s, dst: d }));
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
        assertPlanSize(raw.length, 'items');
        const lps = raw.map((p) => assertNoLocalGlob(assertLocalPath(p)));
        const rp = assertNotStoreCopy(assertRemotePath(remotePath));
        const as = name === undefined ? undefined : uploadName(name, lps, rp);
        const cloudPath = (lp: string) => `${rp.replace(/\/+$/, '')}/${as ?? basename(lp)}`;
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
        const notes = confirm ? [] : await destinationNotes(rt, as === undefined ? rp : cloudPath(lps[0]!), { overwrite: true });
        const summary = [
          ...notes,
          `This will upload ${lps.length} item(s) into the folder ${rp} (created if missing)${background ? ', in the background' : ''}:`,
          ...lps.map((p) => `  ${p}  ->  ${cloudPath(p)}`),
          ...(plan.excluded.length > 0
            ? [
                '',
                "Left out: the MEGAcmd session store, which holds this account's MASTER KEY:",
                ...plan.excluded.map((p) => `  ${p}`),
              ]
            : []),
        ];
        // `replaces` is bound too: the confirmed call re-checks the target, and a
        // file that appeared (or went) since the preview no longer matches it.
        const gate = checkConfirm(rt, 'mega_put', { localPaths: lps, remotePath: rp, name: as ?? null, replaces, background }, confirm, summary);
        if (gate) return gate;
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
          return runToResult(rt, 'put', [...putOpts, ...lps, dest], () => ok(`Uploaded ${lps.length} item(s) -> ${dest}.`, { localPaths: lps, remotePath: dest, background }));
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
          return runToResult(rt, 'put', [...putOpts, ...lps, dest], () => ok(`Uploaded ${lps.length} item(s) -> ${dest}.`, { localPaths: lps, remotePath: dest, background }));
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
          for (let i = 0; i < step.sources.length; i += PUT_CHUNK) {
            const chunk = step.sources.slice(i, i + PUT_CHUNK);
            const r = await rt.run('put', [...putOpts, ...chunk, step.dest]);
            if (r.code !== 0) failed += chunk.length;
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
        'Download a MEGA cloud file/folder (by path or by public link) to a local directory. Requires confirmation.',
      inputSchema: {
        remotePath: z.string().optional().describe('Absolute MEGA path to download (a PCRE pattern when usePcre=true).'),
        link: z.string().optional().describe('A MEGA public link to download (instead of remotePath).'),
        localDir: z.string().describe('Local folder to download into (created if missing).'),
        password: z.string().optional().describe('Password for a password-protected link.'),
        background: z.boolean().default(false).describe('Queue the download in the background.'),
        ignoreQuotaWarn: z.boolean().default(false).describe('Proceed despite a transfer-quota warning.'),
        merge: z.boolean().default(false).describe('Download a folder\'s CONTENTS straight into localDir, next to what is already there, instead of into a new <localDir>/<folder name> (or a numbered copy if that exists).'),
        usePcre: z.boolean().default(false).describe('Interpret remotePath as a PCRE pattern (downloads every match).'),
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
          const g = await pcreGate(
            rt,
            'mega_get',
            { remotePath: rp, localDir: ld, usePcre: true, background, ignoreQuotaWarn, merge },
            confirm,
            rp,
            (n, t) =>
              `This will download ${n} node(s) matching the pattern into ${ld}${created}${merge ? ', each folder\'s contents straight into it (merged with what is there)' : ''}${background ? ', in the background' : ''}${ignoreQuotaWarn ? ', ignoring a transfer-quota warning' : ''}:\n${t}`,
            (p, topmost) => {
              // Every match is checked for a store copy; where it lands matters only
              // for the topmost ones - the rest land inside them.
              assertNotStoreCopy(p, 'A matched node');
              if (!topmost) return;
              if (ldMissing) assertDownloadTarget(dirname(ld), basename(ld));
              else if (merge) assertDownloadTarget(ld, null);
              else for (const name of localNamesOf(p)) assertDownloadTarget(ld, name);
            },
          );
          if (!g.proceed) return g.result;
          if (g.handles.length === 0) return ok('No matching nodes to download.', { downloaded: 0, localDir: ld });
          makeLd();
          const { done, failed } = await runPerHandle(rt, 'get', g.handles, (h) => [...transferOpts, h, ld]);
          return ok(`Downloaded ${done} node(s)${failed ? `; ${failed} failed` : ''} into ${ld}.`, { downloaded: done, failed, localDir: ld });
        }

        // Single path or public link.
        const source = isLink
          ? assertPublicLink(assertNoFlag(link as string, 'link'))
          : remotePath !== undefined && remotePath !== ''
            ? assertNotStoreCopy(assertNoWildcard(assertRemotePath(remotePath), 'remotePath'))
            : '';
        if (!source) throw new ValidationError('Provide remotePath or link.');
        // localDir alone is not where the data lands: `<localDir>/<node name>` is.
        // A link's node name is unknown until it is fetched, and a MERGED folder
        // writes its CONTENTS straight into localDir (measured on MEGAcmd 2.6.0:
        // `get -m /x/mg dir` put mg/new.txt at dir/new.txt), so both of those
        // check everything directly in localDir instead.
        if (ldMissing) assertDownloadTarget(dirname(ld), basename(ld));
        else if (isLink || merge) assertDownloadTarget(ld, null);
        else for (const name of localNamesOf(source)) assertDownloadTarget(ld, name);
        if (!isLink && !confirm) await assertNoStoreCopyBelow(rt, source);
        // The password is a secret: bound as an HMAC (secretBinding), never stored.
        const gate = checkConfirm(
          rt,
          'mega_get',
          { source, localDir: ld, isLink, background, ignoreQuotaWarn, merge, password: secretBinding(password) },
          confirm,
          `This will download ${isLink ? `the link ${source}` : source} into ${ld}${created}${merge ? ' - its contents straight into that folder, merged with what is already there' : ''}${background ? ', in the background' : ''}${ignoreQuotaWarn ? ', ignoring a transfer-quota warning' : ''}.`,
        );
        if (gate) return gate;
        if (!isLink) await assertNoStoreCopyBelow(rt, source);
        makeLd();
        const args = [...transferOpts, ...(password ? [`--password=${password}`] : []), source, ld];
        return runToResult(rt, 'get', args, () => ok(`Downloaded into ${ld}.`, { source, localDir: ld, isLink }));
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
        const summary =
          action === 'set' ? `This will set the thumbnail of ${rp} from ${lp}.` : `This will write the thumbnail of ${rp} to ${lp}.`;
        const gate = checkConfirm(rt, 'mega_thumbnail', { remotePath: rp, localPath: lp, action }, confirm, summary);
        if (gate) return gate;
        const args = action === 'set' ? ['-s', rp, lp] : [rp, lp];
        return runToResult(rt, 'thumbnail', args, () =>
          ok(action === 'set' ? `Set thumbnail of ${rp} from ${lp}.` : `Thumbnail for ${rp} saved to ${lp}.`, { remotePath: rp, localPath: lp, action }),
        );
      }),
  );
}
