/**
 * ALLOWLIST parser for `mega-whoami -l` (extended account details).
 *
 * `whoami -l` is the ONLY MEGAcmd command that reports the account plan tier
 * (`df` is storage-only). Its output also contains a "Current Active Sessions:"
 * block (session HANDLE + IP / country / user-agent) and balance / purchase /
 * transaction history. We extract ONLY the plan + storage fields below and build
 * a fresh object — the raw stdout is NEVER echoed (HARD CONSTRAINT 2 + 4).
 *
 * This is an ALLOWLIST, deliberately fail-closed: any line we don't explicitly
 * match is dropped, so a future MEGAcmd that adds new sensitive lines still
 * cannot leak them. Safety is contingent on matching PER LINE with ANCHORED,
 * non-dotall regexes (a greedy /(.+)/s over the whole buffer would swallow the
 * trailing session block) — so we split by line and anchor every pattern, and
 * additionally STOP at the session block as defense in depth.
 *
 * Note: `whoami -l` never calls dumpSession(), so the resumable login KEY is not
 * present in this output at all (it appears only in `logout -k` / `session`,
 * which we never run). The "Session ID" it does print is the killSession handle.
 *
 * Field labels & order: meganz/MEGAcmd src/megacmdexecuter.cpp
 * actUponGetExtendedAccountDetails (~line 2252). There is NO transfer-quota line.
 */

/** Pro level integer -> human name (SDK MegaAccountDetails ACCOUNT_TYPE enum). */
const PRO_LEVEL: Record<number, string> = {
  0: 'Free',
  1: 'Pro I',
  2: 'Pro II',
  3: 'Pro III',
  4: 'Pro Lite', // 4 is Lite, NOT "Pro IV"
  11: 'Starter',
  12: 'Basic',
  13: 'Essential',
  100: 'Business',
  101: 'Pro Flexi',
  99999: 'Feature',
};

export interface AccountInfo {
  /** Human-readable plan name (mapped from the integer level). */
  plan?: string;
  /** Raw Pro level integer. */
  proLevel?: number;
  /** Pro expiration date, when present. */
  planExpires?: string;
  /** "Available storage" (total quota). */
  storageTotal?: string;
  /** Per-root storage usage (ROOT / INBOX / RUBBISH), raw value strings. */
  storageByFolder?: Record<string, string>;
  /** Size taken up by file versions, when present. */
  fileVersionsSize?: string;
}

// Defense in depth: even within an allowlisted line, never emit a captured
// value that contains a label from the sensitive blocks. Per-line anchoring
// already prevents cross-line capture; this guards a hypothetical future format
// that appended a sensitive token to an allowlisted line. Dates (which contain
// ':') are unaffected — they carry none of these keywords.
const SENSITIVE = /\b(Session|Balance|IP|Country|User-?Agent|Purchase|Transaction)\b/i;
function safe(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return SENSITIVE.test(value) ? undefined : value;
}

export function parseAccount(stdout: string): AccountInfo {
  const info: AccountInfo = {};
  const byFolder: Record<string, string> = {};

  for (const raw of stdout.split(/\r?\n/)) {
    // Defense in depth: stop before the sensitive session block. Nothing below
    // is allowlisted anyway, but we bail to be doubly safe.
    if (/^\s*Current Active Sessions:/i.test(raw)) break;

    let m: RegExpMatchArray | null;
    if ((m = raw.match(/^\s*Pro level:\s*(\d+)\s*$/i))) {
      const lvl = Number(m[1]);
      info.proLevel = lvl;
      info.plan = PRO_LEVEL[lvl] ?? `Pro level ${lvl}`;
    } else if ((m = raw.match(/^\s*Pro expiration date:\s*(.+?)\s*$/i))) {
      info.planExpires = safe(m[1]);
    } else if ((m = raw.match(/^\s*Available storage:\s*(.+?)\s*$/i))) {
      info.storageTotal = safe(m[1]);
    } else if ((m = raw.match(/^\s*In (ROOT|INBOX|RUBBISH):\s*(.+?)\s*$/i))) {
      // Exact roots only — avoids picking up an optional "In INSHARE <name>:" line.
      const v = safe(m[2]);
      if (v !== undefined) byFolder[(m[1] as string).toUpperCase()] = v;
    } else if ((m = raw.match(/^\s*Total size taken up by file versions:\s*(.+?)\s*$/i))) {
      info.fileVersionsSize = safe(m[1]);
    }
  }

  if (Object.keys(byFolder).length) info.storageByFolder = byFolder;
  return info;
}
