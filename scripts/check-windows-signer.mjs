#!/usr/bin/env node
// Windows only: the official MEGAcmd installer must pass this connector's own signature check.
// MEGA changed the certificate it signs MEGAcmd for Windows with once (2.7.0, October 2026), and
// megacmd_setup and every tool then failed on Windows until someone reported it. CI runs this on
// every push and once a week, so a change of signer shows up here first.
//
// It downloads https://mega.nz/MEGAcmdSetup64.exe (never runs it) and calls the same
// verifyAuthenticodeWin the server uses (from dist/, so run `npm run build` first). When 7-Zip is
// there, the programs inside the installer are checked too: those are what the server verifies
// at every start. A program signed by someone else, and an unsigned file, must be refused.
//
// Usage: npm run build && node scripts/check-windows-signer.mjs
import { execFileSync } from 'node:child_process';
import { createWriteStream, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = 'https://mega.nz/MEGAcmdSetup64.exe';

if (process.platform !== 'win32') {
  console.log('skip Windows signer check (not Windows)');
  process.exit(0);
}

const { verifyAuthenticodeWin } = await import(pathToFileURL(join(root, 'dist', 'download', 'megacmd.js')).href);

const failures = [];
async function expect(label, file, accepted) {
  let error;
  try {
    await verifyAuthenticodeWin(file);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const ok = accepted ? error === undefined : /signature_failed/.test(error ?? '');
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${error ? `\n     ${error}` : ''}`);
  if (!ok) failures.push(label);
}

/** Who signed `file`, for the log (the check itself is verifyAuthenticodeWin). */
function signer(file) {
  try {
    // (No double quotes in the command: they don't survive the command line.)
    const ps = "$s = Get-AuthenticodeSignature -LiteralPath $env:FILE_TO_SHOW; '{0}: {1} [{2}]' -f $s.Status, $s.SignerCertificate.Subject, $s.SignerCertificate.Thumbprint";
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', env: { ...process.env, FILE_TO_SHOW: file } }).trim();
  } catch (e) {
    return `(could not read the signature: ${e instanceof Error ? e.message.split('\n')[0] : e})`;
  }
}

function filesNamed(dir, names, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) filesNamed(path, names, found);
    else if (names.includes(entry.name.toLowerCase())) found.push(path);
  }
  return found;
}

const work = mkdtempSync(join(tmpdir(), 'mega-signer-check-'));
try {
  const installer = join(work, 'MEGAcmdSetup64.exe');
  const res = await fetch(INSTALLER, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok || !res.body) throw new Error(`could not download ${INSTALLER}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(installer));
  console.log(`downloaded ${INSTALLER} (${statSync(installer).size} bytes)\n     ${signer(installer)}`);

  await expect("MEGA's installer is accepted", installer, true);

  // The programs the server checks at every start, when the installer can be unpacked.
  try {
    const unpacked = join(work, 'unpacked');
    execFileSync('7z', ['x', '-y', `-o${unpacked}`, installer], { stdio: 'ignore' });
    const programs = filesNamed(unpacked, ['megacmdserver.exe', 'megaclient.exe']);
    if (programs.length === 0) console.log('note: no MEGAcmdServer.exe / MEGAclient.exe found inside the installer; not checked');
    for (const program of programs) {
      console.log(`     ${signer(program)}`);
      await expect(`${program.slice(unpacked.length + 1)} inside the installer is accepted`, program, true);
    }
  } catch (e) {
    console.log(`note: the installer was not unpacked (${e instanceof Error ? e.message.split('\n')[0] : e}); the programs inside it are not checked`);
  }

  // Signed by someone else (Node.js), and not signed at all.
  await expect('a program signed by someone else is refused', process.execPath, false);
  await expect('an unsigned file is refused', fileURLToPath(import.meta.url), false);
} catch (e) {
  console.error(`FAIL Windows signer check\n     ${e instanceof Error ? e.message : e}`);
  failures.push('check did not finish');
} finally {
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // left for the OS to clean up
  }
}

if (failures.length) {
  console.error(`\n${failures.length} Windows signer check(s) failed.`);
  process.exitCode = 1;
}
