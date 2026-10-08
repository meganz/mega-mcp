import { z } from 'zod';
import { posix } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from '../runtime.js';
import { ok, err } from '../mcpResult.js';
import { joinRemote, assertNoVersionName, assertRemotePath, assertOptionalRemotePath, assertNoFlag, assertFlagValue, assertSecret, assertNoWildcard, assertNotStoreCopy, ValidationError } from '../paths.js';
import { parseExportLink, parseCreatedLink } from '../parsers/exportLink.js';
import { classifyExit, ExitCode } from '../errors.js';
import { remoteKind, contentDigest, syncedWithinLines, ownExportLink, guardRun, runToResult, checkConfirm, previewSafe, pcreGate, pcreMatchPreview, runPerHandle, secretBinding, assertNoStoreCopyBelow, sameNamed, unconfirmedWriteLines, recoveryKeyLines, recoveryKeyLinesBelow, syncedSourceNotes, writableShareLines } from './helpers.js';

const SHARE_LEVEL: Record<string, string> = { read: '0', readwrite: '1', full: '2', owner: '3' };

/** An 8-byte handle in base64url that is not the all-ones INVALID_HANDLE. */
function isSessionHandle(id: string): boolean {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return false;
  const bytes = Buffer.from(id, 'base64url');
  // Canonical only: the last character's 2 spare bits are ignored, so two spellings name one session.
  return bytes.length === 8 && !bytes.every((b) => b === 0xff) && bytes.toString('base64url') === id;
}

/** This computer's own session handle (`whoami -l`, "* Current Session"), or null. */
async function currentSessionId(rt: Runtime): Promise<string | null> {
  const r = await rt.run('whoami', ['-l']);
  if (r.code !== 0) return null;
  const lines = r.stdout.split(/\r?\n/);
  const ids = new Set<string>();
  lines.forEach((line, i) => {
    if (!/^\s*\* Current Session\s*$/.test(line)) return;
    const m = (lines[i + 1] ?? '').match(/^\s*Session ID:\s*([A-Za-z0-9_-]{11})\s*$/);
    ids.add(m ? (m[1] as string) : '');
  });
  return ids.size === 1 && !ids.has('') ? ([...ids][0] as string) : null;
}

/** A public link without its key: the key opens the node even when the link has a password. */
function withoutKey(link: string): string {
  const modern = link.match(/^(.*\/(?:file|folder)\/[^#/]+)#/);
  if (modern) return modern[1] as string;
  const legacy = link.match(/^(.*#F?![^!]+)!/);
  if (legacy) return legacy[1] as string;
  return link.replace(/#.*$/, '');
}

/** A MEGA password-protected link carries the `#P!` marker. */
function isPasswordProtected(link: string | undefined): boolean {
  return !!link && link.includes('#P!');
}

/**
 * An expiry delay in words, read as MEGAcmd reads it (getTimeStampAfter): numbers each followed
 * by y, m (MONTHS), d, h, M (minutes) or s; a unit given twice keeps its last number.
 */
export function describeExpiry(expire: string): string {
  if (!/^(?:\d{1,6}[ymdhMs])+$/.test(expire)) {
    throw new ValidationError('expire must be numbers each followed by a unit: y (years), m (months), d (days), h (hours), M (minutes) or s (seconds), e.g. "7d" or "1m2d".');
  }
  const units: [string, string][] = [['y', 'year'], ['m', 'month'], ['d', 'day'], ['h', 'hour'], ['M', 'minute'], ['s', 'second']];
  const value = new Map<string, number>();
  for (const [, n, u] of expire.matchAll(/(\d+)([ymdhMs])/g)) value.set(u as string, Number(n));
  return units
    .filter(([u]) => value.has(u))
    .map(([u, word]) => `${value.get(u)} ${word}${value.get(u) === 1 ? '' : 's'}`)
    .join(' ');
}

/** The link options that change what is published - each one is approved, so each one is shown. */
function exportOptionLines(megaHosted: boolean, password: string | undefined, expire: string | undefined): string[] {
  return [
    ...(megaHosted ? ['The folder key will also be shared with MEGA (MEGA-hosted / S4).'] : []),
    ...(password ? ['The link will be password-protected.'] : []),
    ...(expire ? [`The link will expire after ${describeExpiry(expire)} ("${expire}").`] : []),
  ];
}

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
      // Destructive: ends this login on the server; the user has to log in again.
      annotations: { title: 'MEGA: log out', destructiveHint: true, openWorldHint: true },
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
  // (`-a`); a sessionId from mega_sessions closes just that one. Confirm-gated;
  // the current session is never closed.
  server.registerTool(
    'mega_killsession',
    {
      title: 'MEGA: close other sessions',
      description:
        'Close other MEGA login sessions on this account (the current session is kept). By default closes ALL other sessions; optionally pass a specific sessionId (not this computer\'s own session - mega_logout does that). Requires confirmation.',
      inputSchema: {
        sessionId: z.string().optional().describe('A specific session ID to close (from mega_sessions when account details are enabled, or from the user). Omit to close all other sessions.'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: close other sessions', destructiveHint: true, openWorldHint: true },
    },
    async ({ sessionId, confirm }) =>
      guardRun(async () => {
        const sid = sessionId === undefined ? undefined : assertNoFlag(sessionId, 'sessionId');
        if (sid !== undefined && /\s/.test(sid)) {
          throw new ValidationError('sessionId must be a single non-empty token.');
        }
        // Only a real session handle: 8 bytes, base64url, 11 characters. MEGAcmd
        // reads the word "all" - and any id that decodes to the invalid handle
        // (all bits set, e.g. "___________") - as EVERY other session; that request
        // is the no-sessionId form, whose preview says so.
        if (sid !== undefined && !isSessionHandle(sid)) {
          throw new ValidationError('sessionId must be a session handle (11 characters, as listed by MEGA). To close all other sessions, omit sessionId.');
        }
        // Closing this computer's own session logs MEGAcmd out here: mega_logout's job.
        const current = sid ? await currentSessionId(rt) : null;
        if (sid && current === sid) {
          throw new ValidationError(`Session ${sid} is this computer's own session; closing it would log MEGAcmd out here. Use mega_logout for that.`);
        }
        const summary = sid
          ? current
            ? `This will close MEGA session ${sid} (not this computer's own session, which is kept).`
            : `This will close MEGA session ${sid}. (Could not check whether it is this computer's own session - if it is, MEGAcmd is logged out here and its syncs stop.)`
          : 'This will close ALL other MEGA login sessions on this account (the current session is kept).';
        const gate = checkConfirm(rt, 'mega_killsession', { sessionId: sid ?? null, current }, confirm, summary);
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
        usePcre: z.boolean().default(false).describe('Interpret remotePath as a PCRE pattern and delete EVERY match. It starts with "/" and each part of the path is matched on its own, e.g. /Docs/.*\\.pdf$.'),
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
            undefined,
            // A match in a two-way synced folder is deleted on this computer too.
            { extraLines: (tops) => syncedSourceNotes(rt, tops, 'removed'), bindContents: true },
          );
          if (!g.proceed) return g.result;
          if (g.handles.length === 0) return ok('No matching nodes to delete.', { deleted: 0 });
          const { done, failed } = await runPerHandle(rt, 'rm', g.handles, (h) => ['-r', '-f', h]);
          return ok(`Deleted ${done} node(s)${failed ? `; ${failed} failed` : ''}.`, { deleted: done, failed });
        }
        // No native wildcard here: MEGAcmd would expand it AFTER approval, so the
        // one-line preview could not name what is actually being deleted.
        const rp = assertNoWildcard(assertRemotePath(remotePath), 'remotePath');
        // `name#<10 digits>` names a version: only an older one is accepted (the current one's
        // would remove the whole file), and an older version is not on this computer.
        if (posix.dirname(rp).split('/').some((seg) => /#\d{10}$/.test(seg))) {
          throw new ValidationError('remotePath may name a file version only in its last part.');
        }
        const ver = posix.basename(rp).match(/^(.+)#(\d{10})$/);
        if (ver) {
          const file = joinRemote(posix.dirname(rp), ver[1] as string);
          // MEGAcmd resolves name#<time> as the FIRST version with that time, current one first
          // (a restored file keeps its time): delete by handle, only a unique older version.
          if ((await sameNamed(rt, file)).count !== 1 || (await remoteKind(rt, file)) !== 'file') {
            throw new ValidationError(`Deleting one version needs exactly one FILE named ${file}.`);
          }
          const ls = await rt.run('ls', ['-l', '--versions', '--show-handles', file]);
          if (ls.code !== 0) throw new ValidationError(`Could not list the versions of ${file}: ${classifyExit(ls)}`);
          const lines = ls.stdout.split(/\r?\n/);
          const from = lines.findIndex((l) => l.startsWith('Versions of '));
          // "Versions of <path>:" then one line per version, the current one first.
          const own = from < 0 ? [] : lines.slice(from + 1);
          const end = own.findIndex((l) => l.trim() === '' || l.startsWith('Versions of '));
          const versions = (end < 0 ? own : own.slice(0, end))
            .map((l) => l.match(/\s(H:[A-Za-z0-9_-]+)\s.*#(\d{10})\s*$/))
            .filter((m): m is RegExpMatchArray => m !== null)
            .map((m) => ({ handle: m[1] as string, time: m[2] as string }));
          const hits = versions.map((v, i) => ({ ...v, current: i === 0 })).filter((v) => v.time === ver[2]);
          if (hits.length !== 1 || (hits[0] as { current: boolean }).current) {
            throw new ValidationError(
              hits.some((h) => h.current)
                ? `${rp} has the time of the CURRENT ${file} (a restored version keeps its time), so it cannot be deleted on its own here. Use the MEGA app, or delete the file with its plain path.`
                : `${rp} is not one older version of ${file}.`,
            );
          }
          const handle = (hits[0] as { handle: string }).handle;
          const vgate = checkConfirm(rt, 'mega_rm', { remotePath: rp, olderVersion: handle }, confirm, [
            `This will PERMANENTLY delete one older version of ${file} (${rp}); the current file and its other versions stay.`,
          ]);
          if (vgate) return vgate;
          return runToResult(rt, 'rm', ['-f', handle], () => ok(`Deleted the older version ${rp}.`, { remotePath: rp, deleted: true }));
        }
        const same = await sameNamed(rt, rp);
        const local = await syncedSourceNotes(rt, [rp], 'removed');
        // What is deleted with it is bound too: anything moved in after the preview voids it.
        const contents = await contentDigest(rt, rp);
        const gate = checkConfirm(rt, 'mega_rm', { remotePath: rp, items: same.count, local, contents }, confirm, [`This will PERMANENTLY delete ${rp} and all its contents.`, ...same.lines, ...local]);
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
        if (rp) assertNoVersionName(assertNoWildcard(rp, 'remotePath'));
        if (!all && !rp) throw new ValidationError('Provide a remotePath, or set all=true to clear the whole account.');
        const summary = all
          ? 'This will delete ALL prior file versions across the entire account.'
          : `This will delete prior file versions of ${rp as string} (of every file inside it, if it is a folder).`;
        const same = rp && !all ? await sameNamed(rt, rp) : { count: 0, lines: [] };
        // MEGAcmd recurses into a folder: anything moved in after the preview voids it.
        const contents = rp && !all ? await contentDigest(rt, rp) : null;
        const gate = checkConfirm(rt, 'mega_deleteversions', { remotePath: rp ?? null, all, items: same.count, contents }, confirm, [summary, ...same.lines]);
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
        action: z.enum(['create', 'delete', 'status']).describe('What to do with the public link. "status" says whether there is one, without its key; "create" (asks first) returns the full link, also an existing one.'),
        writable: z.boolean().default(false).describe('Create a WRITABLE folder link — anyone with the link can upload into the folder.'),
        megaHosted: z.boolean().default(false).describe('Share the folder share-key with MEGA (for S4 access).'),
        password: z.string().optional().describe('Password-protect the link.'),
        expire: z.string().optional().describe('Expiry delay: numbers each followed by a unit - y (years), m (MONTHS), d (days), h (hours), M (minutes), s (seconds). E.g. "7d", "1m" (one month), "30M" (30 minutes).'),
        usePcre: z.boolean().default(false).describe('Interpret remotePath as a PCRE pattern (affects every match). It starts with "/" and each part of the path is matched on its own, e.g. /Docs/.*\\.pdf$.'),
        confirm: z.string().optional().describe('Confirmation token (create/delete only).'),
      },
      annotations: { title: 'MEGA: public link', destructiveHint: true, openWorldHint: true },
    },
    async ({ remotePath, action, writable, megaHosted, password, expire, usePcre, confirm }) =>
      guardRun(async () => {
        if (action === 'status') {
          const rp = usePcre ? assertNoFlag(remotePath, 'remotePath') : assertRemotePath(remotePath);
          const r = await rt.run('export', [...(usePcre ? ['--use-pcre'] : []), rp]);
          if (r.code !== 0) return err(classifyExit(r), { ok: false, code: r.code });
          // A folder's listing also holds the links of what is inside it.
          const link = usePcre ? (parseExportLink(r.stdout)?.replace(/\)+$/, '') ?? null) : ownExportLink(r.stdout, rp);
          if (!link) return ok(`No public link for ${rp}.`, { remotePath: rp, link: null });
          // A link publishing a session-store copy is not handed out: the URL is the copy.
          try {
            if (usePcre) {
              const m = await pcreMatchPreview(rt, rp);
              if (!m.ok) return err(m.error, { remotePath: rp });
              for (const p of m.paths) assertNotStoreCopy(p, 'A matched node');
            } else {
              assertNotStoreCopy(rp);
              await assertNoStoreCopyBelow(rt, rp);
            }
          } catch (e) {
            if (!(e instanceof ValidationError)) throw e;
            return err(
              `${rp} has a public link, but it is (or holds) a copy of the MEGAcmd session store, which carries this account's login, so the link is not shown. Remove it with action "delete". (${e.message})`,
              { remotePath: rp, link: null, withheld: true },
            );
          }
          const shown = withoutKey(link);
          return ok(
            `${rp} has a public link: ${shown}#... (its key is not shown here - with it, the link opens even where a password was set on it elsewhere). To get the full link, use action "create", which asks the user first and returns the existing link.`,
            { remotePath: rp, link: shown, keyHidden: true },
          );
        }
        if (action === 'create') {
          if (password !== undefined) assertSecret(password, 'password');
          const exp = expire === undefined ? undefined : assertFlagValue(expire, 'expire');
          if (exp !== undefined) describeExpiry(exp);
          const note = writable ? ' These are WRITABLE links — anyone with the URL can UPLOAD into the folder.' : '';
          // MEGAcmd publishes the node FIRST and only then tries to add the password;
          // on an account that cannot, it logs a warning and still succeeds with a
          // plain link. A link the preview called password-protected that is not is
          // withdrawn again, rather than left public.
          const publish = async (node: string, path: string): Promise<'ok' | 'unprotected' | 'still-public' | 'failed'> => {
            const r = await rt.run('export', createArgs(node));
            // Linked before this call: MEGAcmd changes nothing (EXISTS), and that link is not this call's to withdraw.
            if (r.code === ExitCode.EXISTS) return 'failed';
            const withdraw = async () => {
              const c = (await rt.run('export', ['-d', node])).code;
              return c === 0 ? 'unprotected' : c === ExitCode.INVALIDSTATE ? 'failed' : 'still-public';
            };
            // A failure AFTER publishing (an expiry or password MEGA could not add) leaves a link the preview
            // did not describe: withdrawn ("not exported" means nothing was published).
            if (r.code !== 0) return password || exp ? withdraw() : 'failed';
            // (Read after the matched node's own path: a name cannot place a link of its own there.)
            if (password && !isPasswordProtected(parseCreatedLink(r.stdout, path))) return withdraw();
            return 'ok';
          };
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
            const listedAll: string[] = [];
            const g = await pcreGate(
              rt,
              'mega_export:create',
              { remotePath: rp, writable, megaHosted, password: secretBinding(password), expire: expire ?? null, usePcre: true },
              confirm,
              rp,
              (n, t) => [`This will create PUBLIC links for ${n} node(s) that anyone with the URL can access.${note}`, ...exportOptionLines(megaHosted, password, exp).map(previewSafe), t].join('\n'),
              (p) => {
                assertNotStoreCopy(p, 'A matched node');
                listedAll.push(p);
              },
              {
                extraLines: async (tops) => [
                  ...unconfirmedWriteLines(tops),
                  ...recoveryKeyLines(listedAll),
                  ...(await syncedWithinLines(rt, tops, 'published')),
                  ...(writable ? await writableShareLines(rt, tops, 'anyone with the writable link', 'make a read-only link instead') : []),
                ],
                bindContents: true,
              },
            );
            if (!g.proceed) return g.result;
            if (g.handles.length === 0) return ok('No matching nodes.', { created: 0 });
            let done = 0;
            let failed = 0;
            let unprotected = 0;
            const stillPublic: string[] = [];
            for (const [i, h] of g.handles.entries()) {
              const outcome = await publish(h, g.paths[i] ?? '');
              if (outcome === 'ok') done++;
              else if (outcome === 'unprotected') unprotected++;
              else if (outcome === 'still-public') stillPublic.push(h);
              else failed++;
            }
            return (failed || unprotected || stillPublic.length ? err : ok)(
              `Created ${done} public link(s)${failed ? `; ${failed} failed` : ''}${unprotected ? `; ${unprotected} withdrawn because MEGA would not apply the password or expiry (that needs a Pro account)` : ''}${
                stillPublic.length ? `; ${stillPublic.length} could NOT be withdrawn and are public WITHOUT a password (${stillPublic.join(', ')}) - remove them with action "delete"` : ''
              }.`,
              { created: done, failed, unprotected, stillPublic },
            );
          }
          // A wildcard here would publish a link per matched node while the preview
          // named one — the exfiltration equivalent of the mega_rm case.
          const rp = assertNotStoreCopy(assertNoVersionName(assertNoWildcard(assertRemotePath(remotePath), 'remotePath')));
          if (!confirm) await assertNoStoreCopyBelow(rt, rp);
          const same = await sameNamed(rt, rp);
          // MEGAcmd exports every same-named item and fails at one already linked, so a link
          // left without the password could not be told apart and withdrawn.
          if (password && same.count > 1) {
            throw new ValidationError(`${same.count} items are named ${rp}; a password-protected link is made for one item at a time. Use usePcre to pick them.`);
          }
          // Unconfirmed writes in it are named and bound: anything added after the preview voids it.
          const placed = [
            ...unconfirmedWriteLines(rp),
            ...(await recoveryKeyLinesBelow(rt, [rp])),
            ...(await syncedWithinLines(rt, rp, 'published')),
            // An upload key lets anyone with the link add files: a sync brings them to this computer.
            ...(writable ? await writableShareLines(rt, [rp], 'anyone with the writable link', 'make a read-only link instead') : []),
          ];
          const contents = await contentDigest(rt, rp);
          // MEGAcmd 2.6.0 answers "Already exists" for a linked node: confirming shows that link in
          // full instead (the one way to get its key, which status hides).
          const existing = same.count <= 1 ? ownExportLink((await rt.run('export', [rp])).stdout, rp) : null;
          if (existing && (password || exp || writable || megaHosted)) {
            throw new ValidationError(`${rp} already has a public link, and MEGA cannot add options to it. Remove it (action "delete") and create it again with those options.`);
          }
          const gate = checkConfirm(
            rt,
            'mega_export:create',
            { remotePath: rp, writable, megaHosted, password: secretBinding(password), expire: expire ?? null, items: same.count, placed, existing: existing !== null, contents },
            confirm,
            existing
              ? [
                  `${rp} already has a public link. Confirming shows it in full, with its key: anyone who gets it can open ${rp} (also where a password was set on the link elsewhere).`,
                  ...placed,
                ]
              : [
                  `This will create a PUBLIC link for ${rp} that anyone with the URL can access.${writable ? ' This is a WRITABLE link — anyone with the URL can UPLOAD into the folder.' : ''}`,
                  ...exportOptionLines(megaHosted, password, exp),
                  ...same.lines,
                  ...placed,
                ],
          );
          if (gate) return gate;
          await assertNoStoreCopyBelow(rt, rp);
          if (existing) {
            const now = ownExportLink((await rt.run('export', [rp])).stdout, rp);
            if (!now) return err(`${rp} no longer has a public link.`, { remotePath: rp });
            return ok(`Public link for ${rp}:\n${now}`, { remotePath: rp, link: now, existing: true });
          }
          const r = await rt.run('export', createArgs(rp));
          if (r.code !== 0) {
            // MEGAcmd can fail AFTER publishing (an expiry or password it could not set, a writable
            // link shown read-only): no link the preview did not describe is left up.
            const made = exp || password ? ownExportLink((await rt.run('export', [rp])).stdout, rp) : null;
            if (made && (exp || !isPasswordProtected(made))) {
              const gone = (await rt.run('export', ['-d', rp])).code === 0;
              const what = exp ? 'without the expiry' : 'without the password';
              return err(`${classifyExit(r)} ${gone ? `The link MEGA made ${what} was removed again.` : `The link MEGA made ${what} could NOT be removed: ${rp} is public now. Remove it with action "delete".`}`, { ok: false, code: r.code, withdrawn: gone });
            }
            return err(classifyExit(r), { ok: false, code: r.code });
          }
          const link = parseCreatedLink(r.stdout);
          if (password && !isPasswordProtected(link)) {
            if ((await rt.run('export', ['-d', rp])).code !== 0) {
              return err(
                `MEGA created the link for ${rp} WITHOUT a password (password-protected links need a Pro account), and removing it again FAILED: ${rp} is public now, without a password. Remove the link with action "delete".`,
                { remotePath: rp, unprotected: true, withdrawn: false },
              );
            }
            return err(
              `MEGA created the link for ${rp} WITHOUT a password (password-protected links need a Pro account), so it was removed again. Nothing is published.`,
              { remotePath: rp, unprotected: true },
            );
          }
          return ok(link ? `Public link created for ${rp}:\n${link}` : `Public link created for ${rp}.`, { remotePath: rp, link, writable });
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
        // A wildcard would unpublish every match while the preview named one.
        const rp = assertNoWildcard(assertRemotePath(remotePath), 'remotePath');
        const same = await sameNamed(rt, rp);
        const gate = checkConfirm(rt, 'mega_export:delete', { remotePath: rp, items: same.count }, confirm, [`This will remove the public link for ${rp}.`, ...same.lines]);
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
        usePcre: z.boolean().default(false).describe('Interpret remotePath as a PCRE pattern (affects every match). It starts with "/" and each part of the path is matched on its own, e.g. /Docs/.*\\.pdf$.'),
        confirm: z.string().optional().describe('Confirmation token (add/remove only).'),
      },
      annotations: { title: 'MEGA: share', destructiveHint: true, openWorldHint: true },
    },
    async ({ remotePath, action, withEmail, level, pending, usePcre, confirm }) =>
      guardRun(async () => {
        if (action === 'list') {
          const rp = usePcre && remotePath ? assertNoFlag(remotePath, 'remotePath') : assertOptionalRemotePath(remotePath);
          const args = [...(pending ? ['-p'] : []), ...(usePcre && rp ? ['--use-pcre'] : []), ...(rp ? [rp] : [])];
          return runToResult(rt, 'share', args, (r) => ok(r.stdout.trim().slice(0, 4000) || '(no shares)', { remotePath: rp ?? null, pending }));
        }
        if (!withEmail) throw new ValidationError('withEmail is required for add/remove.');
        if (action === 'add') {
          const lvl = SHARE_LEVEL[level ?? 'read'] as string;
          const addArgs = (node: string) => ['-a', `--with=${withEmail}`, `--level=${lvl}`, node];
          if (usePcre) {
            const rp = assertNoFlag(remotePath ?? '', 'remotePath');
            const listedAll: string[] = [];
            const g = await pcreGate(
              rt,
              'mega_share:add',
              { remotePath: rp, withEmail, level: level ?? 'read', usePcre: true },
              confirm,
              rp,
              (n, t) => `This will share ${n} node(s) with ${withEmail} (${level ?? 'read'} access):\n${t}`,
              (p) => {
                assertNotStoreCopy(p, 'A matched node');
                listedAll.push(p);
              },
              {
                extraLines: async (tops) => [...unconfirmedWriteLines(tops), ...recoveryKeyLines(listedAll), ...(await syncedWithinLines(rt, tops, 'shared')), ...(lvl === '0' ? [] : await writableShareLines(rt, tops, withEmail))],
                bindContents: true,
              },
            );
            if (!g.proceed) return g.result;
            if (g.handles.length === 0) return ok('No matching nodes.', { shared: 0 });
            const { done, failed } = await runPerHandle(rt, 'share', g.handles, addArgs);
            return ok(`Shared ${done} node(s) with ${withEmail}${failed ? `; ${failed} failed` : ''}.`, { withEmail, shared: done, failed });
          }
          const rp = assertNotStoreCopy(assertNoVersionName(assertNoWildcard(assertRemotePath(remotePath ?? '', 'remotePath'), 'remotePath')));
          if (!confirm) await assertNoStoreCopyBelow(rt, rp);
          const same = await sameNamed(rt, rp);
          const placed = [...unconfirmedWriteLines(rp), ...(await recoveryKeyLinesBelow(rt, [rp])), ...(await syncedWithinLines(rt, rp, 'shared')), ...(lvl === '0' ? [] : await writableShareLines(rt, [rp], withEmail))];
          // Bind what the folder holds: anything moved or swapped in after the preview voids it.
          const contents = await contentDigest(rt, rp);
          const gate = checkConfirm(rt, 'mega_share:add', { remotePath: rp, withEmail, level: level ?? 'read', items: same.count, placed, contents }, confirm, [`This will share ${rp} with ${withEmail} (${level ?? 'read'} access).`, ...same.lines, ...placed]);
          if (gate) return gate;
          await assertNoStoreCopyBelow(rt, rp);
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
        const rp = assertNoWildcard(assertRemotePath(remotePath ?? '', 'remotePath'), 'remotePath');
        const same = await sameNamed(rt, rp);
        const gate = checkConfirm(rt, 'mega_share:remove', { remotePath: rp, withEmail, items: same.count }, confirm, [`This will revoke ${withEmail}'s access to ${rp}.`, ...same.lines]);
        if (gate) return gate;
        return runToResult(rt, 'share', rmArgs(rp), () => ok(`Revoked ${withEmail}'s access to ${rp}.`, { remotePath: rp, withEmail }));
      }),
  );
}
