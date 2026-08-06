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
    // Split into lines so the match listing keeps its structure; each line is
    // then escaped individually, since the node names in it come from the cloud
    // and are as untrusted as any other model-reachable value.
    const gate = checkConfirm(rt, action, normArgs, undefined, summaryFor(prev.count, prev.text).split('\n')) as CallToolResult;
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
 * Execute a command over MANY sources in a SINGLE invocation per chunk —
 * `cmd <src1> <src2> … <trailing…>` — instead of one call per source. MEGAcmd
 * `mv` accepts multiple sources, so an N-node move collapses to ⌈N/chunk⌉ calls
 * (usually 1). Sources are chunked to stay well under argv length limits. If a
 * chunk's bulk call fails, we retry that chunk item-by-item so a single bad node
 * doesn't sink the whole chunk and the done/failed tally stays exact.
 * `trailingArgv` is appended after the sources (e.g. `[dst]` for mv).
 */
export async function runBulk(
  rt: Runtime,
  cmd: string,
  sources: string[],
  trailingArgv: string[],
  chunkSize = 2000,
): Promise<{ done: number; failed: number }> {
  let done = 0;
  let failed = 0;
  for (let i = 0; i < sources.length; i += chunkSize) {
    const chunk = sources.slice(i, i + chunkSize);
    const r = await rt.run(cmd, [...chunk, ...trailingArgv]);
    if (r.code === 0) {
      done += chunk.length;
      continue;
    }
    for (const s of chunk) {
      const one = await rt.run(cmd, [s, ...trailingArgv]);
      if (one.code === 0) done++;
      else failed++;
    }
  }
  return { done, failed };
}

/**
 * Run a tool body, converting a thrown ValidationError into a clean error
 * result and any other throw into a generic (non-leaking) error result. Tools
 * return errors, never throw.
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
 * Neutralize C0 control characters in text that goes into a confirmation preview.
 *
 * The preview is the ONE thing a human reads before approving a destructive or
 * exfiltrating action, and every summary is built by interpolating model-supplied
 * values. The path validators reject NUL and a double quote but permit LF, CR,
 * TAB and ESC — enough to append convincing fake lines, to blank the real ones by
 * scrolling them away, or to emit ANSI escapes that rewrite what a terminal shows.
 * That would let the attacker who supplied the path also author the sentence the
 * user is agreeing to.
 *
 * Escaped rather than stripped so the value stays faithful: a name containing a
 * newline is still shown, just as `\n`.
 */
const CONTROL_ESCAPES: Record<string, string> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\x1b': '\\e',
};

/**
 * Escape control characters in ONE model-supplied value being interpolated into
 * a confirmation preview.
 *
 * The preview is the only thing a human reads before approving a destructive or
 * exfiltrating action, and every summary is built by interpolating values the
 * model supplied. The validators reject NUL and a double quote, but LF, CR, TAB
 * and ESC all pass - and all four survive MEGAcmd's argv round-trip intact
 * (verified against MEGAclient 2.5.2), so they are reachable in a real path and
 * cannot be rejected the way a quote is. A newline lets an attacker-chosen name
 * append convincing extra lines to the summary; ESC lets it rewrite what a
 * terminal shows. Either way the attacker who supplied the path also authors the
 * sentence the user agrees to.
 *
 * Escaped, not stripped, so the value stays faithful: a name that really does
 * contain a newline is still shown, as `\n`.
 *
 * Applied per VALUE, not to the assembled summary: our own templates use newlines
 * structurally (the upload listing, the session-store warning), and escaping
 * those would make every multi-line preview unreadable.
 */
export function previewSafe(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\x00-\x1f\x7f]/g, (c) => CONTROL_ESCAPES[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/**
 * The two-call confirmation gate. Returns a result to short-circuit with
 * (either the confirmation prompt, or an invalid-token error), or null when the
 * action is confirmed and the caller should proceed to execute.
 *
 * `normArgs` must be the normalized (validated) action arguments WITHOUT the
 * confirm token, so the token binds to the exact operation being confirmed.
 *
 * The summary is control-character-escaped HERE, centrally, so a tool added later
 * cannot forget it — forgetting now fails safe (over-escaped) rather than leaving
 * the preview forgeable. Pass an ARRAY when the preview has real structure: each
 * element is escaped on its own and the elements are joined with newlines, so our
 * line breaks survive while a newline inside a model-supplied value does not.
 */
export function checkConfirm(
  rt: Runtime,
  action: string,
  normArgs: unknown,
  confirm: string | undefined,
  rawSummary: string | string[],
): CallToolResult | null {
  const summary = Array.isArray(rawSummary) ? rawSummary.map(previewSafe).join('\n') : previewSafe(rawSummary);
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
