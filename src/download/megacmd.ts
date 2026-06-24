import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, realpathSync } from 'node:fs';
import { mkdir, rm, copyFile, symlink, unlink, writeFile, access, rename } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from '../types.js';
import { redact } from '../errors.js';

const pExecFile = promisify(execFile);
const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;
const ALLOWED_HOSTS = ['mega.nz', 'mega.io'];
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type AcquireReason =
  | 'unsupported_os'
  | 'no_url'
  | 'network'
  | 'hash_unpinned'
  | 'hash_mismatch'
  | 'signature_failed'
  | 'extract_failed'
  | 'install_pending'
  | 'tool_missing'
  | 'manual_install';

export interface AcquireResult {
  ok: boolean;
  binDir?: string;
  libDir?: string;
  version?: string;
  reason?: AcquireReason;
  detail?: string;
}

/** Whether automatic runtime download is implemented for the current platform. */
export function isAcquireSupported(): boolean {
  return ['darwin', 'win32', 'linux'].includes(process.platform);
}

export async function acquireMegacmd(
  config: Config,
  onProgress: (phase: string) => void = () => {},
): Promise<AcquireResult> {
  switch (process.platform) {
    case 'darwin':
      return acquireDarwin(config, onProgress);
    case 'win32':
      return acquireWindows(config, onProgress);
    case 'linux':
      return acquireLinux();
    default:
      return { ok: false, reason: 'unsupported_os', detail: `Automatic download is not implemented for ${process.platform}.` };
  }
}

/** Classify a thrown acquire error into a structured reason. Match the
 * structured sentinel prefixes the code throws BEFORE the tool-name heuristic. */
function classifyAcquireError(raw: string): AcquireReason {
  const lower = raw.toLowerCase();
  if (lower.includes('signature_failed') || lower.includes('authenticode')) return 'signature_failed';
  if (lower.includes('tool_missing')) return 'tool_missing';
  if (lower.includes('hash_mismatch')) return 'hash_mismatch';
  if (lower.includes('extract_failed') || lower.includes('hdiutil') || lower.includes('ditto') || lower.includes('7z')) {
    return 'extract_failed';
  }
  return 'network';
}

/** Write meta.json and point `current` at the version dir (symlink on posix,
 * current.txt on Windows where symlinks need elevation). */
async function promoteToCache(cacheDir: string, versionName: string, meta: Record<string, unknown>): Promise<void> {
  await writeFile(join(cacheDir, versionName, 'meta.json'), JSON.stringify(meta, null, 2));
  if (process.platform === 'win32') {
    await writeFile(join(cacheDir, 'current.txt'), versionName);
  } else {
    const current = join(cacheDir, 'current');
    await unlink(current).catch(() => {});
    await symlink(join(cacheDir, versionName), current, 'dir');
  }
}

/**
 * Move a freshly-built staging dir into the final version dir. Extraction
 * happens in staging so a failed/interrupted acquire never destroys a working
 * cached install (only the final rm+rename, both fast, touch the live dir).
 */
async function swapIntoPlace(stagingDir: string, versionDir: string): Promise<void> {
  await rm(versionDir, { recursive: true, force: true });
  await rename(stagingDir, versionDir);
}

async function acquireDarwin(config: Config, onProgress: (p: string) => void): Promise<AcquireResult> {
  const { url, version = 'latest', sha256Allow, teamId } = config.download;
  const appBin = config.systemAppBinDirs?.[0]; // /Applications/MEGAcmd.app/Contents/MacOS
  const appDest = appBin ? resolve(appBin, '..', '..') : undefined; // the .app bundle
  const binSubdir = join('MEGAcmd.app', 'Contents', 'MacOS');

  // Already installed (by us earlier, or by the user)? Use it — no download.
  if (appBin && (await exists(join(appBin, 'mega-whoami')))) {
    await ensureMacLoginHelper(appBin).catch(() => {});
    return { ok: true, binDir: appBin, version: 'installed', detail: `Using existing MEGAcmd at ${appDest}` };
  }

  if (!url) return { ok: false, reason: 'no_url' };

  const tmp = join(config.cacheDir, 'tmp');
  const mountPoint = join(tmp, 'mnt');
  const dmg = join(tmp, 'MEGAcmdSetup.dmg');

  try {
    await pExecFile('hdiutil', ['detach', mountPoint, '-force']).catch(() => {});
    await rm(tmp, { recursive: true, force: true });
    await mkdir(mountPoint, { recursive: true });

    onProgress('downloading');
    await fetchToFile(url, dmg);

    // Optional hash pin (rollback protection): enforced only when configured.
    // The mandatory gate is the Developer-ID/notarization signature below.
    onProgress('verifying-hash');
    const hash = await sha256File(dmg);
    if (sha256Allow.length && !sha256Allow.includes(hash)) {
      return { ok: false, reason: 'hash_mismatch', detail: `Downloaded artifact hash ${hash.slice(0, 12)}… is not in the vetted allowlist.` };
    }

    onProgress('mounting');
    await pExecFile('hdiutil', ['attach', '-nobrowse', '-noautoopen', '-mountpoint', mountPoint, dmg]);
    const appSrc = join(mountPoint, 'MEGAcmd.app');

    let binDir: string;
    let location: 'applications' | 'cache';
    try {
      onProgress('verifying-signature');
      await verifySignatureMac(appSrc, teamId);

      onProgress('installing');
      try {
        if (!appDest) throw new Error('no standard install location');
        // Preferred: install to the standard location (/Applications), where the
        // macOS client's auto-spawn finds the server natively.
        await pExecFile('ditto', [appSrc, appDest]);
        binDir = join(appDest, 'Contents', 'MacOS');
        location = 'applications';
      } catch {
        // /Applications not writable (non-admin / managed Mac): fall back to a
        // per-user cache; our own server-launch handles the non-standard path.
        const versionName = sanitizeVersion(version);
        const versionDir = join(config.cacheDir, versionName);
        const staging = join(tmp, 'extract');
        await rm(staging, { recursive: true, force: true });
        await mkdir(staging, { recursive: true });
        await pExecFile('ditto', [appSrc, join(staging, 'MEGAcmd.app')]);
        await swapIntoPlace(staging, versionDir);
        await promoteToCache(config.cacheDir, versionName, {
          version,
          url,
          sha256: hash,
          teamId,
          binSubdir,
          verifiedAt: new Date().toISOString(),
        });
        binDir = join(versionDir, binSubdir);
        location = 'cache';
      }
    } finally {
      await pExecFile('hdiutil', ['detach', mountPoint, '-force']).catch(() => {});
    }

    // Strip quarantine AFTER signature verification so execution isn't blocked.
    await pExecFile('xattr', ['-dr', 'com.apple.quarantine', resolve(binDir, '..', '..')]).catch(() => {});
    await ensureMacLoginHelper(binDir).catch(() => {});
    await rm(dmg, { force: true }).catch(() => {});

    onProgress('finalizing');
    return {
      ok: true,
      binDir,
      version,
      detail:
        location === 'applications'
          ? 'Installed to /Applications/MEGAcmd.app'
          : 'Installed to the per-user cache (/Applications was not writable)',
    };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: classifyAcquireError(raw), detail: redact(raw).slice(0, 300) };
  }
}

/**
 * Ensure a double-clickable macOS login helper exists for a cached MEGAcmd, and
 * return its path (null off macOS or on failure). It opens the MEGAcmd
 * interactive shell where `login <email>` prompts for the password at a HIDDEN
 * prompt — so the password never touches argv, shell history, or the AI. (The
 * one-shot `mega-login` client is non-interactive and would require the password
 * as an argument, which we deliberately avoid.)
 *
 * Self-healing: always (re)writes the helper against the current binaries, so it
 * tracks whichever MEGAcmd is resolved (/Applications or the per-user cache)
 * without re-downloading. Written to a stable per-user dir (NOT into the install
 * location, which may be /Applications or a purgeable cache).
 */
export async function ensureMacLoginHelper(binDir: string): Promise<string | null> {
  if (process.platform !== 'darwin' || !binDir) return null;
  const dir = join(homedir(), 'Library', 'Application Support', 'mega-cloud-mcp');
  const helperPath = join(dir, 'Login to MEGA.command');
  const script = `#!/bin/bash
# Log in to MEGA. Your password is entered at a hidden prompt and never leaves this machine.
DIR=${JSON.stringify(binDir)}
export PATH="$DIR:$PATH"
# Ensure the background server is up (no-op if it already is).
"$DIR/mega-cmd" >/dev/null 2>&1 &
sleep 1
echo
echo "At the 'MEGA CMD>' prompt, type:    login <your-email>"
echo "You'll be asked for your password (it is hidden). When done, type:    quit"
echo
exec "$DIR/MEGAcmdShell"
`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(helperPath, script, { mode: 0o755 });
    return helperPath;
  } catch {
    return null;
  }
}

/** Sanitize a version label for use as a cache directory name (no traversal). */
export function sanitizeVersion(v: string): string {
  const s = v.replace(/[^A-Za-z0-9._-]/g, '_');
  return s === '' || s.includes('..') ? 'unknown' : s;
}

/**
 * Re-verify an already-cached MEGAcmd binary before we launch it
 * (defense-in-depth against tampering of the user-writable cache between
 * install and launch). Platform-aware:
 *  - macOS: re-verify the .app code signature (notarization + team id).
 *  - Windows: re-verify the cached server exe's Authenticode signature.
 *  - Linux: re-hash the cached server binary against the install-time SHA-256.
 * Returns true when it cannot meaningfully verify (e.g. no stored hash).
 */
export async function verifyCachedBinary(
  resolved: { binDir: string | null; serverBin: string },
  opts: { teamId?: string; serverSha256?: string } = {},
): Promise<boolean> {
  try {
    if (process.platform === 'darwin') {
      if (!resolved.binDir) return true;
      await verifySignatureMac(join(resolved.binDir, '..', '..'), opts.teamId);
      return true;
    }
    if (process.platform === 'win32') {
      await verifyAuthenticodeWin(resolved.serverBin);
      return true;
    }
    if (process.platform === 'linux') {
      if (!opts.serverSha256) return true; // nothing to compare against
      return (await sha256File(resolved.serverBin)) === opts.serverSha256;
    }
    return true;
  } catch {
    return false;
  }
}

async function verifySignatureMac(appPath: string, teamId?: string): Promise<void> {
  try {
    // codesign --verify validates the seal; spctl -t exec assesses the launch
    // (execution) Gatekeeper policy for an application bundle. Both throw on
    // non-zero exit; tag the failure so it classifies as signature_failed.
    await pExecFile('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
    await pExecFile('spctl', ['-a', '-vv', '-t', 'exec', appPath]);
  } catch (e) {
    throw new Error(`signature_failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { stderr } = await pExecFile('codesign', ['-dv', '--verbose=4', appPath]).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? '' }));
  if (!/Authority=Developer ID Application: Mega Limited/.test(stderr)) {
    throw new Error('signature_failed: unexpected signing authority');
  }
  if (teamId && !stderr.includes(`TeamIdentifier=${teamId}`)) {
    throw new Error(`signature_failed: unexpected team identifier (want ${teamId})`);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** HTTPS + MEGA-host allowlist check, applied to the initial URL AND the final
 * (post-redirect) URL so a redirect cannot escape the host pin. */
function assertRemoteUrlAllowed(url: string): void {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error(`Refusing non-HTTPS download URL (${u.protocol}).`);
  if (!ALLOWED_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) {
    throw new Error(`Refusing download from non-MEGA host ${u.hostname}.`);
  }
}

/**
 * Download `url` to `dest`. file:// (and bare absolute paths) are an offline /
 * testing escape hatch, disabled unless MEGA_MCP_ALLOW_LOCAL_SOURCE=1. For
 * remote URLs: HTTPS only, host allowlisted to MEGA (re-checked after redirects),
 * with a hard size cap. Note: execution is independently gated by the SHA-256
 * pin + signature check regardless of source.
 */
async function fetchToFile(url: string, dest: string): Promise<void> {
  if (url.startsWith('/') || url.startsWith('file://')) {
    if (process.env.MEGA_MCP_ALLOW_LOCAL_SOURCE !== '1') {
      throw new Error('Local file download sources are disabled (set MEGA_MCP_ALLOW_LOCAL_SOURCE=1 to allow; testing only).');
    }
    const src = url.startsWith('file://') ? fileURLToPath(url) : url;
    await copyFile(src, dest);
    return;
  }

  assertRemoteUrlAllowed(url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}.`);
  assertRemoteUrlAllowed(res.url); // re-validate the final URL after any redirects

  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared && declared > MAX_DOWNLOAD_BYTES) throw new Error('Download exceeds size cap.');

  let seen = 0;
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > MAX_DOWNLOAD_BYTES) source.destroy(new Error('Download exceeds size cap.'));
  });
  await pipeline(source, createWriteStream(dest));
}


async function exists(p: string): Promise<boolean> {
  try {
    await access(p, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Windows. Downloads + Authenticode-verifies the OFFICIAL NSIS installer, then
// launches it for the USER to complete (a normal interactive install) via
// explorer.exe. Under an MSIX-packaged Claude the connector runs inside the
// package container, so a connector-run SILENT install writes to the
// package-private LocalCache (unreachable from a normal terminal). Launching
// through explorer.exe — the user's shell, outside the container — runs the
// installer outside the container too, so MEGAcmd is installed STANDALONE at
// the real %LOCALAPPDATA%\MEGAcmd: it survives a connector uninstall, its
// server auto-spawn works, and the connector reaches it (read fall-through) +
// talks to its server over the username-keyed named pipe (which crosses the
// package boundary). We never use /S and never escape the container silently —
// that pattern (silent + scheduled-task escape) is flagged as malware by AV.
// ---------------------------------------------------------------------------

async function acquireWindows(config: Config, onProgress: (p: string) => void): Promise<AcquireResult> {
  const { url, version = 'latest', sha256Allow } = config.download;

  // Already installed (standalone, or by the user)? Use it — no download.
  const existing = await findWindowsInstall(config);
  if (existing) return { ok: true, binDir: existing, version: 'installed', detail: `Using existing MEGAcmd at ${existing}` };

  if (!url) return { ok: false, reason: 'no_url' };

  const tmp = join(config.cacheDir, 'tmp');
  const exe = join(tmp, 'MEGAcmdSetup64.exe');

  try {
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });

    onProgress('downloading');
    await fetchToFile(url, exe);

    onProgress('verifying-hash');
    const hash = await sha256File(exe);
    if (sha256Allow.length && !sha256Allow.includes(hash)) {
      return { ok: false, reason: 'hash_mismatch', detail: `Downloaded artifact hash ${hash.slice(0, 12)}… is not in the vetted allowlist.` };
    }

    // Integrity gate: Authenticode (signer Organization = Mega Limited, trusted
    // chain, optional thumbprint pin) BEFORE we run it. Hash pin above is optional.
    onProgress('verifying-signature');
    await verifyAuthenticodeWin(exe, config.download.winThumbprint);

    // Launch the verified installer for the user to complete, OUTSIDE the package
    // container (via explorer.exe) so it installs STANDALONE to the real
    // %LOCALAPPDATA%\MEGAcmd. Interactive — the user clicks through and consents.
    // Never silent, never an obfuscated container escape (AV flags those).
    onProgress('installing');
    launchViaExplorer(exe);

    // The install is interactive; poll for the user to finish. If it isn't done
    // within the window, setup returns an "installing" status and reconciles on a
    // later call once the user completes the dialog (any normal tool call also
    // picks the install up via resolveBinaries).
    for (let i = 0; i < 10; i++) {
      await delay(3000);
      const binDir = await findWindowsInstall(config);
      if (binDir) {
        onProgress('finalizing');
        return { ok: true, binDir, version, detail: `Installed (standalone) to ${binDir}` };
      }
    }
    return {
      ok: false,
      reason: 'install_pending',
      detail: `The MEGAcmd installer was launched — please complete the install dialog, then retry. (Not detected yet under ${(config.systemAppBinDirs ?? []).join(', ')}.)`,
    };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: classifyAcquireError(raw), detail: redact(raw).slice(0, 300) };
  }
}

/** Probe the standard (preferred, non-virtualized) Windows install dirs. */
async function findWindowsInstall(config: Config): Promise<string | null> {
  return findInstallIn(config.systemAppBinDirs ?? []);
}

/** Return the first dir that actually contains a MEGAcmd install. */
async function findInstallIn(dirs: string[]): Promise<string | null> {
  for (const dir of dirs) {
    if ((await exists(join(dir, 'MEGAcmdServer.exe'))) || (await exists(join(dir, 'mega-whoami.bat')))) {
      return dir;
    }
  }
  return null;
}

/** Launch a target through explorer.exe — the user's shell, which runs OUTSIDE
 * the MSIX package container. Asking explorer to open the installer runs the
 * installer outside the container too, so MEGAcmd installs standalone to the
 * real %LOCALAPPDATA% (not the package-private LocalCache). Fire-and-forget;
 * the install is then driven interactively by the user.
 *
 * The downloaded installer lives under the connector's VIRTUALIZED %LOCALAPPDATA%
 * cache. explorer resolves paths in the REAL filesystem, so we must hand it the
 * REAL physical path (…\Packages\<family>\LocalCache\…) — the virtual path would
 * not exist for explorer and nothing would launch. */
function launchViaExplorer(target: string): void {
  let real = target;
  try {
    real = realpathSync.native(target).replace(/^\\\\\?\\/, '');
  } catch {
    /* fall back to the given path */
  }
  const child = spawn('explorer.exe', [real], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function verifyAuthenticodeWin(exe: string, thumbprint?: string): Promise<void> {
  // Identity pin (Windows analogue of the macOS Developer-ID team-id pin):
  //  - Status must be 'Valid' (trusted chain; blocks self-signed / untrusted).
  //  - the signer Organization must be EXACTLY "Mega Limited" — anchored on the
  //    O= field at a comma/end boundary so "O=Mega Limited Evil" does NOT pass
  //    (the old unanchored `-notmatch 'Mega Limited'` substring would have).
  //  - if a certificate thumbprint is configured, it must match exactly.
  const ps =
    `$ErrorActionPreference='Stop'; ` +
    `$s = Get-AuthenticodeSignature -LiteralPath $env:MEGA_VERIFY_PATH; ` +
    `if ($s.Status -ne 'Valid') { exit 3 }; ` +
    `if ($s.SignerCertificate.Subject -notmatch 'O=Mega Limited(,|$)') { exit 4 }; ` +
    `if ($env:MEGA_VERIFY_THUMBPRINT -and ($s.SignerCertificate.Thumbprint -ne $env:MEGA_VERIFY_THUMBPRINT)) { exit 5 }; ` +
    `exit 0`;
  try {
    await pExecFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
      env: { ...process.env, MEGA_VERIFY_PATH: exe, ...(thumbprint ? { MEGA_VERIFY_THUMBPRINT: thumbprint } : {}) },
    });
  } catch {
    throw new Error(`signature_failed: Authenticode verification failed for ${basename(exe)} (expected a valid, trusted "O=Mega Limited" signature)`);
  }
}

// ---------------------------------------------------------------------------
// Linux. The standard install is via the system package manager (root-only),
// which the connector (a user process) cannot do non-interactively — so we guide
// the user to install it themselves; the connector then finds it on PATH.
// ---------------------------------------------------------------------------

async function acquireLinux(): Promise<AcquireResult> {
  return {
    ok: false,
    reason: 'manual_install',
    detail:
      'On Linux, install MEGAcmd with your package manager (it needs root, which this connector cannot do for you), then retry:\n' +
      '  Debian/Ubuntu:  download the .deb for your release from https://mega.io/cmd, then  sudo apt install ./megacmd-*.deb\n' +
      '  Fedora/RHEL/openSUSE:  add the MEGA repo from https://mega.io/cmd, then  sudo dnf install megacmd\n' +
      'The connector then detects mega-cmd on your PATH automatically.',
  };
}
