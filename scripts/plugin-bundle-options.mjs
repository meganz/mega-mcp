// Shared esbuild options for the Codex plugin bundle (dist/plugin-server.js).
// build-plugin-bundle.mjs writes the bundle; check-plugin.mjs rebuilds it in
// memory with the same options and compares it with the committed file.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const outfile = join(root, 'dist', 'plugin-server.js');

// The Claude plugin (Claude Code / Cowork, and the claude.ai directory) lives in
// its own folder because installs get only that folder, and the repo root's
// package.json + package-lock.json would make Claude Code run `npm ci` on every
// install. Symlinks are refused by the directory, so these root files are copied
// in by build-plugin-bundle.mjs and check-plugin.mjs verifies the copies.
export const claudePluginDir = join(root, 'plugins', 'mega-mcp');
export const claudePluginMirrors = [
  ['dist/plugin-server.js', 'dist/plugin-server.js'],
  ['LICENSE', 'LICENSE'],
  ['NOTICE', 'NOTICE'],
].map(([from, to]) => ({ from: join(root, from), to: join(claudePluginDir, to) }));

export const pluginBundleOptions = {
  // Pin the working dir so the module-path comments esbuild emits don't depend
  // on where the build was started from.
  absWorkingDir: root,
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  sourcemap: false,
  legalComments: 'none',
  // Marks this bundle as the Codex-plugin distribution; see src/buildFlags.ts.
  // Only the prompt-to-enable-file-reading path is gated on it, and only this
  // bundle gets it, so dist/index.js (MCPB / manual stdio) is unaffected.
  define: { __MEGA_PLUGIN_BUILD__: 'true' },
};
