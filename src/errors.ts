import type { RunResult } from './types.js';

/**
 * MEGAcmd client exit codes. The client negates the internal negative
 * MCMD_* enum to a positive POSIX code, all < 256. Drive control flow off these
 * numbers, never off stderr text.
 */
export const ExitCode = {
  OK: 0,
  EARGS: 51,
  INVALIDEMAIL: 52,
  NOTFOUND: 53,
  INVALIDSTATE: 54,
  INVALIDTYPE: 55,
  NOTPERMITTED: 56,
  NOTLOGGEDIN: 57,
  NOFETCH: 58,
  EUNEXPECTED: 59,
  REQCONFIRM: 60,
  REQSTRING: 61,
  EXISTS: 64,
  REQRESTART: 71,
} as const;

const MESSAGES: Record<number, string> = {
  [ExitCode.EARGS]: 'Invalid arguments.',
  [ExitCode.INVALIDEMAIL]: 'Invalid email address.',
  [ExitCode.NOTFOUND]: 'Not found.',
  [ExitCode.INVALIDSTATE]: 'Invalid state for this operation.',
  [ExitCode.INVALIDTYPE]: 'Invalid node type for this operation.',
  [ExitCode.NOTPERMITTED]: 'Not permitted.',
  [ExitCode.NOTLOGGEDIN]: 'Not logged in. Log in out-of-band in the MEGAcmd interactive shell (login <email>), then retry — call mega_whoami for the exact command.',
  [ExitCode.NOFETCH]: 'Account not yet fetched; try again shortly.',
  [ExitCode.EUNEXPECTED]: 'Unexpected error.',
  [ExitCode.REQCONFIRM]: 'Confirmation required (internal — the wrapper passes -f, so this should not surface).',
  [ExitCode.REQSTRING]: 'Additional input required.',
  [ExitCode.EXISTS]: 'Already exists.',
  [ExitCode.REQRESTART]: 'MEGAcmd requires a restart.',
};

/**
 * Strip MEGAcmd's timestamped diagnostic prefix, e.g.
 *   "[err: 14:05:19] Not logged in." -> "Not logged in."
 *   "[API:err: 09:00:00] ..."        -> "..."
 */
export function stripPrefix(line: string): string {
  return line.replace(/^\[[^\]]*\]\s*/, '').trim();
}

/** First non-empty, prefix-stripped line of stderr (for surfacing context). */
export function firstStderrLine(stderr: string): string {
  for (const raw of stderr.split(/\r?\n/)) {
    const s = stripPrefix(raw);
    if (s) return s;
  }
  return '';
}

/**
 * Defensive redaction for anything we log. Session/credential material should
 * never reach here (we never run -l/session commands), but we belt-and-brace
 * against accidental leakage of long opaque tokens.
 */
export function redact(text: string): string {
  return text
    .replace(/\bsession\b[^\n]*/gi, 'session [redacted]')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]');
}

/**
 * Map an exit code (+ optional stderr) to a user-facing message. Pairs the
 * numeric table with a defensive stderr fallback for unknown/divergent codes.
 */
export function classifyExit(
  result: Pick<RunResult, 'code' | 'stderr' | 'spawnError' | 'timedOut' | 'maxBufferExceeded'>,
): string {
  if (result.maxBufferExceeded) {
    return 'Output too large to return. Narrow the request (a more specific path or pattern).';
  }
  if (result.timedOut) {
    return 'The MEGAcmd command timed out. The server may be busy or still starting; try again shortly.';
  }
  if (result.spawnError === 'INTEGRITY_FAILED') {
    return 'The cached MEGAcmd failed an integrity check. Run the `megacmd_setup` tool to re-download a verified copy.';
  }
  if (result.spawnError) {
    return 'MEGAcmd is not available. Run the `megacmd_setup` tool to download it, or install MEGAcmd / set the MEGAcmd directory in the extension settings.';
  }
  if (result.code === ExitCode.OK) return '';
  const known = MESSAGES[result.code];
  // Redact + length-cap any MEGAcmd stderr before it reaches the model
  // (defense-in-depth for constraint 2, bounded output for constraint 4).
  const detail = redact(firstStderrLine(result.stderr)).slice(0, 200);
  if (known) return detail && result.code !== ExitCode.NOTLOGGEDIN ? `${known} (${detail})` : known;
  return detail ? `MEGAcmd error (${detail}).` : `MEGAcmd error (exit ${result.code}).`;
}
