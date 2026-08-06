import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireMegacmd, sanitizeVersion, verifyResolvedBinary } from '../src/download/megacmd.js';
import type { Config } from '../src/types.js';

// A FRESH temp dir cannot contain a MEGAcmd install, on any platform. The old
// fixture used the literal '/nonexistent/MEGAcmd.app/Contents/MacOS', which is
// only impossible on posix: on Windows it is drive-relative and resolves to
// C:\nonexistent\..., a directory that can genuinely exist — and where one did,
// findWindowsInstall() matched it and acquireMegacmd short-circuited ok:true
// before ever reaching the guard under test.
const NO_INSTALL = join(mkdtempSync(join(tmpdir(), 'mega-noinstall-')), 'MEGAcmd.app', 'Contents', 'MacOS');
process.on('exit', () => rmSync(join(NO_INSTALL, '..', '..', '..'), { recursive: true, force: true }));

const baseCfg = (download: Config['download']): Config => ({
  cacheDir: join(tmpdir(), 'mega-cloud-mcp-test-cache'),
  systemAppBinDirs: [NO_INSTALL],
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

/**
 * The Windows integrity gate. Unlike macOS there is no bundle seal — the server
 * and the client are two loose files in a directory the unprivileged user can
 * write at the stock %LOCALAPPDATA%\MEGAcmd location. The gate used to check only
 * MEGAcmdServer.exe while the connector launches MEGAclient.exe, so swapping the
 * client and leaving the signed server alone passed.
 *
 * Needs a real signed install to assert against; skipped where there isn't one.
 */
const WIN_INSTALL = join(process.env.LOCALAPPDATA ?? '', 'MEGAcmd');
const hasWinInstall =
  process.platform === 'win32' &&
  existsSync(join(WIN_INSTALL, 'MEGAcmdServer.exe')) &&
  existsSync(join(WIN_INSTALL, 'MEGAclient.exe'));

describe.runIf(hasWinInstall)('verifyResolvedBinary (win32 Authenticode)', () => {
  const server = join(WIN_INSTALL, 'MEGAcmdServer.exe');
  const client = join(WIN_INSTALL, 'MEGAclient.exe');
  const base = { binDir: WIN_INSTALL, serverBin: server, clientBin: client, source: 'system' };

  it('accepts a genuine install (both binaries)', async () => {
    expect(await verifyResolvedBinary(base, {})).toBe(true);
  });

  it('REJECTS a swapped client even when the server is genuinely signed', async () => {
    // mega-whoami.bat is a real file in the same dir and carries no signature —
    // it stands in for an attacker-replaced MEGAclient.exe.
    const unsigned = join(WIN_INSTALL, 'mega-whoami.bat');
    expect(existsSync(unsigned)).toBe(true);
    expect(await verifyResolvedBinary({ ...base, clientBin: unsigned }, {})).toBe(false);
  });

  it('enforces MEGA_MCP_WIN_THUMBPRINT at launch time, not just on the installer', async () => {
    // The pin used to be dropped on this path entirely, so an operator who set it
    // got no launch-time protection at all. A wrong pin must fail closed.
    expect(await verifyResolvedBinary(base, { winThumbprint: '0'.repeat(40) })).toBe(false);
  });
});

