/**
 * Narrow-domain link reference definition / reference scanner (P0 round).
 *
 * This is NOT a CommonMark pre-parser: Pass 1 (`collectLinkDefs`) is a
 * blank-line-bounded, escape-aware CHARACTER scan whose only job is to find
 * the extents of link reference definitions ("[label]: dest "title""),
 * including the shapes the vendored markdown-it accepts in practice
 * (destination on the next line at any indent, title continuation lines at
 * 0/4/8 spaces or tab indent, multi-line labels/titles, angle destinations
 * containing spaces, escaped brackets/quotes). Pass 2 lives in
 * delimiters.ts: it rewrites recognized definitions contextually (never
 * inside fences/indented code/spans, never from an open paragraph) and
 * tokenizes reference labels so math inside labels survives.
 *
 * Reference matching uses the exact vendored normalization
 * (md.utils.normalizeReference): trim → collapse whitespace →
 * toLowerCase() → toUpperCase(). Labels that normalize equal share one
 * token BASE (their definition id); every occurrence (definition or
 * reference, in document order) appends a 32-symbol 'a'/'A' variant suffix
 * derived from a global occurrence counter. The mixed-case tokens are
 * unique per occurrence, but normalizeReference folds case, so markdown-it
 * still resolves every occurrence against the definition — while the
 * restore pass can recover the EXACT raw label text per occurrence from a
 * Map keyed by the mixed-case token.
 */

/** Exact vendored label normalization (md.utils.normalizeReference). */
export function normalizeReference(label: string): string {
  // toLowerCase() then toUpperCase() is deliberate: it matches the vendored
  // markdown-it byte-for-byte (ẞ → SS, İ → I + combining dot, Σ → Σ).
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase();
}

/** A link reference definition candidate found by Pass 1. */
export interface LinkDefCandidate {
  /** Source index of the LINE START the definition begins on. */
  readonly start: number;
  /** Label content between the brackets, verbatim (may span lines). */
  readonly labelRaw: string;
  /** Destination as written (angle brackets kept), verbatim. */
  readonly destRaw: string;
  /** Destination attribute content: raw inner text, no <> shell (no early unescape). */
  readonly destContent: string;
  /** Title as written (quotes/parens kept), verbatim, or null. */
  readonly titleRaw: string | null;
  /** Title attribute content: raw inner text, no quote shell (no early unescape), or null. */
  readonly titleContent: string | null;
  /** End of the last line belonging to the definition (excl. newline). */
  readonly extentEnd: number;
}

export interface LinkDefIndex {
  readonly candidates: readonly LinkDefCandidate[];
  /** Line-start ('[') source position → candidate index. */
  readonly byStart: Map<number, number>;
  /** normalizeReference(label) → candidate index of the FIRST definition. */
  readonly byLabel: Map<string, number>;
}

export interface LinkDefOptions {
  /**
   * Fragment mode (visible-label re-render): disable the linkdef/reference
   * prepass entirely so a rendered label can never recurse.
   */
  readonly noLinkRefs?: boolean;
}

const MAX_LABEL = 1000; // CommonMark label limit (between brackets)

const isBlankLine = (line: string): boolean => line.trim() === '';

/** Marker family for list-continuation semantics: bullet char or ordered delimiter. */
export type ListFamily = '-' | '+' | '*' | '.' | ')';

/** The list marker family of a line's leading marker, or null. */
export function listFamilyOf(line: string): ListFamily | null {
  const m = /^ {0,3}([-+*]|(\d{1,9})([.)]))(?:[ \t]+|$)/.exec(line);
  if (!m) return null;
  if (m[2] !== undefined) return m[3] as ListFamily;
  return m[1] as ListFamily;
}

/** True when the line is nothing but a list marker (no content after it). */
function isPureListMarker(line: string): boolean {
  const m = /^ {0,3}([-+*]|\d{1,9}[.)])[ \t]*$/.exec(line);
  return m !== null;
}

/** True for `=+` / `-+` setext-underline-shaped lines (0..3 indent). */
function isSetextShaped(line: string): boolean {
  return /^ {0,3}(=+|-+)[ \t]*$/.test(line);
}

interface DestParse {
  readonly destRaw: string;
  /** Attribute content: shell removed, backslash escapes resolved. */
  readonly content: string;
  readonly after: number; // position after the destination
}

/**
 * Parse a destination starting at [pos] on the given line ([eol] = line
 * end, CR stripped text not needed: we scan the raw source but stop at the
 * newline). Angle destinations may contain anything except an unescaped
 * '<', '>' or newline; bare destinations are a single run without
 * whitespace with balanced, unescaped parentheses.
 */
function parseDestination(src: string, pos: number, eol: number): DestParse | null {
  if (pos >= eol) return null;
  if (src[pos] === '<') {
    let j = pos + 1;
    let destRaw = '';
    while (j < eol) {
      const c = src[j];
      if (c === '\\' && j + 1 < eol) {
        // Keep the escape verbatim (raw literal restore); skip the next char.
        destRaw += src.slice(j, j + 2);
        j += 2;
        continue;
      }
      if (c === '<') return null;
      if (c === '>') {
        const raw = src.slice(pos, j + 1);
        return { destRaw: raw, content: raw.slice(1, -1), after: j + 1 };
      }
      destRaw += c;
      j++;
    }
    return null; // unterminated angle destination on the line
  }
  // Bare destination: no whitespace, balanced parens, backslash escapes.
  let depth = 0;
  let j = pos;
  let destRaw = '';
  while (j < eol) {
    const c = src[j];
    if (c === '\\' && j + 1 < eol) {
      destRaw += src.slice(j, j + 2);
      j += 2;
      continue;
    }
    if (c === ' ' || c === '\t') break;
    if (c === '(') {
      depth++;
    } else if (c === ')') {
      if (depth === 0) break; // unbalanced close ends the destination
      depth--;
    }
    destRaw += c;
    j++;
  }
  if (destRaw.length === 0 || depth !== 0) return null;
  return { destRaw, content: destRaw, after: j };
}

/**
 * Try to parse a title starting at [pos] on the current line ([eol]).
 * Returns { titleStart } when the opening quote is found (title may
 * continue on following lines — the caller switches to multiline-title
 * state), { complete: true, titleRaw, after } when it closes on this line,
 * or null when there is no title opener here.
 */
type TitleParse =
  | { kind: 'none' }
  | { kind: 'open'; readonly quote: string }
  | { kind: 'complete'; readonly titleRaw: string; readonly content: string; readonly after: number };

function parseTitleStart(src: string, pos: number, eol: number): TitleParse {
  if (pos >= eol) return { kind: 'none' };
  const q = src[pos];
  if (q !== '"' && q !== "'" && q !== '(') return { kind: 'none' };
  const close = q === '(' ? ')' : q;
  let j = pos + 1;
  while (j < eol) {
    const c = src[j];
    if (c === '\\' && j + 1 < eol) {
      j += 2;
      continue;
    }
    if (c === close) {
      // The title must be followed by only whitespace to end of line.
      if (src.slice(j + 1, eol).trim() !== '') return { kind: 'none' };
      return {
        kind: 'complete',
        titleRaw: src.slice(pos, j + 1),
        content: src.slice(pos + 1, j),
        after: j + 1,
      };
    }
    j++;
  }
  return { kind: 'open', quote: close };
}

/**
 * Pass 1: collect link reference definition candidates from the raw
 * source. Blank-line bounded; a candidate's state machine is
 * None → AwaitDestination → TitleAllowed → (InMultilineTitle) → Complete.
 * Ambiguous shapes fail conservatively (the lines stay ordinary text for
 * the downstream markdown-it, which is always native-safe).
 */
export function collectLinkDefs(source: string): LinkDefIndex {
  const candidates: LinkDefCandidate[] = [];
  const byStart = new Map<number, number>();
  const byLabel = new Map<string, number>();
  const n = source.length;

  const endOfLine = (p: number): number => {
    const idx = source.indexOf('\n', p);
    return idx === -1 ? n : idx;
  };
  /**
   * LOGICAL line end (CRLF-aware): the raw EOL minus one trailing \r.
   * Every label/dest/title parse bound uses this, so a CR can never leak
   * into a destination, title, label, or extent.
   */
  const lineEnd = (p: number): number => {
    const e = endOfLine(p);
    if (e > p && source[e - 1] === '\r') return e - 1;
    return e;
  };
  const nextLineStart = (p: number): number => {
    const eol = endOfLine(p);
    return eol >= n ? n : eol + 1;
  };
  /** Line [p,eol) with a single trailing \r stripped. */
  const lineText = (p: number, eol: number): string => {
    const s = source.slice(p, eol);
    return s.endsWith('\r') ? s.slice(0, -1) : s;
  };
  const isBlankAt = (p: number): boolean => {
    if (p >= n) return false;
    return isBlankLine(lineText(p, endOfLine(p)));
  };

  type Pending = {
    start: number;
    labelRaw: string;
  };
  type MultilineTitle = {
    start: number;
    labelRaw: string;
    destRaw: string;
    destContent: string;
    titleStart: number; // index of the opening quote
    quote: string;
    /** Title opened on the SAME line as the destination (vs a continuation line). */
    sameLineOpen: boolean;
  };

  let state: 'none' | 'await-dest' | 'title-allowed' | 'multiline-title' = 'none';
  let pending: Pending | null = null;
  let mlTitle: MultilineTitle | null = null;

  const finalize = (
    start: number,
    labelRaw: string,
    destRaw: string,
    destContent: string,
    titleRaw: string | null,
    titleContent: string | null,
    extentEnd: number,
  ): void => {
    const normalized = normalizeReference(labelRaw);
    const idx = candidates.length;
    candidates.push({ start, labelRaw, destRaw, destContent, titleRaw, titleContent, extentEnd });
    byStart.set(start, idx);
    // First definition wins (CommonMark); later same-label candidates are
    // still recorded by position for the contextual pass.
    if (!byLabel.has(normalized)) byLabel.set(normalized, idx);
  };

  /**
   * Try to start a definition whose '[' is at [bracket] (on the line
   * starting at [lineStart]); the candidate records [lineStart] so the
   * consuming scanner can look it up at a line start.
   */
  const tryStart = (
    bracket: number,
    lineStart: number,
  ): 'started-pending' | 'started-complete' | 'started-titled' | 'no' => {
    const p = bracket;
    if (source[p] !== '[') return 'no';
    // Label: first unescaped ']', newlines allowed, no blank line inside,
    // <= 1000 chars, at least one non-whitespace character.
    let j = p + 1;
    let labelRaw = '';
    while (j < n) {
      const c = source[j];
      if (c === '\\' && j + 1 < n) {
        labelRaw += source.slice(j, j + 2);
        j += 2;
        continue;
      }
      if (c === '[') return 'no'; // labels do not nest
      if (c === ']') break;
      if (c === '\n') {
        // Continuation lines of a label must not be blank.
        if (isBlankAt(j + 1)) return 'no';
        labelRaw += '\n';
        j++;
        continue;
      }
      labelRaw += c;
      j++;
    }
    if (j >= n) return 'no';
    if (labelRaw.length < 1 || labelRaw.length > MAX_LABEL) return 'no';
    if (labelRaw.trim() === '') return 'no';
    const afterLabel = j + 1;
    if (source[afterLabel] !== ':') return 'no';
    const eol = lineEnd(afterLabel);
    // Rest of the line after ':': optional leading whitespace.
    let q = afterLabel + 1;
    while (q < eol && (source[q] === ' ' || source[q] === '\t')) q++;
    if (q >= eol) {
      pending = { start: lineStart, labelRaw };
      return 'started-pending';
    }
    const dest = parseDestination(source, q, eol);
    if (!dest) return 'no';
    let r = dest.after;
    while (r < eol && (source[r] === ' ' || source[r] === '\t')) r++;
    const title = parseTitleStart(source, r, eol);
    if (title.kind === 'none') {
      // Trailing junk after the destination invalidates the definition.
      if (source.slice(r, eol).trim() !== '') return 'no';
      finalize(lineStart, labelRaw, dest.destRaw, dest.content, null, null, eol);
      return 'started-complete';
    }
    if (title.kind === 'complete') {
      finalize(lineStart, labelRaw, dest.destRaw, dest.content, title.titleRaw, title.content, eol);
      // A definition that already carries its title is Complete: a
      // following title-shaped line is an ordinary paragraph, never a
      // second title ("Complete 后第二 title" rule).
      return 'started-titled';
    }
    mlTitle = {
      start: lineStart,
      labelRaw,
      destRaw: dest.destRaw,
      destContent: dest.content,
      titleStart: r,
      quote: title.quote,
      sameLineOpen: true,
    };
    return 'started-complete'; // caller: switch to multiline-title state
  };

  let i = 0;
  while (i < n) {
    const rawEol = endOfLine(i);
    const eol = lineEnd(i); // logical: CR never enters a parse bound
    const line = lineText(i, eol);
    if (state === 'none') {
      if (isBlankLine(line)) {
        i = nextLineStart(i);
        continue;
      }
      const m = /^ {0,3}\[/.exec(line);
      let started = false;
      if (m) {
        const res = tryStart(i + m[0].length - 1, i);
        if (res === 'started-pending') {
          state = 'await-dest';
          started = true;
        } else if (res === 'started-complete') {
          started = true;
          // A complete one-line definition may still gain a title from
          // the NEXT line ("[a]: /u\n\"t\""); an open quote switches to
          // the multiline-title state instead.
          state = mlTitle ? 'multiline-title' : 'title-allowed';
        }
      }
      i = nextLineStart(i);
      if (started) continue;
      continue;
    }
    if (state === 'await-dest') {
      const pend = pending!;
      if (isBlankLine(line)) {
        // AwaitDestination + blank: the candidate failed.
        state = 'none';
        pending = null;
        i = nextLineStart(i);
        continue;
      }
      if (isSetextShaped(line) || isPureListMarker(line)) {
        // A lone setext form is a heading underline natively, a lone list
        // marker is list-shaped: neither is a destination. Candidate fails.
        state = 'none';
        pending = null;
        i = nextLineStart(i);
        continue;
      }
      // Destination line: any leading whitespace indent (vendored accepts
      // 0/4/8 spaces, tab, mixed), destination, optional title.
      let q = i;
      while (q < eol && (source[q] === ' ' || source[q] === '\t')) q++;
      const dest = parseDestination(source, q, eol);
      if (!dest) {
        state = 'none';
        pending = null;
        continue; // reprocess this line in state 'none' (it may start a def)
      }
      let r = dest.after;
      while (r < eol && (source[r] === ' ' || source[r] === '\t')) r++;
      const title = parseTitleStart(source, r, eol);
      if (title.kind === 'complete') {
        finalize(pend.start, pend.labelRaw, dest.destRaw, dest.content, title.titleRaw, title.content, eol);
        state = 'none';
        pending = null;
        i = nextLineStart(i);
        continue;
      }
      if (title.kind === 'open') {
        mlTitle = {
          start: pend.start,
          labelRaw: pend.labelRaw,
          destRaw: dest.destRaw,
          destContent: dest.content,
          titleStart: r,
          quote: title.quote,
          sameLineOpen: false,
        };
        state = 'multiline-title';
        pending = null;
        i = nextLineStart(i);
        continue;
      }
      if (source.slice(r, eol).trim() !== '') {
        // Junk after the destination: the whole candidate failed.
        state = 'none';
        pending = null;
        continue; // reprocess line in 'none'
      }
      finalize(pend.start, pend.labelRaw, dest.destRaw, dest.content, null, null, eol);
      state = 'title-allowed';
      pending = null;
      i = nextLineStart(i);
      continue;
    }
    if (state === 'title-allowed') {
      if (isBlankLine(line)) {
        // TitleAllowed + blank: keep the definition without a title. Its
        // extent ended at the previous line; state returns to none on the
        // NEXT line — but the blank line itself must not extend it.
        state = 'none';
        i = nextLineStart(i);
        continue;
      }
      // A title continuation line (any leading whitespace) completes the
      // definition WITH a title. Anything else ends the definition without
      // a title and is reprocessed as a fresh line.
      let q = i;
      while (q < eol && (source[q] === ' ' || source[q] === '\t')) q++;
      const title = parseTitleStart(source, q, eol);
      if (title.kind === 'complete') {
        // Extend the most recent candidate (the one in title-allowed) —
        // it was already finalized without a title; amend it.
        const cand = candidates[candidates.length - 1];
        candidates[candidates.length - 1] = {
          ...cand,
          titleRaw: title.titleRaw,
          titleContent: title.content,
          extentEnd: eol,
        };
        state = 'none';
        i = nextLineStart(i);
        continue;
      }
      if (title.kind === 'open') {
        const cand = candidates[candidates.length - 1];
        mlTitle = {
          start: cand.start,
          labelRaw: cand.labelRaw,
          destRaw: cand.destRaw,
          destContent: cand.destContent,
          titleStart: q,
          quote: title.quote,
          sameLineOpen: false,
        };
        state = 'multiline-title';
        i = nextLineStart(i);
        continue;
      }
      // Not a title: the definition stays as finalized (without title);
      // this line is ordinary text — reprocess in 'none'.
      state = 'none';
      continue;
    }
    // state === 'multiline-title'
    {
      const mt = mlTitle!;
      /** Whole-candidate failure: drop it from the index if finalized. */
      const failCandidate = () => {
        const last = candidates[candidates.length - 1];
        if (last && last.start === mt.start) {
          candidates.pop();
          byStart.delete(mt.start);
          const normalized = normalizeReference(mt.labelRaw);
          if (byLabel.get(normalized) === candidates.length) byLabel.delete(normalized);
        }
      };
      if (isBlankLine(line)) {
        // Blank inside an open title, split by where the title OPENED:
        //  - same line as the destination: the whole candidate fails;
        //  - on a continuation line (the definition was already complete
        //    without a title): KEEP that no-title definition.
        if (mt.sameLineOpen) failCandidate();
        state = 'none';
        mlTitle = null;
        i = nextLineStart(i);
        continue;
      }
      // The title continues until its FIRST closing quote; a closer
      // followed by anything but whitespace fails the whole candidate —
      // no falling back to a later quote (native behavior).
      let j = i;
      let closed = -1;
      while (j < eol) {
        const c = source[j];
        if (c === '\\' && j + 1 < eol) {
          j += 2;
          continue;
        }
        if (c === mt.quote) {
          closed = j;
          break;
        }
        j++;
      }
      if (closed >= 0) {
        if (source.slice(closed + 1, eol).trim() !== '') {
          // First closer followed by junk — split by where the title
          // OPENED (same rule as the blank case): a title opened on the
          // destination's own line fails the whole candidate; one opened
          // on a continuation line leaves the already-complete no-title
          // definition intact, the title-shaped text an ordinary
          // paragraph. Never fall back to a later closer.
          if (mt.sameLineOpen) failCandidate();
          state = 'none';
          mlTitle = null;
          i = nextLineStart(i);
          continue;
        }
        const titleRaw = source.slice(mt.titleStart, closed + 1);
        const titleContent = source.slice(mt.titleStart + 1, closed);
        finalize(mt.start, mt.labelRaw, mt.destRaw, mt.destContent, titleRaw, titleContent, eol);
        state = 'none';
        mlTitle = null;
      }
      i = nextLineStart(i);
      continue;
    }
  }
  return { candidates, byStart, byLabel };
}

// ---- placeholder tokens (shape mirrors the math/code tokens) ----

export const LABEL_TOKEN_SOURCE = 'MLABELPH[A-Z0-9]{1,8}[0-9]+[aA]{32}MMM';
export const LIT_TOKEN_SOURCE = 'MLITPH[A-Z0-9]{1,8}[0-9]+MLM';

/**
 * Variant suffix: occurrence id encoded as 32 'a'/'A' symbols (bit i of
 * the id selects the case of symbol i). Two suffixes normalize equal under
 * normalizeReference but differ as exact strings, which is exactly the
 * variant-token contract.
 */
function variantSuffix(occurrenceId: number): string {
  const bits = new Array<string>(32);
  for (let b = 0; b < 32; b++) {
    bits[b] = (occurrenceId & (1 << b)) !== 0 ? 'A' : 'a';
  }
  return bits.join('');
}

export function labelToken(salt: string, baseId: number, occurrenceId: number): string {
  return `MLABELPH${salt}${baseId}${variantSuffix(occurrenceId)}MMM`;
}

export function litToken(salt: string, index: number): string {
  return `MLITPH${salt}${index}MLM`;
}

/** A visible-text or attribute label occurrence, restorable per position. */
export interface LabelSegment {
  readonly token: string;
  readonly kind: 'label';
  /** The exact raw label content at this occurrence. */
  readonly raw: string;
}

/**
 * A linkdef destination/title literal. Attribute-position restore only:
 * [content] is the ATTRIBUTE content (CommonMark unescaped, no `<>` /
 * quote shell) — the destination additionally goes through the vendored
 * normalizeLink at restore time; [raw] keeps the verbatim source span for
 * any literal path.
 */
export interface LiteralSegment {
  readonly token: string;
  readonly kind: 'literal';
  readonly raw: string;
  readonly role: 'dest' | 'title';
  /** Unescaped inner content, shell delimiters removed. */
  readonly content: string;
}

/**
 * Plain CommonMark unescape: backslash before ASCII punctuation loses the
 * backslash; everything else stays verbatim. Applied at RESTORE time to
 * attribute inner text in which COMPLETE math/code spans have already been
 * replaced by alphanumeric placeholder tokens (tokens contain no
 * backslash, so they are unaffected) — that is what keeps paired math
 * delimiters like `/\(x\)/foo` literal while lone escapes (`\(`, `\]`)
 * unescape exactly like the native attribute semantics.
 */
export function unescapeContent(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunctuation(s[i + 1])) {
      out += s[i + 1];
      i++;
      continue;
    }
    out += s[i];
  }
  return out;
}

function isAsciiPunctuation(c: string): boolean {
  return /[!-/:-@\[-`{-~]/.test(c);
}
