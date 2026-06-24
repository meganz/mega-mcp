import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from '../runtime.js';
import { ok } from '../mcpResult.js';
import { assertRemotePath, assertNoFlag, ValidationError } from '../paths.js';
import { guardRun, runToResult, checkConfirm } from './helpers.js';

const TRANSFER_FLAG: Record<string, string> = { pause: '-p', resume: '-r', cancel: '-c' };
const IPC_FLAG: Record<string, string> = { accept: '-a', deny: '-d', ignore: '-i' };
const NUL = String.fromCharCode(0);

/**
 * Confirm-gated management mutations surfaced after the command-surface
 * re-audit. None leaks the user's key/credential material; all mutate state, so
 * all use the two-call confirm protocol. Read forms live elsewhere (attr/users
 * read in readonly.ts/contacts.ts, transfers list in readonly.ts).
 */
export function registerManage(server: McpServer, rt: Runtime): void {
  // mega_attr_set — set or delete a node attribute. (Read form: mega_attr.)
  server.registerTool(
    'mega_attr_set',
    {
      title: 'MEGA: set node attribute',
      description:
        'Set or delete an attribute on a MEGA cloud node. action="set" needs a value; action="delete" removes the attribute. Requires confirmation.',
      inputSchema: {
        remotePath: z.string().describe('Absolute MEGA path of the node.'),
        attribute: z.string().describe('Attribute name.'),
        action: z.enum(['set', 'delete']).describe('Set or delete the attribute.'),
        value: z.string().optional().describe('Value to set (required for action="set").'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: set node attribute', destructiveHint: true, openWorldHint: true },
    },
    async ({ remotePath, attribute, action, value, confirm }) =>
      guardRun(async () => {
        const rp = assertRemotePath(remotePath);
        const attr = assertNoFlag(attribute, 'attribute');
        if (action === 'set' && (value === undefined || value.trim() === '')) {
          throw new ValidationError('value is required for action="set".');
        }
        // Normalize the value once so the confirm token and the argv match byte-for-byte.
        const val = action === 'set' ? assertNoFlag(value as string, 'value') : null;
        const summary =
          action === 'set'
            ? `This will set attribute "${attr}" on ${rp}.`
            : `This will delete attribute "${attr}" from ${rp}.`;
        const gate = checkConfirm(rt, 'mega_attr_set', { remotePath: rp, attribute: attr, action, value: val }, confirm, summary);
        if (gate) return gate;
        const args = action === 'set' ? [rp, '-s', attr, val as string] : [rp, '-d', attr];
        return runToResult(rt, 'attr', args, () => ok(summary.replace(/^This will /, 'Done: '), { remotePath: rp, attribute: attr, action }));
      }),
  );

  // mega_userattr_set — set one of YOUR OWN profile attributes (no --user).
  server.registerTool(
    'mega_userattr_set',
    {
      title: 'MEGA: set profile attribute',
      description: 'Set one of your own MEGA profile attributes. Requires confirmation.',
      inputSchema: {
        attribute: z.string().describe('Profile attribute name.'),
        value: z.string().describe('Value to set.'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: set profile attribute', destructiveHint: true, openWorldHint: true },
    },
    async ({ attribute, value, confirm }) =>
      guardRun(async () => {
        const attr = assertNoFlag(attribute, 'attribute');
        const val = assertNoFlag(value, 'value');
        const summary = `This will set your profile attribute "${attr}".`;
        const gate = checkConfirm(rt, 'mega_userattr_set', { attribute: attr, value: val }, confirm, summary);
        if (gate) return gate;
        return runToResult(rt, 'userattr', ['-s', attr, val], () => ok(`Set profile attribute "${attr}".`, { attribute: attr }));
      }),
  );

  // mega_user_remove — delete a contact. (Read form: mega_users, opt-in.)
  server.registerTool(
    'mega_user_remove',
    {
      title: 'MEGA: remove contact',
      description: 'Remove a contact from the account. Requires confirmation.',
      inputSchema: {
        email: z.string().email().describe('Contact email to remove.'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: remove contact', destructiveHint: true, openWorldHint: true },
    },
    async ({ email, confirm }) =>
      guardRun(async () => {
        // z.string().email() accepts a leading "-" (e.g. "-d@x.co"); re-guard so
        // the address can never be parsed as a flag.
        const em = assertNoFlag(email, 'email');
        const summary = `This will remove ${em} from your contacts.`;
        const gate = checkConfirm(rt, 'mega_user_remove', { email: em }, confirm, summary);
        if (gate) return gate;
        return runToResult(rt, 'users', ['-d', em], () => ok(`Removed contact ${em}.`, { email: em }));
      }),
  );

  // mega_transfer_control — pause/resume/cancel transfers. (List: mega_transfers.)
  server.registerTool(
    'mega_transfer_control',
    {
      title: 'MEGA: control transfers',
      description:
        'Pause, resume, or cancel transfers — a single transfer by tag, or all with all=true. Requires confirmation.',
      inputSchema: {
        action: z.enum(['pause', 'resume', 'cancel']).describe('What to do.'),
        tag: z.string().optional().describe('Transfer tag (from mega_transfers). Omit and set all=true to target every transfer.'),
        all: z.boolean().default(false).describe('Apply to all transfers.'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: control transfers', destructiveHint: true, openWorldHint: true },
    },
    async ({ action, tag, all, confirm }) =>
      guardRun(async () => {
        const t = tag !== undefined ? assertNoFlag(tag, 'tag') : undefined;
        if (!all && !t) throw new ValidationError('Provide a tag, or set all=true.');
        if (all && t) throw new ValidationError('Provide either a tag or all=true, not both.');
        const target = all ? 'all transfers' : `transfer ${t}`;
        const summary = `This will ${action} ${target}.`;
        const gate = checkConfirm(rt, 'mega_transfer_control', { action, tag: t ?? null, all }, confirm, summary);
        if (gate) return gate;
        const args = [TRANSFER_FLAG[action] as string, all ? '-a' : (t as string)];
        return runToResult(rt, 'transfers', args, () => ok(summary.replace(/^This will /, 'Done: '), { action, tag: t ?? null, all }));
      }),
  );

  // mega_invite — send / resend / withdraw a contact invitation (sends email).
  server.registerTool(
    'mega_invite',
    {
      title: 'MEGA: contact invitation',
      description:
        'Send, resend, or withdraw a contact invitation (sends an email on your behalf). Requires confirmation.',
      inputSchema: {
        email: z.string().email().describe('Destination email.'),
        action: z.enum(['send', 'resend', 'delete']).default('send').describe('Send a new invite, resend, or withdraw it.'),
        message: z.string().optional().describe('Optional message included with a new invite.'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: contact invitation', destructiveHint: true, openWorldHint: true },
    },
    async ({ email, action, message, confirm }) =>
      guardRun(async () => {
        // z.string().email() accepts a leading "-"; re-guard against flag parsing.
        const em = assertNoFlag(email, 'email');
        if (message !== undefined && message.includes(String.fromCharCode(0))) {
          throw new ValidationError('message contains a NUL byte.');
        }
        const summary =
          action === 'delete'
            ? `This will withdraw the contact invitation to ${em}.`
            : action === 'resend'
              ? `This will resend the contact invitation to ${em}.`
              : `This will send a contact invitation email to ${em}.`;
        const gate = checkConfirm(rt, 'mega_invite', { email: em, action, message: message ?? null }, confirm, summary);
        if (gate) return gate;
        const args: string[] = [];
        if (action === 'delete') args.push('-d');
        else if (action === 'resend') args.push('-r');
        args.push(em);
        if (action === 'send' && message) args.push(`--message=${message}`);
        return runToResult(rt, 'invite', args, () => ok(summary.replace(/^This will /, 'Done: '), { email: em, action }));
      }),
  );

  // mega_ipc — accept / deny / ignore an incoming contact request.
  server.registerTool(
    'mega_ipc',
    {
      title: 'MEGA: incoming contact request',
      description:
        'Respond to an incoming contact request: accept, deny, or ignore. Identify it by the requester email or handle (see mega_showpcr). Requires confirmation.',
      inputSchema: {
        request: z.string().describe('Requester email or request handle.'),
        action: z.enum(['accept', 'deny', 'ignore']).describe('How to respond.'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: incoming contact request', destructiveHint: true, openWorldHint: true },
    },
    async ({ request, action, confirm }) =>
      guardRun(async () => {
        const req = assertNoFlag(request, 'request');
        const summary = `This will ${action} the incoming contact request from ${req}.`;
        const gate = checkConfirm(rt, 'mega_ipc', { request: req, action }, confirm, summary);
        if (gate) return gate;
        return runToResult(rt, 'ipc', [req, IPC_FLAG[action] as string], () => ok(summary.replace(/^This will /, 'Done: '), { request: req, action }));
      }),
  );

  // mega_import — import a public link's contents into the account (remote
  // write). execFile passes the link as a single argv token so it cannot inject
  // a separate flag. A link password may be supplied (passed as --password=...,
  // a single token). Requires confirmation.
  server.registerTool(
    'mega_import',
    {
      title: 'MEGA: import link',
      description:
        'Import the contents of a MEGA public link into a folder in your account. A password may be supplied for password-protected links. Requires confirmation.',
      inputSchema: {
        link: z.string().describe('MEGA public link (publiclink#key).'),
        remotePath: z.string().describe('Destination absolute MEGA folder path.'),
        password: z.string().optional().describe('Password for a password-protected link.'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: import link', destructiveHint: true, openWorldHint: true },
    },
    async ({ link, remotePath, password, confirm }) =>
      guardRun(async () => {
        const lk = assertNoFlag(link, 'link');
        if (!/^https?:\/\//i.test(lk) && !lk.includes('#') && !/^mega:/i.test(lk)) {
          throw new ValidationError('link does not look like a MEGA public link.');
        }
        if (password !== undefined && password.includes(NUL)) throw new ValidationError('password contains a NUL byte.');
        const rp = assertRemotePath(remotePath);
        const summary = `This will import the contents of the provided link into ${rp}.`;
        // Bind only the presence of a password into the token, never its value.
        const gate = checkConfirm(rt, 'mega_import', { link: lk, remotePath: rp, hasPassword: password !== undefined && password !== '' }, confirm, summary);
        if (gate) return gate;
        const args = [lk, ...(password ? [`--password=${password}`] : []), rp];
        return runToResult(rt, 'import', args, () => ok(`Imported the link into ${rp}.`, { remotePath: rp }));
      }),
  );

  // mega_user_verify — verify / unverify a contact's credentials. Mutates the
  // contact's verification state. Confirm-gated. (Read forms: mega_users.)
  server.registerTool(
    'mega_user_verify',
    {
      title: 'MEGA: verify contact',
      description:
        'Mark a contact as verified or unverified. Verify ONLY after you have manually confirmed the credentials match out-of-band. Requires confirmation.',
      inputSchema: {
        email: z.string().email().describe('Contact email.'),
        action: z.enum(['verify', 'unverify']).describe('Set the contact as verified or no longer verified.'),
        confirm: z.string().optional().describe('Confirmation token from the first call.'),
      },
      annotations: { title: 'MEGA: verify contact', destructiveHint: true, openWorldHint: true },
    },
    async ({ email, action, confirm }) =>
      guardRun(async () => {
        const em = assertNoFlag(email, 'email');
        const summary =
          action === 'verify'
            ? `This will mark ${em} as VERIFIED (only do this if you confirmed credentials match out-of-band).`
            : `This will mark ${em} as no longer verified.`;
        const gate = checkConfirm(rt, 'mega_user_verify', { email: em, action }, confirm, summary);
        if (gate) return gate;
        const flag = action === 'verify' ? '--verify' : '--unverify';
        return runToResult(rt, 'users', [flag, em], () => ok(summary.replace(/^This will /, 'Done: '), { email: em, action }));
      }),
  );
}
