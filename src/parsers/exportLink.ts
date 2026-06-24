/**
 * Extract the public link from `mega-export -a` output. Rather than relying on
 * the documented "4th whitespace field" column position (brittle), we match the
 * URL directly, preferring a mega.nz link and falling back to any https URL.
 */
export function parseExportLink(raw: string): string | undefined {
  const mega = raw.match(/https?:\/\/mega\.nz\/\S+/i);
  if (mega) return mega[0];
  const any = raw.match(/https?:\/\/\S+/i);
  return any?.[0];
}
