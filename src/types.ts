/** Shared types for the MEGA MCP server. */

export interface DownloadSpec {
  /** Where to fetch MEGAcmd for the current platform (https://mega.nz/... or file://). */
  url?: string;
  /** Expected version label (informational; used in cache dir + messages). */
  version?: string;
  /** Optional allowlist of vetted SHA-256 hashes of the downloaded artifact
   * (hex). MEGA does not publish per-release hashes and the URLs are unversioned
   * (rolling), so this is OPTIONAL: when non-empty it is enforced (rollback
   * protection), when empty the signing-IDENTITY check is the gate. */
  sha256Allow: string[];
  /** Expected code-signing team identifier (macOS Developer-ID / notarization). */
  teamId?: string;
  /** Optional Authenticode certificate thumbprint to pin (Windows identity pin). */
  winThumbprint?: string;
}

export interface Config {
  /** User-configured directory containing the mega-* client binaries (optional). */
  megacmdDir?: string;
  /** Base dir for bundled binaries (C2). Platform/arch subdir is appended at resolve time. */
  bundledDir?: string;
  /** Per-user cache root where a runtime-downloaded MEGAcmd is stored. */
  cacheDir: string;
  /** Standard-install bin dirs to probe, in order, and (macOS/Windows) install
   * into. Windows: %LOCALAPPDATA%\MEGAcmd first (the installer's natural per-user
   * location — MEGAcmd assumes it lives there), then Program Files. (MSIX
   * resolution of that path is handled via fs.realpath; see config.ts.) */
  systemAppBinDirs?: string[];
  /** Runtime-download settings for the current platform. */
  download: DownloadSpec;
  /** Cap on rows returned by ls/find to keep tool responses small. */
  maxListLines: number;
  /** Expose contact/profile tools (users/showpcr/userattr). Off by default:
   * these surface third-party contact PII into the model context. */
  exposeContacts: boolean;
  /** Expose account-detail tools (sessions/balance). Off by default: these
   * surface the user's own login metadata (IP/geo/devices) and financial
   * history — not an account-compromise risk, but privacy-sensitive PII. */
  exposeAccountDetails: boolean;
  /** Expose mega_cat (read cloud file contents). Off by default: it brings
   * cloud file content into the model context (capped, text-only). */
  exposeFileContents: boolean;
}

/** How the MEGAcmd binaries were located. */
export type BinarySource = 'bundled' | 'configured' | 'system' | 'cache' | 'path';

export interface Resolved {
  source: BinarySource;
  /** Directory holding the client binaries, or null when found on PATH. */
  binDir: string | null;
  /** Directory of bundled shared libraries to add to LD_LIBRARY_PATH (Linux). */
  libDir?: string | null;
  /**
   * Resolve the spawn invocation for a mega subcommand: the binary to exec and
   * the full argv. On win32 this is MEGAclient.exe with the subcommand prepended
   * — the mega-<cmd>.bat wrappers cannot be execFile'd without shell:true since
   * Node's CVE-2024-27980 fix (which throws `spawn EINVAL`), and we never use a
   * shell. On posix it is the mega-<cmd> client with args passed through as-is.
   */
  clientInvocation: (cmd: string, args: string[]) => { bin: string; argv: string[] };
  /** Full path (or bare name) of the background server binary (platform-specific). */
  serverBin: string;
}

export interface RunOpts {
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface RunResult {
  /** MEGAcmd exit code on a clean exit; -1 for any non-clean outcome below. */
  code: number;
  stdout: string;
  stderr: string;
  /** Set (e.g. 'ENOENT') when the process could not be spawned at all. */
  spawnError?: string;
  /** The process was killed (our timeout fired or an external signal). */
  timedOut?: boolean;
  /** Signal that terminated the process, when killed. */
  killedSignal?: string;
  /** Output exceeded maxBuffer and was aborted. */
  maxBufferExceeded?: boolean;
}

export type AuthReason =
  | 'ok'
  | 'not_logged_in'
  | 'no_megacmd'
  | 'server_error';

export interface AuthState {
  loggedIn: boolean;
  email?: string;
  reason: AuthReason;
  /** Human-readable detail for error reasons (never contains session material). */
  detail?: string;
}
