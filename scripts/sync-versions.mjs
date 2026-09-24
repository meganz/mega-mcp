#!/usr/bin/env node
// Copies package.json's version into the other release manifests so they can't drift.
// Runs from the npm `version` lifecycle, so `npm version patch|minor|major` updates all three.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const versionedManifests = ['manifest.json', '.codex-plugin/plugin.json'];

// Rewrites only the top-level "version" value, keeping the file's own formatting.
function setVersion(relativePath, version) {
  const file = join(root, relativePath);
  const text = readFileSync(file, 'utf8');
  if (JSON.parse(text).version === version) return false;
  const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (JSON.parse(next).version !== version) {
    throw new Error(`${relativePath}: could not locate the top-level "version" field`);
  }
  writeFileSync(file, next);
  return true;
}

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const relativePath of versionedManifests) {
  if (setVersion(relativePath, version)) console.log(`${relativePath} -> ${version}`);
}
