import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from '../runtime.js';
import { registerSetup } from './setup.js';
import { registerWhoami } from './whoami.js';
import { registerAccount, registerAccountDetails } from './account.js';
import { registerReadOnly } from './readonly.js';
import { registerMutate } from './mutate.js';
import { registerDangerous } from './dangerous.js';
import { registerContacts } from './contacts.js';
import { registerManage } from './manage.js';
import { registerConfig } from './config.js';
import { registerSync } from './sync.js';
import { registerCat } from './cat.js';
import { registerFileReading } from './fileReading.js';
import { isPluginBuild } from '../buildFlags.js';
import { readRemembered, readGeneration } from '../fileReading.js';
import { withWriteLock } from './helpers.js';

/** Tools that place content in the cloud, or open it to others: run one at a time. */
const SERIALIZED = new Set(['mega_cp', 'mega_mkdir', 'mega_mv', 'mega_put', 'mega_share', 'mega_export', 'mega_import', 'mega_sync_add', 'mega_sync_control', 'mega_sync_ignore', 'mega_backup_add', 'mega_backup_control', 'mega_thumbnail', 'mega_attr_set', 'mega_rm', 'mega_deleteversions', 'mega_user_remove']);

function serializeWrites(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== 'registerTool') return Reflect.get(target, prop, receiver);
      return (name: string, config: unknown, cb: (...args: unknown[]) => Promise<unknown>) =>
        (target.registerTool as (...a: unknown[]) => unknown).call(target, name, config, SERIALIZED.has(name) ? (...args: unknown[]) => withWriteLock(() => cb(...args)) : cb);
    },
  });
}

/**
 * Register all MCP tools. Each register* module declares its own tools' names,
 * annotations and confirm-gating; the three conditional ones expose extra data
 * (contact PII / account PII / file contents) and stay off unless enabled.
 */
export function registerAll(mcp: McpServer, rt: Runtime): void {
  const server = serializeWrites(mcp);
  registerSetup(server, rt);
  registerWhoami(server, rt);
  registerAccount(server, rt);
  registerReadOnly(server, rt);
  registerMutate(server, rt);
  registerDangerous(server, rt);
  registerManage(server, rt);
  registerConfig(server, rt);
  registerSync(server, rt);
  if (rt.config.exposeContacts) registerContacts(server, rt);
  if (rt.config.exposeAccountDetails) registerAccountDetails(server, rt);
  registerFileTools(server, rt);
}

/**
 * mega_cat, plus the way the user is asked for it.
 *
 * Non-plugin builds keep the original all-or-nothing behaviour: the tool exists
 * only when the host's own settings said so (the MCPB checkbox, or the env var
 * for a hand-registered server). Nothing about Claude Desktop changes.
 *
 * The plugin build (Codex and Claude plugins) has no such setting to read - a
 * plugin-provided MCP server's env is fixed by the plugin, and neither Codex nor
 * Cowork lets user config reach it - so the
 * tool is ALWAYS registered and merely starts disabled, and mega_file_reading
 * flips it after asking. Registering-then-disabling (rather than registering
 * late) is what makes that possible at all: the SDK emits tools/list_changed on
 * enable(), so the tool appears mid-conversation with no restart.
 *
 * Starting state, in order: an explicitly configured env var wins, then the
 * user's remembered "don't ask again", otherwise off.
 */
function registerFileTools(server: McpServer, rt: Runtime): void {
  if (!isPluginBuild) {
    if (rt.config.exposeFileContents) registerCat(server, rt);
    return;
  }
  registerPluginFileTools(server, rt);
}

/** The plugin build's ask-first file reading (exported for tests: the build flag is
 *  only set in the esbuild bundle). */
export function registerPluginFileTools(server: McpServer, rt: Runtime): void {
  // An explicit MEGA_MCP_EXPOSE_FILES=false is a hard off: no reading, and no tool
  // that would ask to turn it on.
  if (rt.config.fileContentsForcedOff) return;
  // This process's own "yes": the turn-off generation it was given under. Any later
  // turn-off sharing the state dir (or a lost state file) changes it and ends it.
  const grant: { gen?: number | null } = {};
  // A settings switch-on holds until a turn-off raises the generation (not a lost state file).
  const startGen = readGeneration(rt.config) ?? 0;
  const allowed = () =>
    (rt.config.exposeFileContents && (readGeneration(rt.config) ?? 0) <= startGen) ||
    readRemembered(rt.config) ||
    (grant.gen !== undefined && readGeneration(rt.config) === grant.gen);
  const cat = registerCat(server, rt, allowed);
  if (!(rt.config.exposeFileContents || readRemembered(rt.config))) cat.disable();
  registerFileReading(server, rt, cat, grant);
}
