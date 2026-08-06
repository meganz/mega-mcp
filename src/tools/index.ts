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
 * Register all MCP tools. Each register* module declares its own tools' names,
 * annotations and confirm-gating; the three conditional ones expose extra data
 * (contact PII / account PII / file contents) and stay off unless enabled.
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
