// Shared esbuild options for the Codex plugin bundle (dist/plugin-server.js).
// build-plugin-bundle.mjs writes the bundle; check-plugin.mjs rebuilds it in
// memory with the same options and compares it with the committed file.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const outfile = join(root, 'dist', 'plugin-server.js');

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
};
