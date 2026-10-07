import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Config } from './types.js';

/**
 * Persistence for the file-reading consent (plugin build only — see
 * src/buildFlags.ts): the user's "don't ask me again", and a counter of how many
 * times file reading has been turned OFF.
 *
 * Everything here FAILS CLOSED: an unreadable, malformed or absent store means
 * "not remembered", so the worst case is being asked once more, never reading
 * file contents the user did not agree to.
 */
const FILE = 'file-reading.json';

/**
 * The per-plugin writable directory the HOST injects, or null.
 *
 * PLUGIN_DATA is the Codex one; the Agent Plugins MCP schema forbids a plugin from
 * SETTING PLUGIN_ROOT/PLUGIN_DATA in its own `env` block, which is what tells us
 * the host owns them. CLAUDE_PLUGIN_DATA is Claude Code's equivalent. Both hosts
 * install each release into its own version directory, so anything written next
 * to the bundle is orphaned by the next update, while the data directory persists
 * across them (and Claude Code deletes it on uninstall).
 */
export function hostStateDir(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.PLUGIN_DATA?.trim() || env.CLAUDE_PLUGIN_DATA?.trim() || null;
}

/**
 * Where the state lives: the host's data dir, else cacheDir. cacheDir is shared by
 * every client that launches this server without a data dir, so it only ever
 * holds a REVOCATION (which may safely reach them all), never a remembered yes.
 */
export function stateDir(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  return hostStateDir(env) ?? config.cacheDir;
}

interface Stored {
  enabled: boolean;
  /** Bumped by every "turn it off"; only ever goes up. */
  gen: number;
}

/** The stored state, or null when the file is absent, unreadable or malformed. */
function readStored(dir: string): Stored | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, FILE), 'utf8')) as { enabled?: unknown; gen?: unknown };
    const gen = typeof raw.gen === 'number' && Number.isInteger(raw.gen) && raw.gen >= 0 ? raw.gen : 0;
    return { enabled: raw.enabled === true, gen };
  } catch {
    return null;
  }
}

/** Write via a temp file + rename, so no reader ever sees a half-written file. */
function writeStored(dir: string, value: Stored): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `${FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tmp, join(dir, FILE));
    return true;
  } catch {
    return false;
  }
}

/**
 * True only when the user explicitly chose "don't ask again" — and only from a data
 * dir the host gave this plugin. In the shared cacheDir a yes given in one client
 * (one AI provider) would switch reading on in every other.
 */
export function readRemembered(config: Config, env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = hostStateDir(env);
  return dir ? readStored(dir)?.enabled === true : false;
}

/**
 * The current "turn it off" generation, or null when the state file is missing or
 * unreadable. A grant in this process is valid only while this still equals the
 * generation it was given under - so a turn-off anywhere sharing the state dir,
 * and equally a deleted or damaged state file, ends it. No clocks involved.
 */
export function readGeneration(config: Config, env: NodeJS.ProcessEnv = process.env): number | null {
  return readStored(stateDir(config, env))?.gen ?? null;
}

/**
 * Make sure the state file exists before a grant is recorded against it, so that a
 * file deleted afterwards reads as a change (null), not as "never turned off".
 */
export function ensureStateFile(config: Config, env: NodeJS.ProcessEnv = process.env): void {
  const dir = stateDir(config, env);
  if (!readStored(dir)) writeStored(dir, { enabled: false, gen: 0 });
}

/**
 * Record "don't ask again" (enabled) or "turn it off" (disabled). Turning off
 * bumps the generation, which every other running server process checks before
 * each read. A remembered yes keeps the generation and needs the host's data dir.
 *
 * Returns false when the answer could not be persisted — the caller still applies
 * it to THIS session and says so.
 */
export function writeRemembered(config: Config, enabled: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = enabled ? hostStateDir(env) : stateDir(config, env);
  if (!dir) return false;
  const gen = readStored(dir)?.gen ?? 0;
  return writeStored(dir, enabled ? { enabled: true, gen } : { enabled: false, gen: gen + 1 });
}
