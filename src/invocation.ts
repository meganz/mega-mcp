import { survivesRoundTrip } from './argv.js';
import { ValidationError, storeCopyIn } from './paths.js';

/**
 * Every MEGAcmd command a tool may run. Anything else - notably the commands that
 * print the session, export the master key, or set passwords and proxy
 * credentials - is refused here, so no tool added later can reach them by mistake.
 */
const ALLOWED_COMMANDS = new Set([
  'attr', 'backup', 'cat', 'cp', 'deleteversions', 'df', 'du', 'errorcode', 'export', 'find', 'get', 'import',
  'invite', 'ipc', 'killsession', 'logout', 'ls', 'mediainfo', 'mkdir', 'mount', 'mv', 'put', 'rm', 'share',
  'showpcr', 'sync', 'sync-config', 'sync-ignore', 'sync-issues', 'thumbnail', 'transfers', 'tree', 'userattr',
  'users', 'version', 'whoami',
  // mega_config's settings, each its own MEGAcmd command
  'speedlimit', 'https', 'graphics', 'log', 'permissions', 'reload', 'debug',
]);

/*
 * Credentials MEGAcmd prints next to a label, in the formats of its source
 * (megacmdexecuter.cpp). The links themselves are left alone - publishing one is
 * what mega_export is for.
 */
// Upload key of a writable link: " AuthKey=<key>" (file) and " AuthToken=<link
// path>:<key>" (folder) in extended node listings; "AuthToken = ..." on its own
// line when export creates one.
const LINK_KEYS = [/( AuthKey=)[^\s)]+/g, /(\bAuthToken[ \t]*=[ \t]*)[^\s)]+/g];
// The folder key handed to MEGA by `export --mega-hosted` (S4).
const SHARE_KEY = /(Share key encryption key[ \t]*=[ \t]*)\S+/g;
// The key part of a MEGA link ("#..." to the end of the word): a contact or share listing has no
// reason to carry one (`users -s` prints in-shares in full where MEGA knows the sharer's link).
const LINK_KEY_IN_URL = /(https?:\/\/mega\.(?:nz|co\.nz|app)\/[^\s#]*#)[^\s)]+/gi;
// The login session (resumes a login without the password), from logout --keep-session or the
// session command: never run, held anyway. whoami -l's "Session ID" handle cannot log in.
const SESSION_TOKEN = /((?:login with the session id|\(secret\) session is):[ \t]*)\S+/g;

/**
 * Which of those a command's output can carry. Only these outputs are scrubbed:
 * everything else - file contents from `cat`, names in listings that the guards
 * parse - reaches the tool exactly as MEGAcmd printed it. Commands that print the
 * session or master key, or take passwords, are not run at all (ALLOWED_COMMANDS).
 */
function secretsIn(cmd: string, args: readonly string[]): RegExp[] {
  switch (cmd) {
    case 'whoami':
    case 'logout':
      return [SESSION_TOKEN];
    case 'export':
      return [...LINK_KEYS, SHARE_KEY];
    case 'users':
    // share listings print no links today; held anyway, as for users.
    case 'share':
      return [...LINK_KEYS, LINK_KEY_IN_URL];
    // Extended node info (find -l; ls/tree -a) prints a link with its key.
    case 'find':
      return args.includes('-l') ? LINK_KEYS : [];
    case 'ls':
    case 'tree':
      return args.some((a) => /^-[a-zA-Z]*a/.test(a)) ? LINK_KEYS : [];
    default:
      return [];
  }
}

export function scrubSecrets(cmd: string, args: readonly string[], text: string): string {
  return secretsIn(cmd, args).reduce((t, re) => t.replace(re, '$1[hidden]'), text);
}

/** Commands that move, copy, publish or reveal node CONTENTS, or write into a folder. */
const CONTENT_COMMANDS = new Set(['cat', 'cp', 'mv', 'get', 'put', 'export', 'share', 'import', 'sync', 'backup', 'thumbnail', 'mkdir']);

/**
 * The one gate every MEGAcmd call passes (Runtime.run), whatever tool built it.
 * (Its counterpart on the way back is scrubSecrets, applied to the outputs that
 * can carry a credential.)
 *
 * Tools validate their own arguments first and give the better error message;
 * this is the backstop that a tool cannot forget. It enforces the invariants that
 * matter when the caller is a model that may have been steered by injected text:
 *
 *  1. Only the MEGAcmd commands the tools need run (ALLOWED_COMMANDS).
 *  2. MEGAcmd reads back exactly the words that were sent and approved (see
 *     argv.ts) - no value can turn into an option or merge with its neighbour.
 *  3. A copy of the session store never passes through a command that moves or
 *     reveals contents. Removing a public link or a share from one is allowed.
 */
export function assertSafeInvocation(cmd: string, args: readonly string[]): void {
  if (!ALLOWED_COMMANDS.has(cmd)) {
    throw new ValidationError(`The MEGAcmd command "${cmd}" is not one this connector runs. Nothing was run.`);
  }
  // A lone UTF-16 surrogate reaches MEGAcmd as U+FFFD: the checks would have compared another name.
  if (args.some((a) => /\p{Cs}/u.test(a))) {
    throw new ValidationError('A value holds a broken Unicode character (a lone surrogate), which MEGAcmd would read as another name. Nothing was run.');
  }
  // MEGAcmd's server may read only the first 8 KB of a command line (one socket read on macOS):
  // the rest would be dropped and the last word read became the target.
  // (On Windows the client also prefixes a local path with "\\?\": four more bytes a word.)
  if (Buffer.byteLength([cmd, ...args].join(' ')) + (process.platform === 'win32' ? 7 : 3) * args.length + 128 > 8000) {
    throw new ValidationError('The command would be too long for MEGAcmd to read whole. Nothing was run; act on fewer items at a time.');
  }
  if (!survivesRoundTrip([cmd, ...args])) {
    throw new ValidationError(
      'A value would be read differently by MEGAcmd than it was sent (for example a leading control character, or a trailing backslash that joins it to the next value), so the command could do something other than what was approved. Nothing was run.',
    );
  }
  // MEGAcmd's client rewrites some command lines: a one-path get/thumbnail gets its program
  // folder as the local target, and on Windows "-o <value>" is dropped. Refuse both.
  const positional = args.filter((a) => a !== '' && !a.startsWith('-'));
  if ((cmd === 'get' || cmd === 'thumbnail') && positional.length < 2) {
    throw new ValidationError(`${cmd} needs both a cloud path and a local path. Nothing was run.`);
  }
  if (args.includes('-o')) throw new ValidationError('The "-o" option is not passed to MEGAcmd. Nothing was run.');
  // (Only a pure removal: "-d" beside "-a" would still publish.)
  const removing = (cmd === 'export' || cmd === 'share') && args.includes('-d') && !args.includes('-a');
  // mkdir resolves names literally, so only a real .megaCmd name counts there.
  const hits = (a: string) => (cmd === 'mkdir' ? storeCopyIn(a) === 'name' : storeCopyIn(a) !== null);
  if (CONTENT_COMMANDS.has(cmd) && !removing && args.some(hits)) {
    throw new ValidationError(
      "This would pass a copy of the MEGAcmd session store (.megaCmd), which holds this account's MASTER KEY. Nothing was run.",
    );
  }
}
