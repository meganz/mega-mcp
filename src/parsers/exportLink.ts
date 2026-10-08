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

/**
 * The link `export -a` made: MEGAcmd prints "Exported <path>: <link>" (then an optional
 * " expires at <time>"). Only the LAST ": https://" counts - the path before it is a node name,
 * which may itself hold text shaped like a link, even across a line break.
 */
export function parseCreatedLink(raw: string, path?: string): string | undefined {
  // With the node's path known (as MEGAcmd prints it): the word right after "Exported <path>: ".
  if (path !== undefined) {
    const prefix = `Exported ${path.startsWith('//from/') ? path.slice('//from/'.length) : path}: `;
    const i = raw.indexOf(prefix);
    return i === 0 || (i > 0 && raw[i - 1] === '\n') ? raw.slice(i + prefix.length).split(/\s/)[0] : undefined;
  }
  const from = raw.search(/^Exported /m);
  if (from < 0) return undefined;
  // (Before the AuthToken line, if any; a name with a line break cannot put a link after the real one.)
  const head = raw.slice(from).split(/\r?\n {2,}AuthToken = /)[0] as string;
  const at = head.lastIndexOf(': https://');
  return at < 0 ? undefined : head.slice(at + 2).split(/\s/)[0];
}
