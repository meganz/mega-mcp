import { describe, it, expect } from 'vitest';
import { acquireMegacmd, sanitizeVersion } from '../src/download/megacmd.js';
import type { Config } from '../src/types.js';

const baseCfg = (download: Config['download']): Config => ({
  cacheDir: '/tmp/mega-cloud-mcp-test-cache',
  // point the "standard install" probe at a path that doesn't exist, so the
  // detect-existing short-circuit never fires in tests (env-independent).
  systemAppBinDirs: ['/nonexistent/MEGAcmd.app/Contents/MacOS'],
  download,
  maxListLines: 1000,
  exposeContacts: false,
  exposeAccountDetails: false,
  exposeFileContents: false,
});

describe('acquireMegacmd safety guards', () => {
  it('refuses when no URL is configured (or unsupported OS)', async () => {
    const res = await acquireMegacmd(baseCfg({ url: undefined, sha256Allow: [] }));
    expect(res.ok).toBe(false);
    // darwin: no_url; other platforms short-circuit earlier with unsupported_os.
    expect(['no_url', 'unsupported_os']).toContain(res.reason);
  });

  it('refuses a non-MEGA download host (host pin); hash pin is optional, signature is the gate', async () => {
    // Policy change: an empty SHA-256 allowlist no longer hard-fails — the
    // Developer-ID/Authenticode signature is the mandatory gate, the hash is
    // optional rollback protection. The host allowlist still rejects pre-download.
    const res = await acquireMegacmd(baseCfg({ url: 'https://evil.example.com/MEGAcmdSetup.dmg', sha256Allow: [] }));
    expect(res.ok).toBe(false);
    // darwin: host pin throws before any download -> 'network'; other OSes short-circuit unsupported_os.
    expect(['network', 'unsupported_os']).toContain(res.reason);
  });
});

describe('sanitizeVersion', () => {
  it('keeps normal version strings', () => {
    expect(sanitizeVersion('2.5.2')).toBe('2.5.2');
  });
  it('neutralizes path traversal and separators', () => {
    expect(sanitizeVersion('../../etc')).toBe('unknown');
    expect(sanitizeVersion('a/b')).toBe('a_b');
    expect(sanitizeVersion('')).toBe('unknown');
  });
});

