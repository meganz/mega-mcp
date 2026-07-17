import { describe, it, expect } from 'vitest';
import { isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import {
  assertRemotePath,
  assertOptionalRemotePath,
  assertLocalPath,
  assertConstraint,
  ValidationError,
} from '../src/paths.js';

describe('assertRemotePath', () => {
  it('accepts an absolute MEGA path', () => {
    expect(assertRemotePath('/Photos/2024')).toBe('/Photos/2024');
  });

  it('trims surrounding whitespace', () => {
    expect(assertRemotePath('  /a/b  ')).toBe('/a/b');
  });

  it('rejects a relative path (also blocks flag-injection)', () => {
    expect(() => assertRemotePath('Photos')).toThrow(ValidationError);
    expect(() => assertRemotePath('-rf')).toThrow(ValidationError);
  });

  it('rejects an empty path', () => {
    expect(() => assertRemotePath('   ')).toThrow(ValidationError);
  });

  it('rejects a NUL byte', () => {
    expect(() => assertRemotePath(`/a${String.fromCharCode(0)}b`)).toThrow(/NUL/);
  });
});

describe('assertOptionalRemotePath', () => {
  it('passes through undefined', () => {
    expect(assertOptionalRemotePath(undefined)).toBeUndefined();
  });
  it('validates a provided value', () => {
    expect(() => assertOptionalRemotePath('rel')).toThrow(ValidationError);
  });
});

describe('assertConstraint (mtime/size)', () => {
  it('allows the "within the last N" form that starts with "-" (the old bug)', () => {
    expect(assertConstraint('-7d', 'mtime')).toBe('-7d');
    expect(assertConstraint('-100K', 'size')).toBe('-100K');
  });
  it('allows combined units and two-sided ranges', () => {
    expect(assertConstraint('+1m12d3h', 'mtime')).toBe('+1m12d3h');
    expect(assertConstraint('-3d+1h', 'mtime')).toBe('-3d+1h');
    expect(assertConstraint('-4M+100K', 'size')).toBe('-4M+100K');
    expect(assertConstraint('+5y', 'mtime')).toBe('+5y');
  });
  it('rejects empty, NUL, whitespace, and shell-metacharacter garbage', () => {
    expect(() => assertConstraint('  ', 'mtime')).toThrow(ValidationError);
    expect(() => assertConstraint(`-7${String.fromCharCode(0)}d`, 'mtime')).toThrow(/NUL/);
    expect(() => assertConstraint('-7 d', 'mtime')).toThrow(ValidationError);
    expect(() => assertConstraint('-7d; rm -rf /', 'mtime')).toThrow(ValidationError);
  });
});

describe('assertLocalPath', () => {
  it('resolves to an absolute path', () => {
    expect(isAbsolute(assertLocalPath('some/dir'))).toBe(true);
  });
  it('rejects empty and NUL', () => {
    expect(() => assertLocalPath('  ')).toThrow(ValidationError);
    expect(() => assertLocalPath(`a${String.fromCharCode(0)}b`)).toThrow(/NUL/);
  });
  it('refuses paths inside the MEGAcmd config dir (~/.megaCmd)', () => {
    const inside = `${homedir()}/.megaCmd/session`;
    expect(() => assertLocalPath(inside)).toThrow(/configuration directory/i);
  });
});
