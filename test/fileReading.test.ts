import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { stateDir, readRemembered, writeRemembered, readGeneration } from '../src/fileReading.js';
import { registerPluginFileTools } from '../src/tools/index.js';
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

  it('uses Claude Code\'s CLAUDE_PLUGIN_DATA when PLUGIN_DATA is absent', () => {
    const data = tmp();
    const claudeData = tmp();
    const cache = tmp();
    try {
      expect(stateDir(configWith(cache), { CLAUDE_PLUGIN_DATA: claudeData } as NodeJS.ProcessEnv)).toBe(claudeData);
      expect(
        stateDir(configWith(cache), { PLUGIN_DATA: data, CLAUDE_PLUGIN_DATA: claudeData } as NodeJS.ProcessEnv),
      ).toBe(data);
      expect(stateDir(configWith(cache), { CLAUDE_PLUGIN_DATA: ' ' } as NodeJS.ProcessEnv)).toBe(cache);
    } finally {
      rmSync(claudeData, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it('round-trips the remembered answer, and records turning it off as a timestamp', () => {
    const dir = tmp();
    const cfg = configWith(join(dir, 'cache'));
    const env = { PLUGIN_DATA: dir } as NodeJS.ProcessEnv;
    try {
      expect(readRemembered(cfg, env)).toBe(false);
      expect(writeRemembered(cfg, true, env)).toBe(true);
      expect(readRemembered(cfg, env)).toBe(true);
      expect(writeRemembered(cfg, false, env)).toBe(true);
      expect(readRemembered(cfg, env)).toBe(false);
      // Kept, not deleted: other running processes read the turn-off from it.
      expect(readGeneration(cfg, env)).toBe(1);
      writeRemembered(cfg, true, env);
      expect(readGeneration(cfg, env), 'a remembered yes keeps the generation').toBe(1);
      writeRemembered(cfg, false, env);
      expect(readGeneration(cfg, env)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // cacheDir is shared by every client that starts this server without a data
  // dir, so a "yes" kept there would switch reading on for other AI providers.
  it('never keeps a "don\'t ask again" outside a host-injected data dir', () => {
    const dir = tmp();
    const cfg = configWith(dir);
    try {
      expect(writeRemembered(cfg, true, {} as NodeJS.ProcessEnv)).toBe(false);
      writeFileSync(join(dir, 'file-reading.json'), '{"enabled":true}');
      expect(readRemembered(cfg, {} as NodeJS.ProcessEnv)).toBe(false);
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
      // The state file may now exist (it anchors the grant), but holds no "yes".
      expect(readRemembered(configWith(dir), { PLUGIN_DATA: dir } as NodeJS.ProcessEnv), 'no remember -> nothing remembered').toBe(false);
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
    const saved = process.env.PLUGIN_DATA;
    try {
      process.env.PLUGIN_DATA = dir;
      const { call } = harness(join(dir, 'cache'));
      const preview = await call({ remember: true });
      await call({ remember: true, confirm: (preview.structuredContent as { confirmToken: string }).confirmToken });
      expect(readRemembered(configWith(join(dir, 'cache')), { PLUGIN_DATA: dir } as NodeJS.ProcessEnv)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.PLUGIN_DATA;
      else process.env.PLUGIN_DATA = saved;
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

/**
 * Turning file reading off has to reach every running server process that shares
 * the state dir (other conversations, other threads), not only the one asked.
 * Exercised through the plugin registrar, which the build flag hides elsewhere.
 */
describe('file-reading consent across server processes', () => {
  function serverProcess(cacheDir: string, config: Partial<Config> = {}) {
    const tools = new Map<string, { cb: (a: Record<string, unknown>) => Promise<CallToolResult>; handle: { enabled: boolean } }>();
    const server = {
      registerTool: (name: string, _d: unknown, cb: (a: Record<string, unknown>) => Promise<CallToolResult>) => {
        const handle = { enabled: true, enable() { this.enabled = true; }, disable() { this.enabled = false; } };
        tools.set(name, { cb, handle });
        return handle;
      },
    };
    let ran = 0;
    const rt = {
      config: { cacheDir, exposeFileContents: false, ...config } as Config,
      confirm: createConfirmStore(),
      run: async () => (ran++, { code: 0, stdout: 'text', stderr: '' }),
    } as unknown as Runtime;
    registerPluginFileTools(server as never, rt);
    const reading = (args: Record<string, unknown>) => tools.get('mega_file_reading')!.cb({ action: 'enable', remember: false, ...args });
    return { tools, reading, ran: () => ran };
  }

  it('a "turn it off" in one process stops reading in another', async () => {
    const dir = tmp();
    const saved = process.env.PLUGIN_DATA;
    try {
      process.env.PLUGIN_DATA = dir;
      const a = serverProcess(join(dir, 'cache'));
      const b = serverProcess(join(dir, 'cache'));
      const preview = await b.reading({});
      await b.reading({ confirm: (preview.structuredContent as { confirmToken: string }).confirmToken });
      expect(b.tools.get('mega_cat')!.handle.enabled).toBe(true);

      await a.reading({ action: 'disable' });
      const res = await b.tools.get('mega_cat')!.cb({ remotePath: '/notes.txt' });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/turned off/);
      expect(b.tools.get('mega_cat')!.handle.enabled).toBe(false);
      expect(b.ran()).toBe(0);

      // Asking again afterwards works.
      const again = await b.reading({});
      await b.reading({ confirm: (again.structuredContent as { confirmToken: string }).confirmToken });
      expect((await b.tools.get('mega_cat')!.cb({ remotePath: '/notes.txt' })).isError).toBeFalsy();
    } finally {
      if (saved === undefined) delete process.env.PLUGIN_DATA;
      else process.env.PLUGIN_DATA = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The grant is tied to the turn-off generation, never to clocks, and a state file
  // that disappears (deleted by hand, or by a v1.0.4 process turning reading off)
  // ends it instead of resetting it to "never turned off".
  it('a deleted or damaged state file ends existing grants', async () => {
    for (const damage of ['delete', 'garbage'] as const) {
      const dir = tmp();
      const saved = process.env.PLUGIN_DATA;
      try {
        process.env.PLUGIN_DATA = dir;
        const b = serverProcess(join(dir, 'cache'));
        const preview = await b.reading({});
        await b.reading({ confirm: (preview.structuredContent as { confirmToken: string }).confirmToken });
        expect((await b.tools.get('mega_cat')!.cb({ remotePath: '/notes.txt' })).isError).toBeFalsy();
        if (damage === 'delete') rmSync(join(dir, 'file-reading.json'));
        else writeFileSync(join(dir, 'file-reading.json'), '{"gen":');
        const res = await b.tools.get('mega_cat')!.cb({ remotePath: '/notes.txt' });
        expect(res.isError, damage).toBe(true);
      } finally {
        if (saved === undefined) delete process.env.PLUGIN_DATA;
        else process.env.PLUGIN_DATA = saved;
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('an explicit MEGA_MCP_EXPOSE_FILES=false offers neither reading nor the prompt', () => {
    const dir = tmp();
    try {
      const p = serverProcess(dir, { fileContentsForcedOff: true });
      expect([...p.tools.keys()]).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
