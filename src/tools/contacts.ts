import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from '../runtime.js';
import { ok } from '../mcpResult.js';
import { capLines } from '../parsers/listing.js';
import { guardRun, runToResult } from './helpers.js';

const RO = { readOnlyHint: true, openWorldHint: true } as const;

/**
 * Contact / profile tools. These surface third-party contact PII (emails,
 * names) — or the user's own profile attributes — into the model context, so
 * they are registered ONLY when config.exposeContacts is set (default off).
 *
 * All are hardcoded to their READ forms: no -d/-s/--verify/--user flags or
 * values are ever taken from the model, so none can mutate the contact graph or
 * profile. The write forms (e.g. `users -d`, `userattr -s`) are deliberately
 * not exposed. None of these leak the user's own key/credential material.
 *
 * Caveat for userattr: keyring/authring attributes print as "NOT PRINTABLE"
 * only because the SDK returns no text for them — an emergent property, not a
 * deliberate refusal. We cap output and never pass --user, but do not rely on
 * upstream to hide future sensitive attributes.
 */
export function registerContacts(server: McpServer, rt: Runtime): void {
  // mega_users — list the account's contacts (emails/names). Read-only. The
  // delete/verify forms are separate confirm-gated tools (mega_user_remove,
  // mega_user_verify).
  server.registerTool(
    'mega_users',
    {
      title: 'MEGA: list contacts',
      description: 'List the account contacts. Read-only. Surfaces third-party contact details.',
      inputSchema: {
        showNames: z.boolean().default(false).describe('Also show contact names.'),
        showShared: z.boolean().default(false).describe('Also show folders shared with each contact.'),
        showHidden: z.boolean().default(false).describe('Also show hidden/blocked contacts.'),
      },
      annotations: { title: 'MEGA: list contacts', ...RO },
    },
    async ({ showNames, showShared, showHidden }) =>
      guardRun(async () => {
        const args = [...(showShared ? ['-s'] : []), ...(showHidden ? ['-h'] : []), ...(showNames ? ['-n'] : [])];
        return runToResult(rt, 'users', args, (r) => {
          const { text, total, truncated } = capLines(r.stdout, rt.config.maxListLines);
          return ok(text || '(no contacts)', { contactCount: total, truncated });
        });
      }),
  );

  // mega_showpcr — pending contact requests (incoming/outgoing). Read-only.
  server.registerTool(
    'mega_showpcr',
    {
      title: 'MEGA: pending contact requests',
      description: 'Show pending contact requests (incoming and outgoing). Read-only. Surfaces third-party emails.',
      inputSchema: {},
      annotations: { title: 'MEGA: pending contact requests', ...RO },
    },
    async () =>
      guardRun(async () =>
        runToResult(rt, 'showpcr', [], (r) => {
          const { text, total, truncated } = capLines(r.stdout, rt.config.maxListLines);
          return ok(text || '(no pending contact requests)', { requestCount: total, truncated });
        }),
      ),
  );

  // mega_userattr — view profile attributes. Read-only (the -s write form is the
  // separate confirm-gated mega_userattr_set). With a user email it views that
  // CONTACT's attributes (third-party PII); with list=true it lists the valid
  // attribute names.
  server.registerTool(
    'mega_userattr',
    {
      title: 'MEGA: profile attributes',
      description: 'View your own (or, with user set, a contact\'s) MEGA profile attributes, or list valid attribute names. Read-only.',
      inputSchema: {
        user: z.string().email().optional().describe("A contact's email to view their attributes (default: your own)."),
        list: z.boolean().default(false).describe('List the valid attribute names instead of values.'),
      },
      annotations: { title: 'MEGA: profile attributes', ...RO },
    },
    async ({ user, list }) =>
      guardRun(async () => {
        const args = [...(list ? ['--list'] : []), ...(user ? [`--user=${user}`] : [])];
        return runToResult(rt, 'userattr', args, (r) => {
          const { text, total, truncated } = capLines(r.stdout, rt.config.maxListLines);
          return ok(text || '(no profile attributes)', { attrCount: total, truncated, user: user ?? null });
        });
      }),
  );
}
