import { resolve, sep } from 'node:path';
import { homedir } from 'node:os';

/** Thrown when a model-supplied path fails validation. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Refuse local paths inside the MEGAcmd config dir so no tool can read from or
 * write into the session store (HARD CONSTRAINT 3, defense-in-depth). Covers
 * the default ~/.megaCmd location used by our design.
 */
function assertNotConfigDir(abs: string): void {
  const cfg = resolve(homedir(), '.megaCmd');
  if (abs === cfg || abs.startsWith(cfg + sep)) {
    throw new ValidationError('Refusing to access the MEGAcmd configuration directory.');
  }
}

function rejectNul(p: string): void {
  if (p.includes(String.fromCharCode(0))) throw new ValidationError('Path contains a NUL byte.');
}

/**
 * Validate a MEGA cloud path. Requiring a leading "/" both matches MEGA's
 * absolute-path model and guarantees the value cannot be parsed as a CLI flag
 * (it never starts with "-"), neutralizing flag-injection from model input.
 */
export function assertRemotePath(p: string, field = 'remotePath'): string {
  rejectNul(p);
  const t = p.trim();
  if (t === '') throw new ValidationError(`${field} is empty.`);
  if (!t.startsWith('/')) {
    throw new ValidationError(`${field} must be an absolute MEGA path starting with "/".`);
  }
  return t;
}

export function assertOptionalRemotePath(p: string | undefined, field = 'remotePath'): string | undefined {
  return p === undefined ? undefined : assertRemotePath(p, field);
}

/**
 * Validate a free-form positional argument (attribute name/value, contact email,
 * transfer tag, sync id, link, …). Rejects empty, NUL, and a leading "-" so a
 * model-supplied value can never be parsed as a CLI flag (flag-injection guard,
 * the same property assertRemotePath/assertLocalPath give paths). execFile
 * already prevents shell metacharacters; this closes the argv-flag gap.
 */
export function assertNoFlag(v: string, field: string): string {
  rejectNul(v);
  const t = v.trim();
  if (t === '') throw new ValidationError(`${field} is empty.`);
  if (t.startsWith('-')) throw new ValidationError(`${field} must not start with "-".`);
  return t;
}

/**
 * Resolve a local filesystem path to an absolute path. Resolving guarantees the
 * argument never begins with "-" (so it cannot be parsed as a flag) and removes
 * ambiguity about the working directory.
 */
export function assertLocalPath(p: string, field = 'localPath'): string {
  rejectNul(p);
  const t = p.trim();
  if (t === '') throw new ValidationError(`${field} is empty.`);
  // Trim before resolve: leading whitespace would otherwise re-root an absolute
  // path under cwd (resolve('  /x') -> '<cwd>/  /x').
  const abs = resolve(t);
  assertNotConfigDir(abs);
  return abs;
}
