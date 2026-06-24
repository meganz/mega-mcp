import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Runtime } from '../runtime.js';
import type { RunResult } from '../types.js';
import { ok, err } from '../mcpResult.js';
import { ValidationError } from '../paths.js';
import { classifyExit } from '../errors.js';
import { capLines } from '../parsers/listing.js';

/**
 * Dry-run preview for a PCRE pattern: enumerate the nodes a `--use-pcre`
 * operation would match (via `find <pattern> --use-pcre --show-handles`),
 * capturing each node's stable HANDLE. The confirmation preview shows the actual
 * affected set, and the op then executes on those exact handles — never by
 * re-evaluating the pattern — closing the preview→execute TOCTOU.
 */
export async function pcreMatchPreview(
  rt: Runtime,
  pattern: string,
  max = 50,
): Promise<{ ok: true; count: number; handles: string[]; text: string } | { ok: false; error: string }> {
  const r = await rt.run('find', [pattern, '--use-pcre', '--show-handles']);
  if (r.code !== 0) return { ok: false, error: classifyExit(r) };
  const entries: { path: string; handle: string }[] = [];
  for (const raw of r.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.*?)\s*<(H:[A-Za-z0-9_-]+)>\s*$/);
    if (m) entries.push({ path: m[1] as string, handle: m[2] as string });
  }
  const handles = entries.map((e) => e.handle);
  const shown = entries.slice(0, max).map((e) => `${e.path} <${e.handle}>`).join('\n');
  const note = entries.length > max ? `\n...(${entries.length} total; showing first ${max})` : '';
  return { ok: true, count: entries.length, handles, text: (shown || '(no matches)') + note };
}

// Token -> the exact node handles resolved at preview time. Keyed by the confirm
// token so the second (execute) call operates on the previewed set, immune to
// pattern re-evaluation. Mirrors the confirm-store TTL; held only in memory.
const pcrePlans = new Map<string, { handles: string[]; expires: number }>();
function stashPcrePlan(token: string, handles: string[], ttlMs = 120_000): void {
  const now = Date.now();
  for (const [t, p] of pcrePlans) if (p.expires < now) pcrePlans.delete(t);
  pcrePlans.set(token, { handles, expires: now + ttlMs });
}
function takePcrePlan(token: string): string[] | null {
  const p = pcrePlans.get(token);
  if (!p) return null;
  pcrePlans.delete(token);
  return p.expires < Date.now() ? null : p.handles;
}

/**
 * Two-call confirm gate for a PCRE-mode destructive/exfiltration op. First call:
 * resolve the pattern to concrete handles, show them in the preview, stash them
 * under the issued token. Second call: validate the token and return the stashed
 * handles. Returns `{ proceed: true, handles }` to execute, or `{ result }` to
 * return immediately (preview, invalid token, or expired plan).
 */
export async function pcreGate(
  rt: Runtime,
  action: string,
  normArgs: Record<string, unknown>,
  confirm: string | undefined,
  pattern: string,
  summaryFor: (count: number, text: string) => string,
): Promise<{ proceed: false; result: CallToolResult } | { proceed: true; handles: string[] }> {
  if (!confirm) {
    const prev = await pcreMatchPreview(rt, pattern);
    if (!prev.ok) return { proceed: false, result: err(prev.error) };
    const gate = checkConfirm(rt, action, normArgs, undefined, summaryFor(prev.count, prev.text)) as CallToolResult;
    const tok = (gate.structuredContent as { confirmToken?: string } | undefined)?.confirmToken;
    if (tok) stashPcrePlan(tok, prev.handles);
    return { proceed: false, result: gate };
  }
  const gate = checkConfirm(rt, action, normArgs, confirm, '');
  if (gate) return { proceed: false, result: gate };
  const handles = takePcrePlan(confirm);
  if (!handles) {
    return { proceed: false, result: err('The PCRE preview expired. Re-run without "confirm" to get a fresh preview, then confirm.') };
  }
  return { proceed: true, handles };
}

/**
 * Execute a command once per node handle (used after pcreGate). Aggregates
 * success/failure so a partial failure is reported, not thrown.
 */
export async function runPerHandle(
  rt: Runtime,
  cmd: string,
  handles: string[],
  argvFor: (handle: string) => string[],
): Promise<{ done: number; failed: number }> {
  let done = 0;
  let failed = 0;
  for (const h of handles) {
    const r = await rt.run(cmd, argvFor(h));
    if (r.code === 0) done++;
    else failed++;
  }
  return { done, failed };
}

/**
 * Run a tool body, converting a thrown ValidationError into a clean error
 * result and any other throw into a generic (non-leaking) error result. Tools
 * return errors, never throw (§A.9).
 */
export function guardRun(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  return fn().catch((e: unknown) =>
    e instanceof ValidationError
      ? err(e.message)
      : err(`Internal error: ${e instanceof Error ? e.message : String(e)}`),
  );
}

/**
 * Execute a mega-<command> and map the result: non-zero exit -> classified
 * error result; success -> the caller's onSuccess. Centralizes exit-code
 * handling (login/not-found/timeout/etc. all flow through classifyExit).
 */
export async function runToResult(
  rt: Runtime,
  cmd: string,
  args: string[],
  onSuccess: (r: RunResult) => CallToolResult,
): Promise<CallToolResult> {
  const r = await rt.run(cmd, args);
  if (r.code !== 0) return err(classifyExit(r), { ok: false, code: r.code });
  return onSuccess(r);
}

/**
 * The two-call confirmation gate (§D). Returns a result to short-circuit with
 * (either the confirmation prompt, or an invalid-token error), or null when the
 * action is confirmed and the caller should proceed to execute.
 *
 * `normArgs` must be the normalized (validated) action arguments WITHOUT the
 * confirm token, so the token binds to the exact operation being confirmed.
 */
export function checkConfirm(
  rt: Runtime,
  action: string,
  normArgs: unknown,
  confirm: string | undefined,
  summary: string,
): CallToolResult | null {
  if (!confirm) {
    const token = rt.confirm.issue(action, normArgs);
    return ok(
      `${summary}\n\nThis action requires confirmation. To proceed, call ${action} again with "confirm" set to:\n${token}`,
      { requiresConfirmation: true, confirmToken: token, summary },
    );
  }
  if (!rt.confirm.consume(action, normArgs, confirm)) {
    return err(
      'Confirmation token is invalid or expired. Re-run the tool without "confirm" to get a fresh token, then confirm.',
    );
  }
  return null;
}
