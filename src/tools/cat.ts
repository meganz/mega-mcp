import { z } from 'zod';
import { posix } from 'node:path';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from '../runtime.js';
import { ok, err } from '../mcpResult.js';
import { classifyExit, ExitCode } from '../errors.js';
import { assertNoWildcard, assertRemotePath, assertNotStoreCopy, isRecoveryKeyName } from '../paths.js';
import { guardRun, sameNamed, withWriteLock } from './helpers.js';

const DEFAULT_MAX = 1_048_576; // 1 MB
const HARD_MAX = 10_485_760; // 10 MB
const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(0x1b);

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
  // ESC anywhere disqualifies, not only in the sampled prefix: a terminal sequence
  // placed after the first 8 KB would otherwise be returned in full.
  if (s.includes(ESC)) return true;
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
function looksLikeRecoveryKey(line: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(line) && /[a-z]/.test(line) && /[A-Z]/.test(line);
}

const RECOVERY_KEY_REFUSAL =
  "This looks like the account's MEGA recovery key, which is its master key: it is not read into the conversation.";

export function registerCat(server: McpServer, rt: Runtime, allowed?: () => boolean): RegisteredTool {
  const tool: RegisteredTool = server.registerTool(
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
        // Consent is re-checked on every read: turning file reading off in another
        // server process (or another conversation) must stop this one too.
        const refused = () => {
          if (!allowed || allowed()) return null;
          tool.disable();
          return err('Reading file contents was turned off. Ask the user, then call mega_file_reading to turn it on again.');
        };
        const off = refused();
        if (off) return off;
        // One file per read: a wildcard is listed with mega_find, then each match read by its path.
        const rp = assertNoWildcard(assertNotStoreCopy(assertRemotePath(remotePath)), 'remotePath');
        // The recovery key IS the master key: MEGA saves it as MEGA-RECOVERYKEY.txt (or its translation).
        if (isRecoveryKeyName(posix.basename(rp))) {
          return err(RECOVERY_KEY_REFUSAL, { remotePath: rp });
        }
        // Same-named files would print as one joined text, defeating the reader and the key check.
        // Counted and read with no copy or move in between (a copy could add a same-named file).
        const { same, r } = await withWriteLock(async () => {
          const same = await sameNamed(rt, rp);
          // Asked again after the wait for the lock (a long transfer may hold it).
          if (same.count < 0 || same.count > 1 || refused()) return { same, r: null };
          return { same, r: await rt.run('cat', [rp], { maxBuffer: Math.min(maxBytes ?? DEFAULT_MAX, HARD_MAX) }) };
        });
        // ...and once more for a read that was turned off while it ran.
        const late = refused();
        if (late) return late;
        if (same.count === -1) return err(`Could not check how many files are named ${rp}; nothing was read.`, { remotePath: rp });
        if (same.count > 1) {
          return err(
            `${same.count} files are named ${rp} (or match it as a pattern); MEGAcmd would print all of them as one text. List them with mega_find or mega_ls and read each one by its own path (files that share one exact name need one renamed first).`,
            { remotePath: rp },
          );
        }
        const cap = Math.min(maxBytes ?? DEFAULT_MAX, HARD_MAX);
        if (!r) return err(`Could not read ${rp}.`, { remotePath: rp });
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
        // ...and under any name: a line that is just a mixed-case 22-character base64url key.
        if (r.stdout.split(/\r?\n/).some((l) => looksLikeRecoveryKey(l.trim()))) return err(RECOVERY_KEY_REFUSAL, { remotePath: rp });
        // A file that is only one 22-character token is refused in any case (keys can be one case).
        if (/^[A-Za-z0-9_-]{22}$/.test(r.stdout.trim())) return err(RECOVERY_KEY_REFUSAL, { remotePath: rp });
        // Text only, no structuredContent: ok() mirrors the text into it, which
        // would send every file twice (up to 2x the byte cap) for no benefit.
        return { content: [{ type: 'text', text: r.stdout.length ? r.stdout : '(empty file)' }] };
      }),
  );
  return tool;
}
