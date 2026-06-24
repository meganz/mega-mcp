import { describe, it, expect } from 'vitest';
import { capLines } from '../src/parsers/listing.js';
import { parseDf } from '../src/parsers/df.js';
import { parseExportLink } from '../src/parsers/exportLink.js';

describe('capLines', () => {
  it('drops blank lines and counts entries', () => {
    const r = capLines('a\n\nb\n  \nc\n', 100);
    expect(r.total).toBe(3);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe('a\nb\nc');
  });

  it('caps to max and flags truncation', () => {
    const raw = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const r = capLines(raw, 4);
    expect(r.total).toBe(10);
    expect(r.truncated).toBe(true);
    expect(r.text.split('\n')).toHaveLength(4);
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
