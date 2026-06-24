import { describe, it, expect } from 'vitest';
import { isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import {
  assertRemotePath,
  assertOptionalRemotePath,
  assertLocalPath,
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
