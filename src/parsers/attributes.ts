/**
 * Attribute listings with anything key-like taken out before they reach the model.
 *
 * Both MEGAcmd listings print values verbatim. Rule 1 of SECURITY.md - no tool
 * returns key material - therefore needs an explicit filter here, not trust in
 * what MEGAcmd happens to store in an attribute.
 */

export interface Filtered {
  text: string;
  hidden: number;
}

/**
 * `attr <node>`: custom attributes, then an "Official attributes:" section. The
 * only official attribute today is `s4`, the S4 container configuration, which can
 * hold the container's access key and secret key (MCP-3). The whole official
 * section is dropped - including any official attribute MEGAcmd adds later - and
 * any `s4 = ` line in case the header changes.
 */
export function hideNodeSecrets(stdout: string): Filtered {
  const lines = stdout.split(/\r?\n/);
  const official = lines.findIndex((l) => l.trim() === 'Official attributes:');
  const head = official === -1 ? lines : lines.slice(0, official);
  const kept = head.filter((l) => !/^\s*s4\s*=/.test(l));
  const hidden = (official === -1 ? 0 : lines.slice(official + 1).filter((l) => l.trim()).length) + (head.length - kept.length);
  return { text: kept.join('\n').trimEnd(), hidden };
}

/**
 * `userattr [--user=]`: one line per attribute, `\t<long name> (<name>) = <value>`.
 * Only plain profile attributes (a name without a scope prefix: firstname,
 * lastname, country, birthday...) keep their value. Prefixed names are private
 * (`*` encrypted, `^` private), protected (`#`) or key records (`+` public keys,
 * signatures), and the keyring among them holds private keys, so they are dropped.
 * A `--list` listing has no values and passes unchanged.
 */
export function hideUserSecrets(stdout: string): Filtered {
  let hidden = 0;
  const kept = stdout.split(/\r?\n/).filter((line) => {
    const m = line.match(/\(([^()]*)\)\s*=/);
    if (!m) return true;
    if (/^[A-Za-z]+$/.test(m[1] as string)) return true;
    hidden++;
    return false;
  });
  return { text: kept.join('\n').trimEnd(), hidden };
}
