import { z } from 'zod';
import { posix } from 'node:path';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from '../runtime.js';
import { ok, err } from '../mcpResult.js';
import { classifyExit, ExitCode } from '../errors.js';
import { assertNoWildcard, assertRemotePath, assertNotStoreCopy, isRecoveryKeyName } from '../paths.js';
import { guardRun, sameNamed, withWriteLock } from './helpers.js';

const DEFAULT_MAX = 1_048_576; // 1 MB
const HARD_MAX = 10_485_760; // 10 MB
const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(0x1b);

/** U+FFFD, what a UTF-8 decoder emits for a byte sequence that is not valid text. */
const REPLACEMENT = '�';

/**
 * Heuristic binary sniff, so binary garbage and terminal control sequences never
 * reach the model context.
 *
 * By the time we see it, the content is ALREADY a decoded string, and both of the
 * original signals had been eaten before they got here:
 *  - the NUL test never fires, because MEGAcmd does not emit NUL bytes on this
 *    path (a real PNG arrived NUL-free);
 *  - the control-character ratio never reaches 0.3, because every invalid byte
 *    has already been replaced with U+FFFD, which is printable.
 * Measured on Windows against a real PNG served through mega_cat: 0 NULs, control
 * ratio well under the threshold — it was returned as if it were text.
 *
 * So count U+FFFD as non-text as well. A legitimate text file essentially never
 * contains it (it only appears where decoding already failed), while binary is
 * dense with it. The threshold is also lowered, and a single ESC now disqualifies
 * the content outright: there is no benign reason for an ANSI escape in a file we
 * are about to paste into a model's context.
 */
export function looksBinary(s: string): boolean {
  if (s.includes(NUL)) return true;
  // ESC anywhere disqualifies, not only in the sampled prefix: a terminal sequence
  // placed after the first 8 KB would otherwise be returned in full.
  if (s.includes(ESC)) return true;
  const sample = s.slice(0, 8192);
  if (sample.length === 0) return false;
  let nonText = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0x1b) return true; // ESC: terminal control, never benign here
    if (c < 9 || (c > 13 && c < 32) || c === 0x7f) nonText++; // allow tab/LF/CR
    else if (sample[i] === REPLACEMENT) nonText++; // undecodable byte
  }
  return nonText / sample.length > 0.05;
}

/**
 * mega_cat — read a cloud file's text contents, for content-based search /
 * identification (ls/find only see names). Registered ONLY when
 * config.exposeFileContents is set (default off), because it brings cloud file
 * content into the model context.
 *
 * Guards: a byte cap (default 1 MB, hard max 10 MB) enforced via the exec
 * maxBuffer, so an oversized file is aborted before streaming rather than
 * flooding context; binary files are refused. Read-only.
 *
 * Threat note: file content is UNTRUSTED input (prompt-injection vector). The
 * backstop is that every destructive/exfiltration tool stays confirm-gated, so
 * instructions embedded in a file cannot cause silent damage — the user still
 * sees a confirmation preview before anything is deleted/shared/uploaded.
 */
/**
 * A recovery key is 16 bytes in base64url: 22 characters whose last one is A, Q, g or w (the
 * encoding's spare bits are zero). Looked for in every run of base64url characters - as the whole
 * run, or a 22-character part of a longer one between "-"/"_" ("key-<key>") - except a MEGA link's
 * own key (a folder link's key has the same shape), which follows "#" or "!" in a MEGA link.
 */
const KEY_LABEL = /recovery|master[\s_-]*key|\bmega\b|mega[\s_-]*key/i;
// The recovery key's name in the languages of MEGA's web app (its file names are in paths.ts),
// compared with spaces, "-" and "_" left out on both sides, after compatibility normalisation.
const KEY_LABEL_WORDS = new RegExp(
  [
    'rettungsschlüssel', 'rettungsschluessel', 'wiederherstellungsschlüssel', 'wiederherstellungsschluessel',
    'clé de récupération', 'cle de recuperation', 'clave de recuperación', 'clave de recuperacion',
    'chave de recuperação', 'chave de recuperacao', 'chiave di recupero', 'herstelsleutel', 'klucz odzyskiwania',
    'cheie de recuperare', 'kunci pemulihan', 'kurtarma anahtarı', 'kurtarma anahtari', 'khóa phục hồi', 'khoá phục hồi',
    'khoa phuc hoi', 'ключ восстановления', 'คีย์การกู้คืน', '回復キー', 'リカバリーキー', '恢复密钥', '恢復金鑰', '還原金鑰',
    'مفتاح الاستعادة', '복구 키',
  ]
    .map((w) => w.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, ''))
    .join('|'),
);

function isLabelled(line: string): boolean {
  return KEY_LABEL.test(line) || KEY_LABEL_WORDS.test(line.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, ''));
}

// What comes before a MEGA link's key: https://mega.nz/folder/<handle>#<key> (also /file/,
// /embed/, /collection/, /chat/, a subfolder's <key>/folder/<handle>, mega.co.nz, mega.app,
// mega.io), and the older #!<handle>!<key>, #F!<handle>!<key> and #P!<password-protected link>.
// The host starts the link: after "://", a space, a quote or bracket, or the line's start.
const LINK_HOST = String.raw`(?:^|[\s"'(<\[]|:\/\/)(?:[A-Za-z0-9-]+\.)*mega(?:\.co)?\.(?:nz|app|io)(?::\d+)?\/`;
const LINK_BEFORE_HASH = new RegExp(String.raw`${LINK_HOST}(?:file|folder|embed|collection|chat)\/[A-Za-z0-9_-]{8}#$`, 'i');
const LINK_BEFORE_BANG = new RegExp(String.raw`${LINK_HOST}(?:embed)?#(?:F?![A-Za-z0-9_-]{8}!|P!)$`, 'i');
// A link as text to leave out, from its host on (nothing before the host, and no further than a
// separator: a key in the next field of a CSV or JSON line is not part of the link).
const LINK_TOKEN = /mega(?:\.co)?\.(?:nz|app|io)(?::\d+)?\/[^\s"'<>,;]*/gi;

/** The run at `index`, `length` long, is a MEGA link's key: 22 characters (a folder's), 43 (a file's), or a #P! link's data. */
function isLinkKey(line: string, index: number, length: number): boolean {
  const mark = line[index - 1];
  if (mark !== '#' && mark !== '!') return false;
  // A link's start is well within 200 characters; a cut-off start must not pass for a boundary
  // ("/" is none: the host has to follow "://", a space, a quote or bracket, or the line's start).
  const from = Math.max(0, index - 200);
  const before = (from > 0 ? '/' : '') + line.slice(from, index);
  if (!(mark === '#' ? LINK_BEFORE_HASH : LINK_BEFORE_BANG).test(before)) return false;
  // (A key with something glued on - "<link key>-<another key>" - is not a link's key.)
  return length === 22 || length === 43 || before.endsWith('#P!');
}

// A random-looking 22-character run is part of encoded data, not a key written down, inside a
// package lockfile's integrity hash ("shaN-" and exactly that digest's length of standard
// base64), or inside standard base64 data: "+" right next to it, no "-" or "_" in it, in a
// stretch of at least 44 base64 characters (its own included: longer than a word or a key with
// something glued on) whose other characters look encoded too (lower case, upper case and a
// digit or "/": words joined by "+" don't). Not where an invisible character stood nearby: the
// stretch is then two things, not one.
const SRI_LENGTH: Record<string, number> = { '1': 28, '256': 44, '384': 64, '512': 88 };

function inEncodedData(line: string, index: number, end: number, cuts: ReadonlySet<number> | null): boolean {
  if (cuts) for (let i = Math.max(0, index - 96); i <= Math.min(line.length, end + 64); i++) if (cuts.has(i)) return false;
  let from = index;
  while (from > 0 && index - from < 96 && /[A-Za-z0-9+/=_-]/.test(line[from - 1] as string)) from--;
  const sri = /^sha(1|256|384|512)-([A-Za-z0-9+/]+={0,2})(?![A-Za-z0-9+/=_-])/i.exec(line.slice(from, from + 100));
  if (sri && (sri[2] as string).length === SRI_LENGTH[sri[1] as string] && from + sri[0].length >= end) return true;
  if (line[index - 1] !== '+' && line[end] !== '+') return false;
  for (let i = index; i < end; i++) if (line[i] === '-' || line[i] === '_') return false;
  let a = index;
  let b = end;
  while (a > 0 && end - a < 64 && /[A-Za-z0-9+/]/.test(line[a - 1] as string)) a--;
  while (b < line.length && b - a < 64 && /[A-Za-z0-9+/=]/.test(line[b] as string)) b++;
  if (b - a < 44) return false;
  const around = line.slice(a, index) + line.slice(end, b);
  return /[a-z]/.test(around) && /[A-Z]/.test(around) && /[0-9/]/.test(around);
}

interface KeyCandidate {
  token: string;
  /** The whole run (not a part of a longer one). */
  whole: boolean;
  /** Part of encoded data (see inEncodedData): only a label or a line of its own counts then. */
  encoded: boolean;
}

/** `cuts`: where an invisible character stood in the line - a key can start or end there too. */
function* keyCandidates(line: string, cuts: ReadonlySet<number> | null): Generator<KeyCandidate> {
  for (const m of line.matchAll(/[A-Za-z0-9_-]+/g)) {
    const run = m[0];
    const at = m.index ?? 0;
    if (run.length < 22 || isLinkKey(line, at, run.length)) continue;
    const encoded = inEncodedData(line, at, at + run.length, cuts);
    if (run.length === 22) {
      yield { token: run, whole: true, encoded };
      continue;
    }
    for (let i = 0; i + 22 <= run.length; i++) {
      // A part of a longer run counts only with a key's last character (every rule below needs it).
      if (!'AQgw'.includes(run[i + 21] as string)) continue;
      const starts = i === 0 || run[i - 1] === '-' || run[i - 1] === '_' || cuts?.has(at + i) === true;
      const ends = i + 22 === run.length || run[i + 22] === '-' || run[i + 22] === '_' || cuts?.has(at + i + 22) === true;
      if (starts && ends) yield { token: run.slice(i, i + 22), whole: false, encoded };
    }
  }
}

// Characters a reader doesn't see: format characters (zero-width spaces, soft hyphens, a BOM, bidi
// marks), other default-ignorable ones (variation selectors, fillers) and control characters other
// than tabs and line breaks. They don't split a key for a reader, so they are taken out; and one
// between a key and the word next to it doesn't join the two, so a key may start or end there.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/gu;
const CUT = '\ue000';
// Every line-break convention (a CR-only file is one "line" to a split on LF): LF, CR, VT, FF,
// NEL, LS and PS. A line shorter than a key holds none. (Scanned by hand: a regex over a 10 MB
// line overflows the stack.)
function* linesOf(text: string): Generator<string> {
  let from = 0;
  for (let i = 0; i <= text.length; i++) {
    const c = i < text.length ? text.charCodeAt(i) : 10;
    if ((c >= 10 && c <= 13) || c === 0x85 || c === 0x2028 || c === 0x2029) {
      if (i - from >= 22) yield text.slice(from, i);
      from = i + 1;
    }
  }
}

export function holdsRecoveryKey(text: string): boolean {
  const marked = text.replace(INVISIBLE, CUT);
  // A file that is only one 22-character token, in any case.
  if (/^[A-Za-z0-9_-]{22}$/.test(marked.split(CUT).join('').trim())) return true;
  for (let line of linesOf(marked)) {
    let cuts: Set<number> | null = null;
    // The line with a space where each invisible character stood: for a label or a standard
    // base64 key that one separates from the text next to it.
    let spaced: string | null = null;
    if (line.includes(CUT)) {
      cuts = new Set();
      let at = 0;
      const parts = line.split(CUT);
      for (const part of parts.slice(0, -1)) cuts.add((at += part.length));
      line = parts.join('');
      spaced = parts.join(' ');
    }
    const shown = line.trim();
    if (shown.length < 22) continue;
    const labelled = isLabelled(line) || (spaced !== null && isLabelled(spaced));
    for (const { token: t, whole, encoded } of keyCandidates(line, cuts)) {
      const canonical = /[AQgw]$/.test(t);
      const mixed = /[a-z]/.test(t) && /[A-Z]/.test(t);
      // A line that is just the key; one next to a label such as "MEGA Recovery Key:"; or one that
      // looks random anywhere outside encoded data (mixed case and a digit, "-", "_" or several capitals).
      if (whole && t === shown && (mixed || canonical)) return true;
      if (canonical && labelled) return true;
      if (!encoded && canonical && mixed && (/[0-9_-]/.test(t) || (t.match(/[A-Z]/g) ?? []).length >= 4)) return true;
    }
    // Next to a label, also in standard base64 ("+" and "/" for "-" and "_"), outside MEGA links
    // (a link's key followed by "/folder/<handle>" would look like one).
    const outsideLinks = line.replace(LINK_TOKEN, ' ') + (spaced === null ? '' : ` ${spaced.replace(LINK_TOKEN, ' ')}`);
    if (labelled && /(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]*[+/])[A-Za-z0-9+/]{21}[AQgw](?![A-Za-z0-9+/])/.test(outsideLinks)) return true;
  }
  return false;
}

const RECOVERY_KEY_REFUSAL =
  "This looks like the account's MEGA recovery key, which is its master key: it is not read into the conversation.";
const RECOVERY_KEY_CONTENT_REFUSAL = `${RECOVERY_KEY_REFUSAL} Some hashes, encoded data and long identifiers look the same; if this file isn't the recovery key, the user can open it themselves.`;

export function registerCat(server: McpServer, rt: Runtime, allowed?: () => boolean): RegisteredTool {
  const tool: RegisteredTool = server.registerTool(
    'mega_cat',
    {
      title: 'MEGA: read file',
      description:
        'Read the text contents of a MEGA cloud file (for content-based search/identification). Capped (default 1 MB, max 10 MB) and text-only. Read-only.',
      inputSchema: {
        remotePath: z.string().describe('Absolute MEGA path to the file.'),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(HARD_MAX)
          .optional()
          .describe('Max bytes to read (default 1048576 = 1 MB, hard max 10485760 = 10 MB).'),
      },
      annotations: { title: 'MEGA: read file', readOnlyHint: true, openWorldHint: true },
    },
    async ({ remotePath, maxBytes }) =>
      guardRun(async () => {
        // Consent is re-checked on every read: turning file reading off in another
        // server process (or another conversation) must stop this one too.
        const refused = () => {
          if (!allowed || allowed()) return null;
          tool.disable();
          return err('Reading file contents was turned off. Ask the user, then call mega_file_reading to turn it on again.');
        };
        const off = refused();
        if (off) return off;
        // One file per read: a wildcard is listed with mega_find, then each match read by its path.
        const rp = assertNoWildcard(assertNotStoreCopy(assertRemotePath(remotePath)), 'remotePath');
        // The recovery key IS the master key: MEGA saves it as MEGA-RECOVERYKEY.txt (or its translation).
        if (isRecoveryKeyName(posix.basename(rp))) {
          return err(RECOVERY_KEY_REFUSAL, { remotePath: rp });
        }
        // Same-named files would print as one joined text, defeating the reader and the key check.
        // Counted and read with no copy or move in between (a copy could add a same-named file).
        const { same, r } = await withWriteLock(async () => {
          const same = await sameNamed(rt, rp);
          // Asked again after the wait for the lock (a long transfer may hold it).
          if (same.count < 0 || same.count > 1 || refused()) return { same, r: null };
          return { same, r: await rt.run('cat', [rp], { maxBuffer: Math.min(maxBytes ?? DEFAULT_MAX, HARD_MAX) }) };
        });
        // ...and once more for a read that was turned off while it ran.
        const late = refused();
        if (late) return late;
        if (same.count === -1) return err(`Could not check how many files are named ${rp}; nothing was read.`, { remotePath: rp });
        if (same.count > 1) {
          return err(
            `${same.count} files are named ${rp} (or match it as a pattern); MEGAcmd would print all of them as one text. List them with mega_find or mega_ls and read each one by its own path (files that share one exact name need one renamed first).`,
            { remotePath: rp },
          );
        }
        const cap = Math.min(maxBytes ?? DEFAULT_MAX, HARD_MAX);
        if (!r) return err(`Could not read ${rp}.`, { remotePath: rp });
        if (r.maxBufferExceeded) {
          return err(
            `File exceeds the ${Math.floor(cap / 1024)} KB read cap. Raise maxBytes (up to 10 MB), or the file is too large to read inline — download it with mega_get instead.`,
            { remotePath: rp, capped: true },
          );
        }
        if (r.code !== ExitCode.OK) return err(classifyExit(r), { ok: false, code: r.code });
        if (looksBinary(r.stdout)) {
          return ok(`(file appears to be binary; ${r.stdout.length} bytes not shown)`, {
            remotePath: rp,
            binary: true,
            bytes: r.stdout.length,
          });
        }
        // ...and under any name: a recovery key anywhere in the text (see holdsRecoveryKey).
        if (holdsRecoveryKey(r.stdout)) return err(RECOVERY_KEY_CONTENT_REFUSAL, { remotePath: rp });
        // Text only, no structuredContent: ok() mirrors the text into it, which
        // would send every file twice (up to 2x the byte cap) for no benefit.
        return { content: [{ type: 'text', text: r.stdout.length ? r.stdout : '(empty file)' }] };
      }),
  );
  return tool;
}
