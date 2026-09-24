import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from '../runtime.js';
import { ok } from '../mcpResult.js';
import { guardRun, checkConfirm } from './helpers.js';
import { writeRemembered } from '../fileReading.js';

/**
 * mega_file_reading — the Codex-plugin answer to "how does a non-technical user
 * turn on file-content reading?".
 *
 * The other distributions have a place to put this: the MCPB manifest renders
 * `expose_file_contents` as a checkbox, and a hand-registered stdio server takes
 * an env var. The Codex plugin has neither — a plugin-provided MCP server's
 * transport (command/args/env) is fixed by the plugin, and user config can only
 * reach `enabled`, tool allow-lists and approval modes. The only remaining way
 * to ask the user is inside the conversation, which is what this tool is.
 *
 * Confirm-gated on purpose, reusing the same two-call protocol as every other
 * consequential tool here: the first call PREVIEWS what enabling means (file
 * text enters the conversation and is therefore visible to the AI provider) and
 * executes nothing.
 *
 * DEFAULTS TO THIS SERVER PROCESS ONLY. `mega_cat` is re-disabled when the server
 * next starts, so the question comes back. User-facing text says "until the app
 * is restarted", not "this conversation": a host may keep one server process alive
 * across many conversations, and consent text must never promise a SHORTER reach
 * than the grant really has — consent to disclose document contents is
 * not something to infer forever from one "yes". `remember: true` is the user's
 * explicit "don't ask again" and is the ONLY thing that persists.
 */
export function registerFileReading(server: McpServer, rt: Runtime, cat: RegisteredTool): void {
  server.registerTool(
    'mega_file_reading',
    {
      title: 'MEGA: allow reading file contents',
      description:
        "Turn on (or off) the assistant's ability to read the text inside your MEGA files. Call this when the user asks to read, summarise or search INSIDE a document and mega_cat is unavailable. Enabling requires confirmation and applies to the current session only, unless remember=true is passed to keep it on for future sessions.",
      inputSchema: {
        action: z.enum(['enable', 'disable']).default('enable').describe('Turn file-content reading on or off.'),
        remember: z
          .boolean()
          .default(false)
          .describe("Keep the choice for future sessions (the user's explicit \"don't ask me again\"). Pass true ONLY when the user actually said so; otherwise the choice lasts for this session and they are asked again next time."),
        confirm: z.string().optional().describe('Confirmation token from the first call (enabling only).'),
      },
      // Not destructive to data, but it widens what leaves the machine, so it is
      // neither read-only nor auto-allowed.
      annotations: { title: 'MEGA: allow reading file contents', destructiveHint: false, openWorldHint: true },
    },
    async ({ action, remember, confirm }) =>
      guardRun(async () => {
        if (action === 'disable') {
          // Narrowing access never needs a confirmation step.
          cat.disable();
          const cleared = writeRemembered(rt.config, false);
          // An explicitly configured MEGA_MCP_EXPOSE_FILES outranks the remembered
          // answer at startup, so with it set this turns file reading off for the
          // CURRENT session only. Saying a flat "it is off" would be a promise the
          // next restart breaks - and about disclosing document text, of all things.
          const caveat = rt.config.exposeFileContents
            ? '\n\nNote: file reading is switched on in this connector\'s own settings (MEGA_MCP_EXPOSE_FILES), which takes precedence, so it will be on again the next time the app starts. To turn it off permanently, change that setting where the connector is configured.'
            : cleared
              ? ''
              : '\n\nNote: the saved preference could not be cleared on disk, so it may come back on next start.';
          return ok(
            `File-content reading is now OFF${
              rt.config.exposeFileContents ? ' for this session' : ''
            }. The assistant can still list and search your files, but not read what is inside them.${caveat}`,
            { enabled: false, remembered: false, sessionOnly: rt.config.exposeFileContents },
          );
        }

        const scope = remember
          ? 'This will stay on for future sessions until you turn it off.'
          : 'This lasts until the app is restarted - you will be asked again after that.';
        // Action key is the bare tool name (not a "tool:sub" key like the
        // export/share gates use): checkConfirm echoes it back as "call <key>
        // again with confirm", and this flow is aimed at someone who will read
        // that sentence. `action` stays bound through normArgs, so the token is
        // still scoped to enabling.
        const gate = checkConfirm(rt, 'mega_file_reading', { action, remember }, confirm, [
          'This will let the assistant read the TEXT INSIDE your MEGA files.',
          'File contents become part of this conversation and are therefore visible to the AI provider.',
          'Your password, encryption keys and MEGA session are never included.',
          scope,
        ]);
        if (gate) return gate;

        cat.enable();
        const saved = remember ? writeRemembered(rt.config, true) : true;
        const tail = remember
          ? saved
            ? ' It will stay on for future sessions; call this tool with action="disable" to turn it off.'
            : ' It could not be saved to disk, so it applies to this session only.'
          : ' It lasts until the app is restarted, and you will be asked again after that.';
        return ok(`File-content reading is now ON.${tail}`, { enabled: true, remembered: remember && saved });
      }),
  );
}
