import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from '../runtime.js';
import { ok, err } from '../mcpResult.js';
import { guardRun, checkConfirm } from './helpers.js';
import { acquireMegacmd, isAcquireSupported } from '../download/megacmd.js';

type Acq = Awaited<ReturnType<typeof acquireMegacmd>>;

// Soft deadline for the synchronous part of setup. The MCP client times a
// request out (commonly ~60s); a ~50 MB download + native install can exceed
// that. We let the install run in the BACKGROUND and only wait this long before
// returning an "installing" status, so the call never trips the client timeout
// while the work silently continues and is reconciled on a later call.
const SOFT_DEADLINE_MS = Number(process.env.MEGA_MCP_SETUP_DEADLINE_MS) || 45_000;

// Module-scoped (one MCP server per process): the in-flight install and the
// last failure, shared across setup calls so a second call doesn't start a
// duplicate install and can report status instead.
let inFlight: Promise<Acq> | null = null;
let lastFailure: Acq | null = null;

/**
 * megacmd_setup — download MEGAcmd for this platform on first use, verify its
 * signature + checksum, and install it so the other tools work. Confirm-gated
 * (downloads + executes a ~50 MB native binary). Runs in the background and
 * reconciles on later calls so a slow install can't surface as a timeout error.
 * No login is involved.
 */
export function registerSetup(server: McpServer, rt: Runtime): void {
  server.registerTool(
    'megacmd_setup',
    {
      title: 'MEGA: set up MEGAcmd',
      description:
        'Download and install the MEGAcmd engine (verified by signature + checksum) so the MEGA tools can run. Use this when a tool reports that MEGAcmd is not available. Installs in the background — if it reports "installing", just retry shortly. Does not log in.',
      inputSchema: { confirm: z.string().optional().describe('Confirmation token from the first call.') },
      annotations: { title: 'MEGA: set up MEGAcmd', destructiveHint: false, openWorldHint: true },
    },
    async ({ confirm }) =>
      guardRun(async () => {
        if (!isAcquireSupported()) {
          return err(
            `Automatic MEGAcmd download is not available on ${process.platform} yet. Install MEGAcmd manually or set the MEGAcmd directory in the extension settings.`,
            { ok: false, reason: 'unsupported_os' },
          );
        }

        // Reconcile first: a background install from an earlier call may have
        // finished. Re-resolve and, if MEGAcmd is now available, report success.
        rt.invalidateResolved();
        const resolved = await rt.getResolved();
        if (resolved) {
          const auth = await rt.ensureReady();
          const state = auth.loggedIn
            ? `You are logged in as ${auth.email ?? '(unknown)'}.`
            : auth.reason === 'not_logged_in'
              ? 'It is not logged in yet — use mega_whoami for the exact login command.'
              : `Status: ${auth.reason}.`;
          return ok(`MEGAcmd is installed and available. ${state}`.trim(), {
            ok: true,
            ready: true,
            loggedIn: auth.loggedIn,
            email: auth.email,
          });
        }

        // Not installed. Start a background install if one isn't already running
        // (starting requires confirmation; joining an in-progress one does not).
        if (!inFlight) {
          const { url, version } = rt.config.download;
          const failNote = lastFailure
            ? ` (a previous attempt failed: ${lastFailure.reason}${lastFailure.detail ? ' — ' + lastFailure.detail : ''})`
            : '';
          const summary =
            `This will download MEGAcmd ${version ?? ''} from ${url} (~50 MB), verify its MEGA code signature and a pinned checksum before running anything, and install it.${failNote} No MEGA login is involved.`;
          const gate = checkConfirm(rt, 'megacmd_setup', { url, version }, confirm, summary);
          if (gate) return gate;

          lastFailure = null;
          inFlight = (async () => {
            try {
              const r = await acquireMegacmd(rt.config);
              if (r.ok) rt.invalidateResolved();
              else if (r.reason !== 'install_pending') lastFailure = r; // pending != failed
              return r;
            } finally {
              inFlight = null;
            }
          })();
          inFlight.catch(() => {}); // avoid an unhandled rejection if it throws
        }

        // Wait only up to the soft deadline. If the install finishes in time,
        // report the final result in this same call; otherwise return an
        // "installing" status and let it continue in the background.
        let timerId: NodeJS.Timeout;
        const timer = new Promise<{ done: false }>((r) => {
          timerId = setTimeout(() => r({ done: false }), SOFT_DEADLINE_MS);
          timerId.unref?.(); // don't keep the event loop alive if the install wins the race
        });
        const raced = await Promise.race([inFlight.then((r) => ({ done: true as const, r })), timer]);
        clearTimeout(timerId!);

        if (!raced.done) {
          return ok(
            'MEGAcmd installation is running in the background (download + verify + install; up to ~1 minute, especially on Windows). It does NOT log you in. Retry your last command shortly — or call megacmd_setup again to check status.',
            { installing: true },
          );
        }

        const res = raced.r;
        if (!res.ok) {
          // An interactive Windows install the user hasn't finished yet is NOT a
          // failure — report it as in-progress so they complete the dialog + retry.
          if (res.reason === 'install_pending') {
            return ok(res.detail ?? 'MEGAcmd installer launched — complete the dialog, then retry.', { installing: true });
          }
          return err(`MEGAcmd setup failed (${res.reason}). ${res.detail ?? ''}`.trim(), { ok: false, reason: res.reason });
        }

        rt.invalidateResolved();
        const auth = await rt.ensureReady();
        const state = auth.loggedIn
          ? `You are logged in as ${auth.email ?? '(unknown)'}.`
          : auth.reason === 'not_logged_in'
            ? 'It is not logged in yet — use mega_whoami for the exact login command.'
            : `Status: ${auth.reason}.`;
        const where = res.detail ?? `MEGAcmd ${res.version ?? ''} installed`;
        return ok(`${where}. ${state}`.trim(), { ok: true, version: res.version, loggedIn: auth.loggedIn, email: auth.email });
      }),
  );
}
