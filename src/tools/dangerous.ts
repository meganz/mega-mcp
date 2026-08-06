import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from '../runtime.js';
import { ok, err } from '../mcpResult.js';
import { assertRemotePath, assertOptionalRemotePath, assertNoFlag, assertFlagValue, assertSecret, assertNoWildcard, ValidationError } from '../paths.js';
import { parseExportLink } from '../parsers/exportLink.js';
import { guardRun, runToResult, checkConfirm, pcreGate, runPerHandle } from './helpers.js';

const SHARE_LEVEL: Record<string, string> = { read: '0', readwrite: '1', full: '2', owner: '3' };

export function registerDangerous(server: McpServer, rt: Runtime): void {
  // mega_logout — end the current MEGA session (server-side invalidation).
  // Safe to expose: logout needs no credentials. Confirm-gated to avoid an
  // accidental/spontaneous logout. Re-login is out-of-band afterward.
  server.registerTool(
    'mega_logout',
    {
      title: 'MEGA: log out',
      description:
        'Log out of the current MEGA session on this machine (invalidates it server-side). Requires confirmation. Log back in out-of-band afterward.',
      inputSchema: { confirm: z.string().optional().describe('Confirmation token from the first call.') },
      annotations: { title: 'MEGA: log out', destructiveHint: false, openWorldHint: true },
    },
    async ({ confirm }) =>
      guardRun(async () => {
        const gate = checkConfirm(rt, 'mega_logout', {}, confirm, 'This will log out the current MEGA session on this machine (you can log in again afterward).');
        if (gate) return gate;
        return runToResult(rt, 'logout', [], () => ok('Logged out of MEGA.', { loggedOut: true }));
      }),
  );

  // mega_killsession — close other login sessions. Security-positive hygiene
  // (e.g. after a suspicious login). Defaults to closing ALL other sessions
  // (`-a`), which needs no session id and therefore no exposure of the (PII-
  // bearing) session list. An explicit sessionId obtained out-of-band may be
  // passed through. Confirm-gated; the current session is never closed.
  server.registerTool(
    'mega_killsession',
    {
      title: 'MEGA: close other sessions',
      description:
        'Close other MEGA login sessions on this account (the current session is kept). By default closes ALL other sessions; optionally pass a specific sessionId. Requires confirmation.',
      inputSchema: {
        sessionId: z.string().optional().describe('A specific session id to close (obtained out-of-band). Omit to close all other sessions.'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: close other sessions', destructiveHint: true, openWorldHint: true },
    },
    async ({ sessionId, confirm }) =>
      guardRun(async () => {
        const sid = sessionId?.trim();
        if (sid !== undefined && (sid === '' || /\s/.test(sid))) {
          throw new ValidationError('sessionId must be a single non-empty token.');
        }
        // We own every flag we pass; a sessionId must never be parseable as one.
        if (sid !== undefined && sid.startsWith('-')) {
          throw new ValidationError('sessionId must not start with "-".');
        }
        const summary = sid
          ? `This will close MEGA session ${sid} (the current session is kept).`
          : 'This will close ALL other MEGA login sessions on this account (the current session is kept).';
        const gate = checkConfirm(rt, 'mega_killsession', { sessionId: sid ?? null }, confirm, summary);
        if (gate) return gate;
        const args = sid ? [sid] : ['-a'];
        return runToResult(rt, 'killsession', args, () =>
          ok(sid ? `Closed session ${sid}.` : 'Closed all other sessions.', { sessionId: sid ?? null, all: !sid }),
        );
      }),
  );

  // mega_rm — permanently delete a node (recursive). Confirm-gated.
  server.registerTool(
    'mega_rm',
    {
      title: 'MEGA: delete',
      description: 'Permanently delete a MEGA cloud node (recursive). Requires confirmation.',
      inputSchema: {
        remotePath: z.string().describe('Absolute MEGA path to delete (a PCRE pattern when usePcre=true).'),
        usePcre: z.boolean().default(false).describe('Interpret remotePath as a PCRE pattern and delete EVERY match.'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: delete', destructiveHint: true, openWorldHint: true },
    },
    async ({ remotePath, usePcre, confirm }) =>
      guardRun(async () => {
        if (usePcre) {
          const rp = assertNoFlag(remotePath, 'remotePath');
          const g = await pcreGate(
            rt,
            'mega_rm',
            { remotePath: rp, usePcre: true },
            confirm,
            rp,
            (n, t) => `This will PERMANENTLY delete ${n} node(s) matching the pattern, AND ALL THEIR CONTENTS (recursive):\n${t}`,
          );
          if (!g.proceed) return g.result;
          if (g.handles.length === 0) return ok('No matching nodes to delete.', { deleted: 0 });
          const { done, failed } = await runPerHandle(rt, 'rm', g.handles, (h) => ['-r', '-f', h]);
          return ok(`Deleted ${done} node(s)${failed ? `; ${failed} failed` : ''}.`, { deleted: done, failed });
        }
        // No native wildcard here: MEGAcmd would expand it AFTER approval, so the
        // one-line preview could not name what is actually being deleted.
        const rp = assertNoWildcard(assertRemotePath(remotePath), 'remotePath');
        const gate = checkConfirm(rt, 'mega_rm', { remotePath: rp }, confirm, `This will PERMANENTLY delete ${rp} and all its contents.`);
        if (gate) return gate;
        return runToResult(rt, 'rm', ['-r', '-f', rp], () => ok(`Deleted ${rp}.`, { remotePath: rp, deleted: true }));
      }),
  );

  // mega_deleteversions — delete file version history. Destructive. Confirm-gated.
  server.registerTool(
    'mega_deleteversions',
    {
      title: 'MEGA: delete versions',
      description:
        'Delete prior file-version history, for a single path or (with all=true) the entire account. Requires confirmation.',
      inputSchema: {
        remotePath: z.string().optional().describe('Absolute MEGA path whose versions to delete.'),
        all: z.boolean().default(false).describe('Delete version history for the whole account.'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: delete versions', destructiveHint: true, openWorldHint: true },
    },
    async ({ remotePath, all, confirm }) =>
      guardRun(async () => {
        const rp = assertOptionalRemotePath(remotePath);
        if (rp) assertNoWildcard(rp, 'remotePath');
        if (!all && !rp) throw new ValidationError('Provide a remotePath, or set all=true to clear the whole account.');
        const summary = all
          ? 'This will delete ALL prior file versions across the entire account.'
          : `This will delete prior file versions of ${rp as string}.`;
        const gate = checkConfirm(rt, 'mega_deleteversions', { remotePath: rp ?? null, all }, confirm, summary);
        if (gate) return gate;
        const args = all ? ['-f', '--all'] : ['-f', rp as string];
        return runToResult(rt, 'deleteversions', args, () => ok(summary.replace(/^This will /, 'Done: '), { all, remotePath: rp }));
      }),
  );

  // mega_export — create / remove / inspect a public link. Create+delete are
  // exfiltration-sensitive and confirm-gated; status is read-only. Create
  // supports writable links, MEGA-hosted (S4), password protection, and expiry.
  server.registerTool(
    'mega_export',
    {
      title: 'MEGA: public link',
      description:
        'Manage a public link for a MEGA node. action="create" makes a public link (confirm), "delete" removes it (confirm), "status" shows current state (read-only). Create options: writable (anyone with the link can upload), megaHosted (S4), password, expire.',
      inputSchema: {
        remotePath: z.string().describe('Absolute MEGA path.'),
        action: z.enum(['create', 'delete', 'status']).describe('What to do with the public link.'),
        writable: z.boolean().default(false).describe('Create a WRITABLE folder link — anyone with the link can upload into the folder.'),
        megaHosted: z.boolean().default(false).describe('Share the folder share-key with MEGA (for S4 access).'),
        password: z.string().optional().describe('Password-protect the link.'),
        expire: z.string().optional().describe('Expiry delay, e.g. "1d", "2w", "1m".'),
        usePcre: z.boolean().default(false).describe('Interpret remotePath as a PCRE pattern (affects every match).'),
        confirm: z.string().optional().describe('Confirmation token (create/delete only).'),
      },
      annotations: { title: 'MEGA: public link', destructiveHint: true, openWorldHint: true },
    },
    async ({ remotePath, action, writable, megaHosted, password, expire, usePcre, confirm }) =>
      guardRun(async () => {
        if (action === 'status') {
          const rp = usePcre ? assertNoFlag(remotePath, 'remotePath') : assertRemotePath(remotePath);
          return runToResult(rt, 'export', [...(usePcre ? ['--use-pcre'] : []), rp], (r) => {
            const link = parseExportLink(r.stdout);
            return ok(link ? `Public link for ${rp}:\n${link}` : `No public link for ${rp}.`, { remotePath: rp, link });
          });
        }
        if (action === 'create') {
          if (password !== undefined) assertSecret(password, 'password');
          const exp = expire === undefined ? undefined : assertFlagValue(expire, 'expire');
          const note = writable ? ' These are WRITABLE links — anyone with the URL can UPLOAD into the folder.' : '';
          const createArgs = (node: string) => [
            '-a',
            '-f',
            ...(writable ? ['--writable'] : []),
            ...(megaHosted ? ['--mega-hosted'] : []),
            ...(password ? [`--password=${password}`] : []),
            ...(exp ? [`--expire=${exp}`] : []),
            node,
          ];
          if (usePcre) {
            const rp = assertNoFlag(remotePath, 'remotePath');
            const g = await pcreGate(
              rt,
              'mega_export:create',
              { remotePath: rp, writable, megaHosted, hasPassword: password !== undefined && password !== '', expire: expire ?? null, usePcre: true },
              confirm,
              rp,
              (n, t) => `This will create PUBLIC links for ${n} node(s) that anyone with the URL can access.${note}\n${t}`,
            );
            if (!g.proceed) return g.result;
            if (g.handles.length === 0) return ok('No matching nodes.', { created: 0 });
            const { done, failed } = await runPerHandle(rt, 'export', g.handles, createArgs);
            return ok(`Created ${done} public link(s)${failed ? `; ${failed} failed` : ''}.`, { created: done, failed });
          }
          // A wildcard here would publish a link per matched node while the preview
          // named one — the exfiltration equivalent of the mega_rm case.
          const rp = assertNoWildcard(assertRemotePath(remotePath), 'remotePath');
          const gate = checkConfirm(
            rt,
            'mega_export:create',
            { remotePath: rp, writable, megaHosted, hasPassword: password !== undefined && password !== '', expire: expire ?? null },
            confirm,
            `This will create a PUBLIC link for ${rp} that anyone with the URL can access.${writable ? ' This is a WRITABLE link — anyone with the URL can UPLOAD into the folder.' : ''}`,
          );
          if (gate) return gate;
          return runToResult(rt, 'export', createArgs(rp), (r) => {
            const link = parseExportLink(r.stdout);
            return ok(link ? `Public link created for ${rp}:\n${link}` : `Public link created for ${rp}.`, { remotePath: rp, link, writable });
          });
        }
        // delete
        if (usePcre) {
          const rp = assertNoFlag(remotePath, 'remotePath');
          const g = await pcreGate(rt, 'mega_export:delete', { remotePath: rp, usePcre: true }, confirm, rp, (n, t) => `This will remove the public link from ${n} node(s):\n${t}`);
          if (!g.proceed) return g.result;
          if (g.handles.length === 0) return ok('No matching nodes.', { removed: 0 });
          const { done, failed } = await runPerHandle(rt, 'export', g.handles, (h) => ['-d', h]);
          return ok(`Removed ${done} public link(s)${failed ? `; ${failed} failed` : ''}.`, { removed: done, failed });
        }
        const rp = assertRemotePath(remotePath);
        const gate = checkConfirm(rt, 'mega_export:delete', { remotePath: rp }, confirm, `This will remove the public link for ${rp}.`);
        if (gate) return gate;
        return runToResult(rt, 'export', ['-d', rp], () => ok(`Public link removed for ${rp}.`, { remotePath: rp }));
      }),
  );

  // mega_share — grant / revoke / list user shares. Add+remove are
  // exfiltration-sensitive and confirm-gated; list is read-only.
  server.registerTool(
    'mega_share',
    {
      title: 'MEGA: share',
      description:
        'Manage user shares of a MEGA folder. action="add" grants access to a user (confirm), "remove" revokes it (confirm), "list" shows current shares (read-only, set pending=true to include pending shares). Level "owner" grants full owner access.',
      inputSchema: {
        remotePath: z.string().optional().describe('Absolute MEGA folder path (required for add/remove).'),
        action: z.enum(['add', 'remove', 'list']).describe('Share operation.'),
        withEmail: z.string().email().optional().describe('User email (required for add/remove).'),
        level: z.enum(['read', 'readwrite', 'full', 'owner']).optional().describe('Access level for add (default read). "owner" gives full owner access.'),
        pending: z.boolean().default(false).describe('When listing, also show pending shares.'),
        usePcre: z.boolean().default(false).describe('Interpret remotePath as a PCRE pattern (affects every match).'),
        confirm: z.string().optional().describe('Confirmation token (add/remove only).'),
      },
      annotations: { title: 'MEGA: share', destructiveHint: true, openWorldHint: true },
    },
    async ({ remotePath, action, withEmail, level, pending, usePcre, confirm }) =>
      guardRun(async () => {
        if (action === 'list') {
          const rp = usePcre && remotePath ? assertNoFlag(remotePath, 'remotePath') : assertOptionalRemotePath(remotePath);
          // The share listing contains the EMAIL ADDRESSES of share recipients
          // (third-party PII). Gate it like the contact tools: free when the user
          // has opted in via exposeContacts, otherwise confirm-gated so the user
          // approves revealing those emails.
          if (!rt.config.exposeContacts) {
            const gate = checkConfirm(
              rt,
              'mega_share:list',
              { remotePath: rp ?? null, pending: !!pending },
              confirm,
              'This will reveal the EMAIL ADDRESSES of the users this folder is shared with (third-party contact info). Turn on the "Expose contact tools" setting to allow this without confirming each time.',
            );
            if (gate) return gate;
          }
          const args = [...(pending ? ['-p'] : []), ...(usePcre && rp ? ['--use-pcre'] : []), ...(rp ? [rp] : [])];
          return runToResult(rt, 'share', args, (r) => ok(r.stdout.trim().slice(0, 4000) || '(no shares)', { remotePath: rp ?? null, pending }));
        }
        if (!withEmail) throw new ValidationError('withEmail is required for add/remove.');
        if (action === 'add') {
          const lvl = SHARE_LEVEL[level ?? 'read'] as string;
          const addArgs = (node: string) => ['-a', `--with=${withEmail}`, `--level=${lvl}`, node];
          if (usePcre) {
            const rp = assertNoFlag(remotePath ?? '', 'remotePath');
            const g = await pcreGate(
              rt,
              'mega_share:add',
              { remotePath: rp, withEmail, level: level ?? 'read', usePcre: true },
              confirm,
              rp,
              (n, t) => `This will share ${n} node(s) with ${withEmail} (${level ?? 'read'} access):\n${t}`,
            );
            if (!g.proceed) return g.result;
            if (g.handles.length === 0) return ok('No matching nodes.', { shared: 0 });
            const { done, failed } = await runPerHandle(rt, 'share', g.handles, addArgs);
            return ok(`Shared ${done} node(s) with ${withEmail}${failed ? `; ${failed} failed` : ''}.`, { withEmail, shared: done, failed });
          }
          const rp = assertNoWildcard(assertRemotePath(remotePath ?? '', 'remotePath'), 'remotePath');
          const gate = checkConfirm(rt, 'mega_share:add', { remotePath: rp, withEmail, level: level ?? 'read' }, confirm, `This will share ${rp} with ${withEmail} (${level ?? 'read'} access).`);
          if (gate) return gate;
          return runToResult(rt, 'share', addArgs(rp), () => ok(`Shared ${rp} with ${withEmail} (${level ?? 'read'}).`, { remotePath: rp, withEmail, level: level ?? 'read' }));
        }
        // remove
        const rmArgs = (node: string) => ['-d', `--with=${withEmail}`, node];
        if (usePcre) {
          const rp = assertNoFlag(remotePath ?? '', 'remotePath');
          const g = await pcreGate(rt, 'mega_share:remove', { remotePath: rp, withEmail, usePcre: true }, confirm, rp, (n, t) => `This will revoke ${withEmail}'s access to ${n} node(s):\n${t}`);
          if (!g.proceed) return g.result;
          if (g.handles.length === 0) return ok('No matching nodes.', { revoked: 0 });
          const { done, failed } = await runPerHandle(rt, 'share', g.handles, rmArgs);
          return ok(`Revoked ${withEmail}'s access to ${done} node(s)${failed ? `; ${failed} failed` : ''}.`, { withEmail, revoked: done, failed });
        }
        const rp = assertRemotePath(remotePath ?? '', 'remotePath');
        const gate = checkConfirm(rt, 'mega_share:remove', { remotePath: rp, withEmail }, confirm, `This will revoke ${withEmail}'s access to ${rp}.`);
        if (gate) return gate;
        return runToResult(rt, 'share', rmArgs(rp), () => ok(`Revoked ${withEmail}'s access to ${rp}.`, { remotePath: rp, withEmail }));
      }),
  );
}
