#!/usr/bin/env node
// Minimal MCP stdio client to smoke-test the built server end-to-end.
//
// Usage:
//   node scripts/smoke-stdio.mjs                      # list tools + call mega_whoami
//   node scripts/smoke-stdio.mjs mega_ls '{"remotePath":"/"}'
//
// Speaks newline-delimited JSON-RPC to dist/index.js over stdio.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
// Override to smoke-test a packed/unpacked bundle: MEGA_MCP_SERVER_ENTRY=/path/dist/index.js
const serverEntry = process.env.MEGA_MCP_SERVER_ENTRY ?? resolve(here, '..', 'dist', 'index.js');

const toolName = process.argv[2] ?? 'mega_whoami';
const toolArgs = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const child = spawn('node', [serverEntry], { stdio: ['pipe', 'pipe', 'inherit'] });

const pending = new Map();
let nextId = 1;
function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), Number(process.env.SMOKE_TIMEOUT_MS ?? 180_000));
  });
}
function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore non-JSON noise
  }
  if (msg.id != null && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
});

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-stdio', version: '0.0.0' },
  });
  notify('notifications/initialized', {});
  console.log('SERVER INSTRUCTIONS present:', Boolean(init.instructions), `(${init.instructions?.length ?? 0} chars)`);

  const tools = await request('tools/list', {});
  console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '));
  const whoami = tools.tools.find((t) => t.name === 'mega_whoami');
  console.log('mega_whoami annotations:', JSON.stringify(whoami?.annotations ?? {}));

  console.log(`\nCALL ${toolName}(${JSON.stringify(toolArgs)}):`);
  let result = await request('tools/call', { name: toolName, arguments: toolArgs });
  console.log('  isError:', result.isError ?? false);
  console.log('  text:', result.content?.map((c) => c.text).join('\n'));
  if (result.structuredContent) console.log('  structured:', JSON.stringify(result.structuredContent));

  // Auto-complete the two-call confirm protocol when AUTO_CONFIRM is set.
  const token = result.structuredContent?.confirmToken;
  if (process.env.AUTO_CONFIRM && token) {
    console.log(`\nCONFIRM ${toolName} with token...`);
    result = await request('tools/call', { name: toolName, arguments: { ...toolArgs, confirm: token } });
    console.log('  isError:', result.isError ?? false);
    console.log('  text:', result.content?.map((c) => c.text).join('\n'));
    if (result.structuredContent) console.log('  structured:', JSON.stringify(result.structuredContent));
  }
} catch (e) {
  console.error('SMOKE FAILED:', e.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
