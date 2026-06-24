import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from '../runtime.js';
import { ok, err } from '../mcpResult.js';
import { assertRemotePath, assertLocalPath, assertNoFlag, ValidationError } from '../paths.js';
import { guardRun, runToResult, checkConfirm, pcreGate, runPerHandle } from './helpers.js';

const NUL = String.fromCharCode(0);

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
        const rp = assertRemotePath(remotePath);
        return runToResult(rt, 'mkdir', ['-p', rp], () => ok(`Created folder ${rp}.`, { remotePath: rp }));
      }),
  );

  // mega_cp — copy within the cloud (non-destructive). Auto-allow.
  server.registerTool(
    'mega_cp',
    {
      title: 'MEGA: copy',
      description: 'Copy a MEGA cloud node to another cloud path.',
      inputSchema: {
        src: z.string().describe('Source absolute MEGA path.'),
        dst: z.string().describe('Destination absolute MEGA path.'),
      },
      annotations: { title: 'MEGA: copy', destructiveHint: false, openWorldHint: true },
    },
    async ({ src, dst }) =>
      guardRun(async () => {
        const s = assertRemotePath(src, 'src');
        const d = assertRemotePath(dst, 'dst');
        return runToResult(rt, 'cp', [s, d], () => ok(`Copied ${s} -> ${d}.`, { src: s, dst: d }));
      }),
  );

  // mega_mv — move/rename (overwrites/relocates). Confirm-gated.
  server.registerTool(
    'mega_mv',
    {
      title: 'MEGA: move/rename',
      description: 'Move or rename a MEGA cloud node. Requires confirmation.',
      inputSchema: {
        src: z.string().describe('Source absolute MEGA path.'),
        dst: z.string().describe('Destination absolute MEGA path.'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: move/rename', destructiveHint: true, openWorldHint: true },
    },
    async ({ src, dst, confirm }) =>
      guardRun(async () => {
        const s = assertRemotePath(src, 'src');
        const d = assertRemotePath(dst, 'dst');
        const gate = checkConfirm(rt, 'mega_mv', { src: s, dst: d }, confirm, `This will move/rename ${s} to ${d}.`);
        if (gate) return gate;
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
        const lps = raw.map((p) => assertLocalPath(p));
        const rp = assertRemotePath(remotePath);
        const gate = checkConfirm(rt, 'mega_put', { localPaths: lps, remotePath: rp, background }, confirm, `This will upload ${lps.length} item(s) to ${rp}.`);
        if (gate) return gate;
        const args = ['-c', ...(background ? ['-q'] : []), ...lps, rp];
        return runToResult(rt, 'put', args, () => ok(`Uploaded ${lps.length} item(s) -> ${rp}.`, { localPaths: lps, remotePath: rp, background }));
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
        if (password !== undefined && password.includes(NUL)) throw new ValidationError('password contains a NUL byte.');
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
            (n, t) => `This will download ${n} node(s) matching the pattern into ${ld}:\n${t}`,
          );
          if (!g.proceed) return g.result;
          if (g.handles.length === 0) return ok('No matching nodes to download.', { downloaded: 0, localDir: ld });
          const { done, failed } = await runPerHandle(rt, 'get', g.handles, (h) => [...transferOpts, h, ld]);
          return ok(`Downloaded ${done} node(s)${failed ? `; ${failed} failed` : ''} into ${ld}.`, { downloaded: done, failed, localDir: ld });
        }

        // Single path or public link.
        const source = isLink ? assertNoFlag(link as string, 'link') : remotePath !== undefined && remotePath !== '' ? assertRemotePath(remotePath) : '';
        if (!source) throw new ValidationError('Provide remotePath or link.');
        // The password is a secret: bind only its presence into the confirm token.
        const gate = checkConfirm(
          rt,
          'mega_get',
          { source, localDir: ld, isLink, background, ignoreQuotaWarn, merge, hasPassword: password !== undefined && password !== '' },
          confirm,
          `This will download ${isLink ? 'the provided link' : source} into ${ld}.`,
        );
        if (gate) return gate;
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
        const rp = assertRemotePath(remotePath);
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
