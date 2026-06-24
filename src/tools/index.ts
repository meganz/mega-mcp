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

/**
 * Register all MCP tools (§C tool catalog).
 *  - whoami / account / df / ls / find       : read-only, auto-allow
 *  - tree / du / mount / version / transfers : read-only, auto-allow
 *  - mediainfo / attr / errorcode            : read-only, auto-allow
 *  - mkdir / cp                              : mutating, auto-allow
 *  - mv / put / get / thumbnail              : local/cloud writes, confirm-gated
 *  - rm / deleteversions / killsession       : destructive, confirm-gated
 *  - export / share                          : exfiltration, confirm-gated (status/list read-only)
 *  - users / showpcr / userattr             : contact PII, read-only, only when exposeContacts
 *  - sessions / balance                      : account PII, read-only, only when exposeAccountDetails
 *  - cat                                     : file contents, read-only, only when exposeFileContents
 *  - attr_set / userattr_set / user_remove   : mutations, confirm-gated
 *  - transfer_control / invite / ipc / import: mutations, confirm-gated
 *  - config                                  : settings (show auto, set confirm)
 *  - sync_* / backup_*                       : sync/backup (list auto, add/control confirm)
 */
export function registerAll(server: McpServer, rt: Runtime): void {
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
  if (rt.config.exposeFileContents) registerCat(server, rt);
}
