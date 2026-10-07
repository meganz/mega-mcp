import { survivesRoundTrip } from './argv.js';
import { ValidationError, assertNoInshareEnumeration, storeCopyIn } from './paths.js';

/** Commands that move, copy, publish or reveal node CONTENTS, or write into a folder. */
const CONTENT_COMMANDS = new Set(['cat', 'cp', 'mv', 'get', 'put', 'export', 'share', 'import', 'sync', 'backup', 'thumbnail', 'mkdir']);

/**
 * The one gate every MEGAcmd call passes (Runtime.run), whatever tool built it.
 *
 * Tools validate their own arguments first and give the better error message;
 * this is the backstop that a tool cannot forget. It enforces the invariants that
 * matter when the caller is a model that may have been steered by injected text:
 *
 *  1. MEGAcmd reads back exactly the words that were sent and approved (see
 *     argv.ts) - no value can turn into an option or merge with its neighbour.
 *  2. A copy of the session store never passes through a command that moves or
 *     reveals contents. Removing a public link or a share from one is allowed.
 *  3. Incoming shares are not enumerated by pattern unless contact details are
 *     exposed (each shows its sharer's email address).
 */
export function assertSafeInvocation(cmd: string, args: readonly string[], exposeContacts: boolean): void {
  if (!survivesRoundTrip([cmd, ...args])) {
    throw new ValidationError(
      'A value would be read differently by MEGAcmd than it was sent (for example a leading control character, or a trailing backslash that joins it to the next value), so the command could do something other than what was approved. Nothing was run.',
    );
  }
  const removing = (cmd === 'export' || cmd === 'share') && args.includes('-d');
  if (CONTENT_COMMANDS.has(cmd) && !removing && args.some((a) => storeCopyIn(a) !== null)) {
    throw new ValidationError(
      "This would pass a copy of the MEGAcmd session store (.megaCmd), which holds this account's MASTER KEY. Nothing was run.",
    );
  }
  const pattern = args.includes('--use-pcre');
  for (const a of args) assertNoInshareEnumeration(a, pattern, exposeContacts);
}
