import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from '../runtime.js';
import { ok, err } from '../mcpResult.js';
import { ExitCode, classifyExit } from '../errors.js';
import { assertRemotePath, assertLocalPath, assertNoFlag, ValidationError } from '../paths.js';
import { capLines } from '../parsers/listing.js';
import { guardRun, runToResult, checkConfirm } from './helpers.js';

const RO = { readOnlyHint: true, openWorldHint: true } as const;
const SYNC_CTRL: Record<string, string> = { pause: '-p', resume: '-e', delete: '-d' };

/**
 * Sync & backup. The model can only establish / list / pause / remove these
 * relationships — it cannot manipulate the files inside a synced folder (those
 * changes are driven by the user/OS). `sync -d` removes the config, NOT the
 * files. Setup is confirm-gated and validates paths exactly like put/get; the
 * persistent two-way nature is called out in the confirmation preview.
 */
export function registerSync(server: McpServer, rt: Runtime): void {
  // mega_sync_list — list configured synchronizations.
  server.registerTool(
    'mega_sync_list',
    {
      title: 'MEGA: list syncs',
      description: 'List configured folder synchronizations and their state. Read-only.',
      inputSchema: {},
      annotations: { title: 'MEGA: list syncs', ...RO },
    },
    async () =>
      guardRun(async () =>
        runToResult(rt, 'sync', [], (r) => {
          const { text, total, truncated } = capLines(r.stdout, rt.config.maxListLines);
          return ok(text || '(no syncs configured)', { syncCount: total, truncated });
        }),
      ),
  );

  // mega_sync_add — start a two-way sync between a local folder and a remote folder.
  server.registerTool(
    'mega_sync_add',
    {
      title: 'MEGA: add sync',
      description:
        'Start a continuous TWO-WAY sync between a local folder and a MEGA folder. Changes propagate both ways from then on (including deletions). Requires confirmation.',
      inputSchema: {
        localPath: z.string().describe('Local folder to sync.'),
        remotePath: z.string().describe('Absolute MEGA folder path to sync with.'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: add sync', destructiveHint: true, openWorldHint: true },
    },
    async ({ localPath, remotePath, confirm }) =>
      guardRun(async () => {
        const lp = assertLocalPath(localPath);
        const rp = assertRemotePath(remotePath);
        const summary = `This will start a CONTINUOUS TWO-WAY sync between ${lp} and ${rp}. From now on, changes (including deletions) on either side propagate to the other.`;
        const gate = checkConfirm(rt, 'mega_sync_add', { localPath: lp, remotePath: rp }, confirm, summary);
        if (gate) return gate;
        return runToResult(rt, 'sync', [lp, rp], () => ok(`Started sync ${lp} <-> ${rp}.`, { localPath: lp, remotePath: rp }));
      }),
  );

  // mega_sync_control — pause / resume / delete a sync config (delete keeps files).
  server.registerTool(
    'mega_sync_control',
    {
      title: 'MEGA: control sync',
      description:
        'Pause, resume, or delete a sync configuration by its id (from mega_sync_list). Deleting a sync stops mirroring but does NOT delete files. Requires confirmation.',
      inputSchema: {
        action: z.enum(['pause', 'resume', 'delete']).describe('What to do with the sync.'),
        id: z.string().describe('Sync id (from mega_sync_list).'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: control sync', destructiveHint: true, openWorldHint: true },
    },
    async ({ action, id, confirm }) =>
      guardRun(async () => {
        const sid = assertNoFlag(id, 'id');
        const summary =
          action === 'delete'
            ? `This will delete sync ${sid} (stops mirroring; does not delete files).`
            : `This will ${action} sync ${sid}.`;
        const gate = checkConfirm(rt, 'mega_sync_control', { action, id: sid }, confirm, summary);
        if (gate) return gate;
        return runToResult(rt, 'sync', [SYNC_CTRL[action] as string, sid], () => ok(summary.replace(/^This will /, 'Done: '), { action, id: sid }));
      }),
  );

  // mega_backup_list — list configured backups.
  server.registerTool(
    'mega_backup_list',
    {
      title: 'MEGA: list backups',
      description: 'List configured backups and their state. Read-only.',
      inputSchema: {},
      annotations: { title: 'MEGA: list backups', ...RO },
    },
    async () =>
      guardRun(async () => {
        const r = await rt.run('backup', []);
        // `backup` returns NOTFOUND (53) when none are configured — surface that
        // as a clean empty result rather than an error.
        if (r.code === ExitCode.NOTFOUND) return ok('(no backups configured)', { backupCount: 0, truncated: false });
        if (r.code !== ExitCode.OK) return err(classifyExit(r), { ok: false, code: r.code });
        const { text, total, truncated } = capLines(r.stdout, rt.config.maxListLines);
        return ok(text || '(no backups configured)', { backupCount: total, truncated });
      }),
  );

  // mega_backup_add — configure a periodic ONE-WAY backup (local -> remote snapshots).
  server.registerTool(
    'mega_backup_add',
    {
      title: 'MEGA: add backup',
      description:
        'Configure a periodic one-way backup of a local folder into a MEGA folder (timestamped snapshots). Requires confirmation.',
      inputSchema: {
        localPath: z.string().describe('Local folder to back up.'),
        remotePath: z.string().describe('Absolute MEGA folder path to hold the snapshots.'),
        period: z.string().describe('Period: a cron-like expression or a time string (e.g. "0 0 * * *").'),
        numBackups: z.number().int().min(1).describe('Maximum number of snapshots to keep.'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: add backup', destructiveHint: true, openWorldHint: true },
    },
    async ({ localPath, remotePath, period, numBackups, confirm }) =>
      guardRun(async () => {
        const lp = assertLocalPath(localPath);
        const rp = assertRemotePath(remotePath);
        if (period.includes(String.fromCharCode(0)) || period.trim() === '') {
          throw new ValidationError('period is empty or invalid.');
        }
        const summary = `This will configure a periodic backup of ${lp} into ${rp} (period "${period}", keep ${numBackups}).`;
        const gate = checkConfirm(rt, 'mega_backup_add', { localPath: lp, remotePath: rp, period, numBackups }, confirm, summary);
        if (gate) return gate;
        const args = [lp, rp, `--period=${period}`, `--num-backups=${numBackups}`];
        return runToResult(rt, 'backup', args, () => ok(`Configured backup ${lp} -> ${rp}.`, { localPath: lp, remotePath: rp }));
      }),
  );

  // mega_backup_control — abort or delete a backup config.
  server.registerTool(
    'mega_backup_control',
    {
      title: 'MEGA: control backup',
      description:
        'Abort an in-progress backup or delete a backup configuration, by its tag (from mega_backup_list). Requires confirmation.',
      inputSchema: {
        action: z.enum(['abort', 'delete']).describe('Abort the running backup, or delete the config.'),
        tag: z.string().describe('Backup tag (from mega_backup_list).'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: control backup', destructiveHint: true, openWorldHint: true },
    },
    async ({ action, tag, confirm }) =>
      guardRun(async () => {
        const t = assertNoFlag(tag, 'tag');
        const summary = action === 'abort' ? `This will abort backup ${t}.` : `This will delete backup configuration ${t}.`;
        const gate = checkConfirm(rt, 'mega_backup_control', { action, tag: t }, confirm, summary);
        if (gate) return gate;
        return runToResult(rt, 'backup', [action === 'abort' ? '-a' : '-d', t], () => ok(summary.replace(/^This will /, 'Done: '), { action, tag: t }));
      }),
  );

  // mega_sync_issues — show conflicts that have stopped a sync. Read-only.
  server.registerTool(
    'mega_sync_issues',
    {
      title: 'MEGA: sync issues',
      description: 'Show conflicts/issues that have stopped syncs. Read-only.',
      inputSchema: {
        detail: z.string().optional().describe('Show details for a sync-issue ID, or "all" for every issue.'),
        limit: z.number().int().min(1).optional().describe('Show only the first N rows.'),
      },
      annotations: { title: 'MEGA: sync issues', ...RO },
    },
    async ({ detail, limit }) =>
      guardRun(async () => {
        const args: string[] = [];
        if (detail !== undefined) args.push('--detail', detail.toLowerCase() === 'all' ? '--all' : assertNoFlag(detail, 'detail'));
        if (limit !== undefined) args.push(`--limit=${limit}`);
        return runToResult(rt, 'sync-issues', args, (r) => {
          const { text, total, truncated } = capLines(r.stdout, rt.config.maxListLines);
          return ok(text || '(no sync issues)', { issueCount: total, truncated });
        });
      }),
  );

  // mega_sync_config — show global sync configuration (delayed-upload tuning).
  server.registerTool(
    'mega_sync_config',
    {
      title: 'MEGA: sync config',
      description: 'Show the global sync configuration (delayed-upload wait/attempts). Read-only.',
      inputSchema: {},
      annotations: { title: 'MEGA: sync config', ...RO },
    },
    async () =>
      guardRun(async () =>
        runToResult(rt, 'sync-config', [], (r) => ok(r.stdout.trim().slice(0, 2000) || '(no output)', {})),
      ),
  );

  // mega_sync_ignore — view/modify ignore filters for a sync (or DEFAULT for new
  // syncs). "show" is read-only; add/remove change what gets synced (confirm).
  server.registerTool(
    'mega_sync_ignore',
    {
      title: 'MEGA: sync ignore filters',
      description:
        'View or modify the ignore filters of a sync (use target="DEFAULT" for the defaults applied to new syncs). action="show" is read-only; add/remove change what is synced and require confirmation.',
      inputSchema: {
        action: z.enum(['show', 'add', 'add-exclusion', 'remove', 'remove-exclusion']).describe('Operation on the filters.'),
        target: z.string().describe('Sync ID, local path, or "DEFAULT".'),
        filters: z.array(z.string()).optional().describe('Filter patterns (required for add/remove actions).'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: sync ignore filters', destructiveHint: false, openWorldHint: true },
    },
    async ({ action, target, filters, confirm }) =>
      guardRun(async () => {
        const tgt = assertNoFlag(target, 'target');
        if (action === 'show') {
          return runToResult(rt, 'sync-ignore', ['--show', tgt], (r) => {
            const { text, total, truncated } = capLines(r.stdout, rt.config.maxListLines);
            return ok(text || '(no filters)', { target: tgt, filterCount: total, truncated });
          });
        }
        const fs = (filters ?? []).map((f) => assertNoFlag(f, 'filter'));
        if (fs.length === 0) throw new ValidationError('Provide at least one filter for add/remove.');
        const summary = `This will ${action} ${fs.length} filter(s) on sync ${tgt} (changes what gets synced).`;
        const gate = checkConfirm(rt, 'mega_sync_ignore', { action, target: tgt, filters: fs }, confirm, summary);
        if (gate) return gate;
        return runToResult(rt, 'sync-ignore', [`--${action}`, ...fs, tgt], () => ok(summary.replace(/^This will /, 'Done: '), { action, target: tgt }));
      }),
  );
}
