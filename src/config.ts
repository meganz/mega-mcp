import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, accessSync, constants } from 'node:fs';
import type { Config, DownloadSpec } from './types.js';

// Default row cap per listing page. Kept modest on purpose: an agent's context
// is the scarce resource, and a single oversized listing (a 10k-entry folder at
// ~125 chars/row = ~125k chars) floods it. Callers page the rest via the
// nextPageToken cursor; a hard char ceiling (MAX_LISTING_CHARS) bounds wide rows
// independently. Override via MEGA_MCP_MAX_LIST for whole-folder dumps.
const DEFAULT_MAX_LIST = 200;
const MIN_MAX_LIST = 50;
const MAX_MAX_LIST = 10_000;

/**
 * Build runtime config from environment variables set by the MCPB manifest
 * (MEGA_MCP_*). Falls back to sensible defaults for local dev where no
 * variables are set.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const megacmdDir = clean(env.MEGA_MCP_MEGACMD_DIR);

  // In production the manifest injects ${__dirname}/vendor/megacmd. In dev we
  // derive a path relative to this module (which will simply be empty).
  const here = dirname(fileURLToPath(import.meta.url));
  const bundledDir = clean(env.MEGA_MCP_BUNDLED_DIR) ?? resolve(here, '..', 'vendor', 'megacmd');

  return {
    megacmdDir,
    bundledDir,
    cacheDir: resolveCacheDir(env),
    systemAppBinDirs: systemAppBinDirs(env),
    download: downloadSpec(env),
    maxListLines: parseMaxList(env.MEGA_MCP_MAX_LIST),
    exposeContacts: parseBool(env.MEGA_MCP_EXPOSE_CONTACTS),
    exposeAccountDetails: parseBool(env.MEGA_MCP_EXPOSE_ACCOUNT),
    exposeFileContents: parseBool(env.MEGA_MCP_EXPOSE_FILES),
  };
}

/**
 * Cache root for the downloaded MEGAcmd. The MCPB manifest points this at
 * ${__dirname}/megacmd (inside the connector's extension dir) so MEGAcmd is
 * removed when the connector is uninstalled. If that dir can't be created/written
 * (e.g. a read-only install location), fall back to the per-user cache so the
 * connector still works.
 */
function resolveCacheDir(env: NodeJS.ProcessEnv): string {
  const configured = clean(env.MEGA_MCP_CACHE_DIR);
  if (configured) {
    try {
      mkdirSync(configured, { recursive: true });
      accessSync(configured, constants.W_OK);
      return configured;
    } catch {
      // not writable -> fall through to the per-user cache
    }
  }
  return defaultCacheDir();
}

/** Standard install bin dirs to probe (and, for macOS/Windows, install into). */
function systemAppBinDirs(env: NodeJS.ProcessEnv): string[] {
  if (process.platform === 'darwin') {
    return ['/Applications/MEGAcmd.app/Contents/MacOS'];
  }
  if (process.platform === 'win32') {
    // Install to (and probe) the installer's natural per-user location
    // %LOCALAPPDATA%\MEGAcmd. Under an MSIX-packaged Claude Desktop the
    // connector's %LOCALAPPDATA% is redirected to a package-private LocalCache —
    // but that IS a real physical path a normal terminal can reach directly. The
    // connector resolves that physical path (fs.realpath native) and shows it in
    // the out-of-band login instructions, so the user runs MEGAcmd from the same
    // install and shares the connector's running server (the MEGAcmd named pipe
    // is keyed on the Windows username and crosses the package boundary). Keeping
    // the install under %LOCALAPPDATA% also means it is removed when the connector
    // is uninstalled.
    const localAppData = env.LOCALAPPDATA ?? join(env.USERPROFILE ?? homedir(), 'AppData', 'Local');
    const pf = env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    return [join(localAppData, 'MEGAcmd'), join(pf, 'MEGAcmd'), join(pf86, 'MEGAcmd')];
  }
  return []; // Linux: resolved via PATH after a package-manager install
}

/** Per-user cache root for a runtime-downloaded MEGAcmd. */
export function defaultCacheDir(): string {
  const base = 'mega-cloud-mcp';
  switch (process.platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'Caches', base, 'megacmd');
    case 'win32':
      return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), base, 'megacmd');
    default:
      return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), base, 'megacmd');
  }
}

/**
 * Default runtime-download spec for the current platform. macOS is fully
 * supported; the pinned SHA-256 + team id are verified before execution. The
 * URL/version/hash allowlist are overridable via env for forward-compat (the
 * macOS URL is unversioned and rolls over time, so the pin will need refresh).
 */
function downloadSpec(env: NodeJS.ProcessEnv): DownloadSpec {
  const extraHashes = (clean(env.MEGA_MCP_DOWNLOAD_SHA256) ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[0-9a-f]{64}$/.test(h));

  let spec: DownloadSpec;
  switch (process.platform) {
    case 'darwin':
      // Identity pin (Developer-ID team-id + notarization, verified before
      // execution) is the mandatory gate. No file-hash is shipped: MEGA doesn't
      // publish per-release hashes and the URL is unversioned/rolling, so a
      // shipped pin would break on every MEGA release. An operator can still pin
      // a hash via MEGA_MCP_DOWNLOAD_SHA256 for extra rollback protection.
      spec = {
        url: 'https://mega.nz/MEGAcmdSetup.dmg',
        version: '2.5.2',
        sha256Allow: [],
        teamId: 'T9RH74Y7L9',
      };
      break;
    case 'win32':
      // Identity pin = Authenticode "O=Mega Limited" on a trusted chain (+ an
      // optional thumbprint via MEGA_MCP_WIN_THUMBPRINT). Hash optional, as above.
      spec = { url: 'https://mega.nz/MEGAcmdSetup64.exe', sha256Allow: [], winThumbprint: clean(env.MEGA_MCP_WIN_THUMBPRINT) };
      break;
    default:
      spec = { url: undefined, sha256Allow: [] };
  }

  const urlOverride = clean(env.MEGA_MCP_DOWNLOAD_URL);
  if (urlOverride) spec.url = urlOverride;
  if (extraHashes.length) spec.sha256Allow = [...spec.sha256Allow, ...extraHashes];
  return spec;
}

function clean(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  // Unsubstituted manifest tokens (e.g. an unset optional ${user_config.x})
  // can arrive literally; treat those as "unset".
  if (t === '' || t.includes('${')) return undefined;
  return t;
}

/** Parse a boolean-ish env flag ("1"/"true"/"yes"/"on", case-insensitive). */
function parseBool(v: string | undefined): boolean {
  const t = clean(v)?.toLowerCase();
  return t === '1' || t === 'true' || t === 'yes' || t === 'on';
}

function parseMaxList(v: string | undefined): number {
  const n = Number(clean(v));
  if (!Number.isFinite(n)) return DEFAULT_MAX_LIST;
  return Math.min(MAX_MAX_LIST, Math.max(MIN_MAX_LIST, Math.trunc(n)));
}
