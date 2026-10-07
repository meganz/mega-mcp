/**
 * MEGAcmd's own command-line round trip, reproduced so we can check it.
 *
 * An argv array is not delivered to MEGAcmd as an array. The mega-* client joins
 * it into ONE line (megacmdclient.cpp: an argument is wrapped in double quotes
 * only when it contains a space or is empty, and arguments are separated by
 * single spaces), and the server splits that line again with getlistOfWords
 * (megacmdcommonutils.cpp). The two do not invert each other: the server skips
 * any byte 0x01-0x20 before a word, treats a leading single or double quote as
 * quoting, and does not split at a space that follows a backslash.
 *
 * Every earlier argv defect here was one of those differences, found one
 * character at a time. Rather than guessing which characters are dangerous, the
 * runtime now serializes each call the way the client does, splits it the way the
 * server does, and refuses the call unless the server would read back exactly the
 * words we meant to send.
 */

/** megacmdclient.cpp: how the client turns its argv into the command line. */
export function serializeLikeClient(words: readonly string[]): string {
  return words.map((w) => (w.includes(' ') || w === '' ? `"${w}"` : w)).join(' ');
}

/**
 * megacmdcommonutils.cpp getlistOfWords(ptr, escapeBackSlashInCompletion,
 * ignoreTrailingSpaces=TRUE), transcribed branch for branch. TRUE because that is
 * the split whose words the server executes (megacmd.cpp: "Get words again
 * ignoring trailing spaces"); it also drops a final argument that is only blank or
 * control bytes. escapeBackSlashInCompletion only affects the `completion`
 * command, which is never sent. Characters above 0x7F only ever compare unequal to
 * the ASCII delimiters, exactly as their UTF-8 bytes do in the C++ loop, so working
 * on UTF-16 code units is equivalent.
 */
export function splitLikeServer(line: string): string[] {
  const words: string[] = [];
  const n = line.length;
  const at = (k: number): string => (k < n ? (line[k] as string) : '\0');
  let i = 0;
  for (;;) {
    // skip leading blank space: any byte 0x01-0x20, up to and including the end
    while (i < n && line.charCodeAt(i) > 0 && line.charCodeAt(i) <= 0x20) i++;
    if (at(i) === '\0') break;

    const c = at(i);
    if (c === '"' || c === "'") {
      i++;
      let w = i;
      let word = '';
      for (;;) {
        const ch = at(i);
        if (ch === c || ch === '\\' || ch === '\0') {
          word += line.slice(w, i);
          if (ch === '\0') break;
          i++;
          if (ch === c) break;
          w = i - 1; // the backslash is kept: it starts the next appended run
        } else {
          i++;
        }
      }
      words.push(word);
    } else {
      while (at(i) === ' ') i++; // only possible if the next char is the end
      const w = i;
      let prev = i;
      while (at(i) !== '\0' && !(at(i) === ' ' && at(prev) !== '\\')) {
        if (at(i) === '"' && at(i + 1) !== '\0') {
          do {
            i++;
          } while (at(i) !== '"' && at(i + 1) !== '\0');
        }
        prev = i;
        i++;
      }
      words.push(line.slice(w, i));
    }
  }
  return words;
}

/** True when MEGAcmd's server would read back exactly `words`. */
export function survivesRoundTrip(words: readonly string[]): boolean {
  const back = splitLikeServer(serializeLikeClient(words));
  return back.length === words.length && back.every((w, i) => w === words[i]);
}

/**
 * megacmdcommonutils.cpp isPublicLink: what `get` and `import` treat as a public
 * link. Anything else they resolve as a cloud PATH (wildcards and H:handles
 * included), so a "link" argument must pass this exact test.
 */
export function isPublicLink(link: string): boolean {
  return link.startsWith('http') && (link.includes('#') || link.includes('/file/') || link.includes('/folder/'));
}
