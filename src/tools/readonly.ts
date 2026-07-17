import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from '../runtime.js';
import { ok, err } from '../mcpResult.js';
import { assertOptionalRemotePath, assertRemotePath, assertNoFlag, assertConstraint } from '../paths.js';
import { capLines, decodeCursor, pageInfo, headerRowsUpTo } from '../parsers/listing.js';
import { parseDf } from '../parsers/df.js';
import { guardRun, runToResult } from './helpers.js';

const RO = { readOnlyHint: true, openWorldHint: true } as const;

export function registerReadOnly(server: McpServer, rt: Runtime): void {
  // mega_ls — list a cloud folder (capped text listing).
  server.registerTool(
    'mega_ls',
    {
      title: 'MEGA: list folder',
      description:
        'List the contents of a MEGA cloud folder (absolute path starting with "/", defaults to "/"). Returns a capped text listing; if it is truncated, call again with the returned nextPageToken to page through the rest.',
      inputSchema: {
        remotePath: z.string().optional().describe('Absolute MEGA path, e.g. "/Photos". Defaults to "/".'),
        recursive: z.boolean().optional().describe('Recurse into subfolders.'),
        showVersions: z.boolean().default(false).describe('Include prior file versions.'),
        showHandles: z.boolean().default(false).describe('Include node handles (H:XXXXXXXX).'),
        showCreationTime: z.boolean().default(false).describe('Show creation time instead of modification time.'),
        all: z.boolean().default(false).describe('Show all entries, including hidden ones.'),
        usePcre: z.boolean().default(false).describe('Interpret remotePath as a Perl-compatible regular expression.'),
        compact: z.boolean().default(false).describe('Compact, parseable output: ISO-8601 timestamps (2026-07-17T16:11:38) instead of RFC2822 — shorter rows, easy to filter by date (pair with showCreationTime to filter by upload time).'),
        pageToken: z.string().optional().describe('Opaque cursor from a previous call\'s nextPageToken, to fetch the next page of a large listing.'),
      },
      annotations: { title: 'MEGA: list folder', ...RO },
    },
    async ({ remotePath, recursive, showVersions, showHandles, showCreationTime, all, usePcre, compact, pageToken }) =>
      guardRun(async () => {
        const path = usePcre && remotePath ? assertNoFlag(remotePath, 'remotePath') : assertOptionalRemotePath(remotePath);
        const offset = pageToken ? decodeCursor(pageToken) : 0;
        if (offset === null) return err('Invalid pageToken. Omit it to start from the beginning of the listing.');
        const args = ['-l', `--time-format=${compact ? 'ISO6081_WITH_TIME' : 'RFC2822'}`];
        if (recursive) args.push('-R');
        if (all) args.push('-a');
        if (showVersions) args.push('--versions');
        if (showHandles) args.push('--show-handles');
        if (showCreationTime) args.push('--show-creation-time');
        if (usePcre) args.push('--use-pcre');
        if (path) args.push(path);
        return runToResult(rt, 'ls', args, (r) => {
          // Non-data leading lines: the "FLAGS VERS SIZE DATE NAME" column header,
          // plus (on some MEGAcmd versions) a "<path>:" label line before it.
          // Detect them by the FLAGS header rather than a hardcoded count so the
          // entry count is right across versions — exclude from the count, keep
          // atop every page.
          const cap = capLines(r.stdout, rt.config.maxListLines, offset, headerRowsUpTo(r.stdout, 'FLAGS'));
          const { note, fields } = pageInfo(cap, 'entries', 'mega_ls');
          return ok(cap.total > 0 ? `${cap.text}${note}` : '(empty folder)', {
            path: path ?? '/',
            entryCount: cap.total,
            ...fields,
          });
        });
      }),
  );

  // mega_df — storage usage.
  server.registerTool(
    'mega_df',
    {
      title: 'MEGA: storage usage',
      description: 'Show MEGA account storage usage and quota.',
      inputSchema: {},
      annotations: { title: 'MEGA: storage usage', ...RO },
    },
    async () =>
      guardRun(async () =>
        runToResult(rt, 'df', ['-h'], (r) => {
          const text = r.stdout.trim().slice(0, 4000);
          return ok(text || '(no output)', parseDf(r.stdout));
        }),
      ),
  );

  // mega_find — search by name pattern.
  server.registerTool(
    'mega_find',
    {
      title: 'MEGA: find',
      description:
        'Search the MEGA cloud for files/folders by name pattern (glob), optionally filtered by type, modification time, and size. Returns matching paths, capped; if truncated, call again with the returned nextPageToken to page through the rest.',
      inputSchema: {
        pattern: z.string().optional().describe('Glob pattern, e.g. "*.jpg".'),
        remotePath: z.string().optional().describe('Absolute MEGA path to search under. Defaults to "/".'),
        type: z.enum(['file', 'folder']).optional().describe('Restrict to files or folders.'),
        mtime: z
          .string()
          .optional()
          .describe('Modification-time window, relative to now: [+-]N<unit> where h=hours d=days M=minutes m=months y=years. "-7d"=last 7 days, "+1m"=older than 1 month, "-30d+7d"=between 7 and 30 days ago. (Filters modification time, not upload/creation time.)'),
        size: z
          .string()
          .optional()
          .describe('Size constraint: [+-]N<unit> (B/K/M/G/T). "+1M"=larger than 1 MB, "-100K"=smaller than 100 KB, "-4M+100K"=between 100 KB and 4 MB.'),
        showHandles: z.boolean().default(false).describe('Include node handles.'),
        usePcre: z.boolean().default(false).describe('Interpret the pattern as a Perl-compatible regular expression.'),
        pageToken: z.string().optional().describe('Opaque cursor from a previous call\'s nextPageToken, to fetch the next page of results.'),
      },
      annotations: { title: 'MEGA: find', ...RO },
    },
    async ({ pattern, remotePath, type, mtime, size, showHandles, usePcre, pageToken }) =>
      guardRun(async () => {
        const path = assertOptionalRemotePath(remotePath);
        const offset = pageToken ? decodeCursor(pageToken) : 0;
        if (offset === null) return err('Invalid pageToken. Omit it to start from the beginning of the results.');
        const args: string[] = [];
        if (path) args.push(path);
        if (pattern) args.push(`--pattern=${pattern}`);
        if (type) args.push(`--type=${type === 'folder' ? 'd' : 'f'}`);
        if (mtime !== undefined) args.push(`--mtime=${assertConstraint(mtime, 'mtime')}`);
        if (size !== undefined) args.push(`--size=${assertConstraint(size, 'size')}`);
        if (showHandles) args.push('--show-handles');
        if (usePcre) args.push('--use-pcre');
        return runToResult(rt, 'find', args, (r) => {
          const cap = capLines(r.stdout, rt.config.maxListLines, offset);
          const { note, fields } = pageInfo(cap, 'matches', 'mega_find');
          return ok(cap.text ? `${cap.text}${note}` : '(no matches)', { matchCount: cap.total, ...fields });
        });
      }),
  );
  // mega_tree — recursive tree-decorated listing of a folder. Read-only;
  // complements ls/find. Output is capped like other listings.
  server.registerTool(
    'mega_tree',
    {
      title: 'MEGA: folder tree',
      description:
        'Show a MEGA cloud folder as an indented tree (absolute path starting with "/", defaults to "/"). Returns a capped text tree of folders; if truncated, call again with the returned nextPageToken to page through the rest.',
      inputSchema: {
        remotePath: z.string().optional().describe('Absolute MEGA path, e.g. "/Photos". Defaults to "/".'),
        pageToken: z.string().optional().describe('Opaque cursor from a previous call\'s nextPageToken, to fetch the next page of a large tree.'),
      },
      annotations: { title: 'MEGA: folder tree', ...RO },
    },
    async ({ remotePath, pageToken }) =>
      guardRun(async () => {
        const path = assertOptionalRemotePath(remotePath);
        const offset = pageToken ? decodeCursor(pageToken) : 0;
        if (offset === null) return err('Invalid pageToken. Omit it to start from the beginning of the tree.');
        const args: string[] = [];
        if (path) args.push(path);
        return runToResult(rt, 'tree', args, (r) => {
          // headerRows=1: the first line is the root node itself, not a child —
          // exclude it from the count and keep it atop every page.
          const cap = capLines(r.stdout, rt.config.maxListLines, offset, 1);
          const { note, fields } = pageInfo(cap, 'entries', 'mega_tree');
          return ok(cap.total > 0 ? `${cap.text}${note}` : '(empty)', { path: path ?? '/', lineCount: cap.total, ...fields });
        });
      }),
  );

  // mega_du — space used by remote files/folders. Read-only; pairs with df.
  server.registerTool(
    'mega_du',
    {
      title: 'MEGA: disk usage',
      description:
        'Report the storage used by a MEGA cloud path (absolute path starting with "/", defaults to "/"). Read-only.',
      inputSchema: {
        remotePath: z.string().optional().describe('Absolute MEGA path to measure. Defaults to "/".'),
      },
      annotations: { title: 'MEGA: disk usage', ...RO },
    },
    async ({ remotePath }) =>
      guardRun(async () => {
        const path = assertOptionalRemotePath(remotePath);
        const args = ['-h']; // human-readable sizes
        if (path) args.push(path);
        return runToResult(rt, 'du', args, (r) => {
          const text = r.stdout.trim().slice(0, 4000);
          return ok(text || '(no output)', { path: path ?? '/' });
        });
      }),
  );

  // mega_mount — list the account's root nodes and in-shares (Cloud Drive,
  // Inbox, Rubbish, incoming shares). Verified read-only: this is NOT a FUSE
  // mount; it takes no arguments and only enumerates roots.
  server.registerTool(
    'mega_mount',
    {
      title: 'MEGA: list roots',
      description:
        'List the account root nodes and incoming shares (Cloud Drive, Inbox, Rubbish, shares). Read-only; does not mount anything.',
      inputSchema: {},
      annotations: { title: 'MEGA: list roots', ...RO },
    },
    async () =>
      guardRun(async () =>
        runToResult(rt, 'mount', [], (r) => {
          const { text, total, truncated } = capLines(r.stdout, rt.config.maxListLines);
          return ok(text || '(no roots)', { rootCount: total, truncated });
        }),
      ),
  );

  // mega_version — MEGAcmd version string (diagnostics/support). Read-only.
  // No flags: bare `version` prints the version; -c would hit the network for an
  // update check and -l prints the changelog — neither is needed here.
  server.registerTool(
    'mega_version',
    {
      title: 'MEGA: version',
      description: 'Show the installed MEGAcmd version (diagnostics). Read-only.',
      inputSchema: {},
      annotations: { title: 'MEGA: version', ...RO },
    },
    async () =>
      guardRun(async () =>
        runToResult(rt, 'version', [], (r) => {
          const text = r.stdout.trim().slice(0, 2000);
          return ok(text || '(no output)', {});
        }),
      ),
  );

  // mega_transfers — list active transfers (status only). Read-only: we expose
  // the listing but deliberately NOT the pause/cancel forms, which mutate live
  // server state.
  server.registerTool(
    'mega_transfers',
    {
      title: 'MEGA: transfers',
      description:
        'List MEGA transfers (uploads/downloads) and their progress, optionally filtered. Read-only status; pause/cancel live in mega_transfer_control.',
      inputSchema: {
        only: z.enum(['uploads', 'downloads']).optional().describe('Show only uploads or only downloads.'),
        summary: z.boolean().default(false).describe('Print a summary of ongoing transfers.'),
        showCompleted: z.boolean().default(false).describe('Include completed transfers.'),
        limit: z.number().int().min(1).optional().describe('Show only the first N transfers.'),
      },
      annotations: { title: 'MEGA: transfers', ...RO },
    },
    async ({ only, summary, showCompleted, limit }) =>
      guardRun(async () => {
        const args: string[] = [];
        if (only === 'uploads') args.push('--only-uploads');
        if (only === 'downloads') args.push('--only-downloads');
        if (summary) args.push('--summary');
        if (showCompleted) args.push('--show-completed');
        if (limit !== undefined) args.push(`--limit=${limit}`);
        return runToResult(rt, 'transfers', args, (r) => {
          const { text, total, truncated } = capLines(r.stdout, rt.config.maxListLines);
          const note = truncated ? `\n\n(${total} transfers; showing first ${rt.config.maxListLines})` : '';
          return ok(text ? `${text}${note}` : '(no active transfers)', { transferCount: total, truncated });
        });
      }),
  );

  // mega_mediainfo — media technical metadata (codec/resolution/duration) of a
  // remote file. Read-only: MEGAcmd reads the node key internally to decode the
  // media-properties attribute but never prints it.
  server.registerTool(
    'mega_mediainfo',
    {
      title: 'MEGA: media info',
      description:
        "Show technical media metadata (codec, resolution, duration) for a remote media file. Read-only.",
      inputSchema: { remotePath: z.string().describe('Absolute MEGA path to the media file.') },
      annotations: { title: 'MEGA: media info', ...RO },
    },
    async ({ remotePath }) =>
      guardRun(async () => {
        const rp = assertRemotePath(remotePath);
        return runToResult(rt, 'mediainfo', [rp], (r) => {
          const text = r.stdout.trim().slice(0, 4000);
          return ok(text || '(no media metadata)', { remotePath: rp });
        });
      }),
  );

  // mega_attr — view node attributes (labels, favourite, custom app attrs, s4).
  // READ FORM ONLY: the argv is hardcoded to the read form; we never accept
  // -s/-d or a value from the model (those mutate the node — a separate
  // confirm-gated tool's job, out of scope here).
  server.registerTool(
    'mega_attr',
    {
      title: 'MEGA: node attributes',
      description:
        'View the attributes of a MEGA cloud node (labels, favourite, custom attributes). Read-only.',
      inputSchema: { remotePath: z.string().describe('Absolute MEGA path to inspect.') },
      annotations: { title: 'MEGA: node attributes', ...RO },
    },
    async ({ remotePath }) =>
      guardRun(async () => {
        const rp = assertRemotePath(remotePath);
        return runToResult(rt, 'attr', [rp], (r) => {
          const { text, total, truncated } = capLines(r.stdout, rt.config.maxListLines);
          return ok(text || '(no attributes)', { remotePath: rp, lineCount: total, truncated });
        });
      }),
  );

  // mega_errorcode — translate a numeric MEGAcmd/SDK error code to text. Pure
  // offline lookup: no state, network, PII, or keys. Integer-only input.
  server.registerTool(
    'mega_errorcode',
    {
      title: 'MEGA: explain error code',
      description: 'Translate a numeric MEGAcmd/SDK error code into its text description. Read-only, offline.',
      inputSchema: { code: z.number().int().describe('The numeric error code to explain.') },
      annotations: { title: 'MEGA: explain error code', ...RO },
    },
    async ({ code }) =>
      guardRun(async () =>
        runToResult(rt, 'errorcode', [String(code)], (r) => {
          const text = r.stdout.trim().slice(0, 1000);
          return ok(text || `(no description for code ${code})`, { code });
        }),
      ),
  );

  // mega_thumbnail lives in mutate.ts: it writes to a local path, so it is a
  // local-write op (confirm-gated), not read-only.
}
