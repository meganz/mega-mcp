import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from '../runtime.js';
import { ok } from '../mcpResult.js';
import { assertNoFlag, ValidationError } from '../paths.js';
import { guardRun, runToResult, checkConfirm } from './helpers.js';

const SPEED_DIR: Record<string, string> = {
  upload: '-u',
  download: '-d',
  'upload-connections': '--upload-connections',
  'download-connections': '--download-connections',
};

/**
 * mega_config — unified read/modify of MEGAcmd settings. Showing a setting (no
 * value) is read-only and auto-allowed; changing one, and the reload/debug
 * actions, are confirm-gated. None of these touch file data or leak credentials.
 * `psa` is not offered (no client binary in current MEGAcmd).
 */
export function registerConfig(server: McpServer, rt: Runtime): void {
  server.registerTool(
    'mega_config',
    {
      title: 'MEGA: settings',
      description:
        'Show or change a MEGAcmd setting. setting + no value shows it (read-only); setting + value changes it (confirm). Settings: speedlimit (rate limit, with optional direction), https (on|off), graphics (on|off), log (level, with optional scope), permissions (perm value, requires target), reload (refresh remote state), debug (enable verbose logging).',
      inputSchema: {
        setting: z.enum(['speedlimit', 'https', 'graphics', 'log', 'permissions', 'reload', 'debug']).describe('Which setting/action.'),
        value: z.string().optional().describe('New value to set; omit to just show the current value.'),
        direction: z
          .enum(['upload', 'download', 'upload-connections', 'download-connections'])
          .optional()
          .describe('For speedlimit: which limit to read/set (default both speeds).'),
        scope: z.enum(['cmd', 'sdk']).optional().describe('For log: CMD or SDK log level.'),
        target: z.enum(['files', 'folders']).optional().describe('For permissions: files or folders (required when setting).'),
        human: z.boolean().default(false).describe('For speedlimit: show the limit in human-readable units.'),
        confirm: z.string().optional().describe('Confirmation token from the first call (only when changing a value or running reload/debug).'),
      },
      // Mixed read/modify: showing is read-only, changing is confirm-gated. Not
      // data-destructive, so destructiveHint:false; readOnlyHint omitted because
      // it can modify server settings.
      annotations: { title: 'MEGA: settings', destructiveHint: false, openWorldHint: true },
    },
    async ({ setting, value, direction, scope, target, human, confirm }) =>
      guardRun(async () => {
        // Action settings (no value): reload / debug — confirm-gated.
        if (setting === 'reload' || setting === 'debug') {
          const summary =
            setting === 'reload' ? 'This will force MEGAcmd to refresh remote state.' : 'This will enable HIGHLY VERBOSE debug logging.';
          const gate = checkConfirm(rt, `mega_config:${setting}`, {}, confirm, summary);
          if (gate) return gate;
          return runToResult(rt, setting, [], () => ok(summary.replace(/^This will /, 'Done: '), { setting }));
        }

        const hasValue = value !== undefined && value.trim() !== '';

        // Show (no value) — read-only, auto-allow.
        if (!hasValue) {
          const showArgs =
            setting === 'speedlimit'
              ? [...(direction ? [SPEED_DIR[direction] as string] : []), ...(human ? ['-h'] : [])]
              : setting === 'permissions' && target
                ? [`--${target}`]
                : [];
          return runToResult(rt, setting, showArgs, (r) => ok(r.stdout.trim().slice(0, 2000) || '(no output)', { setting }));
        }

        const v = assertNoFlag(value as string, 'value');
        let args: string[];
        switch (setting) {
          case 'https':
          case 'graphics':
            if (!['on', 'off'].includes(v.toLowerCase())) throw new ValidationError(`${setting} value must be "on" or "off".`);
            args = [v.toLowerCase()];
            break;
          case 'speedlimit':
            args = [...(direction ? [SPEED_DIR[direction] as string] : []), v];
            break;
          case 'log':
            args = [...(scope === 'cmd' ? ['-c'] : scope === 'sdk' ? ['-s'] : []), v];
            break;
          case 'permissions':
            if (!target) throw new ValidationError('permissions requires target ("files" or "folders") when setting a value.');
            args = [`--${target}`, '-s', v];
            break;
          default:
            throw new ValidationError('Unsupported setting.');
        }
        const summary = `This will set ${setting} to "${v}".`;
        const gate = checkConfirm(rt, `mega_config:${setting}`, { value: v, direction: direction ?? null, scope: scope ?? null, target: target ?? null }, confirm, summary);
        if (gate) return gate;
        return runToResult(rt, setting, args, () => ok(summary.replace(/^This will /, 'Done: '), { setting, value: v }));
      }),
  );
}
