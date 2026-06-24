import { describe, it, expect } from 'vitest';
import { ExitCode, classifyExit, stripPrefix, firstStderrLine, redact } from '../src/errors.js';

describe('stripPrefix', () => {
  it('removes MEGAcmd timestamped prefixes', () => {
    expect(stripPrefix('[err: 14:05:19] Not logged in.')).toBe('Not logged in.');
    expect(stripPrefix('[API:err: 09:00:00] boom')).toBe('boom');
  });
  it('leaves unprefixed lines intact', () => {
    expect(stripPrefix('plain message')).toBe('plain message');
  });
});

describe('firstStderrLine', () => {
  it('returns the first non-empty stripped line', () => {
    expect(firstStderrLine('\n[err: 1] first\n[err: 2] second')).toBe('first');
  });
  it('returns empty string for blank stderr', () => {
    expect(firstStderrLine('\n\n')).toBe('');
  });
});

describe('classifyExit', () => {
  it('returns empty for success', () => {
    expect(classifyExit({ code: ExitCode.OK, stderr: '' })).toBe('');
  });

  it('maps not-logged-in to the out-of-band login instruction', () => {
    const msg = classifyExit({ code: ExitCode.NOTLOGGEDIN, stderr: '[err: 1] Not logged in.' });
    expect(msg).toMatch(/interactive shell/);
  });

  it('maps not-found and appends stderr detail', () => {
    const msg = classifyExit({ code: ExitCode.NOTFOUND, stderr: '[err: 1] /foo not found' });
    expect(msg).toContain('Not found.');
    expect(msg).toContain('/foo not found');
  });

  it('handles spawn failure (binary missing)', () => {
    const msg = classifyExit({ code: -1, stderr: '', spawnError: 'ENOENT' });
    expect(msg).toMatch(/not available|Install MEGAcmd/i);
  });

  it('falls back to stderr for unknown codes (exit-code drift safety)', () => {
    const msg = classifyExit({ code: 199, stderr: '[err: 1] weird failure' });
    expect(msg).toContain('weird failure');
  });

  it('maps a timeout to a retry-suggesting message (never empty/success)', () => {
    const msg = classifyExit({ code: -1, stderr: '', timedOut: true });
    expect(msg).toMatch(/timed out/i);
  });

  it('maps maxBuffer overflow to an "output too large" message', () => {
    const msg = classifyExit({ code: -1, stderr: '', maxBufferExceeded: true });
    expect(msg).toMatch(/too large/i);
  });

  it('redacts long opaque tokens embedded in stderr detail', () => {
    const token = 'abcDEF1234567890abcDEF1234567890abcDEF1234567890';
    const msg = classifyExit({ code: ExitCode.NOTFOUND, stderr: `[err: 1] boom ${token}` });
    expect(msg).not.toContain(token);
  });
});

describe('redact', () => {
  it('redacts long opaque tokens and session lines', () => {
    const out = redact('session: abcDEF1234567890abcDEF1234567890abcDEF1234567890');
    expect(out).not.toContain('abcDEF1234567890abcDEF1234567890');
    expect(out).toMatch(/redacted/);
  });
});
