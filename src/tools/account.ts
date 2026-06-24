import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from '../runtime.js';
import { ok } from '../mcpResult.js';
import { parseAccount } from '../parsers/account.js';
import { extractSessionsBlock, extractBalanceBlock } from '../parsers/accountDetails.js';
import { capLines } from '../parsers/listing.js';
import { guardRun, runToResult } from './helpers.js';

const RO = { readOnlyHint: true, openWorldHint: true } as const;

/**
 * mega_account — report the account plan tier + storage. Runs `whoami -l` (the
 * only command that surfaces the plan tier) but returns ONLY the allowlisted
 * plan/storage fields parsed by parseAccount; the raw output (which also holds
 * the session block, balance, and purchase/transaction history) is never
 * echoed. Read-only, auto-allow. There is no transfer-quota figure in `-l`.
 */
export function registerAccount(server: McpServer, rt: Runtime): void {
  server.registerTool(
    'mega_account',
    {
      title: 'MEGA: account plan',
      description:
        'Show the MEGA account plan tier, storage quota, and per-folder storage usage. Read-only. Never reveals session, balance, or payment details.',
      inputSchema: {},
      annotations: { title: 'MEGA: account plan', readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guardRun(async () =>
        runToResult(rt, 'whoami', ['-l'], (r) => {
          const a = parseAccount(r.stdout);
          const lines: string[] = [];
          lines.push(`Plan: ${a.plan ?? 'unknown'}${a.planExpires ? ` (expires ${a.planExpires})` : ''}`);
          if (a.storageTotal) lines.push(`Storage quota (total): ${a.storageTotal}`);
          if (a.storageByFolder) {
            for (const [k, v] of Object.entries(a.storageByFolder)) lines.push(`  ${k}: ${v}`);
          }
          if (a.fileVersionsSize) lines.push(`File versions: ${a.fileVersionsSize}`);
          lines.push('', 'For the total storage-used figure, use mega_df.');
          return ok(lines.join('\n'), { ...a });
        }),
      ),
  );
}

/**
 * Opt-in account-detail tools (sessions / balance). Registered ONLY when
 * config.exposeAccountDetails is set (default off): they surface the user's own
 * login metadata (IP/geo/devices) and financial history — privacy-sensitive PII
 * but not an account-compromise risk. Both run `whoami -l` and return only the
 * relevant bounded block; the resumable login key is never in that output.
 */
export function registerAccountDetails(server: McpServer, rt: Runtime): void {
  // mega_sessions — list active login sessions (handle + IP/geo/UA). The handle
  // is the killSession input, so this pairs with mega_killsession.
  server.registerTool(
    'mega_sessions',
    {
      title: 'MEGA: active sessions',
      description:
        'List the active login sessions on this account (session handle, IP, country, device, timestamps). Read-only. The handle can be passed to mega_killsession.',
      inputSchema: {},
      annotations: { title: 'MEGA: active sessions', ...RO },
    },
    async () =>
      guardRun(async () =>
        runToResult(rt, 'whoami', ['-l'], (r) => {
          const { text, total, truncated } = capLines(extractSessionsBlock(r.stdout), rt.config.maxListLines);
          return ok(text || '(no active sessions)', { lineCount: total, truncated });
        }),
      ),
  );

  // mega_balance — account balance + purchase/transaction history.
  server.registerTool(
    'mega_balance',
    {
      title: 'MEGA: balance',
      description: 'Show the account balance, subscription type, and purchase/transaction history. Read-only.',
      inputSchema: {},
      annotations: { title: 'MEGA: balance', ...RO },
    },
    async () =>
      guardRun(async () =>
        runToResult(rt, 'whoami', ['-l'], (r) => {
          const { text, total, truncated } = capLines(extractBalanceBlock(r.stdout), rt.config.maxListLines);
          return ok(text || '(no balance information)', { lineCount: total, truncated });
        }),
      ),
  );
}
