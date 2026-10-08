import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readdirSync, existsSync } from 'node:fs';
import { posix, join as joinLocal, dirname as dirnameLocal, basename as basenameLocal, sep as sepLocal, relative } from 'node:path';
import type { Runtime } from '../runtime.js';
import type { RunResult } from '../types.js';
import { ok, err } from '../mcpResult.js';
import { isIgnoreFileName, ValidationError, storeCopyIn, assertDownloadTarget, assertNotIgnoreFile, assertNotInsideProtected, localAtOrUnder, foldName, relativeWithin, joinRemote, ignoreFilesIn, onDiskSpelling, cloudNameOf, storeCopiesIn, isRecoveryKeyName, localSpellings } from '../paths.js';
import { parseExportLink } from '../parsers/exportLink.js';
import { classifyExit, ExitCode } from '../errors.js';
import { capLines } from '../parsers/listing.js';

/** How many targets a preview names; the operation itself is uncapped and binds every target. */
export const PLAN_MAX = 200;

/** Preview lines for a list: the first PLAN_MAX, then a count. Every item is still bound. */
export function listedLines(items: readonly string[], line: (item: string) => string = (i) => `  ${i}`): string[] {
  const shown = items.slice(0, PLAN_MAX).map(line);
  return items.length > PLAN_MAX ? [...shown, `  ...and ${items.length - PLAN_MAX} more (all ${items.length} are included).`] : shown;
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
): Promise<{ ok: true; count: number; handles: string[]; paths: string[]; topPaths: string[]; text: string; allHandles: string[] } | { ok: false; error: string }> {
  // A relative pattern matches relative to MEGAcmd's cwd; the checks need absolute paths.
  if (!pattern.startsWith('/')) {
    return { ok: false, error: 'A pattern must start with "/": MEGAcmd matches each part of the path separately, so write /Docs/.*\\.pdf (not ^/Docs/...).' };
  }
  // A large match set is still listed in full (the handle cross-check needs all of it).
  const r = await rt.run('find', [pattern, '--use-pcre', '--show-handles'], { maxBuffer: 128 * 1024 * 1024 });
  if (r.code !== 0) return { ok: false, error: classifyExit(r) };
  // The listing prints node NAMES raw, one per line, and a name may contain a
  // line break - so a crafted name could add lines of its own, each with any
  // handle and any path it likes. The handle-only listing cannot be forged that
  // way (a handle is base64), so it is the authority: every line of the named
  // listing must parse, and the handles it yields must be exactly that set.
  const only = await rt.run('find', [pattern, '--use-pcre', '--print-only-handles'], { maxBuffer: 128 * 1024 * 1024 });
  if (only.code !== 0) return { ok: false, error: classifyExit(only) };
  const entries: { path: string; handle: string }[] = [];
  for (const raw of r.stdout.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    // Every line must carry a handle; together with the multiset check below, an
    // extra line from a name with a line break can no longer pass unnoticed.
    const m = raw.match(/^(.+) <(H:[A-Za-z0-9_-]+)>$/);
    if (!m) return { ok: false, error: UNLISTABLE };
    // In-share matches print as "<email>:<share>/..." (//from/ here); refuse other relative ones.
    const shown = m[1] as string;
    const spelled = shown.startsWith('/') ? shown : /^[^/:\s]+@[^/:\s]+:/.test(shown) ? `//from/${shown}` : null;
    if (spelled === null) return { ok: false, error: UNLISTABLE };
    // (The SDK stores names NFC already: compared with NFC tool and listing paths, as a safeguard.)
    const path = spelled.normalize('NFC');
    entries.push({ path, handle: m[2] as string });
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
  // A pattern without regex characters names a node itself - a root too, which MEGA acts on under
  // its own name ("Rubbish Bin", "Vault"), not the name any check would see.
  const root = top.find((e) => /^(?:\/|\/\/(?:bin|in))\/?$/.test(e.path));
  if (root) return { ok: false, error: `The pattern matches the root ${root.path} itself; match the items inside it instead (for example ${root.path === '/' ? '' : root.path}/.*).` };
  const handles = top.map((e) => e.handle);
  const shown = top.slice(0, max).map((e) => `${e.path} <${e.handle}>`).join('\n');
  // What the shortened listing leaves out, by folder: no hidden match goes unnamed.
  const hiddenBy = new Map<string, number>();
  for (const e of top.slice(max)) hiddenBy.set(posix.dirname(e.path), (hiddenBy.get(posix.dirname(e.path)) ?? 0) + 1);
  const hidden = [...hiddenBy].sort((a, b) => b[1] - a[1]);
  const hiddenText = hidden.slice(0, 20).map(([dir, n]) => `${n} in ${dir}`).join(', ') + (hidden.length > 20 ? `, and ${hidden.length - 20} more folders` : '');
  const note =
    (top.length > max ? `\n...(${top.length} total; showing first ${max}. Not listed: ${hiddenText})` : '') +
    (top.length < new Set(entries.map((e) => e.handle)).size ? '\n(Matched folders are acted on as a whole, together with everything inside them.)' : '');
  return { ok: true, count: top.length, handles, paths: entries.map((e) => e.path), topPaths: top.map((e) => e.path), text: (shown || '(no matches)') + note, allHandles: entries.map((e) => e.handle) };
}

/**
 * Confirmed call of a plan whose checks depend on names: each pinned handle must keep its
 * previewed path and the checks rerun, so a node renamed to .megaCmd cannot slip through.
 */
async function recheckPcrePlan(
  rt: Runtime,
  pattern: string,
  plan: PcrePlan,
  checkPath: (path: string, topmost: boolean) => void,
): Promise<string | null> {
  const now = await pcreMatchPreview(rt, pattern);
  if (!now.ok) return now.error;
  // find also lists matched folders' contents: anything moved in or out changes that set.
  if (plan.contents !== undefined && handlesDigest(now.allHandles) !== plan.contents) {
    return 'What the matched folders hold changed after the preview (an item moved in or out). Nothing was run; preview again.';
  }
  const pathOf = new Map(now.handles.map((h, i) => [h, now.topPaths[i]]));
  for (let i = 0; i < plan.handles.length; i++) {
    if (pathOf.get(plan.handles[i] as string) !== plan.paths[i]) {
      return `${plan.paths[i]} changed (renamed or moved) after the preview. Nothing was run; preview again.`;
    }
  }
  const tops = new Set(now.topPaths);
  for (const p of now.paths) checkPath(p, tops.has(p));
  return null;
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
  // Each also as MEGA may escape it on disk (Windows, exFAT, HFS+).
  return [...new Set((base.includes(':') ? [base, base.slice(base.indexOf(':') + 1)] : [base]).flatMap(localSpellings))];
}

const UNLISTABLE =
  'A matching node has a name this preview cannot list unambiguously (for example one containing a line break). Narrow the pattern so it does not match that node, or rename it first.';

/** Entries not inside another listed entry (a folder's match covers its contents). */
function topmost<T extends { path: string; handle: string }>(entries: T[]): T[] {
  const seen = new Set<string>();
  const unique = entries.filter((e) => (seen.has(e.handle) ? false : (seen.add(e.handle), true)));
  const paths = unique.map((e) => e.path.replace(/\/+$/, ''));
  // Topmost: no proper ancestor is matched too (a set lookup per ancestor, not quadratic).
  const matched = new Set(paths);
  return unique.filter((_, i) => {
    let a = paths[i] as string;
    for (let cut = a.lastIndexOf('/'); cut >= 0; cut = a.lastIndexOf('/')) {
      a = a.slice(0, cut);
      if (matched.has(a)) return false;
    }
    return true;
  });
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
interface PcrePlan {
  handles: string[];
  /** The path each pinned handle had in the preview (same order). */
  paths: string[];
  /** opts.bound(paths) at preview time: recomputed and compared on confirm. */
  bound: string;
  /** With bindContents: a digest of every node the preview listed, matches and contents. */
  contents?: string;
  expires: number;
}

function handlesDigest(handles: readonly string[]): string {
  return createHash('sha256').update([...handles].sort().join('\n')).digest('hex');
}
const pcrePlans = new Map<string, PcrePlan>();
function stashPcrePlan(token: string, handles: string[], paths: string[], bound: string, contents?: string, ttlMs = 120_000): void {
  const now = Date.now();
  for (const [t, p] of pcrePlans) if (p.expires < now) pcrePlans.delete(t);
  pcrePlans.set(token, { handles, paths, bound, contents, expires: now + ttlMs });
}
function takePcrePlan(token: string): PcrePlan | null {
  const p = pcrePlans.get(token);
  if (!p) return null;
  pcrePlans.delete(token);
  return p.expires < Date.now() ? null : p;
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
  summaryFor: (count: number, text: string, topPaths: string[]) => string,
  checkPath?: (path: string, topmost: boolean) => void,
  opts: {
    recheckNames?: boolean;
    /** Extra preview lines from the pinned matches (what was placed in them, ...). */
    extraLines?: (topPaths: string[]) => string[] | Promise<string[]>;
    /** Bind what the matched folders hold (sharing, publishing): a change voids the token. */
    bindContents?: boolean;
  } = {},
): Promise<{ proceed: false; result: CallToolResult } | { proceed: true; handles: string[]; paths: string[] }> {
  const extra = async (tops: string[]) => (opts.extraLines ? await opts.extraLines(tops) : []);
  if (!confirm) {
    const prev = await pcreMatchPreview(rt, pattern);
    if (!prev.ok) return { proceed: false, result: err(prev.error) };
    // Checked on the PINNED set: execution runs on these handles and nothing else,
    // so a match refused here cannot come back in the second call.
    // `topmost` tells what is acted on from what goes along inside it.
    const tops = new Set(prev.topPaths);
    if (checkPath) for (const p of prev.paths) checkPath(p, tops.has(p));
    // (prev.count counts the topmost matches only: their contents go with them.)
    // Split into lines so the match listing keeps its structure; each line is
    // then escaped individually, since the node names in it come from the cloud
    // and are as untrusted as any other model-reachable value.
    const lines = summaryFor(prev.count, prev.text, prev.topPaths).split('\n');
    lines.splice(1, 0, `  (pattern: ${pattern})`);
    const added = await extra(prev.topPaths);
    const gate = checkConfirm(rt, action, normArgs, undefined, [...lines, ...added]) as CallToolResult;
    const tok = (gate.structuredContent as { confirmToken?: string } | undefined)?.confirmToken;
    if (tok) stashPcrePlan(tok, prev.handles, prev.topPaths, added.join('\n'), opts.bindContents ? handlesDigest(prev.allHandles) : undefined);
    return { proceed: false, result: gate };
  }
  const gate = checkConfirm(rt, action, normArgs, confirm, '');
  if (gate) return { proceed: false, result: gate };
  const plan = takePcrePlan(confirm);
  if (!plan) {
    return { proceed: false, result: err('The PCRE preview expired. Re-run without "confirm" to get a fresh preview, then confirm.') };
  }
  // Extra lines are looked up by path: a matched folder moved (and filled elsewhere) since
  // the preview would otherwise compare as unchanged.
  if (opts.recheckNames || opts.extraLines || opts.bindContents) {
    const changed = await recheckPcrePlan(rt, pattern, plan, checkPath ?? (() => {}));
    if (changed) return { proceed: false, result: err(changed) };
  }
  if ((await extra(plan.paths)).join('\n') !== plan.bound) {
    return { proceed: false, result: err('Something changed in the matched folders after the preview (an item placed in them, say). Nothing was run; preview again.') };
  }
  return { proceed: true, handles: plan.handles, paths: plan.paths };
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
  for (const chunk of chunkArgs(sources, chunkSize, trailingArgv)) {
    // A chunk the gate refuses (still too long) counts as failed; the rest still run.
    const r = await rt.run(cmd, [...chunk, ...trailingArgv]).catch((e: unknown) => {
      if (e instanceof ValidationError) return null;
      throw e;
    });
    if (r?.code === 0) done += chunk.length;
    else failed += chunk.length;
  }
  return { done, failed };
}

/** assertNoStoreCopyBelow for a list in one `find`; on any failure, each path on its own. */
export async function assertNoStoreCopyBelowMany(rt: Runtime, paths: readonly string[]): Promise<void> {
  if (paths.length === 1) return assertNoStoreCopyBelow(rt, paths[0] as string);
  for (const chunk of chunkArgs(paths)) {
    const r = await rt.run('find', [...chunk, '--type=d']);
    if (r.code !== 0) {
      for (const p of chunk) await assertNoStoreCopyBelow(rt, p);
      continue;
    }
    const hit = r.stdout.split(/\r?\n/).map((l) => l.trim()).find((line) => storeCopyIn(line) === 'name');
    if (hit) {
      const src = chunk.find((p) => hit === p || hit.startsWith(`${p.replace(/\/+$/, '')}/`)) ?? chunk.join(', ');
      throw new ValidationError(
        `${src} contains a copy of the MEGAcmd session store (${hit}), which holds this account's MASTER KEY, so it is not copied, moved, downloaded, shared or published. Delete that .megaCmd folder from the cloud first.`,
      );
    }
  }
}

/** Refuse when a session-store copy lies anywhere BELOW `remotePath` (it would go along); fails closed. */
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
 * .megaignore rules fold ASCII case only (SDK syncfilter.cpp), macOS/Windows fold Unicode:
 * refuse a sync whose cloud side holds a twin ("ſupport") of a path its rules leave out.
 */
export async function assertNoFoldTwinBelow(rt: Runtime, remotePath: string, excludedRels: readonly string[]): Promise<void> {
  if (excludedRels.length === 0) return;
  const r = await rt.run('find', [remotePath], { maxBuffer: 128 * 1024 * 1024 });
  if (r.code === ExitCode.NOTFOUND || r.spawnError) return;
  if (r.code !== 0) throw new ValidationError(`Could not check ${remotePath} for folders named like the ones this sync leaves out: ${classifyExit(r)}`);
  // Every leading part of each excluded path ("Library", "Library/Application Support", ...).
  const prefixes = new Map<string, string>();
  for (const rel of excludedRels) {
    const segs = rel.split('/');
    for (let i = 1; i <= segs.length; i++) prefixes.set(foldName(segs.slice(0, i).join('/')), segs.slice(0, i).join('/'));
  }
  const base = remotePath.replace(/(.)\/+$/, '$1');
  // find prints someone else's share as "<email>:<share>/...".
  const shown = base.startsWith('//from/') ? base.slice('//from/'.length) : base;
  const lead = shown === '/' ? '/' : `${shown}/`;
  const asciiFold = (s: string) => s.normalize('NFC').replace(/[A-Z]/g, (c) => c.toLowerCase());
  for (const raw of r.stdout.split(/\r?\n/)) {
    const p = raw.trim();
    if (!p.startsWith(lead)) continue;
    const rel = p.slice(lead.length);
    const exact = prefixes.get(foldName(rel));
    if (exact !== undefined && asciiFold(rel) !== asciiFold(exact)) {
      throw new ValidationError(
        `${remotePath} holds ${p}, which this computer treats as the same folder as ${exact} - a folder the sync must leave out - but MEGA's sync rules would not see it that way. Rename or remove it in the cloud before syncing.`,
      );
    }
  }
}

/**
 * What a confirmation preview must say about a DESTINATION (MCP-4): whether what
 * lands there becomes visible to other people - an outgoing share or a public link
 * on the folder or any folder above it, or someone else's incoming share - and,
 * with `overwrite`, whether an existing FILE there is replaced. Read from MEGAcmd's
 * own listings; nothing from them (recipients' emails, links) is shown.
 */
// `share -p /`: "<path>, shared [(still pending)] with <email>" or "<path>, (still pending) ...".
function sharePathOf(line: string): string | null {
  const i = Math.max(line.lastIndexOf(', shared'), line.lastIndexOf(', (still pending)'));
  return i > 0 ? line.slice(0, i) : null;
}

// `export /`: "<path> (<details>, shared as exported ...)"; the details can hold brackets of their own.
function exportPathOf(line: string): string | null {
  const i = openingBracket(line);
  return i > 0 && line.slice(i).includes('exported') ? line.slice(0, i).replace(/ $/, '') : null;
}

/**
 * Shared or linked folders INSIDE `cloudPath`: a transfer that merges into existing subfolders
 * (a folder download or upload, what a sync uploads) reaches them too.
 */
export async function sharedBelowNotes(rt: Runtime, cloudPath: string): Promise<string[]> {
  const p = cloudPath.replace(/(.)\/+$/, '$1');
  // A share to you is named as a whole by destinationNotes.
  if (p.startsWith('//from/')) return [];
  const root = (p.match(/^\/\/(?:bin|in)(?=\/|$)/) ?? ['/'])[0];
  const shared = await listedPaths(rt, 'share', root, sharePathOf);
  const exported = await listedPaths(rt, 'export', root, exportPathOf);
  if (!shared || !exported) return [`(Could not check whether folders inside ${p} are shared or have a public link.)`];
  const inside = (set: Set<string>) => [...set].filter((x) => x !== p && under(x, p)).sort();
  return [
    ...inside(shared).map((x) => `${x}, inside ${p}, is shared with other people: what lands there is visible to them.`),
    ...inside(exported).map((x) => `${x}, inside ${p}, has a public link: what lands there is visible to anyone with the link.`),
  ];
}

export async function destinationNotes(rt: Runtime, dst: string, opts: { overwrite?: 'version' | 'delete'; backups?: boolean } = {}): Promise<string[]> {
  const notes: string[] = [];
  // An upload makes the new version; MEGAcmd's cp/mv delete the old file with all its versions.
  const replaced =
    opts.overwrite === 'delete'
      ? `${dst} is an existing FILE: it will be REPLACED, and it and all its older versions are deleted for good (not kept as a version, not in the Rubbish Bin).`
      : `${dst} is an existing FILE: it will be REPLACED (kept as an older version only while file versioning is on).`;
  // A two-way synced folder is written to disk, where a file can matter (autostart, config).
  const mirror = await localMirrorOf(rt, dst);
  if (mirror === undefined) notes.push('(Could not check whether the destination is in a synced folder.)');
  else if (mirror) {
    notes.push(`${dst} is in a synced folder: what is placed there is also written to this computer, at ${mirror}.`);
    const exec = await executableDownloadNote(rt);
    if (exec) notes.push(exec);
    // ...where a scheduled backup may upload it again (and who sees that). Not followed further.
    if (opts.backups !== false) for (const n of await backedUpLines(rt, mirror)) if (!notes.includes(n)) notes.push(n);
  }
  if (dst.startsWith('//from/')) {
    const out = [`${dst} is a folder someone else shared with you: its owner, and anyone they share it with, will see what is placed there.`, ...notes];
    if (opts.overwrite && (await remoteKind(rt, dst)) === 'file') out.push(replaced);
    return out;
  }
  // //bin and //in are roots of their own for share/export listings; a folder moved to the
  // Rubbish Bin keeps its shares and links.
  const root = (dst.match(/^\/\/(?:bin|in)(?=\/|$)/) ?? ['/'])[0];
  const chain = ancestorsOf(dst);
  const shared = await listedPaths(rt, 'share', root, sharePathOf);
  const exported = await listedPaths(rt, 'export', root, exportPathOf);
  if (!shared || !exported) notes.push('(Could not check whether the destination is shared or has a public link.)');
  const sharedAt = shared && chain.find((p) => shared.has(p));
  const linkedAt = exported && chain.find((p) => exported.has(p));
  const self = dst.replace(/(.)\/+$/, '$1');
  const subject = (at: string) => (at === self ? dst : `${dst} is inside ${at}, which`);
  if (sharedAt) notes.push(`${subject(sharedAt)} is shared with other people: they will be able to see what is placed there.`);
  if (linkedAt) notes.push(`${subject(linkedAt)} has a public link: anyone with the link will be able to see what is placed there.`);
  if (opts.overwrite && (await remoteKind(rt, dst)) === 'file') notes.push(replaced);
  return notes;
}

/**
 * How many items a literal path names: names repeat, and MEGAcmd reads a path with any
 * non-[A-Za-z0-9_] character as a pattern, acting on all of them. Callers bind `count`.
 */
export async function sameNamed(rt: Runtime, path: string): Promise<{ count: number; lines: string[] }> {
  // Wide enough that the size never runs into a long path.
  const r = await rt.run('du', [`--path-display-size=${path.length + 2}`, path]);
  if (r.code === ExitCode.NOTFOUND) return { count: 0, lines: [] };
  if (r.code !== 0) return { count: -1, lines: [`(Could not check how many items are named ${path}.)`] };
  let count = 0;
  for (const line of r.stdout.split(/\r?\n/).slice(1)) {
    if (/^-+$/.test(line.trim())) break;
    if (!line.trim()) continue;
    // Every item is one "<path>: <size>" line; a name with a line break breaks that.
    if (!/:\s+[\d.]+(?:\s*[A-Za-z]+)?\s*$/.test(line)) return { count: -1, lines: [`(Could not check how many items are named ${path}.)`] };
    count++;
  }
  return { count, lines: sameNameLines(path, count) };
}

function sameNameLines(path: string, count: number): string[] {
  return count > 1 ? [`Note: ${count} items are named ${path} - this acts on ALL of them.`] : [];
}

/**
 * sameNamed for a list in one `du`; a path it cannot attribute (an in-share, or a missing
 * path ending du early) is counted on its own.
 */
export async function sameNamedMany(rt: Runtime, paths: readonly string[]): Promise<{ count: number; lines: string[] }[]> {
  const counts: (number | null)[] = paths.map(() => null);
  if (paths.length > 1) {
    let at = 0;
    for (const chunk of chunkArgs(paths)) {
      // Wide enough that no path is shortened - and no wider: MEGAcmd pads every line to it.
      const width = Math.max(...chunk.map((p) => p.length)) + 2;
      const r = await rt.run('du', [`--path-display-size=${width}`, ...chunk]);
      if (r.code === 0) {
        const lines = r.stdout.split(/\r?\n/);
        chunk.forEach((p, i) => {
          const n = lines.filter((l) => l.startsWith(`${p}:`) && /^\s+[\d.]+(?:\s*[A-Za-z]+)?\s*$/.test(l.slice(p.length + 1))).length;
          if (n > 0) counts[at + i] = n;
        });
      }
      at += chunk.length;
    }
  }
  const out: { count: number; lines: string[] }[] = [];
  for (let i = 0; i < paths.length; i++) {
    const n = counts[i];
    out.push(n === null || n === undefined ? await sameNamed(rt, paths[i] as string) : { count: n, lines: sameNameLines(paths[i] as string, n) });
  }
  return out;
}

/**
 * MEGAcmd applies its saved file permissions to every download and sync: execute bits make
 * downloads runnable, so the preview says so (no such setting on Windows).
 */
export async function executableDownloadNote(rt: Runtime): Promise<string | null> {
  if (process.platform === 'win32') return null;
  const r = await rt.run('permissions', ['--files']);
  const m = r.stdout.match(/Default files permissions:\s*([0-7]{3})/);
  if (m && /[1357]/.test(m[1] as string)) {
    return `Downloaded files will be EXECUTABLE: MEGAcmd's file permissions are ${m[1]} (a file in a folder on PATH could then run in place of a program).`;
  }
  return null;
}

const SYNC_SEP = ';;MEGA-MCP;;';

interface SyncPair {
  local: string;
  remote: string;
  /** Only a running sync's cloud path is kept current; a paused one's may be stale. */
  running: boolean;
}

/**
 * Every configured sync, or null when the list cannot be read or parsed. Not cached: a
 * sync added a moment ago counts. In-shares ("email:Share/...") become //from/.
 */
/**
 * MEGAcmd prints cloud paths raw: a folder name holding a line break would add rows to a listing.
 * The same listing without any path column has one line per sync; a different count = unreadable.
 */
async function syncRowsIntact(rt: Runtime, listed: string, args: readonly string[]): Promise<boolean> {
  const r = await rt.run('sync', [...args, `--col-separator=${SYNC_SEP}`]);
  const lines = (t: string) => t.split(/\r?\n/).filter((l) => l.trim() !== '').length;
  return r.code === 0 && lines(r.stdout) === lines(listed);
}

async function syncPairs(rt: Runtime, unrunnable: SyncPair[] | null = null): Promise<SyncPair[] | null> {
  const r = await rt.run('sync', ['--output-cols=LOCALPATH,REMOTEPATH,RUN_STATE', `--col-separator=${SYNC_SEP}`]);
  // Only a missing MEGAcmd means "nothing runs"; any other spawn failure leaves the list unknown.
  if (r.spawnError) return r.spawnError === 'NO_MEGACMD' ? unrunnable : null;
  if (r.code !== 0) return r.code === ExitCode.NOTFOUND ? [] : null;
  if (!(await syncRowsIntact(rt, r.stdout, ['--output-cols=RUN_STATE']))) return null;
  const out: SyncPair[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.trim() === '' || line === `LOCALPATH${SYNC_SEP}REMOTEPATH${SYNC_SEP}RUN_STATE`) continue;
    const parts = line.split(SYNC_SEP);
    // MEGAcmd's notice after the table ("Some of your "Pending" sync uploads...") has no separator.
    if (parts.length === 1) continue;
    if (parts.length !== 3) return null;
    const remote = (parts[1] as string).replace(/(.)\/+$/, '$1').normalize('NFC');
    out.push({ local: parts[0] as string, remote: remote.startsWith('/') ? remote : `//from/${remote}`, running: (parts[2] as string).trim().toLowerCase() === 'running' });
  }
  return out;
}

/**
 * One sync by its id (or local folder), with its cloud folder's handle: null if there is no
 * such sync, undefined if the list cannot be read. The cloud path is the last one MEGA knew.
 */
export async function syncById(rt: Runtime, id: string): Promise<{ local: string; remote: string; handle: string; running: boolean } | null | undefined> {
  const r = await rt.run('sync', ['--show-handles', '--output-cols=ID,LOCALPATH,REMOTEHANDLE,REMOTEPATH,RUN_STATE', `--col-separator=${SYNC_SEP}`]);
  if (r.code === ExitCode.NOTFOUND) return null;
  if (r.code !== 0) return undefined;
  if (!(await syncRowsIntact(rt, r.stdout, ['--show-handles', '--output-cols=ID,RUN_STATE']))) return undefined;
  let found: { local: string; remote: string; handle: string; running: boolean } | null = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    const parts = line.split(SYNC_SEP);
    if (parts.length === 1 || parts[0] === 'ID') continue;
    if (parts.length !== 5) return undefined;
    // Paths as printed (not padded with this separator): a name may end in a space.
    const [sid, local, handle, remote, state] = parts.map((p, i) => (i === 1 || i === 3 ? p : p.trim())) as [string, string, string, string, string];
    if (sid !== id && local !== id) continue;
    // Two rows answering to it: which one MEGAcmd acts on is not known.
    if (found) return undefined;
    const h = handle.match(/^<(H:[A-Za-z0-9_-]{8})>$/)?.[1];
    if (!h) return undefined;
    const rp = remote.replace(/(.)\/+$/, '$1').normalize('NFC');
    found = { local, remote: rp.startsWith('/') ? rp : `//from/${rp}`, handle: h, running: state.toLowerCase() === 'running' };
  }
  return found;
}

/** Is the folder with `handle` still at `path`? (`find` lists a folder itself last.) */
export async function folderStillAt(rt: Runtime, path: string, handle: string): Promise<boolean> {
  // Roots cannot move: the Cloud Drive, the Rubbish Bin, the Vault. A share's top folder is
  // named after the ":" ("//from/<email>:<name>").
  if (/^(?:\/|\/\/(?:bin|in))$/.test(path)) return true;
  const top = path.match(/^\/\/from\/[^/:]+:([^/]+)$/)?.[1];
  const r = await rt.run('find', [path, '--type=d', '--print-only-handles', `--pattern=${top ?? posix.basename(path)}`]);
  if (r.code !== 0) return false;
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() === handle;
}

/** Local path a two-way sync mirrors `cloudPath` to; null if none, undefined if unknown. */
export async function localMirrorOf(rt: Runtime, cloudPath: string): Promise<string | null | undefined> {
  return mirrorIn(await syncPairs(rt), cloudPath);
}

function mirrorIn(pairs: SyncPair[] | null, cloudPath: string): string | null | undefined {
  if (!pairs) return undefined;
  const p = cloudPath.replace(/(.)\/+$/, '$1');
  for (const { local, remote } of pairs) {
    if (p === remote) return local;
    const prefix = remote === '/' ? '/' : `${remote}/`;
    if (p.startsWith(prefix)) return localOfCloud(local, p.slice(prefix.length).split('/'));
  }
  // (A sync that is not running is matched by its last known cloud path.)
  return null;
}

/**
 * Where cloud names below a sync's local root are on disk: a local "my%20project" is the cloud's
 * "my project" (the SDK decodes `%xx`), so each part is matched against what already exists.
 */
function localOfCloud(root: string, parts: readonly string[]): string {
  let cur = root;
  for (const part of parts) {
    const direct = joinLocal(cur, part);
    if (existsSync(direct)) {
      cur = direct;
      continue;
    }
    let match: string | undefined;
    try {
      match = readdirSync(cur).find((e) => cloudNameOf(e) === part.normalize('NFC'));
    } catch {
      match = undefined;
    }
    cur = joinLocal(cur, match ?? part);
  }
  return cur;
}

/**
 * Removing or moving out of a two-way synced folder does the same locally: refused for a
 * protected local path or a .megaignore (the sync's rules), otherwise noted in the preview.
 */
export async function syncedSourceNotes(rt: Runtime, paths: readonly string[], what: 'removed' | 'moved'): Promise<string[]> {
  // (No MEGAcmd at all: nothing is removed or moved either.)
  const pairs = await syncPairs(rt, []);
  const lines: string[] = [];
  for (const p of paths) {
    const mirror = mirrorIn(pairs, p);
    if (mirror === undefined) {
      // Unknown is not "not synced": a sync could carry this change to a protected local folder.
      throw new ValidationError(`Could not read MEGAcmd's list of syncs, so whether ${what === 'removed' ? 'removing' : 'moving'} ${p} also changes a folder on this computer is unknown. Nothing was run; try again.`);
    }
    if (!mirror) continue;
    if (isIgnoreFileName(posix.basename(p))) {
      throw new ValidationError(`${p} holds the rules of a synced folder (${mirror}); it is not ${what} through this tool.`);
    }
    try {
      assertDownloadTarget(dirnameLocal(mirror), basenameLocal(mirror));
    } catch {
      throw new ValidationError(
        `${p} is in a synced folder: this would also change ${mirror} on this computer, which is, holds or is inside a folder MEGAcmd, this connector or the app depends on. Nothing was run.`,
      );
    }
    lines.push(`${p} is in a synced folder: it is also ${what} on this computer, at ${mirror}.`);
  }
  return listedLines(lines, (l) => l);
}

/**
 * Files in a cloud folder that a sync could read as a .megaignore: "." + 10 characters, or a
 * name MEGA decodes to one (`%2emegaignore`). `unchecked`: a listing failed; null: no MEGAcmd.
 */
export async function ignoreFilesBelow(rt: Runtime, path: string): Promise<{ hits: string[]; unchecked: boolean } | null> {
  const hits: string[] = [];
  let unchecked = false;
  for (const pattern of ['.??????????*', '%2e*']) {
    const r = await rt.run('find', [path, '--type=f', `--pattern=${pattern}`]);
    if (r.spawnError === 'NO_MEGACMD') return null;
    if (r.spawnError) {
      unchecked = true;
      continue;
    }
    if (r.code === ExitCode.NOTFOUND) continue;
    if (r.code !== 0) unchecked = true;
    else hits.push(...r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && isIgnoreFileName(posix.basename(l))));
  }
  return { hits, unchecked };
}

/** A .megaignore below the root of a cloud folder about to be synced would be downloaded and read first. */
export async function assertNoNestedIgnoreFile(rt: Runtime, remotePath: string): Promise<void> {
  const r = await ignoreFilesBelow(rt, remotePath);
  if (!r) return;
  if (r.unchecked) throw new ValidationError(`Could not check ${remotePath} for .megaignore files before syncing it.`);
  const base = remotePath.replace(/(.)\/+$/, '$1');
  const shown = base.startsWith('//from/') ? base.slice('//from/'.length) : base;
  const hit = r.hits.find((l) => posix.dirname(l) !== shown);
  if (hit) throw new ValidationError(`${remotePath} holds ${hit}; a .megaignore below the root of a sync decides what it carries there, so remove it in the cloud before syncing.`);
}

/** Cloud folders of two-way syncs strictly below `cloudPath`, with their local side (null: unknown). */
export async function syncRootsBelowCloud(rt: Runtime, cloudPath: string): Promise<string[] | null> {
  const pairs = await syncPairs(rt, []);
  if (!pairs) return null;
  const p = cloudPath.replace(/(.)\/+$/, '$1');
  return pairs.filter((x) => x.remote !== p && under(x.remote, p)).map((x) => `${x.remote} <-> ${x.local}`);
}

/** Local folders of all two-way syncs (null: the sync list could not be read). */
export async function syncLocalRoots(rt: Runtime): Promise<string[] | null> {
  // No runnable MEGAcmd: nothing is downloaded either.
  const pairs = await syncPairs(rt, []);
  return pairs ? pairs.map((p) => p.local) : null;
}

/** A moved folder that is, or holds, a sync's or backup's cloud side: it follows (by handle) to `dst`. */
export async function syncFollowLines(rt: Runtime, sources: readonly string[], dst: string): Promise<string[]> {
  const pairs = await syncPairs(rt);
  const backups = await backupPairs(rt);
  const lines = new Set<string>();
  if (!pairs) lines.add('(Could not check whether a sync follows what is moved.)');
  if (!backups) lines.add('(Could not check whether a periodic backup follows what is moved.)');
  const bare = (p: string) => p.split('/').map((seg) => seg.trimEnd()).join('/');
  const tree = (p: string) => p.match(/^\/\/from\/[^/:]+/)?.[0] ?? '/';
  for (const raw of sources) {
    const src = raw.replace(/(.)\/+$/, '$1');
    for (const p of pairs ?? []) {
      if (!under(p.remote, src)) continue;
      // Between your drive and a share MEGA copies and deletes: the sync loses its folder.
      if (tree(src) !== tree(dst)) {
        lines.add(`${p.remote} is two-way synced with ${p.local} on this computer: moved into ${dst}, it is copied and the original deleted, so that sync stops.`);
        continue;
      }
      lines.add(`${p.remote} is two-way synced with ${p.local} on this computer: the sync follows it into ${dst}, and what is saved there later goes there too.`);
      // Under a folder others can write into, what they add reaches this computer.
      const writers = await writableAround(rt, dst);
      if (writers === null) throw new ValidationError(`Could not check who else can write into ${dst}. Nothing was run.`);
      for (const w of writers.filter((w) => under(dst.replace(/(.)\/+$/, '$1'), w))) {
        assertUnknownLandingSafe(p.local, `${w} can be written by other people, and what they add to the moved sync folder`);
      }
    }
    for (const b of backups ?? []) {
      if (b.remote !== null && under(bare(b.remote), bare(src))) lines.add(`${b.remote} receives periodic backups of ${b.local} from this computer: later backups follow it into ${dst}.`);
    }
  }
  return [...lines];
}

/** The download landing checks, for what a sync writes locally when `names` land in `cloudDir`. */
export async function assertSyncedLanding(
  rt: Runtime,
  cloudDir: string,
  names: readonly string[] | 'self' | 'unknown',
  inside: { cloud?: readonly string[]; local?: readonly string[]; listed?: readonly string[] } = {},
): Promise<void> {
  const mirror = await localMirrorOf(rt, cloudDir);
  // Unknown is not "not synced": a sync made elsewhere could map onto a protected folder.
  if (mirror === undefined) {
    throw new ValidationError(`Could not read MEGAcmd's list of syncs, so whether ${cloudDir} is written to this computer (and where) is unknown. Nothing was run; try again.`);
  }
  if (!mirror) return;
  // Pattern matches come listed whole (every node below each match): their names are checked as listed.
  const listedHit = (inside.listed ?? []).find((p) => isIgnoreFileName(posix.basename(p)));
  if (listedHit) throw new ValidationError(`${listedHit} is a .megaignore, and in a two-way synced folder one decides what the sync carries, so it is not placed in ${cloudDir}.`);
  // A .megaignore anywhere in what is placed would become a rule file of the sync - also one an
  // upload of this session is still delivering into it.
  for (const src of inside.cloud ?? []) {
    await assertNoPendingIgnoreUpload(rt, src, `place ${src} in a synced folder`);
    const r = await ignoreFilesBelow(rt, src);
    if (!r || r.unchecked) throw new ValidationError(`Could not check ${src} for a .megaignore before placing it in a synced folder.`);
    const hit = r.hits[0];
    if (hit) throw new ValidationError(`${src} holds ${hit}, and in a two-way synced folder a .megaignore decides what the sync carries, so it is not placed in ${cloudDir}.`);
  }
  if (inside.local && inside.local.length > 0) {
    const r = ignoreFilesIn(inside.local);
    if (r.found.length > 0) throw new ValidationError(`${r.found[0]} is a .megaignore, and in a two-way synced folder one decides what the sync carries, so it is not uploaded into ${cloudDir}.`);
    if (!r.complete) throw new ValidationError(`Too many folders to search for a .megaignore before uploading into the synced folder ${cloudDir}; upload smaller folders.`);
  }
  // (Each name also as MEGA may escape it on disk.)
  if (names === 'self') {
    assertNotIgnoreFile(mirror);
    for (const n of localSpellings(basenameLocal(mirror))) assertDownloadTarget(dirnameLocal(mirror), n);
  } else if (names === 'unknown') {
    assertUnknownLandingSafe(mirror, `What arrives in ${cloudDir}`);
  } else {
    for (const name of names.flatMap(localSpellings)) {
      assertNotIgnoreFile(joinLocal(mirror, name));
      assertDownloadTarget(mirror, name);
    }
  }
}

/** Queued transfers (`transfers --summary`: right-aligned columns of 16, 12, 12, 8, 5 spaces, 16...); NaN if unknown. */
async function transfersRunning(rt: Runtime): Promise<{ downloads: number; uploads: number }> {
  const r = await rt.run('transfers', ['--summary']);
  // No MEGAcmd at all: nothing is transferring.
  if (r.spawnError === 'NO_MEGACMD') return { downloads: 0, uploads: 0 };
  const row = r.code === 0 ? r.stdout.split(/\r?\n/)[1] ?? '' : '';
  const num = (from: number, to: number) => (/^\s*\d+\s*$/.test(row.slice(from, to)) ? Number(row.slice(from, to)) : NaN);
  return { downloads: num(0, 16), uploads: num(53, 69) };
}

/**
 * Where a transfer of this process puts a .megaignore - known from what it carries - is refused
 * for a sync until the file is there (from then on the nested-rules search refuses it). Where
 * what a transfer carries is unknown (a link, a search cut short), a sync waits for transfers.
 */
const expectedCloudIgnores = new Set<string>();
const unknownUploads = new Set<string>();
const expectedLocalIgnores = new Set<string>();
const unknownDownloads = new Set<string>();
/** Where a downloaded folder may land: <ld>/<name>, in each spelling MEGA may write the name. */
export function landingsOf(ld: string, name: string): string[] {
  return localSpellings(name).map((n) => joinLocal(ld, n));
}

/** Local folders whose downloaded contents were not known beforehand (searched before a sync). */
const ignoreDownloads = new Set<string>();

export function noteUploadIgnores(files: readonly string[], unknownDirs: readonly string[]): void {
  for (const f of files) expectedCloudIgnores.add(f.replace(/(.)\/+$/, '$1'));
  for (const d of unknownDirs) unknownUploads.add(d.replace(/(.)\/+$/, '$1'));
}

export function noteDownloadIgnores(files: readonly string[], unknownDirs: readonly string[], into: readonly string[] = []): void {
  for (const f of files) expectedLocalIgnores.add(f);
  // The folders they land in are also searched before a sync (whatever spelling the files arrive under).
  if (files.length > 0) for (const d of into) ignoreDownloads.add(d);
  for (const d of unknownDirs) {
    unknownDownloads.add(d);
    ignoreDownloads.add(d);
  }
}

/** A cloud folder about to be synced, where an upload of this session may still put a .megaignore. */
export async function assertNoPendingIgnoreUpload(rt: Runtime, rp: string, then = `sync ${rp}`): Promise<void> {
  const root = rp.replace(/(.)\/+$/, '$1');
  for (const f of [...expectedCloudIgnores]) {
    if (!under(f, root)) continue;
    const kind = await remoteKind(rt, f);
    // There: the nested-rules search refuses it. Not there: still arriving, or removed or moved since.
    if (kind === 'file') continue;
    if (kind === 'unknown' || (await remoteKind(rt, posix.dirname(f))) !== 'folder' || (await transfersRunning(rt)).uploads !== 0) {
      throw new ValidationError(`An upload from this session puts ${f} (a .megaignore) into ${rp} and it may still arrive (mega_transfers); ${then} once uploads have finished.`);
    }
    // Kept, and asked again on every call (the confirming one too): a folder transfer still
    // scanning has no file transfers yet, so "none running" may only mean "not started".
  }
  // (Not by path: an upload in flight follows its folder when that is moved.)
  if (unknownUploads.size > 0 && (await transfersRunning(rt)).uploads !== 0) {
    throw new ValidationError(`An upload of this session whose contents were not all checked may still be running (mega_transfers); ${then} once it has finished.`);
  }
}

/** Local folders a download of this process went into: an upload from at or above them is named. */
const downloadedInto = new Set<string>();

export function noteDownload(localDir: string): void {
  downloadedInto.add(localDir);
}

/** Preview lines for an upload whose sources hold (or lie in) a folder downloaded into this session. */
export function downloadedIntoLines(sources: readonly string[]): string[] {
  if (downloadedInto.size === 0) return [];
  // On-disk spellings, each worked out once (an upload can list thousands of files).
  const within = (a: string, b: string) => a === b || a.startsWith(b.endsWith(sepLocal) ? b : b + sepLocal);
  const real = sources.map((lp) => onDiskSpelling(lp));
  const hits = [...downloadedInto].filter((d) => {
    const rd = onDiskSpelling(d);
    return real.some((r) => within(rd, r) || within(r, rd));
  });
  return hits.length > 0 ? ['Downloaded into earlier in this session (what is uploaded may include it):', ...listedLines(hits.sort())] : [];
}

/**
 * A .megaignore below the root of a folder about to be two-way synced is read before the root
 * rules, so it could carry a protected folder after all. Searched where a download of this
 * process put one, and (as far as the bounded search goes) anywhere else below; a background
 * download there must have finished first.
 */
export async function assertNoNestedLocalIgnoreFile(rt: Runtime, lp: string): Promise<void> {
  // A download into lp, or into a folder holding lp.
  const near = (d: string) => localAtOrUnder(d, lp) || localAtOrUnder(lp, d);
  // A .megaignore a download of this session puts below lp: refused until it is there (then found below).
  for (const f of [...expectedLocalIgnores]) {
    if (!localAtOrUnder(f, lp)) continue;
    if (existsSync(f)) {
      // There: at the root it is the sync's rules file, below it a rules file read first. Either way refused.
      throw new ValidationError(`${f} is a .megaignore a download of this session put ${localAtOrUnder(lp, dirnameLocal(f)) ? 'at the root of' : 'below'} ${lp}; it would decide what the sync carries. Remove it (or check it yourself) before syncing.`);
    }
    // Not there: still arriving (its folder not made yet, or downloads running) - or removed since.
    if (!existsSync(dirnameLocal(f)) || (await transfersRunning(rt)).downloads !== 0) {
      throw new ValidationError(`A download of this session puts ${f} (a .megaignore) below ${lp} and it may still arrive (mega_transfers); sync ${lp} once downloads have finished.`);
    }
    // Kept, and asked again on every call (see assertNoPendingIgnoreUpload).
  }
  // Contents unknown (a link): wait for downloads to end (asked on every call, the confirming one included).
  const pending = [...unknownDownloads].filter(near);
  if (pending.length > 0 && (await transfersRunning(rt)).downloads !== 0) {
    throw new ValidationError(`A download into ${pending[0]} may still be running (mega_transfers); sync ${lp} once it has finished.`);
  }
  const nested = (found: string[]) => found.filter((f) => relative(lp, dirnameLocal(f)) !== '');
  for (const d of ignoreDownloads) {
    if (!near(d)) continue;
    // Its root rules file may be the downloaded one (which could undo MEGA's default exclusions).
    if (localAtOrUnder(lp, d) && rootIgnoreFile(lp)) {
      throw new ValidationError(`${rootIgnoreFile(lp)} may have been downloaded earlier in this session; as the root rules of the sync it decides what is carried. Remove it (or check it yourself) before syncing ${lp}.`);
    }
    const where = localAtOrUnder(d, lp) ? d : lp;
    const r = ignoreFilesIn([where]);
    const hit = nested(r.found)[0] ?? (r.complete ? null : where);
    if (hit) throw new ValidationError(`${hit} holds a .megaignore downloaded earlier in this session; below the root of a sync it decides what the sync carries, so ${lp} is not synced. Remove it first.`);
  }
  const hit = nested(ignoreFilesIn([lp]).found)[0];
  if (hit) throw new ValidationError(`${hit} is a .megaignore below the root of ${lp}; it would decide what the sync carries there, so ${lp} is not synced. Remove it first.`);
}

/**
 * Content nobody checked (an import, other people's writes) lands in synced `local`: as sync rules
 * fold only ASCII and a .megaignore in it is read first, `local` must not be, hold or be inside a
 * protected folder, nor hold a .megaCmd copy.
 */
function assertUnknownLandingSafe(local: string, what: string): void {
  let copy: string | undefined;
  try {
    assertNotInsideProtected(local);
    assertDownloadTarget(local, null);
    const r = storeCopiesIn(local);
    copy = r.found[0] ? `${r.found[0]}, a copy of MEGAcmd's session store` : r.complete ? undefined : 'folders that could not all be searched for a copy of MEGAcmd\'s session store';
  } catch {
    copy = undefined;
    throw new ValidationError(`${what} is written by a two-way sync to ${local} on this computer, which is, holds or is inside a folder MEGAcmd, this connector or the app depends on. Nothing was run.`);
  }
  if (copy) throw new ValidationError(`${what} is written by a two-way sync to ${local} on this computer, which holds ${copy}. Nothing was run.`);
}

/**
 * Folders others can write into at, above or below `cloudPath` - shared read/write or more, a
 * writable public link, or someone else's share; null if unknown.
 */
async function writableAround(rt: Runtime, cloudPath: string, atOrBelow = false): Promise<string[] | null> {
  const p = cloudPath.replace(/(.)\/+$/, '$1');
  const share = p.match(/^\/\/from\/[^/]+/)?.[0];
  if (share) return [share];
  const root = (p.match(/^\/\/(?:bin|in)(?=\/|$)/) ?? ['/'])[0];
  const out: string[] = [];
  const near = (w: string) => (!atOrBelow && under(p, w)) || under(w, p);
  for (const cmd of ['share', 'export'] as const) {
    const r = await rt.run(cmd, cmd === 'share' ? ['-p', root] : [root]);
    // No MEGAcmd at all: nothing syncs either. Any other failure (a passing check error): unknown.
    if (r.spawnError === 'NO_MEGACMD' || r.code === ExitCode.NOTFOUND) continue;
    if (r.spawnError) return null;
    if (r.code !== 0) return null;
    for (const raw of r.stdout.split(/\r?\n/)) {
      const line = raw.trimEnd();
      // (`export /` lists older versions of a linked file indented below it.)
      if (!line.trim() || /^\s/.test(raw)) continue;
      const path = cmd === 'share' ? sharePathOf(line) : exportPathOf(line);
      if (!path || !path.startsWith('/')) return null;
      const w = path.replace(/(.)\/+$/, '$1').normalize('NFC');
      if (!near(w)) continue;
      // A share whose level is not plainly "read", or a link carrying an upload key.
      const writable = cmd === 'share' ? !/\(read access\)(?:\[UNVERIFIED\])?$/.test(line) : /\bAuth(?:Token|Key)\b/.test(line);
      if (writable) out.push(w);
    }
  }
  return out;
}

/** A sync between `lp` and `rp`: what others can write there reaches `lp` unchecked (see assertUnknownLandingSafe). */
export async function assertNoWritersReach(rt: Runtime, rp: string, lp: string): Promise<void> {
  const writers = await writableAround(rt, rp);
  if (writers === null) throw new ValidationError(`Could not check who else can write into ${rp}. Nothing was run.`);
  const root = rp.replace(/(.)\/+$/, '$1');
  for (const w of writers) {
    const local = under(root, w) ? lp : localOfCloud(lp, w.slice(root === '/' ? 1 : root.length + 1).split('/'));
    assertUnknownLandingSafe(local, `${w} can be written by other people, and what they add there`);
  }
}

/** The .megaignore directly in `lp` (any spelling a sync reads as one), or null. */
export function rootIgnoreFile(lp: string): string | null {
  try {
    const n = readdirSync(lp).find((e) => isIgnoreFileName(e));
    return n ? joinLocal(lp, n) : null;
  } catch {
    return null;
  }
}

/**
 * Folders moved INTO a two-way synced folder bring their shares and links along: what this
 * computer saves there reaches those people, and what writers add reaches this computer.
 * `localOf` maps a moved path to where the sync writes it.
 */
export async function movedIntoSyncedLines(rt: Runtime, sources: readonly string[], d: string, into: boolean): Promise<string[]> {
  const mirror = await localMirrorOf(rt, d);
  if (mirror === undefined) return ['(Could not check whether the destination is in a synced folder.)'];
  if (!mirror) return [];
  const lines: string[] = [];
  for (const raw of sources) {
    const src = raw.replace(/(.)\/+$/, '$1');
    const local = into ? localOfCloud(mirror, [posix.basename(src).replace(/^[^:]*:/, '')]) : mirror;
    const writers = await writableAround(rt, src, true);
    if (writers === null) throw new ValidationError(`Could not check who else can write into ${src}. Nothing was run.`);
    for (const w of writers) {
      assertUnknownLandingSafe(w === src ? local : localOfCloud(local, w.slice(src.length + 1).split('/')), `${w} can be written by other people, and moved into the synced folder, what they add`);
    }
    const self = await destinationNotes(rt, src);
    const own = self.filter((n) => n.startsWith(`${src} is shared with other people`) || n.startsWith(`${src} has a public link`));
    for (const n of [...own, ...(await sharedBelowNotes(rt, src))]) {
      lines.push(`Moved into the synced folder ${mirror}: ${n}`);
    }
  }
  return lines;
}

/** Is a local path inside the local folder of a two-way sync? (undefined: unknown) */
export async function inSyncedLocalFolder(rt: Runtime, localPath: string): Promise<boolean | undefined> {
  const pairs = await syncPairs(rt);
  if (!pairs) return undefined;
  // By any spelling (case, a firmlink, a symlink): a string prefix would miss one.
  return pairs.some(({ local }) => localAtOrUnder(localPath, local));
}

/** Split items into argv chunks: at most maxCount each, within Windows' ~32K or POSIX ARG_MAX. */
export function chunkArgs(items: readonly string[], maxCount = 2000, others?: readonly string[]): string[][] {
  // MEGAcmd's server may read only the first 8 KB of a command line (the gate refuses longer).
  // Counted as the gate counts (a space and up to 3 quoting bytes per word), less the other
  // words of the command - or a fixed allowance for short ones when they are not given.
  const cost = (a: string) => Buffer.byteLength(a) + (process.platform === 'win32' ? 8 : 4);
  const maxBytes = others ? 7600 - others.reduce((n, a) => n + cost(a), 0) : 6000;
  const out: string[][] = [];
  for (let i = 0; i < items.length; ) {
    let j = i;
    let bytes = 0;
    while (j < items.length && j - i < maxCount && (j === i || bytes + cost(items[j] as string) <= maxBytes)) {
      bytes += cost(items[j] as string);
      j++;
    }
    out.push(items.slice(i, j));
    i = j;
  }
  return out;
}

/** The names directly inside a cloud folder (`ls` prints one per line), or null. */
export async function childNames(rt: Runtime, dir: string): Promise<Set<string> | null> {
  const r = await rt.run('ls', [dir]);
  if (r.code !== 0) return null;
  return new Set(r.stdout.split(/\r?\n/).filter((l) => l !== ''));
}

/**
 * Copies and folders made WITHOUT a preview (cp/mkdir in private folders): named when a
 * folder holding them is shared, published or moved where others see. Entries follow moves.
 */
interface UnconfirmedWrite {
  path: string;
  source: string | null;
}
const unconfirmedWrites: UnconfirmedWrite[] = [];
/** Confirmed copies, moves and uploads of the recovery key file under another name: still the master key. */
const keyCopies: UnconfirmedWrite[] = [];

/** After a confirmed copy, move or upload of `from` to `to`: a recovery key file renamed on the way is remembered. */
export function noteKeyCopy(from: string, to: string, shownAs = from): void {
  const path = to.replace(/(.)\/+$/, '$1');
  // (Still named like it, it is found by its name.)
  if (!isRecoveryKeyName(posix.basename(from.replace(/(.)\/+$/, '$1'))) || isRecoveryKeyName(posix.basename(path)) || keyCopies.some((k) => k.path === path)) return;
  if (keyCopies.length >= MAX_TRACKED) {
    trackingIncomplete = true;
    return;
  }
  keyCopies.push({ path, source: shownAs });
}
const MAX_TRACKED = 20_000;
let trackingIncomplete = false;

export function noteUnconfirmedWrite(entries: readonly { path: string; source: string | null }[]): void {
  for (const e of entries) {
    if (unconfirmedWrites.length >= MAX_TRACKED) {
      trackingIncomplete = true;
      return;
    }
    unconfirmedWrites.push({ path: e.path, source: e.source });
  }
}

const under = (p: string, folder: string) => {
  const f = folder.replace(/(.)\/+$/, '$1');
  return p === f || p.startsWith(f === '/' ? '/' : `${f}/`);
};

export function unconfirmedWritesIn(folder: string): string[] {
  const f = folder.replace(/(.)\/+$/, '$1');
  const hits = unconfirmedWrites
    .filter((w) => under(w.path, f) || under(f, w.path))
    .map((w) =>
      under(w.path, f)
        ? w.source ? `${w.path} (a copy of ${w.source})` : w.path
        : `${f} is inside ${w.path}${w.source ? `, a copy of ${w.source}` : ''}`,
    );
  return [...new Set(hits)];
}

/** After a move or copy of `from` to `to`, what was placed unconfirmed inside it is there too. */
export function carryUnconfirmedWrites(from: string, to: string, move: boolean): void {
  const f = from.replace(/(.)\/+$/, '$1');
  for (const w of [...unconfirmedWrites]) {
    if (!under(w.path, f)) continue;
    const moved = to.replace(/(.)\/+$/, '$1') + w.path.slice(f.length);
    if (move) w.path = moved;
    else noteUnconfirmedWrite([{ path: moved, source: w.source }]);
  }
  for (const k of [...keyCopies]) {
    if (!under(k.path, f)) continue;
    const moved = to.replace(/(.)\/+$/, '$1') + k.path.slice(f.length);
    if (move) k.path = moved;
    else if (!keyCopies.some((x) => x.path === moved)) keyCopies.push({ path: moved, source: k.source });
  }
  for (const c of [...sessionChanges]) {
    if (!under(c.path, f)) continue;
    const moved = to.replace(/(.)\/+$/, '$1') + c.path.slice(f.length);
    if (move) c.path = moved;
    else noteSessionChange(moved, c.what);
  }
  // An upload in flight follows a moved folder (and its copy may get it too): both places are expected.
  for (const e of [...expectedCloudIgnores]) {
    if (under(e, f)) expectedCloudIgnores.add(to.replace(/(.)\/+$/, '$1') + e.slice(f.length));
  }
}

/**
 * Confirmed changes the handle digest cannot see (an upload still running, a thumbnail or
 * attribute set): named and bound when the folder is shared or published.
 */
const sessionChanges: { path: string; what: string }[] = [];
export function noteSessionChange(path: string, what: string): void {
  if (sessionChanges.length >= MAX_TRACKED) {
    trackingIncomplete = true;
    return;
  }
  sessionChanges.push({ path: path.replace(/(.)\/+$/, '$1'), what });
}

/** Preview lines for a folder (or folders) about to reach other people. */
export function unconfirmedWriteLines(folders: string | readonly string[]): string[] {
  const list = typeof folders === 'string' ? [folders] : folders;
  const hits = [...new Set(list.flatMap((f) => unconfirmedWritesIn(f)))];
  const changed = [
    ...new Set(
      list.flatMap((raw) => {
        const f = raw.replace(/(.)\/+$/, '$1');
        return sessionChanges.filter((c) => under(c.path, f) || under(f, c.path)).map((c) => `${c.path}: ${c.what}`);
      }),
    ),
  ];
  return [
    ...(hits.length > 0 ? ['Placed in it earlier in this session without a confirmation:', ...listedLines(hits)] : []),
    ...(changed.length > 0 ? ['Changed in it earlier in this session:', ...listedLines(changed)] : []),
    ...(trackingIncomplete ? ['(More was placed in private folders without a confirmation than this session can track: check the contents before sharing.)'] : []),
  ];
}

/**
 * Items named like MEGA's recovery key file (it holds the account's master key), by their own
 * name or as an unconfirmed copy of one under another name.
 */
export function recoveryKeyLines(paths: readonly string[], found: readonly string[] = []): string[] {
  const hits = new Set<string>(found);
  for (const raw of paths) {
    const p = raw.replace(/(.)\/+$/, '$1');
    if (isRecoveryKeyName(posix.basename(p))) hits.add(p);
    for (const w of unconfirmedWrites) {
      if (w.source && isRecoveryKeyName(posix.basename(w.source)) && (under(w.path, p) || under(p, w.path))) hits.add(`${w.path} (a copy of ${w.source})`);
    }
    for (const k of keyCopies) if (under(k.path, p) || under(p, k.path)) hits.add(`${k.path} (a copy of ${k.source})`);
  }
  return hits.size > 0 ? ["Named like MEGA's recovery key file, which holds the account's master key:", ...listedLines([...hits])] : [];
}

/** recoveryKeyLines, also for such a file anywhere inside the given folders (found by `find`). */
export async function recoveryKeyLinesBelow(rt: Runtime, paths: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  let unchecked = false;
  for (const chunk of chunkArgs(paths)) {
    // Every translated name starts "MEGA-" or ends "-MEGA" before ".txt" - in any case (MEGAcmd's
    // wildcards compare case exactly, so four "?" stand for the letters).
    for (const pattern of ['????-*', '*-????*']) {
      const r = await rt.run('find', [...chunk, '--type=f', `--pattern=${pattern}`], { maxBuffer: 128 * 1024 * 1024 });
      // No MEGAcmd at all: nothing else will run either.
      if (r.spawnError === 'NO_MEGACMD') continue;
      if (r.spawnError || (r.code !== 0 && r.code !== ExitCode.NOTFOUND)) unchecked = true;
      for (const line of r.stdout.split(/\r?\n/).map((l) => l.trim())) {
        if (line && isRecoveryKeyName(posix.basename(line))) found.push(line.startsWith('/') ? line : `//from/${line}`);
      }
    }
  }
  return [...recoveryKeyLines(paths, found), ...(unchecked ? ["(Could not check everything inside for MEGA's recovery key file.)"] : [])];
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
  // "//bin/..." and "//in/..." keep their root (a plain split would make them "/bin/...").
  const special = p.match(/^(\/\/(?:bin|in))(?=\/|$)/)?.[1];
  const base = special ?? '';
  const parts = p.slice(base.length).replace(/\/+$/, '').split('/').filter(Boolean);
  return [special ?? '/', ...parts.map((_, i) => `${base}/${parts.slice(0, i + 1).join('/')}`)];
}

async function listedPaths(rt: Runtime, cmd: 'share' | 'export', root: string, pathOf: (line: string) => string | null): Promise<Set<string> | null> {
  // -p includes pending shares: an invitation gives the folder once accepted.
  const r = await rt.run(cmd, cmd === 'share' ? ['-p', root] : [root]);
  if (r.spawnError) return null;
  // No shares / no links at all is reported as "not found" by some versions.
  if (r.code === ExitCode.NOTFOUND) return new Set();
  if (r.code !== 0) return null;
  const paths = new Set<string>();
  for (const raw of r.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // `export /` lists the older versions of a linked file indented below it.
    if (/^\s/.test(raw)) continue;
    // A line not starting with "/" is a name with a line break: unreadable is not "not shared".
    const p = line.startsWith('/') ? pathOf(line) : null;
    if (!p) return null;
    // Compared with NFC tool paths: a name stored in another Unicode form still matches.
    paths.add(p.replace(/(.)\/+$/, '$1').normalize('NFC'));
  }
  return paths;
}

/**
 * The public link of `path` itself in `export <path>` output, or null: MEGAcmd also lists
 * every exported node below it, so the first link may be a child's.
 */
export function ownExportLink(stdout: string, path: string): string | null {
  const p = path.replace(/(.)\/+$/, '$1');
  const shown = p.startsWith('//from/') ? p.slice('//from/'.length) : p;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const i = openingBracket(line);
    // (The link ends the bracketed details: its own ")" is not part of it.)
    if (i > 0 && line.slice(0, i).replace(/ $/, '') === shown && line.slice(i).includes('exported')) return parseExportLink(line.slice(i))?.replace(/\)+$/, '') ?? null;
  }
  return null;
}

/** Preview lines for sharing or publishing: syncs and backups that keep writing into the target. */
export async function syncedWithinLines(rt: Runtime, targets: string | readonly string[], what: 'shared' | 'published'): Promise<string[]> {
  const pairs = await syncPairs(rt);
  const backups = await backupPairs(rt);
  const list = typeof targets === 'string' ? [targets] : targets;
  const lines = new Set<string>();
  if (!pairs) lines.add(`(Could not check whether ${list.length === 1 ? list[0] : 'these'} is synced with this computer.)`);
  if (!backups) lines.add(`(Could not check whether a periodic backup writes into ${list.length === 1 ? list[0] : 'these'}.)`);
  for (const raw of list) {
    const t = raw.replace(/(.)\/+$/, '$1');
    for (const p of pairs ?? []) {
      if (under(p.remote, t) || under(t, p.remote)) lines.add(`${p.remote} is two-way synced with ${p.local} on this computer: what is saved there later is ${what} too.`);
    }
    // A scheduled backup adds a new copy of its local folder in its cloud folder each time.
    // (The fixed-width listing loses a name's trailing spaces: compared without them.)
    const bare = (p: string) => p.split('/').map((seg) => seg.trimEnd()).join('/');
    for (const b of backups ?? []) {
      if (b.remote !== null && under(bare(b.remote), bare(t))) lines.add(`${b.remote} receives periodic backups of ${b.local} from this computer: later backups are ${what} too.`);
    }
  }
  return [...lines];
}

/**
 * Write access to a synced folder: what the recipient adds there, the sync writes to this
 * computer. Refused like an import where that local folder is or holds a protected one.
 */
export async function writableShareLines(rt: Runtime, targets: readonly string[], email: string, instead = 'share it read-only instead'): Promise<string[]> {
  const pairs = await syncPairs(rt);
  if (!pairs) throw new ValidationError(`Could not read MEGAcmd's list of syncs, so whether what ${email} adds is written to this computer is unknown. Nothing was run.`);
  const lines = new Set<string>();
  for (const raw of targets) {
    const t = raw.replace(/(.)\/+$/, '$1');
    for (const p of pairs) {
      const local = under(p.remote, t) ? p.local : under(t, p.remote) ? mirrorIn([p], t) : null;
      if (!local) continue;
      assertUnknownLandingSafe(local, `What ${email} adds to ${t} (${instead})`);
      lines.add(`${email} can add files to ${t}: the two-way sync writes them to ${local} on this computer.`);
    }
    // A backup's copies are told apart by name only: what others add there can get real copies deleted.
    for (const l of await backupFoldersWithinLines(rt, t, `${email} can add items to`)) lines.add(l);
  }
  return [...lines];
}

/** For content others (or a merge) put anywhere in `folder`: periodic backups that keep their copies there. */
export async function backupFoldersWithinLines(rt: Runtime, folder: string, what: string): Promise<string[]> {
  const backups = await backupPairs(rt);
  if (!backups) return [`(Could not check whether a periodic backup keeps its copies in ${folder}.)`];
  const bare = (p: string) => p.replace(/(.)\/+$/, '$1').split('/').map((seg) => seg.trimEnd()).join('/').normalize('NFC');
  return backups
    .filter((b) => b.remote !== null && under(bare(b.remote), bare(folder)))
    .map((b) => `${what} ${b.remote}, where the periodic backup of ${b.local} keeps its copies: an item named like ${backupNamesOf(b.local)[0]}_bk_<date> there counts as one of them, and beyond the kept count the oldest are DELETED for good by the next backup run.`);
}

/**
 * A name MEGA's backup rotation would take as one of its copies (it starts with the backed-up
 * folder's name and holds "_bk_") in a backup's cloud folder: the oldest beyond the kept count are
 * deleted for good on the next run, whoever made them.
 */
export async function backupRotationLines(rt: Runtime, parent: string, names: readonly string[]): Promise<string[]> {
  return backupRotationLinesAt(rt, names.map((n) => joinRemote(parent, n)));
}

/**
 * The names a scheduled backup of `local` counts as its copies start with (the SDK's backupName:
 * a trailing separator also drops the letter before it), plus the plain folder name.
 */
export function backupNamesOf(local: string): string[] {
  let aux = local;
  let found = aux.search(/[/\\][^/\\]*$/);
  while (aux.length > 0 && found === aux.length - 1) {
    aux = aux.slice(0, Math.max(found - 1, 0));
    found = aux.search(/[/\\][^/\\]*$/);
  }
  return [...new Set([aux.slice(found + 1), basenameLocal(local)].filter((n) => n !== '').map((n) => n.normalize('NFC')))];
}

/** backupRotationLines for each path's own name in its parent folder. */
export async function backupRotationLinesAt(rt: Runtime, paths: readonly string[]): Promise<string[]> {
  // Only a name holding "_bk_" can count as a copy: nothing else needs the list.
  const named = paths.map((p) => p.replace(/(.)\/+$/, '$1')).filter((p) => posix.basename(p).includes('_bk_'));
  if (named.length === 0) return [];
  const backups = await backupPairs(rt);
  if (!backups) return ['(Could not check whether the destination is a periodic backup\'s folder.)'];
  const bare = (p: string) => p.split('/').map((seg) => seg.trimEnd()).join('/').normalize('NFC');
  const lines: string[] = [];
  for (const b of backups) {
    if (b.remote === null) continue;
    const bases = backupNamesOf(b.local);
    for (const p of named.filter((p) => bare(posix.dirname(p)) === bare(b.remote as string) && bases.some((base) => posix.basename(p).normalize('NFC').startsWith(base)))) {
      lines.push(`${p} would count as a backup copy of ${b.local}: beyond the kept count, the oldest are DELETED for good by the next backup run.`);
    }
  }
  return lines;
}

/** For an item whose name is not known beforehand (an import): a periodic backup's cloud folder is named. */
export async function backupFolderLines(rt: Runtime, folder: string): Promise<string[]> {
  const backups = await backupPairs(rt);
  if (!backups) return ['(Could not check whether the destination is a periodic backup\'s folder.)'];
  const bare = (p: string) => p.replace(/(.)\/+$/, '$1').split('/').map((seg) => seg.trimEnd()).join('/').normalize('NFC');
  return backups
    .filter((b) => b.remote !== null && bare(b.remote) === bare(folder))
    .map((b) => `${folder} is where the periodic backup of ${b.local} keeps its copies: an item named like ${backupNamesOf(b.local)[0]}_bk_<date> counts as one of them, and beyond the kept count the oldest are DELETED for good by the next backup run.`);
}

/** Local folders of scheduled backups (null: the list cannot be read; none without MEGAcmd). */
export async function backupLocalRoots(rt: Runtime): Promise<string[] | null> {
  const r = await backupPairs(rt, []);
  return r ? r.map((b) => b.local) : null;
}

/** Every sync and backup as configured now: compared again under the write lock. */
export async function syncSnapshot(rt: Runtime): Promise<string> {
  return JSON.stringify([await syncPairs(rt, []), await backupPairs(rt, [])]);
}

/**
 * MEGAcmd's scheduled backups (local, cloud folder), listed wide enough to keep paths whole. A
 * backup whose cloud folder is gone ("INVALIDPATH") writes nowhere: remote null.
 */
type BackupPair = { local: string; remote: string | null };
async function backupPairs(rt: Runtime, unrunnable: BackupPair[] | null = null): Promise<BackupPair[] | null> {
  const width = 4096;
  const r = await rt.run('backup', [`--path-display-size=${width}`]);
  if (r.spawnError) return r.spawnError === 'NO_MEGACMD' ? unrunnable : null;
  if (r.code !== 0) return r.code === ExitCode.NOTFOUND ? [] : null;
  const out: BackupPair[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    // Header, blank and indented detail lines carry no backup; any other row starts with a tag.
    if (line.trim() === '' || /^\s/.test(line) || line.startsWith('TAG') || line.startsWith('BACKUP not found')) continue;
    // Split on long runs of padding: MEGAcmd pads by estimated display width, not characters.
    const cells = line.split(/ {64,}/);
    if (cells.length !== 3 || !/^-?\d+ /.test(cells[0] as string)) return null;
    const local = (cells[0] as string).replace(/^-?\d+ +/, '');
    const remote = (cells[1] as string).trimEnd();
    if (remote === 'INVALIDPATH') {
      out.push({ local, remote: null });
      continue;
    }
    // A backup whose cloud folder cannot be read could be writing anywhere.
    if (!remote.startsWith('/') && !remote.includes(':')) return null;
    out.push({ local, remote: (remote.startsWith('/') ? remote : `//from/${remote}`).normalize('NFC') });
  }
  return out;
}

/** Digest of every node handle in `path`, bound into share/link confirmations: any change voids it. */
export async function contentDigest(rt: Runtime, path: string): Promise<string> {
  const r = await rt.run('find', [path, '--print-only-handles'], { maxBuffer: 128 * 1024 * 1024 });
  // Missing: the command reports it. Unreadable: refuse, or the token would bind "could not list".
  if (r.code === ExitCode.NOTFOUND) return 'missing';
  // No runnable MEGAcmd at all: the command cannot run either, and says so.
  if (r.spawnError === 'NO_MEGACMD') return 'unavailable';
  if (r.code !== 0) throw new ValidationError(`Could not list what ${path} holds: ${classifyExit(r)}. Nothing was run.`);
  const handles = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).sort();
  return createHash('sha256').update(handles.join('\n')).digest('hex');
}

/** Preview lines for a download into a two-way synced folder: the sync uploads it to the cloud. */
export async function syncedLocalLines(rt: Runtime, localPath: string): Promise<string[]> {
  return [...(await twoWaySyncedLines(rt, localPath)), ...(await backedUpLines(rt, localPath))];
}

async function twoWaySyncedLines(rt: Runtime, localPath: string): Promise<string[]> {
  const pairs = await syncPairs(rt);
  if (!pairs) return [`(Could not check whether ${localPath} is in a two-way synced folder.)`];
  const pair = pairs.find((p) => localAtOrUnder(localPath, p.local));
  if (!pair) return [];
  // Relative path by any spelling (case, Unicode, links); the cloud side names it NFC.
  const rel = relativeWithin(onDiskSpelling(pair.local), onDiskSpelling(localPath));
  if (rel === null) {
    throw new ValidationError(`${localPath} is in the two-way synced folder ${pair.local}, but where in it could not be worked out, so where the sync uploads it is unknown. Use the usual spelling of the folder.`);
  }
  const cloud = rel ? joinRemote(pair.remote, rel.split('/').map(cloudNameOf).join('/')) : pair.remote;
  const notes = (await destinationNotes(rt, cloud)).filter((n) => !n.includes(' is in a synced folder: '));
  // Downloaded folders merge into existing ones, so a shared folder below is reached too.
  return [`${localPath} is in a two-way synced folder: what is downloaded there is also uploaded to ${cloud}.`, ...notes, ...(await sharedBelowNotes(rt, cloud))];
}

/** A scheduled backup of a folder holding `localPath` uploads what lands there on its next run. */
async function backedUpLines(rt: Runtime, localPath: string): Promise<string[]> {
  const backups = await backupPairs(rt);
  if (!backups) return [`(Could not check whether ${localPath} is backed up periodically.)`];
  const lines: string[] = [];
  // (The fixed-width listing loses a name's trailing spaces: compared without them.)
  const bare = (p: string) => p.split(/([\\/])/).map((seg) => seg.trimEnd()).join('');
  for (const b of backups.filter((b) => localAtOrUnder(localPath, b.local) || localAtOrUnder(bare(localPath), b.local))) {
    if (b.remote === null) continue;
    lines.push(`${localPath} is backed up periodically to ${b.remote}: the next backup uploads what arrives there.`);
    // A folder listed without its trailing spaces is not found under that name: its sharing is unknown.
    const notes = (await remoteKind(rt, b.remote)) === 'missing' ? [`(Could not check whether ${b.remote} - as MEGAcmd lists it - is shared or has a public link.)`] : await destinationNotes(rt, b.remote, { backups: false });
    for (const n of notes) if (!lines.includes(n)) lines.push(n);
  }
  return lines;
}

/** contentDigest for several paths in one `find` (a batch must not cost a call per item). */
export async function contentDigestMany(rt: Runtime, paths: readonly string[]): Promise<string> {
  if (paths.length === 1) return contentDigest(rt, paths[0] as string);
  const handles: string[] = [];
  for (const chunk of chunkArgs(paths)) {
    const r = await rt.run('find', [...chunk, '--print-only-handles'], { maxBuffer: 128 * 1024 * 1024 });
    if (r.code !== 0) return (await Promise.all(paths.map((p) => contentDigest(rt, p)))).join(',');
    handles.push(...r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  }
  return createHash('sha256').update(handles.sort().join('\n')).digest('hex');
}

let writeChain: Promise<unknown> = Promise.resolve();
/**
 * Run one at a time, in order: interleaved writers could each act on the other's "before"
 * (a copy judged private just as a share of that folder runs).
 */
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Index of the "(" that matches the ")" ending `line`, or -1. */
function openingBracket(line: string): number {
  if (!line.endsWith(')')) return -1;
  let depth = 0;
  for (let i = line.length - 1; i >= 0; i--) {
    if (line[i] === ')') depth++;
    else if (line[i] === '(' && --depth === 0) return i;
  }
  return -1;
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
  // C0/C1, DEL, U+2028/9 line breaks, and invisible characters (format, default-ignorable - bidi
  // controls, zero-width, tags, variation selectors): each could forge, disguise or hide text.
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, (c) => {
    const code = c.codePointAt(0) as number;
    return CONTROL_ESCAPES[c] ?? (code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : code <= 0xffff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\u{${code.toString(16)}}`);
  });
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
