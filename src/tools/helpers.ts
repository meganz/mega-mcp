import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHmac, randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type { Runtime } from '../runtime.js';
import type { RunResult } from '../types.js';
import { ok, err } from '../mcpResult.js';
import { ValidationError, storeCopyIn } from '../paths.js';
import { classifyExit, ExitCode } from '../errors.js';
import { capLines } from '../parsers/listing.js';

/**
 * Most targets one confirmed operation may act on. Every target is named in the
 * preview — a preview that showed the first N and executed the rest would let a
 * target nobody saw ride along with the approval — so the cap is what keeps that
 * preview readable. A larger set is split into several confirmed operations.
 */
export const PLAN_MAX = 200;

/** Refuse a plan the preview could not name in full. */
export function assertPlanSize(count: number, what: string): void {
  if (count > PLAN_MAX) {
    throw new ValidationError(
      `This would act on ${count} ${what}; at most ${PLAN_MAX} can be confirmed at once, so that every one is listed in the preview. Split it into smaller operations (a narrower pattern, or shorter lists).`,
    );
  }
}

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
  max = PLAN_MAX,
): Promise<{ ok: true; count: number; handles: string[]; paths: string[]; topPaths: string[]; text: string } | { ok: false; error: string }> {
  const r = await rt.run('find', [pattern, '--use-pcre', '--show-handles']);
  if (r.code !== 0) return { ok: false, error: classifyExit(r) };
  // The listing prints node NAMES raw, one per line, and a name may contain a
  // line break - so a crafted name could add lines of its own, each with any
  // handle and any path it likes. The handle-only listing cannot be forged that
  // way (a handle is base64), so it is the authority: every line of the named
  // listing must parse, and the handles it yields must be exactly that set.
  const only = await rt.run('find', [pattern, '--use-pcre', '--print-only-handles']);
  if (only.code !== 0) return { ok: false, error: classifyExit(only) };
  const entries: { path: string; handle: string }[] = [];
  for (const raw of r.stdout.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    // Every line must carry a handle; together with the multiset check below, an
    // extra line from a name with a line break can no longer pass unnoticed.
    const m = raw.match(/^(.+) <(H:[A-Za-z0-9_-]+)>$/);
    if (!m) return { ok: false, error: UNLISTABLE };
    entries.push({ path: m[1] as string, handle: m[2] as string });
  }
  const authoritative: string[] = [];
  for (const raw of only.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!/^H:[A-Za-z0-9_-]+$/.test(line)) return { ok: false, error: UNLISTABLE };
    authoritative.push(line);
  }
  if (!sameMultiset(entries.map((e) => e.handle), authoritative)) return { ok: false, error: UNLISTABLE };
  // `find` recurses into every matched folder, so the raw set holds each match AND
  // all of its contents. Acting on all of them would move every descendant out on
  // its own (flattening the folder), or publish a link per file. Only the topmost
  // matches are acted on - their contents go with them - while `paths` keeps the
  // full set, so checks such as "no session-store copy" still see everything.
  const top = topmost(entries);
  const handles = top.map((e) => e.handle);
  const shown = top.slice(0, max).map((e) => `${e.path} <${e.handle}>`).join('\n');
  const note =
    (top.length > max ? `\n...(${top.length} total; showing first ${max})` : '') +
    (top.length < new Set(entries.map((e) => e.handle)).size ? '\n(Matched folders are acted on as a whole, together with everything inside them.)' : '');
  return { ok: true, count: top.length, handles, paths: entries.map((e) => e.path), topPaths: top.map((e) => e.path), text: (shown || '(no matches)') + note };
}


/** Per-process key: binds a secret into a confirm token without keeping or echoing it. */
const SECRET_KEY = randomBytes(32);

/**
 * What a confirm token binds for a secret value (a link password): an HMAC under a
 * key that never leaves this process. A preview approved for one password cannot
 * then be spent with another, and the password itself is never stored.
 */
export function secretBinding(secret: string | undefined): string | null {
  if (secret === undefined || secret === '') return null;
  return createHmac('sha256', SECRET_KEY).update(secret).digest('hex');
}

/**
 * Every name a downloaded node may be written under. The top folder of an incoming
 * share is spelled `<email>:<name>` - with or without `//from/`, and with or
 * without a trailing slash - but saved as `<name>`. Any last segment holding a
 * colon is therefore checked both ways.
 */
export function localNamesOf(remotePath: string): string[] {
  const base = posix.basename(remotePath.replace(/(.)\/+$/, '$1'));
  return base.includes(':') ? [base, base.slice(base.indexOf(':') + 1)] : [base];
}

const UNLISTABLE =
  'A matching node has a name this preview cannot list unambiguously (for example one containing a line break). Narrow the pattern so it does not match that node, or rename it first.';

/** Entries not inside another listed entry (a folder's match covers its contents). */
function topmost<T extends { path: string; handle: string }>(entries: T[]): T[] {
  const seen = new Set<string>();
  const unique = entries.filter((e) => (seen.has(e.handle) ? false : (seen.add(e.handle), true)));
  const paths = unique.map((e) => e.path.replace(/\/+$/, ''));
  return unique.filter((_, i) => !paths.some((other, j) => j !== i && (other === '' || paths[i]!.startsWith(`${other}/`))));
}

function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
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
 * return immediately (preview, invalid token, or expired plan). `checkPath` may
 * throw a ValidationError to refuse the whole operation over one matched path.
 */
export async function pcreGate(
  rt: Runtime,
  action: string,
  normArgs: Record<string, unknown>,
  confirm: string | undefined,
  pattern: string,
  summaryFor: (count: number, text: string) => string,
  checkPath?: (path: string, topmost: boolean) => void,
): Promise<{ proceed: false; result: CallToolResult } | { proceed: true; handles: string[] }> {
  if (!confirm) {
    const prev = await pcreMatchPreview(rt, pattern);
    if (!prev.ok) return { proceed: false, result: err(prev.error) };
    assertPlanSize(prev.count, 'matching nodes');
    // Checked on the PINNED set: execution runs on these handles and nothing else,
    // so a match refused here cannot come back in the second call.
    // `topmost` tells what is acted on from what goes along inside it.
    const tops = new Set(prev.topPaths);
    if (checkPath) for (const p of prev.paths) checkPath(p, tops.has(p));
    // (prev.count counts the topmost matches only: their contents go with them.)
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
 * (usually 1). Sources are chunked to stay well under argv length limits.
 * `trailingArgv` is appended after the sources (e.g. `[dst]` for mv).
 *
 * A failed chunk is NOT retried one source at a time. A multi-source `mv` fails
 * as a whole when the destination is not an existing folder, and a one-source
 * `mv` to such a destination is a RENAME: the first retry would rename that node
 * to the destination name, and each later retry would replace it, deleting the
 * previous one. The approved preview said "move N items into X", never that.
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
    if (r.code === 0) done += chunk.length;
    else failed += chunk.length;
  }
  return { done, failed };
}

/**
 * Refuse when a copy of the session store lies anywhere BELOW `remotePath`.
 *
 * The path checks see only the segments of the path itself, so copying, moving,
 * downloading, sharing or publishing the folder that CONTAINS a `.megaCmd` copy
 * would carry the master key along. Fails closed on any other error.
 */
export async function assertNoStoreCopyBelow(rt: Runtime, remotePath: string): Promise<void> {
  // Every FOLDER below, judged by name here rather than by a MEGAcmd pattern:
  // MEGAcmd's wildcards are case-sensitive, and a store copy may be `.MEGACMD`.
  const r = await rt.run('find', [remotePath, '--type=d']);
  // Not found, or no runnable MEGAcmd at all: the real command cannot run either,
  // and reports that itself.
  if (r.code === ExitCode.NOTFOUND || r.spawnError) return;
  if (r.code !== 0) throw new ValidationError(`Could not check ${remotePath} for a copy of the MEGAcmd session store: ${classifyExit(r)}`);
  if (r.stdout.split(/\r?\n/).some((line) => storeCopyIn(line.trim()) === 'name')) {
    throw new ValidationError(
      `${remotePath} contains a copy of the MEGAcmd session store (.megaCmd), which holds this account's MASTER KEY, so it is not copied, moved, downloaded, shared or published. Delete that .megaCmd folder from the cloud first.`,
    );
  }
}

/**
 * What a confirmation preview must say about a DESTINATION (MCP-4): whether what
 * lands there becomes visible to other people - an outgoing share or a public link
 * on the folder or any folder above it, or someone else's incoming share - and,
 * with `overwrite`, whether an existing FILE there is replaced. Read from MEGAcmd's
 * own listings; nothing from them (recipients' emails, links) is shown.
 */
export async function destinationNotes(rt: Runtime, dst: string, opts: { overwrite?: boolean } = {}): Promise<string[]> {
  if (dst.startsWith('//from/')) {
    return [`${dst} is a folder someone else shared with you: its owner, and anyone they share it with, will see what is placed there.`];
  }
  const notes: string[] = [];
  const chain = ancestorsOf(dst);
  // `share /` prints "<path>, shared with <email>...", `export /` prints
  // "<path> (<details>, shared as exported ...)", one line per shared/exported node.
  const shared = await listedPaths(rt, 'share', (line) => {
    const i = line.lastIndexOf(', shared');
    return i > 0 ? line.slice(0, i) : null;
  });
  const exported = await listedPaths(rt, 'export', (line) => {
    const i = line.lastIndexOf(' (');
    return i > 0 && line.includes('exported') ? line.slice(0, i) : null;
  });
  if (!shared || !exported) notes.push('(Could not check whether the destination is shared or has a public link.)');
  const sharedAt = shared && chain.find((p) => shared.has(p));
  const linkedAt = exported && chain.find((p) => exported.has(p));
  const self = dst.replace(/(.)\/+$/, '$1');
  const subject = (at: string) => (at === self ? dst : `${dst} is inside ${at}, which`);
  if (sharedAt) notes.push(`${subject(sharedAt)} is shared with other people: they will be able to see what is placed there.`);
  if (linkedAt) notes.push(`${subject(linkedAt)} has a public link: anyone with the link will be able to see what is placed there.`);
  if (opts.overwrite && (await remoteKind(rt, dst)) === 'file') notes.push(`${dst} is an existing FILE: it will be REPLACED.`);
  return notes;
}

/** What is at a cloud path. `find <path> --type=d` lists a folder itself, and nothing for a file. */
export async function remoteKind(rt: Runtime, path: string): Promise<'folder' | 'file' | 'missing' | 'unknown'> {
  const r = await rt.run('find', [path, '--type=d', '--print-only-handles']);
  if (r.code === ExitCode.NOTFOUND) return 'missing';
  if (r.code !== 0) return 'unknown';
  return r.stdout.trim() ? 'folder' : 'file';
}

/** `/a/b/c` -> [/a, /a/b, /a/b/c] (and `/` itself). */
function ancestorsOf(p: string): string[] {
  const parts = p.replace(/\/+$/, '').split('/').filter(Boolean);
  return ['/', ...parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`)];
}

async function listedPaths(rt: Runtime, cmd: 'share' | 'export', pathOf: (line: string) => string | null): Promise<Set<string> | null> {
  const r = await rt.run(cmd, ['/']);
  if (r.spawnError) return null;
  // No shares / no links at all is reported as "not found" by some versions.
  if (r.code === ExitCode.NOTFOUND) return new Set();
  if (r.code !== 0) return null;
  const paths = new Set<string>();
  for (const raw of r.stdout.split(/\r?\n/)) {
    const p = pathOf(raw.trim());
    if (p) paths.add(p.replace(/(.)\/+$/, '$1'));
  }
  return paths;
}

/**
 * Make sure `path` is an existing cloud FOLDER, creating it (and its parents) if
 * missing. MEGAcmd's `mkdir -p` reports an existing last folder as an error, so
 * that case is recognised here rather than failing the caller. 'file' when a
 * file already sits at `path`.
 */
export async function ensureRemoteFolder(rt: Runtime, path: string): Promise<'folder' | 'file' | 'error'> {
  // `mkdir` does not resolve the special roots (//from/, //in/, //bin): it would
  // create look-alike folders under / and report success.
  if (path.startsWith('//')) return 'error';
  // A trailing "/" makes mkdir accept an existing FILE as if it were a folder.
  const target = path.replace(/(.)\/+$/, '$1');
  const r = await rt.run('mkdir', ['-p', target]);
  if (r.code === 0) return 'folder';
  // Only MEGAcmd's own line about THIS path counts, never the same words echoed
  // from a name elsewhere in the message. Measured on MEGAcmd 2.6.0, it names just
  // the last component and closes the log bracket:
  //   [2026-10-07_03-49-59.658032 cmd ERR  Folder already exists: a]
  // The full path is accepted too, in case another version prints that.
  const leaf = target.slice(target.lastIndexOf('/') + 1);
  const names = `(?:${escapeRegExp(leaf)}|${escapeRegExp(target)})`;
  const line = (kind: string) => new RegExp(`(?:^|\\s)${kind} already exists: ${names}\\]?\\s*$`, 'm');
  if (line('Folder').test(r.stderr)) return 'folder';
  if (line('File').test(r.stderr)) return 'file';
  return 'error';
}

function escapeRegExp(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
