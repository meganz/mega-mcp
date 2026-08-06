import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from '../runtime.js';
import { ok, err } from '../mcpResult.js';
import { classifyExit, ExitCode } from '../errors.js';
import { assertRemotePath } from '../paths.js';
import { guardRun } from './helpers.js';

const DEFAULT_MAX = 1_048_576; // 1 MB
const HARD_MAX = 10_485_760; // 10 MB
const NUL = String.fromCharCode(0);

/** U+FFFD, what a UTF-8 decoder emits for a byte sequence that is not valid text. */
const REPLACEMENT = '�';

/**
 * Heuristic binary sniff, so binary garbage and terminal control sequences never
 * reach the model context.
 *
 * By the time we see it, the content is ALREADY a decoded string, and both of the
 * original signals had been eaten before they got here:
 *  - the NUL test never fires, because MEGAcmd does not emit NUL bytes on this
 *    path (a real PNG arrived NUL-free);
 *  - the control-character ratio never reaches 0.3, because every invalid byte
 *    has already been replaced with U+FFFD, which is printable.
 * Measured on Windows against a real PNG served through mega_cat: 0 NULs, control
 * ratio well under the threshold — it was returned as if it were text.
 *
 * So count U+FFFD as non-text as well. A legitimate text file essentially never
 * contains it (it only appears where decoding already failed), while binary is
 * dense with it. The threshold is also lowered, and a single ESC now disqualifies
 * the content outright: there is no benign reason for an ANSI escape in a file we
 * are about to paste into a model's context.
 */
export function looksBinary(s: string): boolean {
  if (s.includes(NUL)) return true;
  const sample = s.slice(0, 8192);
  if (sample.length === 0) return false;
  let nonText = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0x1b) return true; // ESC: terminal control, never benign here
    if (c < 9 || (c > 13 && c < 32) || c === 0x7f) nonText++; // allow tab/LF/CR
    else if (sample[i] === REPLACEMENT) nonText++; // undecodable byte
  }
  return nonText / sample.length > 0.05;
}

/**
 * mega_cat — read a cloud file's text contents, for content-based search /
 * identification (ls/find only see names). Registered ONLY when
 * config.exposeFileContents is set (default off), because it brings cloud file
 * content into the model context.
 *
 * Guards: a byte cap (default 1 MB, hard max 10 MB) enforced via the exec
 * maxBuffer, so an oversized file is aborted before streaming rather than
 * flooding context; binary files are refused. Read-only.
 *
 * Threat note: file content is UNTRUSTED input (prompt-injection vector). The
 * backstop is that every destructive/exfiltration tool stays confirm-gated, so
 * instructions embedded in a file cannot cause silent damage — the user still
 * sees a confirmation preview before anything is deleted/shared/uploaded.
 */
export function registerCat(server: McpServer, rt: Runtime): void {
  server.registerTool(
    'mega_cat',
    {
      title: 'MEGA: read file',
      description:
        'Read the text contents of a MEGA cloud file (for content-based search/identification). Capped (default 1 MB, max 10 MB) and text-only. Read-only.',
      inputSchema: {
        remotePath: z.string().describe('Absolute MEGA path to the file.'),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(HARD_MAX)
          .optional()
          .describe('Max bytes to read (default 1048576 = 1 MB, hard max 10485760 = 10 MB).'),
      },
      annotations: { title: 'MEGA: read file', readOnlyHint: true, openWorldHint: true },
    },
    async ({ remotePath, maxBytes }) =>
      guardRun(async () => {
        const rp = assertRemotePath(remotePath);
        const cap = Math.min(maxBytes ?? DEFAULT_MAX, HARD_MAX);
        const r = await rt.run('cat', [rp], { maxBuffer: cap });
        if (r.maxBufferExceeded) {
          return err(
            `File exceeds the ${Math.floor(cap / 1024)} KB read cap. Raise maxBytes (up to 10 MB), or the file is too large to read inline — download it with mega_get instead.`,
            { remotePath: rp, capped: true },
          );
        }
        if (r.code !== ExitCode.OK) return err(classifyExit(r), { ok: false, code: r.code });
        if (looksBinary(r.stdout)) {
          return ok(`(file appears to be binary; ${r.stdout.length} bytes not shown)`, {
            remotePath: rp,
            binary: true,
            bytes: r.stdout.length,
          });
        }
        return ok(r.stdout.length ? r.stdout : '(empty file)', { remotePath: rp, bytes: r.stdout.length });
      }),
  );
}
