import { describe, it, expect } from 'vitest';
import { isAbsolute, win32 } from 'node:path';
import { systemTool } from '../src/sysbin.js';

// A bare name is looked up through PATH, where a user-writable directory can
// shadow the real verifier. Every tool the connector runs itself is absolute.
describe('systemTool', () => {
  it('returns absolute posix paths for every helper', () => {
    for (const name of ['hdiutil', 'ditto', 'xattr', 'codesign', 'spctl']) {
      expect(isAbsolute(systemTool(name, 'darwin')), name).toBe(true);
    }
  });

  it('returns absolute Windows paths under SystemRoot', () => {
    for (const name of ['powershell', 'powershellModules', 'explorer']) {
      expect(win32.isAbsolute(systemTool(name, 'win32')), name).toBe(true);
    }
    expect(systemTool('powershell', 'win32')).toMatch(/System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  });

  it('refuses a tool it does not know rather than falling back to PATH', () => {
    expect(() => systemTool('curl', 'darwin')).toThrow(/Unknown system tool/);
  });
});
