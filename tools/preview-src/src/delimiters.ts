/**
 * MathMD math-protection scanner.
 *
 * Extracts TeX/LaTeX math segments (all four delimiter styles) from markdown
 * source BEFORE the markdown parser sees it, replacing them — together with
 * code constructs — with opaque alphanumeric placeholder tokens. This is the
 * layer plain markdown-it/marked pipelines lack: without it, CommonMark
 * backslash-escape and emphasis rules destroy `\(`, `\[`, `$\{x\}$`,
 * `$x_i$ ... $y_j$` and friends before any math renderer runs.
 *
 * Supported math delimiters (longest-first at each position):
 *   $$...$$   display       \[...\]   display
 *   $...$     inline        \(...\)   inline
 *
 * Rules (owner call, post-1.0.1 — matches the README's stated dollar rule):
 *  - Every UNESCAPED `$` is a math delimiter, period. `$$` is checked first
 *    (display), then a single `$` pairs with the next unescaped `$`. There
 *    are NO whitespace/opening-closing heuristics — they were fragile and
 *    defeated by real documents. Literal dollar signs MUST be escaped
 *    (`\$`) or placed inside code spans; a bare `$` is never prose.
 *  - `\`` `` ` `` `\$` `\\` are stepped over so the markdown parser handles
 *    them natively and the scanner never opens math on an escaped `$`.
 *  - Fenced code blocks (``` / ~~~), indented code blocks and inline code
 *    spans are extracted verbatim; math inside them is never touched.
 *    Indented extraction is gated by a lightweight block context (see
 *    blockcontext.ts) so paragraph math is never mistaken for code (M1),
 *    and single-level same-prefix blockquote fences are extracted too (M2).
 *  - `\[` without a matching `\]` falls back to CommonMark's escaped-bracket
 *    rendering (links keep working).
 *
 * Placeholder tokens contain a caller-supplied salt ([A-Z0-9], 1-8 chars) so
 * literal token-shaped text in user documents cannot collide with real
 * placeholders.
 */

import {
  BlockContext,
  delimiterRowShape,
  isTableDelimiter,
  splitUnescapedPipes,
  tableHeaderEligible,
} from './blockcontext';
import {
  collectLinkDefs,
  labelToken,
  litToken,
  normalizeReference,
  type LabelSegment,
  type LinkDefIndex,
  type LiteralSegment,
} from './linkrefs';

/** A math segment extracted from the source. */
export interface MathSegment {
  readonly token: string;
  readonly kind: 'math';
  /** true = display math ($$..$$ or \[..\]), false = inline. */
  readonly display: boolean;
  /** The TeX source between the delimiters, verbatim. */
  readonly tex: string;
  /** Full original source including delimiters, for literal attribute restore. */
  readonly raw: string;
}

/**
 * A code construct (fence / indented block / inline span), verbatim.
 *
 * `body` is the RESTORE content, produced by the scanner at extraction time
 * (H3): for spans it is the source between the two equal-length backtick
 * runs; for fences/indented blocks it is the content the restore pass
 * emits. `raw` keeps the full original text for literal attribute restore.
 */
export interface CodeSegment {
  readonly token: string;
  readonly kind: 'code';
  /**
   * Which construct produced this segment. The restore pass dispatches on
   * this instead of sniffing `raw`: a fence whose interior is 4-space- or
   * tab-indented (syntactically meaningful in Python etc.) would otherwise
   * match the indented-block sniff and have that indent stripped.
   */
  readonly construct: 'fence' | 'indented' | 'span';
  /**
   * For fences: the interior lines. For indented blocks: the indented lines.
   * For inline spans: the full original text including backtick delimiters.
   */
  readonly raw: string;
  /**
   * Content to restore, fixed at scan time. Spans: the text between the
   * matched delimiter runs (no re-derivation, so a longer backtick run
   * inside the span can never be mistaken for a closer). Fences: same as
   * `raw`. Indented: the lines with their 4-space/tab markers stripped.
   */
  readonly body: string;
}

export interface Protection {
  /** Markdown source with math/code replaced by placeholder tokens. */
  readonly text: string;
  readonly math: readonly MathSegment[];
  readonly code: readonly CodeSegment[];
  /**
   * Link reference label occurrences (definitions and references),
   * tokenized so math inside labels survives; restorable per exact
   * mixed-case variant token (linkrefs). Empty in fragment mode.
   */
  readonly labels: readonly LabelSegment[];
  /** Linkdef destination/title literals (attribute restore, esc only). */
  readonly lits: readonly LiteralSegment[];
}

/** Options for protectMath (fragment modes for restore-time re-protection). */
export interface ProtectOptions {
  /** Disable the linkdef/reference prepass (prevents restore recursion). */
  readonly noLinkRefs?: boolean;
  /**
   * INLINE-ONLY mode (label fragments, attribute inner content): disable
   * Pass 1 linkdefs AND every block-level behavior — fence/quote-fence/
   * indented extraction, table row mode, the illusion breaker, and all
   * BlockContext line classification/rewriting. Only inline code spans,
   * the four math delimiters, and backslash-escape stepping run; the
   * output can never gain or lose newlines (an isolated ``` or ~~~ in an
   * attribute stays the literal text it is).
   */
  readonly inlineOnly?: boolean;
}

/** Global (non-capturing-safe) matchers for placeholder tokens. */
export const MATH_TOKEN_SOURCE = 'MMATHMDPH[A-Z0-9]{1,8}[0-9]+MMM';
export const CODE_TOKEN_SOURCE = 'MCODEPH[A-Z0-9]{1,8}[0-9]+MMM';
export { LABEL_TOKEN_SOURCE, LIT_TOKEN_SOURCE } from './linkrefs';

const SALT_RE = /^[A-Z0-9]{1,8}$/;

/**
 * Does this line, seen during a code-span closer search, end the inline
 * leaf block the opener belongs to? (L1.) The set is deliberately
 * over-inclusive in the markdown-it paragraph-interrupter direction: a
 * killed span only costs literal backticks, while an over-long span would
 * swallow headings/fences and hide their math inside a fake code restore.
 */
const isSpanBoundaryLine = (line: string, quoted: boolean, prefix: string): boolean => {
  const l = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (l.trim() === '') return true; // blank line: hard inline boundary
  if (quoted) {
    if (l.startsWith(prefix)) {
      const body = l.slice(prefix.length);
      if (body.trim() === '') return true; // marker-only quote line: paragraph break
      return isSpanBoundaryShape(body);
    }
    // Other quote-marked line: only the marker-only shape is a provable
    // paragraph break; content lines may be soft continuations — no guess.
    return /^ {0,3}>[ \t]*$/.test(l);
  }
  if (/^ {0,3}>/.test(l)) return true; // blockquote interrupts a top-level paragraph
  return isSpanBoundaryShape(l);
};

const isSpanBoundaryShape = (body: string): boolean => {
  // Top-level CommonMark shapes: an interrupting block may carry at most 3
  // leading spaces. Lines indented 4+ inside an OPEN paragraph are plain
  // continuations (indented code cannot interrupt a paragraph) — treating
  // them as boundaries used to kill legitimate multi-line spans whose
  // inline math then leaked into markdown-it's own code_inline.
  if (/^ {0,3}(`{3,}|~{3,})/.test(body)) return true; // fence line
  if (/^ {0,3}#{1,6}(?:[ \t]+|$)/.test(body)) return true; // ATX heading
  if (/^ {0,3}(=+|-+)[ \t]*$/.test(body)) return true; // setext underline / hr run
  if (/^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/.test(body)) return true; // thematic break
  // Bullet and start-1 ordered markers interrupt paragraphs; start!=1
  // ordered markers do not (a span may legitimately contain "2. text"),
  // and neither do markers indented 4+.
  if (/^ {0,3}(?:[-+*]|1[.)])(?:[ \t]+|$)/.test(body)) return true;
  if (isTableDelimiter(body)) return true; // table delimiter row
  return false;
};

export function protectMath(
  source: string,
  salt = 'K7',
  opts: ProtectOptions = {},
): Protection {
  if (!SALT_RE.test(salt)) {
    throw new Error(`salt must match ${SALT_RE}, got "${salt}"`);
  }

  const math: MathSegment[] = [];
  const code: CodeSegment[] = [];
  const labels: LabelSegment[] = [];
  const lits: LiteralSegment[] = [];
  // linkrefs Pass 1: collect definition candidates textually. Pass 2 (the
  // tryLinkDef/tryReference hooks below) contextualizes: nothing inside
  // fences/indented code/code spans is ever rewritten, and definitions
  // never interrupt open paragraphs. Fragment mode (visible-label
  // re-render) disables the prepass entirely.
  const inline = opts.inlineOnly === true;
  const linkIndex: LinkDefIndex | null = opts.noLinkRefs || inline ? null : collectLinkDefs(source);
  let occurrence = 0;
  let out = '';
  const n = source.length;

  // ---- lightweight block context (M1/M2) ----
  // Every PROTECTED line the scanner emits is classified here, because that
  // is the exact text markdown-it will parse. The context gates indented
  // extraction; ambiguous shapes classify conservatively as paragraph text.
  // A parallel RAW buffer tracks the original source of each protected
  // line: table column counting uses raw pipes (GFM splits rows on
  // unescaped pipes BEFORE inline parsing).
  const ctx = new BlockContext(salt);
  let outLineStart = 0;
  let rawBuf = '';
  let rawLineStart = 0;
  let lineUncertain = false; // current line swallowed a multi-line construct
  // Previous emitted (protected) line — the fake-table illusion breaker
  // compares its token-visible cell count with a rejected delimiter row.
  let prevOutLineText: string | null = null;
  /** Unescaped-pipe cell count of a line (outer pipes removed), null if no pipe. */
  const cellCount = (l: string): number | null => {
    if (!hasUnescapedPipe(l)) return null;
    let cells = splitUnescapedPipes(l);
    if (cells.length > 1 && cells[0].trim() === '') cells = cells.slice(1);
    if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells = cells.slice(0, -1);
    return cells.length;
  };
  /** Escape the first unescaped '|' so markdown-it cannot split a cell there. */
  const escapeFirstUnescapedPipe = (l: string): string => {
    for (let i = 0; i < l.length; i++) {
      if (l[i] === '|' && backslashRunIn(l, i) % 2 === 0) {
        return `${l.slice(0, i)}\\|${l.slice(i + 1)}`;
      }
    }
    return l;
  };

  // ---- GFM table-row mode (Lead round 3) ----
  // Inside a table row, unescaped pipes are STRUCTURAL: cells are split
  // before inline parsing, so math/code pairing must never cross a cell
  // boundary. While this mode is active the scanner treats every
  // unescaped pipe (and the row's line end) as a hard inline boundary —
  // pipes are emitted verbatim, cell-local constructs still protect
  // normally, and cross-cell delimiters stay literal fragments exactly
  // like the native parse. No tokens are orphaned and no raw text is
  // re-emitted wholesale.
  let rowPipeMode = false;
  const stripCR = (l: string): string => (l.endsWith('\r') ? l.slice(0, -1) : l);
  const hasUnescapedPipe = (l: string): boolean => {
    for (let i = 0; i < l.length; i++) {
      if (l[i] === '|' && backslashRunIn(l, i) % 2 === 0) return true;
    }
    return false;
  };
  /** Backslash run before index j INSIDE a string (escape parity check). */
  const backslashRunIn = (s: string, j: number): number => {
    let k = 0;
    while (j - 1 - k >= 0 && s[j - 1 - k] === '\\') k++;
    return k;
  };
  /** Lines that open a block and therefore end a table / are not rows. */
  const blockOpenerShape = (l: string): boolean =>
    /^ {0,3}(`{3,}|~{3,})/.test(l) ||
    /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(l) ||
    /^ {0,3}(=+|-+)[ \t]*$/.test(l) ||
    /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/.test(l) ||
    /^ {0,3}([-+*]|\d{1,9}[.)])(?:[ \t]+|$)/.test(l) ||
    /^ {0,3}>/.test(l);
  /**
   * Decide row mode at a line start. A VALID table header (shared
   * isValidRawTable predicate) enters cell mode EVEN when the header line
   * is list-shaped ("1. h | j", "- h | j") — natively the delimiter row
   * makes it a table; only the delimiter's own list-marker shape keeps the
   * list interpretation. Body rows follow tableActive. Invalid candidates
   * are ordinary lines: cross-pipe math/code pairs normally there.
   */
  const computeRowMode = (p: number): boolean => {
    const eol = endOfLine(p);
    const line = stripCR(source.slice(p, eol));
    if (line.trim() === '') return false;
    if (hasUnescapedPipe(line) && eol < n) {
      const neol = endOfLine(eol + 1);
      const next = stripCR(source.slice(eol + 1, neol));
      if (delimiterRowShape(next)) {
        // SHARED predicate + the snapshot captured BEFORE this header line
        // is classified — the same pair the delimiter line's classification
        // will use, so the two decisions can never drift (family-aware
        // list suppression lives inside tableHeaderEligible).
        if (tableHeaderEligible(line, next, ctx.snapshot())) return true;
      }
    }
    if (blockOpenerShape(line)) return false;
    return ctx.tableActive;
  };

  const handleLine = (lineText: string, rawLine: string | null): string | null => {
    ctx.classifyLine(lineText, rawLine);
    // Fake-table illusion breaker. The raw validation may reject a table
    // (column mismatch, delimiter indent, list-marker priority) while
    // markdown-it — which sees TOKENS, not the raw pipes a token swallowed
    // — would still count equal columns and build a table the raw layout
    // denies; the line after it would then turn into code that renders
    // math. Escape the delimiter row's first unescaped pipe: '\|' renders
    // as '|' (byte-identical to the native paragraph rendering of an
    // invalid delimiter), every token stays live, no table forms.
    let replacement: string | null = null;
    if (
      rawLine !== null &&
      !ctx.tableActive &&
      prevOutLineText !== null &&
      delimiterRowShape(rawLine) &&
      hasUnescapedPipe(prevOutLineText)
    ) {
      const protCells = cellCount(prevOutLineText);
      const delimCells = cellCount(rawLine);
      if (protCells !== null && delimCells !== null && protCells === delimCells) {
        replacement = escapeFirstUnescapedPipe(lineText);
      }
    }
    prevOutLineText = lineText;
    return replacement;
  };

  /**
   * Append to the protected output and classify each completed line.
   * [rawOverride] is the source text the emission replaces (defaults to
   * the emitted string itself); null marks the line as raw-uncertain
   * (a construct swallowed newlines into one token). Any emit whose string
   * contains '\n' MUST use the default override so the raw buffer stays
   * line-aligned.
   */
  const emit = (s: string, rawOverride?: string | null): void => {
    if (inline) {
      // Inline-only mode: plain append, no block bookkeeping at all.
      out += s;
      return;
    }
    out += s;
    if (rawOverride === undefined || rawOverride !== null) {
      rawBuf += rawOverride === undefined ? s : (rawOverride as string);
    } else {
      lineUncertain = true;
    }
    let rel = s.indexOf('\n');
    while (rel !== -1) {
      const nlPos = out.length - s.length + rel;
      const outLine = out.slice(outLineStart, nlPos);
      const rawSlice = lineUncertain
        ? null
        : rawBuf.slice(rawLineStart, rawBuf.length - s.length + rel);
      const rawLine = rawSlice === null ? null : rawSlice.replace(/\r$/, '');
      const replacement = handleLine(outLine, rawLine);
      if (replacement !== null) {
        // Fake-table illusion breaker rewrote this line in place; later
        // positions are recomputed from the new length below.
        out = out.slice(0, outLineStart) + replacement + out.slice(nlPos);
      }
      const suffix = s.length - rel - 1;
      outLineStart = out.length - suffix;
      rawLineStart = rawBuf.length - suffix;
      lineUncertain = false;
      rel = s.indexOf('\n', rel + 1);
    }
  };

  const mathToken = (): string => `MMATHMDPH${salt}${math.length}MMM`;
  const codeToken = (): string => `MCODEPH${salt}${code.length}MMM`;
  const lineStart = (p: number): boolean => p === 0 || source[p - 1] === '\n';
  const endOfLine = (p: number): number => {
    const idx = source.indexOf('\n', p);
    return idx === -1 ? n : idx;
  };

  /** Number of backslashes immediately before position j. */
  const backslashRun = (j: number): number => {
    let k = 0;
    while (j - 1 - k >= 0 && source[j - 1 - k] === '\\') k++;
    return k;
  };

  /**
   * Find `closer` starting at or after `start`, honoring backslash escapes
   * (odd backslash-run before a candidate invalidates it). Returns the index
   * of the closer's first char, or -1.
   *
   * In table-row mode, an unescaped pipe or the row's line end is a hard
   * cell boundary (GFM splits rows before inline parsing): the scan stops
   * there so cross-cell delimiters stay literal fragments.
   */
  const scanCloser = (
    start: number,
    closer: string,
  ): number => {
    for (let j = start; j < n; j++) {
      if (rowPipeMode && (source[j] === '\n' || (source[j] === '|' && backslashRun(j) % 2 === 0))) {
        return -1;
      }
      if (!source.startsWith(closer, j)) continue;
      if (backslashRun(j) % 2 === 1) continue;
      return j;
    }
    return -1;
  };
  // Worst case is O(n x openers) (every opener scans to EOF when unclosed).
  // Acceptable: real documents escape literal $ per the strict rule, so
  // unclosed openers are rare; revisit with a closer-candidate index only
  // if a pathological document ever shows a measurable render stall.

  const pushMath = (p: number, openLen: number, closeIdx: number, closeLen: number, display: boolean): number => {
    const token = mathToken();
    const raw = source.slice(p, closeIdx + closeLen);
    math.push({
      token,
      kind: 'math',
      display,
      tex: source.slice(p + openLen, closeIdx),
      raw,
    });
    // Raw bookkeeping: a single-line segment keeps its raw; a multi-line
    // one makes the emitted line raw-uncertain.
    emit(token, raw.includes('\n') ? null : raw);
    return closeIdx + closeLen;
  };

  /** Math openers, longest-first. Returns new index, or -1 if no opener here. */
  const tryMath = (p: number): number => {
    const two = source.substring(p, p + 2);
    if (two === '$$') {
      const c = scanCloser(p + 2, '$$');
      return c === -1 ? skipOne(p) : pushMath(p, 2, c, 2, true);
    }
    if (two === '\\[') {
      const c = scanCloser(p + 2, '\\]');
      return c === -1 ? skipOne(p) : pushMath(p, 2, c, 2, true);
    }
    if (two === '\\(') {
      const c = scanCloser(p + 2, '\\)');
      return c === -1 ? skipOne(p) : pushMath(p, 2, c, 2, false);
    }
    if (source[p] === '$') {
      const nx = source[p + 1];
      // opener: next char must exist and not be '$' (which would mean $$)
      if (nx === undefined || nx === '$') return skipOne(p);
      const c = scanCloser(p + 1, '$');
      if (c === -1 || c === p + 1) return skipOne(p);
      return pushMath(p, 1, c, 1, false);
    }
    return -1;
  };

  /** Emit one literal char (used when a math opener has no closer). */
  const skipOne = (p: number): number => {
    emit(source[p]);
    return p + 1;
  };

  /** Fenced code block (``` or ~~~). Returns new index or -1. */
  const tryFence = (p: number): number => {
    if (!lineStart(p)) return -1;
    const eol = endOfLine(p);
    const line = source.slice(p, eol);
    // JS `.` does not match \r — match shapes on a CR-stripped copy but
    // EMIT the original line (the \r belongs to the output text).
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(
      line.endsWith('\r') ? line.slice(0, -1) : line,
    );
    if (!m) return -1;
    // CommonMark: a BACKTICK fence's info string may not contain a
    // backtick — "```bad`info" is a paragraph, not a fence.
    if (m[1][0] === '`' && m[2].includes('`')) return -1;
    const fch = m[1][0];
    const flen = m[1].length;
    const closeRe = new RegExp(`^ {0,3}[${fch === '\`' ? '\`' : '~'}]{${flen},}\\s*$`);

    let q = eol < n ? eol + 1 : n;
    const bodyStart = q;
    let bodyEnd = n;
    let closeIdx = -1;
    let closeEol = -1;
    while (q < n) {
      const qeol = endOfLine(q);
      if (closeRe.test(source.slice(q, qeol))) {
        bodyEnd = q;
        closeIdx = q;
        closeEol = qeol;
        break;
      }
      q = qeol + 1;
    }

    const token = codeToken();
    const rawBody = source.slice(bodyStart, bodyEnd);
    code.push({ token, kind: 'code', construct: 'fence', raw: rawBody, body: rawBody });
    emit(line);
    // Terminate the opener line even at EOF without a trailing newline —
    // otherwise the token glues onto the fence marker and markdown-it
    // parses it as an info string instead of fence content.
    emit('\n');
    emit(token, null); // interior lines have no single raw line
    if (closeIdx >= 0) emit('\n' + source.slice(closeIdx, closeEol));
    // A consumed fence (closed or EOF-unclosed) re-opens nothing; a
    // column-0 fence provably exits a possible list.
    ctx.onFenceClosed(/^ {0,3}/.exec(line)![0].length === 0);
    if (closeIdx === -1) return n;
    return closeEol; // trailing \n (if any) handled by main loop
  };

  /**
   * Single-level, same-prefix blockquote fence (M2): every opener/body/
   * closer line must carry the exact prefix captured from the opener. A
   * nested or heterogeneous prefix never guesses — the construct stays
   * unextracted (documented residual). An unclosed fence ends at a provable
   * container exit (first blank or non-quote line), mirroring markdown-it.
   */
  const tryQuoteFence = (p: number): number => {
    if (!lineStart(p)) return -1;
    const eol = endOfLine(p);
    const line = source.slice(p, eol);
    // Match on a CR-stripped copy (JS `.` excludes \r); emit the original.
    const m = /^( {0,3}> ?)[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(
      line.endsWith('\r') ? line.slice(0, -1) : line,
    );
    if (!m) return -1;
    // Same CommonMark rule inside the quote: backtick fence info may not
    // contain a backtick — the line is quote paragraph text, not a fence.
    if (m[2][0] === '`' && m[3].includes('`')) return -1;
    const prefix = m[1];
    const fch = m[2][0];
    const flen = m[2].length;
    const closeRe = new RegExp(`^[ \\t]{0,3}[${fch === '\`' ? '\`' : '~'}]{${flen},}[ \\t]*$`);

    let q = eol < n ? eol + 1 : n;
    const bodyLines: string[] = [];
    let closeIdx = -1;
    let closeEol = -1;
    while (q < n) {
      const qeol = endOfLine(q);
      const l = source.slice(q, qeol);
      if (l.startsWith(prefix)) {
        const rest = l.slice(prefix.length);
        if (closeRe.test(rest)) {
          closeIdx = q;
          closeEol = qeol;
          break;
        }
        bodyLines.push(rest);
        q = qeol + 1;
        continue;
      }
      // Blank or marker-less lines end the container — the fence ends here
      // (unclosed). Any other quote-prefixed line is a hetero/nested shape:
      // do not guess.
      if (/^ {0,3}>/.test(l)) return -1;
      break;
    }
    // An unclosed construct with no body has nothing to protect — and a
    // trailing closer-looking line after a fallback must not spawn a
    // spurious empty fence.
    if (closeIdx === -1 && bodyLines.length === 0) return -1;

    const token = codeToken();
    const rawBody = bodyLines.join('\n');
    code.push({ token, kind: 'code', construct: 'fence', raw: rawBody, body: rawBody });
    // Token lines carry the original prefix so markdown-it still sees a
    // fence inside the blockquote. The emitted closer line classifies as
    // fenceClosed (blockcontext); an unclosed fence must still terminate
    // its token line so the container-exit line starts fresh.
    emit(line);
    // Terminate the opener line even at EOF without a trailing newline (the
    // token must not glue onto the fence marker).
    emit('\n');
    emit(prefix + token, null);
    if (closeIdx >= 0) {
      emit('\n' + source.slice(closeIdx, closeEol));
      return closeEol;
    }
    emit('\n');
    return q; // resume at the container-exit line
  };

  /**
   * linkrefs Pass 2 (definitions): at a line start where Pass 1 collected a
   * definition candidate AND the block context allows one (no open
   * paragraph — definitions never interrupt paragraphs — and no active
   * table body), consume the WHOLE candidate extent and rewrite it as a
   * single token-shaped definition line. markdown-it consumes that line as
   * a definition, so its tokens never reach the output; references carry
   * variant tokens that normalize identically (see linkrefs.ts).
   *
   * Runs BEFORE tryIndented so a pending-destination continuation line
   * indented 4+ spaces is never mistaken for indented code (the N9 bug:
   * "[a]:\n    /url\n    $x$" used to swallow the whole tail).
   */
  const tryLinkDef = (p: number): number => {
    if (linkIndex === null) return -1;
    if (!lineStart(p)) return -1;
    const ci = linkIndex.byStart.get(p);
    if (ci === undefined) return -1;
    if (ctx.paragraphOpen || ctx.tableActive) return -1;
    const cand = linkIndex.candidates[ci];
    if (cand.extentEnd <= p) return -1;
    // Variant-token base: the FIRST candidate of this normalized label, so
    // every occurrence of the label — regardless of raw contents — folds
    // to the same normalized token.
    const base = linkIndex.byLabel.get(normalizeReference(cand.labelRaw));
    if (base === undefined) return -1;
    const lt = labelToken(salt, base, occurrence++);
    labels.push({ token: lt, kind: 'label', raw: cand.labelRaw });
    const d0 = litToken(salt, lits.length);
    lits.push({
      token: d0,
      kind: 'literal',
      raw: cand.destRaw,
      role: 'dest',
      content: cand.destContent,
    });
    let emitted = `[${lt}]: ${d0}`;
    if (cand.titleRaw !== null) {
      const t0 = litToken(salt, lits.length);
      lits.push({
        token: t0,
        kind: 'literal',
        raw: cand.titleRaw,
        role: 'title',
        content: cand.titleContent ?? '',
      });
      emitted += ` "${t0}"`;
    }
    emit(emitted, null); // classified as linkDef via the token-line regex
    return cand.extentEnd;
  };

  /**
   * linkrefs Pass 2 (references): a bracketed label whose normalization
   * matches a collected definition is replaced by its variant token, so
   * markdown-it resolves the reference against the tokenized definition
   * while the restore pass can re-render the exact raw label per
   * occurrence (visible text via renderInlineFragment, attributes as
   * esc(raw)). Inline links ("[t](/u)") always win over references and are
   * left to normal scanning; a full reference's SECOND label is matched on
   * its own bracket when the scanner reaches it.
   */
  const tryReference = (p: number): number => {
    if (linkIndex === null) return -1;
    if (source[p] !== '[') return -1;
    if (backslashRun(p) % 2 === 1) return -1; // escaped \[
    // Find the label end: first unescaped ']', crossing non-blank
    // continuation lines; in table-row mode a pipe or line end is a hard
    // cell boundary — references never pair across cells.
    let j = p + 1;
    while (j < n) {
      const c = source[j];
      if (c === '\\' && j + 1 < n) {
        j += 2;
        continue;
      }
      if (c === '[') return -1; // labels do not nest
      if (c === ']') break;
      if (c === '\n') {
        if (rowPipeMode) return -1;
        const eol = endOfLine(j + 1);
        if (stripCR(source.slice(j + 1, eol)).trim() === '') return -1;
        j++;
        continue;
      }
      if (rowPipeMode && c === '|' && backslashRun(j) % 2 === 0) return -1;
      j++;
    }
    if (j >= n) return -1;
    const labelRaw = source.slice(p + 1, j);
    if (labelRaw.length < 1 || labelRaw.length > 1000) return -1;
    if (labelRaw.trim() === '') return -1;
    const after = j + 1;
    const next = source[after];
    if (next === '(') return -1; // inline link: link text scans normally
    if (next === '[') {
      // Full reference "[text][label]" — leave the text to normal
      // scanning; the second label matches on its own bracket. Collapsed
      // "[text][]" uses the TEXT as the label and must be handled here.
      let k = after + 1;
      if (k < n && source[k] === ']') {
        const base = linkIndex.byLabel.get(normalizeReference(labelRaw));
        if (base === undefined) return -1;
        const lt = labelToken(salt, base, occurrence++);
        labels.push({ token: lt, kind: 'label', raw: labelRaw });
        emit(`[${lt}][]`);
        return k + 1;
      }
      return -1;
    }
    // Shortcut reference "[label]".
    const base = linkIndex.byLabel.get(normalizeReference(labelRaw));
    if (base === undefined) return -1;
    const lt = labelToken(salt, base, occurrence++);
    labels.push({ token: lt, kind: 'label', raw: labelRaw });
    emit(`[${lt}]`);
    return after;
  };

  /**
   * Indented code block (>=4 spaces or a tab at line start), gated by the
   * lightweight block context: it may not interrupt a paragraph, follow a
   * possible list, or follow ambiguous containers (M1). Emits a single
   * normalized 4-space-indented placeholder line so markdown-it still
   * renders a <pre><code> block.
   */
  const tryIndented = (p: number): number => {
    if (!lineStart(p)) return -1;
    const eol = endOfLine(p);
    const line = source.slice(p, eol);
    if (!/^( {4}|\t)/.test(line)) return -1;
    // A whitespace-only line is BLANK (CommonMark), never the first line of
    // an indented code block: native markdown-it starts the block at the
    // next content line. (Internal blank lines are kept by the loop below.)
    if (line.trim() === '') return -1;
    // M1: the block context decides (the old "previous emitted line is
    // blank or placeholder-shaped" heuristic both missed standard code
    // after headings/setext/hrs/tables and produced false positives inside
    // paragraphs and list items).
    if (!ctx.allowIndented()) return -1;

    const lines: string[] = [];
    let q = p;
    let endedAtEof = false;
    for (;;) {
      const qeol = endOfLine(q);
      const l = source.slice(q, qeol);
      if (/^( {4}|\t)/.test(l)) {
        lines.push(l);
        if (qeol >= n) { q = n; endedAtEof = true; break; }
        q = qeol + 1;
        continue;
      }
      if (l.trim() === '') {
        const nq = qeol + 1;
        if (nq < n) {
          const neol = endOfLine(nq);
          if (/^( {4}|\t)/.test(source.slice(nq, neol))) {
            lines.push(l);
            q = nq;
            continue;
          }
        }
        break;
      }
      break;
    }

    const token = codeToken();
    const rawBody = lines.join('\n');
    code.push({
      token,
      kind: 'code',
      construct: 'indented',
      raw: rawBody,
      // Restore content: the scanner strips the 4-space/tab markers exactly
      // like the old restore pass did (kept here so restore is data-driven).
      body: rawBody.replace(/^ {4}/gm, '').replace(/^\t/gm, ''),
    });
    emit('    ' + token, null); // multi-line raw collapsed into one token line
    if (!endedAtEof) emit('\n');
    return q;
  };

  /**
   * Inline code span (backtick run with matching run of equal length).
   *
   * H3/L1 semantics: when no equal-length closer exists before a block
   * boundary (blank line or a real fence line), the ENTIRE opener run is
   * emitted as a dead string and scanning resumes after it — the scanner
   * never retries a shorter "opener" inside the run, which is what used to
   * turn `x ``a` y` into a fake span around `a`.
   */
  const tryCodeSpan = (p: number): number => {
    if (source[p] !== '`') return -1;
    // An escaped opener (\`) is not a code span in CommonMark.
    if (backslashRun(p) % 2 === 1) return -1;
    let k = 1;
    while (p + k < n && source[p + k] === '`') k++;
    // Leaf-block context of the opener (L1 full): boundary shapes are
    // checked after the same quote prefix when the opener lives inside a
    // SINGLE-level blockquote paragraph; nested (>>) openers and lines
    // without the prefix are handled conservatively instead.
    let ls = p;
    while (ls > 0 && source[ls - 1] !== '\n') ls--;
    const openerLineText = source.slice(ls, endOfLine(ls));
    const qm = /^( {0,3}> ?)/.exec(openerLineText);
    const quoted = qm !== null && openerLineText[qm[1].length] !== '>';
    const qprefix = qm ? qm[1] : '';
    // Boundary lines start strictly after the first real newline following
    // the opener — the opener's own line can never self-match (```a```).
    let guardPos = source.indexOf('\n', p + k);
    guardPos = guardPos === -1 ? n : guardPos + 1;
    const boundaryBefore = (to: number): boolean => {
      // `<= to`: when the closer run sits at a LINE START (guardPos === to),
      // the closer's own line must be boundary-tested — a line-start run of
      // 3+ backticks IS a fence marker that interrupts the paragraph, so
      // `para ```x\n```\n$y$` must not form a span swallowing the fence.
      // Mid-line closers already had their (start-anchored) line tested.
      while (guardPos <= to) {
        const eolIdx = endOfLine(guardPos);
        if (isSpanBoundaryLine(source.slice(guardPos, eolIdx), quoted, qprefix)) return true;
        if (eolIdx >= n) break;
        guardPos = eolIdx + 1;
      }
      return false;
    };
    let q = p + k;
    for (;;) {
      const idx = source.indexOf('`', q);
      if (idx === -1) break;
      let k2 = 1;
      while (idx + k2 < n && source[idx + k2] === '`') k2++;
      if (boundaryBefore(idx)) break;
      // Table-row mode: an unescaped pipe or the row's line end between
      // opener and closer crosses a cell boundary (GFM splits rows before
      // inline parsing) — the run is a dead string, its fragments literal.
      if (rowPipeMode) {
        let cellBoundary = false;
        for (let j = p + k; j < idx && !cellBoundary; j++) {
          cellBoundary = source[j] === '\n' || (source[j] === '|' && backslashRun(j) % 2 === 0);
        }
        if (cellBoundary) break;
      }
      if (k2 === k) {
        const token = codeToken();
        const raw = source.slice(p, idx + k2);
        code.push({
          token,
          kind: 'code',
          construct: 'span',
          raw,
          body: source.slice(p + k, idx),
        });
        emit(token, raw.includes('\n') ? null : raw);
        return idx + k2;
      }
      q = idx + k2;
    }
    // Dead string: the whole opener run stays literal (cmark 4.7), and no
    // position inside the run is retried as a shorter opener.
    emit(source.slice(p, p + k));
    return p + k;
  };

  let i = 0;
  while (i < n) {
    // Table-row mode is re-decided at every line start (and stays constant
    // within a line): pipes are structural there, cell-local constructs
    // protect normally, cross-cell pairing is refused. Plain paragraphs
    // are unaffected — pipes pair freely outside table rows.
    if (lineStart(i)) rowPipeMode = inline ? false : computeRowMode(i);
    let ni = inline ? -1 : tryFence(i);
    if (ni >= 0) { i = ni; continue; }
    ni = inline ? -1 : tryQuoteFence(i);
    if (ni >= 0) { i = ni; continue; }
    // Definitions (and pending destinations) BEFORE indented code, so a
    // 4-space continuation line of a definition is never code (N9).
    ni = inline ? -1 : tryLinkDef(i);
    if (ni >= 0) { i = ni; continue; }
    ni = inline ? -1 : tryIndented(i);
    if (ni >= 0) { i = ni; continue; }
    ni = tryCodeSpan(i);
    if (ni >= 0) { i = ni; continue; }
    ni = inline ? -1 : tryReference(i);
    if (ni >= 0) { i = ni; continue; }
    ni = tryMath(i);
    if (ni >= 0) { i = ni; continue; }
    // stepped-over escapes: \$ \\ \` stay literal for the markdown parser;
    // without the \` case an escaped backtick would open a fake code span
    // (the backslash gets emitted, then the bare ` matches as opener).
    if (source[i] === '\\' && (source[i + 1] === '$' || source[i + 1] === '\\' || source[i + 1] === '`')) {
      emit(source.substring(i, i + 2));
      i += 2;
      continue;
    }
    emit(source[i]);
    i++;
  }

  // Flush the final logical line when the source does NOT end with a
  // newline: its classification — and the fake-table illusion breaker —
  // must run even without a trailing LF (a dangling `| --- | --- |` at EOF
  // would otherwise let markdown-it build a table the raw layout denies).
  // No newline is appended; out keeps the source's exact ending.
  // (Skipped in inline-only mode: no block classification exists there.)
  if (!inline && outLineStart < out.length) {
    const outLine = out.slice(outLineStart);
    const rawSlice = lineUncertain ? null : rawBuf.slice(rawLineStart);
    const rawLine = rawSlice === null ? null : rawSlice.replace(/\r$/, '');
    const replacement = handleLine(outLine, rawLine);
    if (replacement !== null) {
      out = out.slice(0, outLineStart) + replacement;
    }
  }

  return { text: out, math, code, labels, lits };
}
