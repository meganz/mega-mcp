/**
 * Opt-in extraction of the account-detail blocks from `mega-whoami -l`.
 *
 * These DELIBERATELY surface blocks that the strict plan parser (account.ts)
 * drops: the active-session list and the balance / payment history. They are
 * the user's OWN login metadata and financial info — privacy-sensitive PII, but
 * NOT an account-compromise risk — so the tools that use them are gated behind
 * `exposeAccountDetails` (default off).
 *
 * Crucially, the resumable login KEY is never present in `whoami -l` output at
 * all (it appears only in `logout -k` / `session`, which we never run), so it
 * cannot leak here. The "Session ID" surfaced is the killSession HANDLE.
 *
 * Each extractor bounds its region so the two never overlap: the balance block
 * stops BEFORE "Current Active Sessions:", and the session block starts AT it.
 */

const SESSION_HEADER = /^\s*Current Active Sessions:/i;
const BALANCE_START = /^\s*(Account balance:|Subscription type:)/i;
// Any line that smells like the START of the session block, used as a
// fail-closed boundary for the balance extractor (don't rely only on the exact
// header wording).
const SESSION_BOUNDARY = /^\s*(Current Active Sessions:|Session ID:|\* Current Session)/i;
// Belt-and-suspenders: the resumable login key never appears in `whoami -l`
// output (only in `logout -k` / `session`, which we never run). Scrub any line
// that looks like it carries one, so a future format change can't leak it.
const SECRET_LINE = /login with the session|dumpSession/i;

/** Lines from the balance/subscription header up to (excluding) the session block. */
export function extractBalanceBlock(stdout: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of stdout.split(/\r?\n/)) {
    if (SESSION_BOUNDARY.test(raw)) break; // fail-closed: never cross into sessions
    if (!inBlock && BALANCE_START.test(raw)) inBlock = true;
    if (inBlock && raw.trim() !== '' && !SECRET_LINE.test(raw)) out.push(raw.replace(/\s+$/, ''));
  }
  return out.join('\n');
}

/** Lines from "Current Active Sessions:" to the end (handles + IP/geo/UA). */
export function extractSessionsBlock(stdout: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of stdout.split(/\r?\n/)) {
    if (SESSION_HEADER.test(raw)) inBlock = true;
    if (inBlock && raw.trim() !== '' && !SECRET_LINE.test(raw)) out.push(raw.replace(/\s+$/, ''));
  }
  return out.join('\n');
}
