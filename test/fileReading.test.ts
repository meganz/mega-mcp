import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { stateDir, readRemembered, writeRemembered } from '../src/fileReading.js';
import { registerFileReading } from '../src/tools/fileReading.js';
import { createConfirmStore } from '../src/confirm.js';
import type { Runtime } from '../src/runtime.js';
import { isPluginBuild } from '../src/buildFlags.js';
import type { Config } from '../src/types.js';

const configWith = (cacheDir: string) => ({ cacheDir } as Config);
const tmp = () => mkdtempSync(join(tmpdir(), 'mega-fr-'));

describe('file-reading preference store', () => {
  it('prefers the host-injected PLUGIN_DATA over cacheDir', () => {
    const data = tmp();
    const cache = tmp();
    try {
      expect(stateDir(configWith(cache), { PLUGIN_DATA: data } as NodeJS.ProcessEnv)).toBe(data);
      // A blank value is not a directory: fall back rather than write to "".
      expect(stateDir(configWith(cache), { PLUGIN_DATA: '  ' } as NodeJS.ProcessEnv)).toBe(cache);
      expect(stateDir(configWith(cache), {} as NodeJS.ProcessEnv)).toBe(cache);
    } finally {
      rmSync(data, { recursive: true, force: true });
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it('round-trips the remembered answer and clears it', () => {
    const dir = tmp();
    const cfg = configWith(dir);
    const env = {} as NodeJS.ProcessEnv;
    try {
      expect(readRemembered(cfg, env)).toBe(false);
      expect(writeRemembered(cfg, true, env)).toBe(true);
      expect(readRemembered(cfg, env)).toBe(true);
      expect(writeRemembered(cfg, false, env)).toBe(true);
      expect(readRemembered(cfg, env)).toBe(false);
      expect(existsSync(join(dir, 'file-reading.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the state dir when the host points at one that does not exist yet', () => {
    const base = tmp();
    const data = join(base, 'not-created-yet');
    const env = { PLUGIN_DATA: data } as NodeJS.ProcessEnv;
    try {
      expect(writeRemembered(configWith(base), true, env)).toBe(true);
      expect(readRemembered(configWith(base), env)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // The whole point of this store is deciding whether to disclose document text,
  // so every unreadable state must mean "ask again", never "assume yes".
  it('fails closed on malformed, empty or wrongly-typed content', () => {
    const dir = tmp();
    const cfg = configWith(dir);
    const env = {} as NodeJS.ProcessEnv;
    const path = join(dir, 'file-reading.json');
    try {
      for (const body of ['', 'not json', '{}', '[]', 'null', '{"enabled":"true"}', '{"enabled":1}', '{"enabled":false}']) {
        writeFileSync(path, body);
        expect(readRemembered(cfg, env), `body: ${JSON.stringify(body)}`).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the state path is unreadable', () => {
    const dir = tmp();
    try {
      // A DIRECTORY where the file should be: readFileSync throws EISDIR.
      mkdirSync(join(dir, 'file-reading.json'));
      expect(readRemembered(configWith(dir), {} as NodeJS.ProcessEnv)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a failed write instead of throwing, so the session can still proceed', () => {
    const base = tmp();
    const file = join(base, 'a-file');
    writeFileSync(file, 'x');
    try {
      // A child of a regular file can never be created (ENOTDIR).
      expect(writeRemembered(configWith(base), true, { PLUGIN_DATA: join(file, 'nope') } as NodeJS.ProcessEnv)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('build flag', () => {
  // Guards the isolation this feature rests on: the prompt path must not compile
  // into the tsc build that MCPB/Claude Desktop ships. esbuild substitutes the
  // constant for the plugin bundle only (scripts/plugin-bundle-options.mjs);
  // under vitest the identifier is absent, exactly as in dist/index.js.
  it('is false unless esbuild substituted it', () => {
    expect(isPluginBuild).toBe(false);
  });
});

/** Minimal stand-ins for the SDK server + the mega_cat handle it hands back. */
function harness(cacheDir: string, exposeFileContents = false) {
  const cat = { enabled: true, enable() { this.enabled = true; }, disable() { this.enabled = false; } };
  const rt = { config: { cacheDir, exposeFileContents } as Config, confirm: createConfirmStore() } as Runtime;
  let fn!: (args: Record<string, unknown>) => Promise<CallToolResult>;
  registerFileReading({ registerTool: (_n: string, _d: unknown, cb: typeof fn) => (fn = cb) } as never, rt, cat as never);
  // The SDK applies zod defaults before the callback; supply them here.
  const call = (args: Record<string, unknown> = {}) => fn({ action: 'enable', remember: false, ...args });
  return { cat, call };
}
const textOf = (r: CallToolResult) => (r.content[0] as { text: string }).text;

describe('mega_file_reading', () => {
  it('previews without enabling, then enables on the confirm token', async () => {
    const dir = tmp();
    try {
      const { cat, call } = harness(dir);
      cat.disable();
      const preview = await call();
      expect(preview.structuredContent).toMatchObject({ requiresConfirmation: true });
      expect(textOf(preview)).toContain('visible to the AI provider');
      expect(cat.enabled, 'a preview must not grant access').toBe(false);

      const token = (preview.structuredContent as { confirmToken: string }).confirmToken;
      const done = await call({ confirm: token });
      expect(cat.enabled).toBe(true);
      expect(done.structuredContent).toMatchObject({ enabled: true, remembered: false });
      expect(existsSync(join(dir, 'file-reading.json')), 'no remember -> nothing persisted').toBe(false);
      // "Until restart", never "this conversation": a host may keep one server
      // process alive across conversations, and the text must not understate it.
      expect(textOf(done)).toContain('until the app is restarted');
      expect(textOf(preview)).toContain('until the app is restarted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists only when the user asked not to be asked again', async () => {
    const dir = tmp();
    try {
      const { call } = harness(dir);
      const preview = await call({ remember: true });
      await call({ remember: true, confirm: (preview.structuredContent as { confirmToken: string }).confirmToken });
      expect(readRemembered(configWith(dir), {} as NodeJS.ProcessEnv)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The user approved a preview that said "this session only". The same token
  // must not be spendable on the persistent variant: remember is bound into the
  // token's args, so a model (or an injected instruction) cannot quietly turn a
  // one-session yes into a permanent one.
  it('refuses to upgrade a session-only approval into "don\'t ask again"', async () => {
    const dir = tmp();
    try {
      const { cat, call } = harness(dir);
      cat.disable();
      const preview = await call({ remember: false });
      const token = (preview.structuredContent as { confirmToken: string }).confirmToken;
      const upgraded = await call({ remember: true, confirm: token });
      expect(upgraded.isError).toBe(true);
      expect(cat.enabled).toBe(false);
      expect(readRemembered(configWith(dir), {} as NodeJS.ProcessEnv)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a replayed token', async () => {
    const dir = tmp();
    try {
      const { cat, call } = harness(dir);
      const preview = await call();
      const token = (preview.structuredContent as { confirmToken: string }).confirmToken;
      await call({ confirm: token });
      await call({ action: 'disable' });
      const replay = await call({ confirm: token });
      expect(replay.isError).toBe(true);
      expect(cat.enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disables without a confirmation step and clears the remembered answer', async () => {
    const dir = tmp();
    try {
      writeRemembered(configWith(dir), true, {} as NodeJS.ProcessEnv);
      const { cat, call } = harness(dir);
      const r = await call({ action: 'disable' });
      expect(cat.enabled).toBe(false);
      expect(readRemembered(configWith(dir), {} as NodeJS.ProcessEnv)).toBe(false);
      expect(r.structuredContent).toMatchObject({ enabled: false, remembered: false });
      expect(textOf(r)).not.toContain('for this session');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A configured MEGA_MCP_EXPOSE_FILES outranks the stored answer at startup, so
  // here "off" lasts only until the next restart. Claiming otherwise would be a
  // promise about document disclosure that the app breaks on its own.
  it('does not claim a permanent off when the connector setting forces it on', async () => {
    const dir = tmp();
    try {
      const { cat, call } = harness(dir, true);
      const r = await call({ action: 'disable' });
      expect(cat.enabled).toBe(false);
      expect(r.structuredContent).toMatchObject({ sessionOnly: true });
      expect(textOf(r)).toContain('for this session');
      expect(textOf(r)).toContain('MEGA_MCP_EXPOSE_FILES');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
