/**
 * Parse `mega-whoami` stdout. When logged in, the account email appears as
 * "Account e-mail: <email>". This parser surfaces ONLY the email
 * (account identity, low sensitivity); it is fed the plain `whoami` output (no
 * `-l`), so no session material is ever parsed here. The
 * extended `whoami -l` is used ONLY by mega_account, which routes it through the
 * fail-closed allowlist parser in parsers/account.ts (never this one).
 */
export function parseWhoami(stdout: string): string | undefined {
  const m = stdout.match(/Account\s+e-?mail:\s*(\S+)/i);
  return m?.[1];
}
