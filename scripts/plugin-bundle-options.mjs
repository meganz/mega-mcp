// Shared esbuild options for the Codex plugin bundle (dist/plugin-server.js).
// build-plugin-bundle.mjs writes the bundle; check-plugin.mjs rebuilds it in
// memory with the same options and compares it with the committed file.
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const outdir = join(root, 'dist');
export const outfile = join(outdir, 'plugin-server.js');
// Every file but images must stay under 256 KiB for the claude.ai directory to read it
// (a larger one holds each version for a reviewer as "couldn't inspect"). The bundle is
// therefore split into parts, each holding one library or group of the connector's code
// (scripts/plugin-parts/*.mjs name them); esbuild keeps one copy of every module across
// them. check-plugin.mjs enforces the limit.
export const partsDir = 'plugin-parts';
export const DIRECTORY_FILE_LIMIT = 256 * 1024;

// The Claude plugin (Claude Code / Cowork, and the claude.ai directory) lives in
// its own folder because installs get only that folder, and the repo root's
// package.json + package-lock.json would make Claude Code run `npm ci` on every
// install. Symlinks are refused by the directory, so these root files are copied
// in by build-plugin-bundle.mjs and check-plugin.mjs verifies the copies.
export const claudePluginDir = join(root, 'plugins', 'mega-mcp');
// The directory takes .claude-plugin/icon.png as the listing icon, but only from the
// first commit the portal saves or submits; adding or changing it later has no effect.
// (The bundle's files are mirrored too: bundleMirrors() lists them from a build.)
// dist/package.json marks the bundle as ES modules: without it a Node that doesn't detect them
// (18, 20 before 20.19, 22 before 22.7), or a package.json saying "commonjs" in a folder above
// the install, refuses to start it. (Not at the plugin root, where a package.json would make
// Claude Code install dependencies.) The Codex plugin has the repo's package.json.
export const claudePluginMirrors = [
  ['LICENSE', 'LICENSE'],
  ['NOTICE', 'NOTICE'],
  ['assets/icon.png', '.claude-plugin/icon.png'],
  ['scripts/plugin-dist-package.json', 'dist/package.json'],
].map(([from, to]) => ({ from: join(root, from), to: join(claudePluginDir, to) }));

export const pluginBundleOptions = {
  // Pin the working dir so the module-path comments esbuild emits don't depend
  // on where the build was started from.
  absWorkingDir: root,
  entryPoints: {
    'plugin-server': join(root, 'src', 'index.ts'),
    ...Object.fromEntries(
      ['zod', 'sdk-types', 'sdk', 'ajv', 'uri', 'core', 'tools'].map((part) => [`${partsDir}/${part}`, join(root, 'scripts', 'plugin-parts', `${part}.mjs`)]),
    ),
  },
  outdir,
  splitting: true,
  chunkNames: `${partsDir}/chunk-[hash]`,
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

/** Where each file of a bundle build goes in dist/ and in the Claude plugin folder. */
export function bundleMirrors(outputPaths) {
  return outputPaths.map((path) => {
    const rel = relative(outdir, path);
    return { rel, dist: join(outdir, rel), plugin: join(claudePluginDir, 'dist', rel) };
  });
}
