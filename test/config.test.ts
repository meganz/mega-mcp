import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, defaultCacheDir } from '../src/config.js';

describe('cacheDir resolution', () => {
  it('uses MEGA_MCP_CACHE_DIR (the extension dir) when writable, creating it', () => {
    const base = mkdtempSync(join(tmpdir(), 'mega-cfg-'));
    const target = join(base, 'megacmd');
    const cfg = loadConfig({ MEGA_MCP_CACHE_DIR: target } as NodeJS.ProcessEnv);
    expect(cfg.cacheDir).toBe(target);
    expect(existsSync(target)).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });

  it('falls back to the per-user cache when the configured dir is not creatable', () => {
    // A child OF A REGULAR FILE is uncreatable (ENOTDIR) on every platform. The
    // old fixture used '/dev/null/nope', which is only uncreatable on posix: on
    // Windows it is a drive-relative path that mkdir happily creates at
    // C:\dev\null\nope, so the fallback never fired and the test littered the disk.
    const base = mkdtempSync(join(tmpdir(), 'mega-cfg-'));
    const file = join(base, 'a-file');
    writeFileSync(file, 'x');
    try {
      const cfg = loadConfig({ MEGA_MCP_CACHE_DIR: join(file, 'nope') } as NodeJS.ProcessEnv);
      expect(cfg.cacheDir).toBe(defaultCacheDir());
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('uses the per-user cache when unset', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.cacheDir).toBe(defaultCacheDir());
  });
});

describe('exposeContacts flag (PII gate)', () => {
  const expose = (v?: string) =>
    loadConfig({ ...(v === undefined ? {} : { MEGA_MCP_EXPOSE_CONTACTS: v }) } as NodeJS.ProcessEnv).exposeContacts;

  it('defaults to OFF when unset', () => {
    expect(expose(undefined)).toBe(false);
  });

  it('is OFF for an unsubstituted manifest token', () => {
    expect(expose('${user_config.expose_contacts}')).toBe(false);
  });

  it('enables only on explicit truthy values', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) expect(expose(v)).toBe(true);
  });

  it('stays OFF for falsy / junk values', () => {
    for (const v of ['', '0', 'false', 'no', 'off', 'maybe', '2']) expect(expose(v)).toBe(false);
  });
});

describe('exposeAccountDetails flag (account PII gate)', () => {
  const expose = (v?: string) =>
    loadConfig({ ...(v === undefined ? {} : { MEGA_MCP_EXPOSE_ACCOUNT: v }) } as NodeJS.ProcessEnv).exposeAccountDetails;

  it('defaults to OFF when unset or an unsubstituted token', () => {
    expect(expose(undefined)).toBe(false);
    expect(expose('${user_config.expose_account_details}')).toBe(false);
  });

  it('enables only on explicit truthy values', () => {
    for (const v of ['1', 'true', 'on', 'yes']) expect(expose(v)).toBe(true);
    for (const v of ['', '0', 'false', 'off']) expect(expose(v)).toBe(false);
  });
});
