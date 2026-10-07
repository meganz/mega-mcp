import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from '../runtime.js';
import { ok, err } from '../mcpResult.js';
import { posix } from 'node:path';
import { assertRemotePath, assertLocalPath, assertNoFlag, assertSecret, assertNoWildcard, assertNotStoreCopy, assertDownloadTarget, assertNoLocalGlob, planUpload, ValidationError } from '../paths.js';
import { guardRun, runToResult, checkConfirm, pcreGate, runPerHandle, runBulk, assertPlanSize, ensureRemoteFolder, secretBinding, localNamesOf, assertNoStoreCopyBelow } from './helpers.js';
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
        const rp = assertNotStoreCopy(assertRemotePath(remotePath));
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
      description: 'Copy a MEGA cloud node to another cloud path. Requires confirmation.',
      inputSchema: {
        src: z.string().describe('Source absolute MEGA path.'),
        dst: z.string().describe('Destination absolute MEGA path.'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: copy', destructiveHint: false, openWorldHint: true },
    },
    async ({ src, dst, confirm }) =>
      guardRun(async () => {
        const s = assertNotStoreCopy(assertNoWildcard(assertRemotePath(src, 'src'), 'src'), 'src');
        const d = assertRemotePath(dst, 'dst');
        if (!confirm) await assertNoStoreCopyBelow(rt, s);
        const gate = checkConfirm(rt, 'mega_cp', { src: s, dst: d }, confirm, `This will copy ${s} to ${d}.`);
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
          const summary = [`This will move ${list.length} item(s) to ${d}:`, ...list.map((p) => `  ${p}`)];
          if (!confirm) for (const p of list) await assertNoStoreCopyBelow(rt, p);
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
          const g = await pcreGate(
            rt,
            'mega_mv',
            { src: pattern, usePcre: true, dst: d },
            confirm,
            pattern,
            (n, t) => `This will move ${n} node(s) matching the pattern to ${d}:\n${t}`,
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
        const gate = checkConfirm(rt, 'mega_mv', { src: s, dst: d }, confirm, `This will move/rename ${s} to ${d}.`);
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
      description: 'Upload one or more local files/folders to a MEGA cloud path. Requires confirmation.',
      inputSchema: {
        localPath: z.string().optional().describe('A single local file/folder to upload.'),
        localPaths: z.array(z.string()).optional().describe('Multiple local files/folders to upload.'),
        remotePath: z.string().describe('Destination absolute MEGA path.'),
        background: z.boolean().default(false).describe('Queue the upload in the background (do not wait for it to finish).'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: upload', destructiveHint: true, openWorldHint: true },
    },
    async ({ localPath, localPaths, remotePath, background, confirm }) =>
      guardRun(async () => {
        const raw = [...(localPaths ?? []), ...(localPath ? [localPath] : [])];
        if (raw.length === 0) throw new ValidationError('Provide localPath or localPaths.');
        assertPlanSize(raw.length, 'items');
        const lps = raw.map((p) => assertNoLocalGlob(assertLocalPath(p)));
        const rp = assertNotStoreCopy(assertRemotePath(remotePath));
        // A folder holding the session store is uploaded WITHOUT it (see planUpload).
        // Planned again on the confirmed call, so the store is left out of what is
        // actually uploaded, not only of what the preview showed.
        const plan = planUpload(lps, rp, await rt.getBinDir());
        // The preview MUST name what leaves the machine: it is the only human
        // checkpoint here, and "upload 1 item(s)" gives nothing to refuse on.
        // Built as LINES so checkConfirm escapes each path on its own — a newline
        // inside one must not be able to forge an extra line here.
        const summary = [
          `This will upload ${lps.length} item(s) into the folder ${rp} (created if missing)${background ? ', in the background' : ''}:`,
          ...lps.map((p) => `  ${p}`),
          ...(plan.excluded.length > 0
            ? [
                '',
                "Left out: the MEGAcmd session store, which holds this account's MASTER KEY:",
                ...plan.excluded.map((p) => `  ${p}`),
              ]
            : []),
        ];
        const gate = checkConfirm(rt, 'mega_put', { localPaths: lps, remotePath: rp, background }, confirm, summary);
        if (gate) return gate;
        const putOpts = ['-c', ...(background ? ['-q'] : [])];
        const untouched = plan.excluded.length === 0 && plan.steps.length === 1 && plan.steps[0]!.dest === rp;
        // rp must exist as a FOLDER before anything is put into it. With -c and a
        // missing destination MEGAcmd creates only its PARENT and uploads under
        // rp's last name instead, so the same request built a different tree
        // depending on whether rp already existed.
        // A special root (//from/<email>:<share>, //in) cannot be created, only used:
        // an untouched plan goes there as one plain put, a rebuilt tree cannot.
        if (rp.startsWith('//')) {
          if (!untouched) return err(`Cannot rebuild folders under ${rp}; upload into a regular folder, or upload a subfolder that does not contain the session store.`, { remotePath: rp });
          return runToResult(rt, 'put', [...putOpts, ...lps, rp], () => ok(`Uploaded ${lps.length} item(s) -> ${rp}.`, { localPaths: lps, remotePath: rp, background }));
        }
        const target = await ensureRemoteFolder(rt, rp);
        if (target === 'error') return err(`Could not create the destination folder ${rp}.`, { remotePath: rp });
        if (target === 'file') {
          // A file at rp: MEGAcmd replaces it with a single local file (a new
          // version) and refuses anything else. Never with the store left out.
          if (!untouched) return err(`${rp} is a file, not a folder.`, { remotePath: rp });
          return runToResult(rt, 'put', [...putOpts, ...lps, rp], () => ok(`Uploaded ${lps.length} item(s) -> ${rp}.`, { localPaths: lps, remotePath: rp, background }));
        }
        // Only an untouched plan (everything in one put to rp) runs as a plain put;
        // anything else runs step by step, so the store is never a source.
        if (untouched) {
          return runToResult(rt, 'put', [...putOpts, ...lps, rp], () => ok(`Uploaded ${lps.length} item(s) -> ${rp}.`, { localPaths: lps, remotePath: rp, background }));
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
        localDir: z.string().describe('Local destination directory.'),
        password: z.string().optional().describe('Password for a password-protected link.'),
        background: z.boolean().default(false).describe('Queue the download in the background.'),
        ignoreQuotaWarn: z.boolean().default(false).describe('Proceed despite a transfer-quota warning.'),
        merge: z.boolean().default(false).describe('If the local folder exists, merge into it (preserve existing files) instead of creating a numbered copy.'),
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
            (n, t) => `This will download ${n} node(s) matching the pattern into ${ld}${merge ? ', merging into folders that already exist there' : ''}:\n${t}`,
            (p) => {
              assertNotStoreCopy(p, 'A matched node');
              if (merge) assertDownloadTarget(ld, null);
              else for (const name of localNamesOf(p)) assertDownloadTarget(ld, name);
            },
          );
          if (!g.proceed) return g.result;
          if (g.handles.length === 0) return ok('No matching nodes to download.', { downloaded: 0, localDir: ld });
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
        if (isLink || merge) assertDownloadTarget(ld, null);
        else for (const name of localNamesOf(source)) assertDownloadTarget(ld, name);
        if (!isLink && !confirm) await assertNoStoreCopyBelow(rt, source);
        // The password is a secret: bound as an HMAC (secretBinding), never stored.
        const gate = checkConfirm(
          rt,
          'mega_get',
          { source, localDir: ld, isLink, background, ignoreQuotaWarn, merge, password: secretBinding(password) },
          confirm,
          `This will download ${isLink ? `the link ${source}` : source} into ${ld}${merge ? ', merging into a folder that already exists there' : ''}${background ? ', in the background' : ''}${ignoreQuotaWarn ? ', ignoring a transfer-quota warning' : ''}.`,
        );
        if (gate) return gate;
        if (!isLink) await assertNoStoreCopyBelow(rt, source);
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
