export interface CappedListing {
  /** The kept lines, joined with "\n". */
  text: string;
  /** Total non-empty lines before capping. */
  total: number;
  /** Whether lines were dropped to satisfy the cap. */
  truncated: boolean;
}

/**
 * Cap a plain-text listing (e.g. `mega-ls -l`, `mega-find`) to `max` non-empty
 * lines so we never dump an unbounded listing into the model context
 * (HARD CONSTRAINT 4). Format-agnostic on purpose: we validate the exact
 * column layout of `ls -l` against live output before parsing per-field.
 */
export function capLines(raw: string, max: number): CappedListing {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '');
  const total = lines.length;
  const truncated = total > max;
  const kept = truncated ? lines.slice(0, max) : lines;
  return { text: kept.join('\n'), total, truncated };
}
