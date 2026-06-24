import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from '../runtime.js';
import { ok, err } from '../mcpResult.js';
import { ensureMacLoginHelper } from '../download/megacmd.js';

/**
 * Out-of-band login instructions. Login MUST use the MEGAcmd interactive shell,
 * where `login <email>` prompts for the password at a HIDDEN prompt. The
 * one-shot `mega-login` client is non-interactive and would require the password
 * as an argument (exposed in argv/shell history), which we never instruct. The
 * password is never seen by the AI either way. `helperPath` is the (self-healed)
 * double-click helper when available.
 */
/**
 * Resolve a directory to its real on-disk path. Under an MSIX-packaged Claude
 * the connector's %LOCALAPPDATA% is redirected to a package-private LocalCache:
 * the connector sees the virtual path (C:\Users\<u>\AppData\Local\MEGAcmd) but a
 * normal user terminal needs the real physical path
 * (…\Packages\<family>\LocalCache\Local\MEGAcmd). fs.realpath native (Windows:
 * GetFinalPathNameByHandle) resolves the redirect. Falls back to the input on
 * any error (non-MSIX installs already return the same path).
 */
function realDir(dir: string): string {
  try {
    return realpathSync.native(dir).replace(/^\\\\\?\\/, '');
  } catch {
    return dir;
  }
}

function loginInstructions(binDir: string | null, helperPath: string | null): string {
  const lines = [
    'Not logged in to MEGA. Log in yourself - your password is entered at a hidden prompt and is never seen by the AI assistant.',
  ];
  if (helperPath) {
    lines.push('', `- Easiest: double-click this file in Finder:\n  ${helperPath}`);
  }
  if (binDir) {
    const launch =
      process.platform === 'win32'
        ? `"${join(realDir(binDir), 'MEGAcmdShell.exe')}"`
        : `PATH="${binDir}:$PATH" MEGAcmdShell`;
    lines.push('', `- Or in a terminal:\n  ${launch}`);
  } else {
    lines.push('', '- Start the MEGAcmd interactive shell (MEGAcmdShell).');
  }
  lines.push(
    '',
    'Then at the "MEGA CMD>" prompt type:  login <your-email>',
    'enter your password at the hidden prompt, then type:  quit  - and retry.',
  );
  return lines.join('\n');
}

/**
 * mega_whoami - report the logged-in MEGA account (Section C). Read-only,
 * auto-allow. Returns ONLY { loggedIn, email? }; never session material
 * (HARD CONSTRAINT 2).
 */
export function registerWhoami(server: McpServer, rt: Runtime): void {
  server.registerTool(
    'mega_whoami',
    {
      title: 'MEGA: who am I',
      description:
        'Show the currently logged-in MEGA account (email only). If not logged in, explains how to log in out-of-band.',
      inputSchema: {},
      annotations: { title: 'MEGA: who am I', readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const state = await rt.ensureReady();

      if (state.loggedIn) {
        return ok(`Logged in to MEGA as ${state.email ?? '(unknown email)'}.`, {
          loggedIn: true,
          email: state.email,
        });
      }

      if (state.reason === 'no_megacmd') {
        return err(
          'MEGAcmd is not available. Run the `megacmd_setup` tool to download it automatically, or install MEGAcmd / set the MEGAcmd directory in this server\'s configuration.',
          { loggedIn: false, reason: 'no_megacmd' },
        );
      }

      if (state.reason === 'not_logged_in') {
        const resolved = await rt.getResolved();
        const binDir = resolved?.binDir ?? null;
        const helperPath = binDir ? await ensureMacLoginHelper(binDir) : null;
        return ok(loginInstructions(binDir, helperPath), { loggedIn: false, reason: 'not_logged_in' });
      }

      return err(`Could not determine MEGA login state: ${state.detail ?? 'unknown error'}`, {
        loggedIn: false,
        reason: state.reason,
      });
    },
  );
}
