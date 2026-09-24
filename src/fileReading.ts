import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import type { Config } from './types.js';

/**
 * Persistence for the "don't ask me again" answer to the file-reading prompt
 * (Codex plugin build only — see src/buildFlags.ts).
 *
 * Everything here FAILS CLOSED: an unreadable, malformed or absent store means
 * "not remembered", so the worst case is being asked once more, never reading
 * file contents the user did not agree to.
 */
const FILE = 'file-reading.json';

/**
 * Where to keep the answer.
 *
 * PLUGIN_DATA is the per-plugin writable directory the Codex host injects; the
 * Agent Plugins MCP schema forbids a plugin from SETTING PLUGIN_ROOT/PLUGIN_DATA
 * in its own `env` block, which is what tells us the host owns them. Preferring
 * it matters for more than tidiness: the marketplace installs each release into
 * its own version directory, so anything written next to the bundle is orphaned
 * by the next update, while PLUGIN_DATA persists across them.
 *
 * cacheDir is the fallback for hosts that don't inject it (and for tests). It is
 * already this connector's per-user writable root, so it exists and is writable
 * wherever the connector runs at all.
 */
export function stateDir(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  const injected = env.PLUGIN_DATA?.trim();
  return injected ? injected : config.cacheDir;
}

/** True only when the user explicitly chose "don't ask again". */
export function readRemembered(config: Config, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const raw = readFileSync(join(stateDir(config, env), FILE), 'utf8');
    return (JSON.parse(raw) as { enabled?: unknown }).enabled === true;
  } catch {
    return false; // absent / unreadable / malformed -> ask again
  }
}

/**
 * Record (or clear) the remembered answer. Returns false when the answer could
 * not be persisted — the caller still enables file reading for THIS session and
 * says so, rather than failing the user's request over a disk problem.
 */
export function writeRemembered(config: Config, enabled: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = join(stateDir(config, env), FILE);
  try {
    if (!enabled) {
      rmSync(path, { force: true });
      return true;
    }
    mkdirSync(stateDir(config, env), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ enabled: true }, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}
