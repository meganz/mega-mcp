import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Runtime } from '../runtime.js';
import { ok, err } from '../mcpResult.js';
import { ExitCode, classifyExit } from '../errors.js';
import { assertNoWildcard, assertRemotePath, assertRemoteDest, assertLocalPath, assertNoFlag, assertFlagValue, assertNoStoreWithin, assertNotStoreCopy, syncExclusions, globCanMatchStoreName, ValidationError } from '../paths.js';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { capLines } from '../parsers/listing.js';
import { syncById, folderStillAt, downloadedIntoLines, assertNoPendingIgnoreUpload, sharedBelowNotes, childNames, assertNoWritersReach, rootIgnoreFile, assertNoNestedIgnoreFile, assertNoNestedLocalIgnoreFile, assertSyncedLanding, assertNoFoldTwinBelow, guardRun, runToResult, checkConfirm, listedLines, assertNoStoreCopyBelow, destinationNotes, executableDownloadNote, backupNamesOf } from './helpers.js';

const RO = { readOnlyHint: true, openWorldHint: true } as const;
const SYNC_CTRL: Record<string, string> = { pause: '-p', resume: '-e', delete: '-d' };

/**
 * Sync & backup. The model can only establish / list / pause / remove these
 * relationships — it cannot manipulate the files inside a synced folder (those
 * changes are driven by the user/OS). `sync -d` removes the config, NOT the
 * files. Setup is confirm-gated and validates paths exactly like put/get; the
 * persistent two-way nature is called out in the confirmation preview.
 */
/**
 * Append `rules` to <lp>/.megaignore as its final block (the last matching rule wins), ending
 * with `-sync:.megaignore` so the cloud cannot replace it. A new file starts from the defaults.
 */
async function addIgnoreRules(rt: Runtime, lp: string, rules: string[]): Promise<void> {
  const file = join(lp, '.megaignore');
  const block = [IGNORE_HEADER, ...rules, '-sync:.megaignore'].join('\n') + '\n';
  if (existsSync(file) || isSymlink(file)) {
    if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) {
      throw new ValidationError(`${file} is not a regular file; not writing exclusion rules through it. Nothing was synced.`);
    }
    const content = readFileSync(file, 'utf8');
    if (content.endsWith(block)) return;
    writeFileSync(file, `${content}${content === '' || content.endsWith('\n') ? '' : '\n'}${block}`);
    return;
  }
  const d = await rt.run('sync-ignore', ['--show', 'DEFAULT']);
  const shown = d.code === 0 ? d.stdout.trim() : '';
  // MEGAcmd writes .megaignore.default only on a sync's first start: else use the SDK's
  // built-in list (DefaultFilterChain), which keeps hidden folders such as ~/.ssh out.
  const defaults = shown ? `${shown}\n` : `${SDK_DEFAULT_EXCLUSIONS.map((n) => `-:${n}`).join('\n')}\n`;
  writeFileSync(file, `${defaults}${block}`, { flag: 'wx' });
}

/** The SDK's predefined name exclusions (syncfilter.cpp mPredefinedNameExclusions). */
const SDK_DEFAULT_EXCLUSIONS = ['Thumbs.db', 'desktop.ini', '~*', '.*', '*~.*', '*.crdownload', '*.sb-????????-??????', '*.tmp'];

/** An existing root .megaignore is used as it is (MEGA's default exclusions only seed a new one). */
function rootRulesLines(lp: string): string[] {
  const f = rootIgnoreFile(lp);
  return f ? [`${f} already exists: its own rules decide what else is synced (MEGA's default exclusions apply only if it lists them).`] : [];
}

const IGNORE_HEADER = "# Added by MEGA Cloud MCP: never sync MEGAcmd's session store or these app folders.";

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Does an exclusion rule keep .megaCmd out (like the default `-:.*`)? A regex counts as yes. */
function excludesStore(rule: string): boolean {
  const m = rule.match(/^-([adfs]?)([Nnp]?)([GgRr]?):(.*)$/);
  if (!m) return false;
  if (m[1] === 'f' || m[1] === 's') return false;
  if (m[3] === 'R' || m[3] === 'r') return true;
  return (m[4] as string).split('/').some((seg) => seg.toLowerCase() === '.megacmd' || (/[*?]/.test(seg) && globCanMatchStoreName(seg)));
}

/** mega_sync_ignore may not undo syncExclusions: no include rules (last match wins), no removals. */
function assertFiltersKeepExclusions(action: string, filters: readonly string[]): void {
  for (const f of filters) {
    const rule = action === 'add-exclusion' || action === 'remove-exclusion' ? `-${f.replace(/^-/, '')}` : f;
    if (action.startsWith('add') && rule.startsWith('+')) {
      throw new ValidationError(`Include filters ("${f}") are not added through this tool: one could re-include MEGAcmd's session store or a protected folder. Edit the .megaignore file yourself if you need it.`);
    }
    if (action.startsWith('remove') && (/megacmd/i.test(rule) || /^-ap[gr]:/i.test(rule) || /sync:\.megaignore/i.test(rule) || excludesStore(rule))) {
      throw new ValidationError(`"${f}" keeps MEGAcmd's session store, a protected folder or the sync's own rules out of the sync; it is not removed through this tool.`);
    }
  }
}

export function registerSync(server: McpServer, rt: Runtime): void {
  /**
   * Resuming syncs again everything changed on either side while paused: the same checks as
   * mega_sync_add, on the sync's CURRENT cloud folder (a paused sync does not follow a move).
   */
  const resumeSync = async (sid: string, confirm: string | undefined, done: () => CallToolResult): Promise<CallToolResult> => {
    const row = await syncById(rt, sid);
    if (row === undefined) throw new ValidationError(`Could not read MEGAcmd's list of syncs, so what resuming sync ${sid} would carry is unknown. Nothing was run.`);
    if (row === null) throw new ValidationError(`There is no sync ${sid}; mega_sync_list shows the ids.`);
    const lp = assertLocalPath(row.local);
    // A spelling assertLocalPath changes (a trailing space, say) would be checked as another folder.
    if (lp !== row.local) throw new ValidationError(`Sync ${sid}'s local folder "${row.local}" cannot be checked under that spelling; resume it yourself in MEGAcmd if intended.`);
    const rp = row.remote;
    if (!(await folderStillAt(rt, rp, row.handle))) {
      throw new ValidationError(`Sync ${sid}'s cloud folder is no longer at ${rp} (moved or renamed while paused), so what resuming it would carry cannot be checked. Delete this sync and add it again with mega_sync_add.`);
    }
    const exclusions = syncExclusions(lp, await rt.getBinDir());
    await assertNoStoreCopyBelow(rt, rp);
    await assertNoFoldTwinBelow(rt, rp, exclusions.filter((e) => e.rel !== '').map((e) => e.rel));
    await assertNoNestedIgnoreFile(rt, rp);
    await assertNoNestedLocalIgnoreFile(rt, lp);
    await assertNoWritersReach(rt, rp, lp);
    await assertNoPendingIgnoreUpload(rt, rp);
    const execNote = await executableDownloadNote(rt);
    const notes = [...(await destinationNotes(rt, rp)), ...(await sharedBelowNotes(rt, rp))];
    // Downloaded into earlier in this session: synced up to the cloud side too.
    const downloaded = downloadedIntoLines([lp]);
    const summary = [
      `This will resume sync ${sid}: a CONTINUOUS TWO-WAY sync between ${lp} and ${rp}. What changed on either side while it was paused (including deletions) propagates to the other, and so does every later change.`,
      ...(exclusions.length > 0 ? ['', `Never synced, in either direction (rules in ${join(lp, '.megaignore')}):`, ...exclusions.map((e) => `  ${e.label}`)] : []),
      ...rootRulesLines(lp),
      ...(execNote ? [execNote] : []),
      ...notes,
      ...downloaded,
    ];
    const gate = checkConfirm(rt, 'mega_sync_control', { action: 'resume', id: sid, localPath: lp, remotePath: rp, handle: row.handle, exclusions: exclusions.map((e) => e.rule), root: rootRulesLines(lp), exec: execNote, notes, downloaded }, confirm, summary);
    if (gate) return gate;
    await assertNoStoreCopyBelow(rt, rp);
    if (exclusions.length > 0) await addIgnoreRules(rt, lp, exclusions.map((e) => e.rule));
    return runToResult(rt, 'sync', [SYNC_CTRL.resume as string, sid], done);
  };

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
        // Two-way: the cloud side is downloaded too, so a store copy there would land on disk.
        const rp = assertNotStoreCopy(assertNoWildcard(assertRemoteDest(remotePath), 'remotePath'));
        // The store and protected folders in lp are excluded (both directions) by .megaignore rules.
        const exclusions = syncExclusions(lp, await rt.getBinDir());
        // A store copy below rp, or a fold twin of an excluded folder, would sync down to disk.
        await assertNoStoreCopyBelow(rt, rp);
        await assertNoFoldTwinBelow(rt, rp, exclusions.filter((e) => e.rel !== '').map((e) => e.rel));
        await assertNoNestedIgnoreFile(rt, rp);
        await assertNoNestedLocalIgnoreFile(rt, lp);
        await assertNoWritersReach(rt, rp, lp);
        await assertNoPendingIgnoreUpload(rt, rp);
        // Two-way: files from the cloud are written locally with MEGAcmd's permissions.
        const execNote = await executableDownloadNote(rt);
        const notes = [...(await destinationNotes(rt, rp)), ...(await sharedBelowNotes(rt, rp))];
        const downloaded = downloadedIntoLines([lp]);
        const summary = [
          `This will start a CONTINUOUS TWO-WAY sync between ${lp} and ${rp}. From now on, changes (including deletions) on either side propagate to the other.`,
          ...(exclusions.length > 0
            ? ['', `Never synced, in either direction (rules added to ${join(lp, '.megaignore')}):`, ...exclusions.map((e) => `  ${e.label}`)]
            : []),
          ...rootRulesLines(lp),
          ...(execNote ? [execNote] : []),
          ...notes,
          ...downloaded,
        ];
        const gate = checkConfirm(rt, 'mega_sync_add', { localPath: lp, remotePath: rp, exclusions: exclusions.map((e) => e.rule), root: rootRulesLines(lp), exec: execNote, notes, downloaded }, confirm, summary);
        if (gate) return gate;
        await assertNoStoreCopyBelow(rt, rp);
        // The rules must be in place BEFORE the sync starts: it uploads at once.
        if (exclusions.length > 0) await addIgnoreRules(rt, lp, exclusions.map((e) => e.rule));
        return runToResult(rt, 'sync', [lp, rp], () => ok(`Started sync ${lp} <-> ${rp}.`, { localPath: lp, remotePath: rp, excluded: exclusions.map((e) => e.label) }));
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
        const done = () => ok(`Done: ${action} sync ${sid}.`, { action, id: sid });
        if (action === 'resume') return resumeSync(sid, confirm, done);
        const summary =
          action === 'delete'
            ? `This will delete sync ${sid} (stops mirroring; does not delete files).`
            : `This will ${action} sync ${sid}.`;
        const gate = checkConfirm(rt, 'mega_sync_control', { action, id: sid }, confirm, summary);
        if (gate) return gate;
        return runToResult(rt, 'sync', [SYNC_CTRL[action] as string, sid], done);
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
        const rp = assertNoWildcard(assertRemoteDest(remotePath), 'remotePath');
        const per = assertFlagValue(period, 'period');
        const walkNote = assertNoStoreWithin(lp, 'back up', await rt.getBinDir());
        // Each run adds a copy of lp in rp, written to this computer too if rp is two-way synced.
        await assertSyncedLanding(rt, rp, 'unknown', { local: [lp] });
        // MEGA deletes the oldest "<name>_bk_<time>" folders in rp beyond the count - whoever made them.
        // MEGAcmd registers the backup under lp's real path (symlinks resolved), which names its copies.
        let real = lp;
        try {
          real = realpathSync.native(lp);
        } catch {
          // Missing: MEGAcmd refuses it.
        }
        const bases = [...new Set([...backupNamesOf(lp), ...backupNamesOf(real)])];
        const name = bases[0] ?? basename(lp);
        const here = await childNames(rt, rp);
        const older = here ? [...here].filter((n) => bases.some((b) => n.normalize('NFC').startsWith(b)) && n.includes('_bk_')) : [];
        const notes = [
          ...walkNote,
          ...(await destinationNotes(rt, rp)),
          ...(older.length > 0 ? [`${rp} already holds ${older.length} folder(s) that MEGA counts as backups of a folder named ${name}: beyond ${numBackups} copies the oldest are DELETED, whoever made them:`, ...listedLines(older)] : []),
        ];
        const downloaded = downloadedIntoLines([lp]);
        const summary = [`This will configure a periodic backup of ${lp} into ${rp} (period "${per}", keep ${numBackups}).`, ...notes, ...downloaded];
        const gate = checkConfirm(rt, 'mega_backup_add', { localPath: lp, remotePath: rp, period: per, numBackups, notes, downloaded }, confirm, summary);
        if (gate) return gate;
        const args = [lp, rp, `--period=${per}`, `--num-backups=${numBackups}`];
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
        'View or modify the ignore filters of a sync (use target="DEFAULT" for the defaults applied to new syncs). action="show" is read-only; the others change what is synced and require confirmation. Use add-exclusion / remove-exclusion with the filter WITHOUT its leading "-" (e.g. ":*.tmp", "d:node_modules"). Include filters ("+...") are not added through this tool, and the rules that keep MEGAcmd\'s session store and protected folders out (including MEGA\'s default ":.*") are not removed.',
      inputSchema: {
        action: z.enum(['show', 'add', 'add-exclusion', 'remove', 'remove-exclusion']).describe('Operation on the filters.'),
        target: z.string().describe('Sync ID, local path, or "DEFAULT".'),
        filters: z.array(z.string()).optional().describe('Filters in MEGA\'s <CLASS><TARGET><TYPE><STRATEGY>:<PATTERN> form (for the *-exclusion actions, without the leading "-").'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      // Destructive: removing an exclusion starts uploading what it kept out.
      annotations: { title: 'MEGA: sync ignore filters', destructiveHint: true, openWorldHint: true },
    },
    async ({ action, target, filters, confirm }) =>
      guardRun(async () => {
        const tgt = assertNoFlag(target, 'target');
        if (action === 'show') {
          return runToResult(rt, 'sync-ignore', ['--show', tgt], (r) => {
            // MEGAcmd prints every non-comment line of the rules file: only rule-shaped lines are shown
            // (a file copied in under that name is not read out through this tool).
            const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
            const rules = lines.filter((l) => /^[-+](?:[adfs]?[Nnp]?[GgRr]?|sync):.+$|^exclude-(?:larger|smaller):\s*\d+[kKmMgGtT]?\s*$/.test(l.trim()));
            const other = lines.length - rules.length;
            const { text, total, truncated } = capLines(rules.join('\n'), rt.config.maxListLines);
            return ok(`${text || '(no filters)'}${other ? `\n(${other} other line(s) that are not filter rules are not shown.)` : ''}`, { target: tgt, filterCount: total, truncated, hidden: other });
          });
        }
        const fs = (filters ?? []).map((f) => assertNoFlag(f, 'filter'));
        if (fs.length === 0) throw new ValidationError('Provide at least one filter for add/remove.');
        assertFiltersKeepExclusions(action, fs);
        // Which folders change, and who sees the cloud side.
        let where: string[] = ['(DEFAULT: the filters new syncs start with; existing syncs keep theirs.)'];
        // (MEGAcmd reads "default" in any case.)
        if (tgt.toLowerCase() !== 'default') {
          const row = await syncById(rt, tgt);
          if (row === undefined) throw new ValidationError(`Could not read MEGAcmd's list of syncs, so which folders sync ${tgt} covers is unknown. Nothing was run.`);
          if (row === null) throw new ValidationError(`There is no sync ${tgt}; mega_sync_list shows the ids.`);
          where = [
            `Sync ${tgt} is between ${row.local} and ${row.remote}.`,
            ...(action.startsWith('remove') ? [`What these rules kept out is synced from then on: uploaded to ${row.remote} and downloaded to ${row.local}.`] : []),
            ...(await destinationNotes(rt, row.remote)),
            // Newly included files go into every folder of the sync, shared or linked ones too.
            ...(action.startsWith('remove') ? await sharedBelowNotes(rt, row.remote) : []),
          ];
        }
        const summary = [`This will ${action} ${fs.length} filter(s) on sync ${tgt} (changes what gets synced):`, ...listedLines(fs), ...where];
        const gate = checkConfirm(rt, 'mega_sync_ignore', { action, target: tgt, filters: fs, where }, confirm, summary);
        if (gate) return gate;
        return runToResult(rt, 'sync-ignore', [`--${action}`, ...fs, tgt], () => ok(`Done: ${action} ${fs.length} filter(s) on sync ${tgt}.`, { action, target: tgt }));
      }),
  );
}
