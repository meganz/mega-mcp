import { describe, it, expect } from 'vitest';
import { parseWhoami } from '../src/parsers/whoami.js';

describe('parseWhoami', () => {
  it('extracts the account email (logged in)', () => {
    expect(parseWhoami('Account e-mail: alice@example.com\n')).toBe('alice@example.com');
  });

  it('tolerates extra surrounding lines and casing', () => {
    const out = 'Some banner\nAccount E-mail:   bob@mega.nz  \nStorage: ...\n';
    expect(parseWhoami(out)).toBe('bob@mega.nz');
  });

  it('returns undefined when no email present (e.g. not logged in stderr only)', () => {
    expect(parseWhoami('')).toBeUndefined();
    expect(parseWhoami('Not logged in.')).toBeUndefined();
  });
});
