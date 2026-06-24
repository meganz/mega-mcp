/**
 * Best-effort parse of `mega-df -h` output into key/value pairs (e.g.
 * "USED STORAGE: 1.50 GB"). The exact labels vary by MEGAcmd version, so this
 * is intentionally lenient and the raw (capped) text is always returned too.
 * Validate the label set against live output before relying on specific keys.
 */
export function parseDf(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z][\w .\/-]*?):\s*(.+?)\s*$/);
    if (m && m[1] && m[2]) out[m[1].trim()] = m[2].trim();
  }
  return out;
}
