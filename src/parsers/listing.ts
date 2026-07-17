/**
 * Hard character ceiling for a single capped listing page, independent of the
 * line cap. A listing already within the line cap can still be enormous when
 * rows are wide (long S4 object keys, RFC2822 timestamps, node handles): ~1000
 * `ls -l` rows was observed at ~125k characters, overflowing the tool response
 * and flooding the model context. The char budget bounds a page so wide rows
 * can't blow up regardless of the row COUNT.
 */
export const MAX_LISTING_CHARS = 30_000;

export interface CappedListing {
  /** The kept lines for this page, joined with "\n". */
  text: string;
  /** Total non-empty lines in the full listing (before paging). */
  total: number;
  /** Lines actually returned in this page. */
  shown: number;
  /** Starting line offset of this page (clamped into range). */
  offset: number;
  /** Whether more lines remain beyond this page (line cap OR char cap hit). */
  truncated: boolean;
  /** Line offset to request for the next page, or null when this is the last. */
  nextOffset: number | null;
}

/**
 * Cap a plain-text listing (e.g. `mega-ls -l`, `mega-find`) to a single page:
 * at most `max` non-empty lines AND at most MAX_LISTING_CHARS characters,
 * starting at data-line `offset`. Two bounds, not one — the line cap keeps the
 * row COUNT sane; the char cap keeps a page of very wide rows from overflowing
 * the tool response regardless of line count (HARD CONSTRAINT 4). At least one
 * data line is always emitted (even if it alone exceeds the char budget) so
 * paging can never livelock on a single monster row.
 *
 * `headerRows` (0 by default) are leading lines that are NOT data — the `ls -l`
 * column header, or the `tree` root-node line. They are excluded from `total`
 * (so counts reflect real entries, not the header), never subject to `offset`,
 * and re-prepended to EVERY page (so a column header isn't lost on page 2+).
 * Format-agnostic otherwise.
 */
export function capLines(raw: string, max: number, offset = 0, headerRows = 0): CappedListing {
  const all = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '');
  const header = headerRows > 0 ? all.slice(0, headerRows) : [];
  const data = headerRows > 0 ? all.slice(headerRows) : all;
  const total = data.length;
  const start = Math.min(Math.max(Math.trunc(offset) || 0, 0), total);

  const page: string[] = [];
  let chars = header.reduce((n, l) => n + l.length + 1, 0); // header counts toward the char budget
  let i = start;
  for (; i < total && page.length < max; i++) {
    const line = data[i] as string;
    const added = line.length + 1; // +1 for the join newline
    if (page.length > 0 && chars + added > MAX_LISTING_CHARS) break;
    page.push(line);
    chars += added;
  }
  const nextOffset = i < total ? i : null;
  return {
    text: header.concat(page).join('\n'),
    total,
    shown: page.length,
    offset: start,
    truncated: nextOffset !== null,
    nextOffset,
  };
}

/**
 * How many leading lines of a header-bearing listing are NOT data rows:
 * everything up to AND INCLUDING the first line beginning with `marker`. For
 * `ls -l` the data rows follow the `FLAGS VERS SIZE DATE NAME` header, but some
 * MEGAcmd versions also print a `<path>:` label line before it — so the count is
 * 1 or 2 (or 0 when the marker is absent), never a hardcoded constant. Uses the
 * same empty-line filtering as capLines so the returned count lines up exactly
 * with capLines's `headerRows` argument.
 */
export function headerRowsUpTo(raw: string, marker: string): number {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '');
  const idx = lines.findIndex((l) => l.startsWith(marker));
  return idx >= 0 ? idx + 1 : 0;
}

/**
 * Opaque page cursor <-> line offset. Encoded (base64url) so callers treat it as
 * a token — like Google Drive's pageToken — rather than doing arithmetic on it.
 * Decoding is tolerant: a bare integer offset also works, so an agent that
 * passes the raw number instead of the token still pages correctly. Returns null
 * for a malformed token (the tool then asks the caller to omit it).
 */
export function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

export function decodeCursor(token: string): number | null {
  const raw = token.trim();
  if (raw === '') return null;
  if (/^\d+$/.test(raw)) return Number(raw); // tolerant: accept a bare offset
  try {
    const m = Buffer.from(raw, 'base64url').toString('utf8').match(/^o:(\d+)$/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Build the trailing "(showing X of Y …)" note and the structured paging fields
 * for a paginated listing tool. Emits a `nextPageToken` (and a hint to call the
 * tool again with it) only while more rows remain.
 */
export function pageInfo(
  cap: CappedListing,
  unit: string,
  toolName: string,
): { note: string; fields: Record<string, unknown> } {
  const nextPageToken = cap.nextOffset !== null ? encodeCursor(cap.nextOffset) : undefined;
  let note = '';
  if (cap.truncated) {
    note = `\n\n(showing ${cap.shown} of ${cap.total} ${unit}, from #${cap.offset + 1}; more remain — call ${toolName} again with pageToken "${nextPageToken}" for the next page)`;
  } else if (cap.offset > 0) {
    note = `\n\n(showing ${cap.shown} of ${cap.total} ${unit}, from #${cap.offset + 1}; end of listing)`;
  }
  const fields: Record<string, unknown> = { shown: cap.shown, offset: cap.offset, truncated: cap.truncated };
  if (nextPageToken) fields.nextPageToken = nextPageToken;
  return { note, fields };
}
