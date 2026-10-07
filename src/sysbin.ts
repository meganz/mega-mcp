import { existsSync } from 'node:fs';
import { win32 as winPath } from 'node:path';

/**
 * Absolute paths of the OS tools the connector runs itself — the signature
 * verifiers, the installer helpers and the PATH probe.
 *
 * Never by bare name: a bare name is looked up through the inherited PATH, and
 * the first match wins. A user-writable directory early on PATH could then supply
 * its own `codesign` or `powershell` that reports a valid signature, or run
 * during setup, which defeats the very checks these tools exist to perform.
 */
const POSIX: Record<string, string[]> = {
  which: ['/usr/bin/which', '/bin/which'],
  hdiutil: ['/usr/bin/hdiutil'],
  ditto: ['/usr/bin/ditto'],
  xattr: ['/usr/bin/xattr'],
  codesign: ['/usr/bin/codesign'],
  spctl: ['/usr/sbin/spctl'],
};

/** Relative to %SystemRoot%. */
const WINDOWS: Record<string, string> = {
  where: 'System32\\where.exe',
  powershell: 'System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  explorer: 'explorer.exe',
};

export function systemTool(name: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const rel = WINDOWS[name];
    if (!rel) throw new Error(`Unknown system tool: ${name}`);
    return winPath.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', rel);
  }
  const candidates = POSIX[name];
  if (!candidates) throw new Error(`Unknown system tool: ${name}`);
  return candidates.find((p) => existsSync(p)) ?? (candidates[0] as string);
}
