import { describe, it, expect } from 'vitest';
import { parseAccount } from '../src/parsers/account.js';
import { extractSessionsBlock, extractBalanceBlock } from '../src/parsers/accountDetails.js';

// Realistic `mega-whoami -l` output (format per meganz/MEGAcmd
// actUponGetExtendedAccountDetails): plan + storage, THEN the sensitive
// balance + Current Active Sessions block we must never surface.
const SAMPLE = [
  'Account e-mail: user@example.com',
  '    Available storage: 400.00 GBytes',
  '        In ROOT:      1.50 GBytes in 10 file(s) and 3 folder(s)',
  '        In INBOX:     0 Bytes in 0 file(s) and 0 folder(s)',
  '        In RUBBISH:   0.20 GBytes in 2 file(s) and 0 folder(s)',
  '        In INSHARE SharedByBob: 9.99 GBytes in 1 file(s) and 0 folder(s)',
  '        Total size taken up by file versions: 0.05 GBytes',
  '    Pro level: 4',
  '        Pro expiration date: Mon, 31 Dec 2026 23:59:59',
  '    Subscription type: S',
  '    Account balance:',
  '    Balance:     Balance: EUR 9.99',
  'Current Active Sessions:',
  '    * Current Session',
  '    Session ID: aBcDeFgSECREThandle123',
  '    Session start: Mon, 01 Jan 2026 00:00:00',
  '    Most recent activity: Mon, 25 Jun 2026 12:00:00',
  '    IP: 203.0.113.7',
  '    Country: NZ',
  '    User-Agent: MEGAcmd/2.5.2',
  '    -----',
  '1 active sessions opened',
].join('\n');

describe('parseAccount allowlist', () => {
  it('extracts plan + storage fields', () => {
    const a = parseAccount(SAMPLE);
    expect(a.plan).toBe('Pro Lite'); // level 4 = Lite, not "Pro IV"
    expect(a.proLevel).toBe(4);
    expect(a.planExpires).toBe('Mon, 31 Dec 2026 23:59:59');
    expect(a.storageTotal).toBe('400.00 GBytes');
    expect(a.storageByFolder?.ROOT).toBe('1.50 GBytes in 10 file(s) and 3 folder(s)');
    expect(a.storageByFolder?.RUBBISH).toBe('0.20 GBytes in 2 file(s) and 0 folder(s)');
    expect(a.fileVersionsSize).toBe('0.05 GBytes');
  });

  it('NEVER surfaces session id, IP, country, UA, balance, or subscription', () => {
    const a = parseAccount(SAMPLE);
    const blob = JSON.stringify(a);
    for (const secret of [
      'aBcDeFgSECREThandle123', // session handle
      '203.0.113.7', // IP
      'EUR 9.99', // balance
      'Country', 'NZ',
      'User-Agent', 'MEGAcmd/2.5.2',
      'Session', 'Subscription',
    ]) {
      expect(blob).not.toContain(secret);
    }
  });

  it('does not capture an "In INSHARE <name>:" line as a root folder', () => {
    const a = parseAccount(SAMPLE);
    expect(a.storageByFolder).toBeDefined();
    // Only the three exact roots, never an inshare folder name.
    expect(Object.keys(a.storageByFolder ?? {}).sort()).toEqual(['INBOX', 'ROOT', 'RUBBISH']);
    expect(JSON.stringify(a)).not.toContain('SharedByBob');
  });

  it('maps an unknown Pro level to a safe fallback', () => {
    const a = parseAccount('    Pro level: 777');
    expect(a.proLevel).toBe(777);
    expect(a.plan).toBe('Pro level 777');
  });

  it('does not leak even when the session block precedes a malformed plan line', () => {
    // Defense-in-depth: scanning stops at "Current Active Sessions:".
    const reordered = [
      'Current Active Sessions:',
      '    Session ID: LEAKME',
      '    Pro level: 1', // appears AFTER the session header -> must be ignored
    ].join('\n');
    const a = parseAccount(reordered);
    expect(JSON.stringify(a)).not.toContain('LEAKME');
    expect(a.proLevel).toBeUndefined();
  });

  it('drops an allowlisted value that smuggles a sensitive token on the same line', () => {
    // Hypothetical future format that appends a session/IP token to a good line.
    const a = parseAccount('    Available storage: 2 TB  Session ID: SNEAKY  IP: 203.0.113.7');
    expect(a.storageTotal).toBeUndefined(); // safe() drops the whole value
    expect(JSON.stringify(a)).not.toContain('SNEAKY');
    expect(JSON.stringify(a)).not.toContain('203.0.113.7');
  });

  it('keeps a date value (colons but no sensitive keyword)', () => {
    const a = parseAccount('        Pro expiration date: Mon, 31 Dec 2026 23:59:59');
    expect(a.planExpires).toBe('Mon, 31 Dec 2026 23:59:59');
  });
});

describe('account-detail block extraction (opt-in tools)', () => {
  it('balance block has financial info but NOT the session block', () => {
    const b = extractBalanceBlock(SAMPLE);
    expect(b).toContain('EUR 9.99');
    expect(b).toContain('Subscription type');
    expect(b).not.toContain('Current Active Sessions');
    expect(b).not.toContain('aBcDeFgSECREThandle123');
    expect(b).not.toContain('203.0.113.7');
    expect(b).not.toContain('Available storage'); // not the plan/storage region
  });

  it('session block has handles/IP but NOT balance', () => {
    const s = extractSessionsBlock(SAMPLE);
    expect(s).toContain('Current Active Sessions');
    expect(s).toContain('aBcDeFgSECREThandle123'); // handle (killSession input) — intended
    expect(s).toContain('203.0.113.7');
    expect(s).not.toContain('EUR 9.99');
    expect(s).not.toContain('Subscription type');
  });

  it('neither block ever contains a resumable session key marker', () => {
    // whoami -l never prints dumpSession(); guard against a future format that does.
    const all = extractSessionsBlock(SAMPLE) + extractBalanceBlock(SAMPLE);
    expect(all.toLowerCase()).not.toContain('login with the session');
  });

  it('scrubs a resumable-session-key line if a future format ever emits one', () => {
    const withKey = SAMPLE + '\n    You can also login with the session id: SECRETKEY123';
    const s = extractSessionsBlock(withKey);
    expect(s).not.toContain('SECRETKEY123');
    expect(s).toContain('aBcDeFgSECREThandle123'); // legitimate handle still shown
  });

  it('balance extractor stops at a session line even without the exact header', () => {
    const weird = ['Subscription type: S', 'Balance: EUR 1.00', 'Session ID: HANDLEX', 'IP: 1.2.3.4'].join('\n');
    const b = extractBalanceBlock(weird);
    expect(b).toContain('EUR 1.00');
    expect(b).not.toContain('HANDLEX');
    expect(b).not.toContain('1.2.3.4');
  });
});
