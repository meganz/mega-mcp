import { describe, it, expect } from 'vitest';
import { capLines, decodeCursor, encodeCursor, pageInfo, headerRowsUpTo, MAX_LISTING_CHARS } from '../src/parsers/listing.js';
import { parseDf } from '../src/parsers/df.js';
import { parseExportLink } from '../src/parsers/exportLink.js';

describe('capLines', () => {
  it('drops blank lines and counts entries', () => {
    const r = capLines('a\n\nb\n  \nc\n', 100);
    expect(r.total).toBe(3);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe('a\nb\nc');
    expect(r.shown).toBe(3);
    expect(r.nextOffset).toBeNull();
  });

  it('caps to max and flags truncation', () => {
    const raw = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const r = capLines(raw, 4);
    expect(r.total).toBe(10);
    expect(r.truncated).toBe(true);
    expect(r.text.split('\n')).toHaveLength(4);
    expect(r.shown).toBe(4);
    expect(r.nextOffset).toBe(4);
  });

  it('pages from an offset and reports the end of the listing', () => {
    const raw = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const page2 = capLines(raw, 4, 4); // rows 4..7
    expect(page2.text).toBe('line4\nline5\nline6\nline7');
    expect(page2.offset).toBe(4);
    expect(page2.nextOffset).toBe(8);
    const page3 = capLines(raw, 4, 8); // rows 8..9, last page
    expect(page3.text).toBe('line8\nline9');
    expect(page3.shown).toBe(2);
    expect(page3.truncated).toBe(false);
    expect(page3.nextOffset).toBeNull();
  });

  it('enforces the character ceiling below the line cap for wide rows', () => {
    const wide = 'x'.repeat(5000);
    const raw = Array.from({ length: 100 }, () => wide).join('\n'); // 100 rows, way under a big line cap
    const r = capLines(raw, 1000); // line cap won't bind; char cap must
    expect(r.text.length).toBeLessThanOrEqual(MAX_LISTING_CHARS);
    expect(r.shown).toBeLessThan(100);
    expect(r.truncated).toBe(true);
    expect(r.nextOffset).toBe(r.shown);
  });

  it('always emits at least one row even if it alone exceeds the char budget (no livelock)', () => {
    const monster = 'y'.repeat(MAX_LISTING_CHARS + 1000);
    const r = capLines(`${monster}\ntail`, 1000);
    expect(r.shown).toBe(1);
    expect(r.text).toBe(monster);
    expect(r.nextOffset).toBe(1); // paging still advances past the monster row
  });

  it('clamps an out-of-range offset to the end', () => {
    const raw = 'a\nb\nc';
    const r = capLines(raw, 10, 99);
    expect(r.offset).toBe(3);
    expect(r.shown).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.nextOffset).toBeNull();
  });

  it('headerRows: excludes the header from the count and keeps it on every page', () => {
    const raw = ['HEADER', 'f0', 'f1', 'f2', 'f3', 'f4'].join('\n'); // 1 header + 5 data
    const p1 = capLines(raw, 2, 0, 1);
    expect(p1.total).toBe(5); // header NOT counted
    expect(p1.text).toBe('HEADER\nf0\nf1'); // header prepended
    expect(p1.shown).toBe(2);
    expect(p1.nextOffset).toBe(2);
    const p2 = capLines(raw, 2, 2, 1);
    expect(p2.text).toBe('HEADER\nf2\nf3'); // header re-prepended on page 2
    expect(p2.offset).toBe(2);
  });

  it('headerRows: an empty listing (header only) reports total 0', () => {
    const r = capLines('FLAGS VERS SIZE DATE NAME', 100, 0, 1);
    expect(r.total).toBe(0); // header-only => no entries (fixes the off-by-one)
    expect(r.shown).toBe(0);
    expect(r.truncated).toBe(false);
  });
});

describe('headerRowsUpTo (version-robust ls header detection)', () => {
  it('counts through the FLAGS header when there is NO path-label line (MEGAcmd 2.5.2)', () => {
    expect(headerRowsUpTo('FLAGS VERS SIZE DATE NAME\nrow1\nrow2', 'FLAGS')).toBe(1);
  });
  it('counts through a "<path>:" label line before the FLAGS header (other versions)', () => {
    expect(headerRowsUpTo('/mega-selftest/src:\nFLAGS VERS SIZE DATE NAME\nrow1', 'FLAGS')).toBe(2);
  });
  it('returns 0 when the marker is absent', () => {
    expect(headerRowsUpTo('just\nsome\nlines', 'FLAGS')).toBe(0);
  });

  // The exact failure the user reported: an empty folder whose ls output is a
  // "<path>:" label + FLAGS header must count as 0 entries, not 1.
  it('fixes the reported off-by-one: label + header, no rows => entryCount 0', () => {
    const raw = '/mega-selftest-empty:\nFLAGS VERS SIZE DATE NAME';
    const cap = capLines(raw, 200, 0, headerRowsUpTo(raw, 'FLAGS'));
    expect(cap.total).toBe(0);
    expect(cap.shown).toBe(0);
  });
  it('fixes the reported off-by-one: label + header + 4 rows => entryCount 4', () => {
    const raw = ['/mega-selftest/src:', 'FLAGS VERS SIZE DATE NAME', 'a', 'b', 'c', 'd'].join('\n');
    const cap = capLines(raw, 200, 0, headerRowsUpTo(raw, 'FLAGS'));
    expect(cap.total).toBe(4);
    expect(cap.text.startsWith('/mega-selftest/src:\nFLAGS')).toBe(true); // both header lines kept
  });
});

describe('page cursor', () => {
  it('round-trips an offset through the opaque token', () => {
    expect(decodeCursor(encodeCursor(0))).toBe(0);
    expect(decodeCursor(encodeCursor(200))).toBe(200);
    expect(encodeCursor(200)).not.toBe('200'); // opaque, not the bare number
  });

  it('tolerates a bare integer offset', () => {
    expect(decodeCursor('400')).toBe(400);
  });

  it('returns null for a malformed token', () => {
    expect(decodeCursor('not-a-token!!')).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });
});

describe('pageInfo', () => {
  it('emits a nextPageToken and a follow-up hint while rows remain', () => {
    const cap = capLines(Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n'), 4);
    const { note, fields } = pageInfo(cap, 'entries', 'mega_ls');
    expect(fields.nextPageToken).toBe(encodeCursor(4));
    expect(fields.truncated).toBe(true);
    expect(note).toContain('more remain');
    expect(note).toContain('mega_ls');
  });

  it('omits the token on the final (offset 0, complete) page', () => {
    const cap = capLines('a\nb', 10);
    const { note, fields } = pageInfo(cap, 'entries', 'mega_ls');
    expect(fields.nextPageToken).toBeUndefined();
    expect(note).toBe('');
  });
});

describe('parseDf (best-effort)', () => {
  it('extracts key/value lines', () => {
    const out = parseDf('USED STORAGE: 1.50 GB\nTOTAL: 50 GB\ngarbage line\n');
    expect(out['USED STORAGE']).toBe('1.50 GB');
    expect(out['TOTAL']).toBe('50 GB');
  });
});

describe('parseExportLink', () => {
  it('prefers a mega.nz link regardless of column position', () => {
    const out = 'Exported /f/x: https://mega.nz/folder/abc#KEY (took 0.1s)';
    expect(parseExportLink(out)).toBe('https://mega.nz/folder/abc#KEY');
  });
  it('returns undefined when no URL present', () => {
    expect(parseExportLink('no link here')).toBeUndefined();
  });
});
