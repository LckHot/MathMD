/**
 * Lightweight incremental block-context tracker (M1/M2).
 *
 * The math-protection scanner feeds this the PROTECTED lines it emits —
 * placeholder tokens in place of math/code — because that is exactly the
 * text markdown-it will parse downstream. Structure decisions made here
 * therefore mirror the parser's own view of the document.
 *
 * It answers one gating question — "may a 4-space-indented line start an
 * indented code block here?" — and tracks the paragraph/list/table state
 * needed to answer it conservatively:
 *
 *  - An indented code block can never interrupt a paragraph, so a line
 *    inside an open paragraph is never code (fixes `` `s`\n    *em* ``).
 *  - List content indents cannot be told apart from top-level indents
 *    without a full container model, so while a list is POSSIBLE
 *    (`possibleList`) indented lines are never extracted. That
 *    deliberately leaks real code inside lists ("known residual") but can
 *    never hide paragraph math like `- formula:\n\n    $x$` inside a fake
 *    code block.
 *  - After blocks that legitimately allow following indented code
 *    (ATX/setext headings, thematic breaks, closed fences, indented code,
 *    valid GFM tables, blanks, document start) extraction is allowed.
 *
 * This is NOT a CommonMark parser: anything ambiguous (containers, lazy
 * continuations, list content) classifies conservatively toward "this is
 * paragraph text", because a missed code block only leaks math rendering
 * while a false one hides it.
 */

import { listFamilyOf } from './linkrefs';

export type BlockKind =
  | 'start'
  | 'blank'
  | 'paragraph'
  | 'atx'
  | 'hr'
  | 'setext'
  | 'fenceClosed'
  | 'indentedCode'
  | 'table'
  | 'linkDef'
  | 'other';

const ATX_RE = /^#{1,6}(?:[ \t]+|$)/;
const SETEXT_EQ_RE = /^=+[ \t]*$/;
const SETEXT_DASH_RE = /^-+[ \t]*$/;
const HR_RE = /^([-*_])([ \t]*\1){2,}[ \t]*$/;
const LIST_RE = /^([-+*]|\d{1,9}[.)])(?:[ \t]+|$)/;
const FENCE_RE = /^(`{3,}|~{3,})/;
const HR_DASH_RE = /^-{3,}[ \t]*$/;
// NOTE: there is deliberately NO second linkdef grammar here. Real
// definitions are consumed and rewritten whole by the scanner's tryLinkDef
// (linkrefs Pass 1 + Pass 2); definition-shaped text the prepass did NOT
// rewrite (rejected candidates, fragment mode) is paragraph text natively
// and must classify as such — an extra pending/destination/title state
// machine here used to steal the setext/list priority from lines like
// "[a]:\n-" and let math be tokenized into what markdown-it makes code.

function countTrailingBackslashes(s: string): number {
  let k = 0;
  while (k < s.length && s[s.length - 1 - k] === '\\') k++;
  return k;
}

/** Split on `|` characters not preceded by an odd backslash run. */
export function splitUnescapedPipes(s: string): string[] {
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '|' && countTrailingBackslashes(cur) % 2 === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/**
 * Cells of a pipe-table line (outer pipes removed), or null when the line
 * contains no unescaped pipe at all.
 */
function tableCells(line: string): string[] | null {
  if (!line.includes('|')) return null;
  let cells = splitUnescapedPipes(line);
  if (cells.length > 1 && cells[0].trim() === '') cells = cells.slice(1);
  if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells = cells.slice(0, -1);
  return cells;
}

/**
 * GFM delimiter-row shape: at least one unescaped pipe and every cell
 * `:?-+:?`. Callers must check list-marker shape FIRST (`- | -` is a list
 * item that merely looks like a delimiter row).
 */
export function isTableDelimiter(t: string): boolean {
  const cells = tableCells(t);
  if (!cells) return false;
  return cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

/** Header candidate matches the delimiter row: both have pipes, counts equal. */
export function headerMatchesDelimiter(header: string, delim: string): boolean {
  const h = tableCells(header);
  const d = tableCells(delim);
  if (!h || !d) return false;
  return h.length === d.length;
}

/**
 * A raw line is a table DELIMITER row candidate: 0..3 indent, not a list
 * marker (list beats table, e.g. `- | - | -`), and every cell `:?-+:?`
 * with at least one unescaped pipe.
 */
export function delimiterRowShape(delimiter: string): boolean {
  const dsp = /^ */.exec(delimiter)![0].length;
  if (dsp > 3) return false;
  const dt = delimiter.slice(dsp);
  if (LIST_RE.test(dt)) return false;
  return isTableDelimiter(dt);
}

/**
 * Full RAW validation of a table: header candidate line + following
 * delimiter line. This is the SINGLE source of truth shared by
 * BlockContext.classifyLine and the scanner's table-row mode decision, so
 * the two can never drift: a header candidate that fails here is an
 * ordinary paragraph, and its cross-pipe math/code must pair normally.
 *
 * Conditions: both lines indented 0..3; delimiter row shape (see
 * [delimiterRowShape]); equal unescaped-pipe column counts.
 */
export function isValidRawTable(header: string, delimiter: string): boolean {
  const hsp = /^ */.exec(header)![0].length;
  if (hsp > 3) return false;
  if (!delimiterRowShape(delimiter)) return false;
  const dsp = /^ */.exec(delimiter)![0].length;
  return headerMatchesDelimiter(header.slice(hsp), delimiter.slice(dsp));
}

/**
 * Block-list state as it was BEFORE a line was classified. Captured once
 * per line at the top of [BlockContext.classifyLine] and shared with the
 * scanner's row-mode decision, so the header classification and the
 * delimiter classification can never evaluate two different snapshots
 * (the "logic drift" class of bugs).
 */
export interface TableSnapshot {
  readonly possibleList: boolean;
  readonly listBlankSeen: boolean;
  readonly possibleListFamily: string | null;
}

/**
 * SINGLE shared predicate deciding whether a raw header line followed by a
 * raw delimiter line forms a GFM table, given the list state captured
 * BEFORE the header line was classified. Used by BOTH
 * BlockContext.classifyLine (at the delimiter line, with the snapshot
 * saved while classifying the header) and the scanner's computeRowMode
 * (at the header line, with the pre-line snapshot) — never two logics.
 *
 * Suppression rules (each mirrors the vendored markdown-it oracle):
 *  - [isValidRawTable] must hold (delimiters, indents, equal raw columns);
 *  - inside a possible list WITHOUT a blank since: a plain column-0 header
 *    is a lazy list continuation → suppressed; a same-FAMILY list-marker
 *    header continues the list → suppressed; a different-family marker
 *    (other bullet char, bullet↔ordered, '.'↔')') interrupts → allowed;
 *  - after a blank inside a possible list: a plain column-0 header provably
 *    exited the list → allowed (marker headers keep the family rules).
 */
export function tableHeaderEligible(
  headerRaw: string,
  delimiterRaw: string,
  snap: TableSnapshot,
): boolean {
  if (!isValidRawTable(headerRaw, delimiterRaw)) return false;
  if (!snap.possibleList) return true;
  const hf = listFamilyOf(headerRaw);
  const headerCol0 = !/^[ \t]/.test(headerRaw);
  const headerBlockShaped =
    /^ {0,3}(`{3,}|~{3,})/.test(headerRaw) ||
    /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(headerRaw) ||
    /^ {0,3}>/.test(headerRaw) ||
    /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/.test(headerRaw) ||
    /^ {0,3}(=+|-+)[ \t]*$/.test(headerRaw);
  const headerIsPlainCol0 = headerCol0 && hf === null && !headerBlockShaped;
  const suppressed =
    !(snap.listBlankSeen && headerIsPlainCol0) &&
    !(hf !== null && hf !== snap.possibleListFamily);
  return !suppressed;
}

export class BlockContext {
  lastBlock: BlockKind = 'start';
  paragraphOpen = false;
  /** A list marker was seen and no provable container exit since. */
  possibleList = false;
  /** A blank line was seen inside the possible-list span. */
  listBlankSeen = false;
  /** Inside the body of a recognized GFM table. */
  tableActive = false;
  /**
   * Marker family ('-', '+', '*', '.', ')') of the most recent list marker
   * while a list is possible; null outside list context. List-continuation
   * semantics for table headers depend on the FAMILY (a different-family
   * marker interrupts the list; the same family continues it).
   */
  possibleListFamily: string | null = null;
  /**
   * List state captured before the PREVIOUS classified line — i.e. before
   * the header line, when the line being classified is a delimiter row.
   */
  private snapBeforePrevLine: TableSnapshot | null = null;
  private prevLine: string | null = null;
  /**
   * The RAW source line corresponding to [prevLine], or null when that line
   * swallowed a multi-line construct (its raw shape is not a single source
   * line) or was blank. Table COLUMN counting uses the raw line: GFM splits
   * header/delimiter rows on unescaped pipes BEFORE inline parsing, so a
   * pipe inside a code span still separates cells even though the span was
   * tokenized (M1 issue: protected-only counting dropped columns).
   */
  private prevRawLine: string | null = null;
  private codePlaceholderRe: RegExp;
  /** The scanner's REWRITTEN single-line definition (token-shaped). */
  private linkDefTokenRe: RegExp;

  constructor(salt: string) {
    // Only the scanner's own indented placeholder lines match; a literal
    // token-shaped line in the document carries a different salt.
    this.codePlaceholderRe = new RegExp(`^ {4}MCODEPH${salt}[0-9]+MMM$`);
    // The scanner's REWRITTEN single-line definition (token-shaped).
    this.linkDefTokenRe = new RegExp(
      `^\\[MLABELPH${salt}[0-9]+[aA]{32}MMM\\]:[ \\t]+MLITPH${salt}[0-9]+MLM` +
        `(?:[ \\t]+"MLITPH${salt}[0-9]+MLM")?[ \\t]*$`,
    );
  }

  /** May an indented line starting here open an indented code block? */
  allowIndented(): boolean {
    if (this.paragraphOpen || this.possibleList) return false;
    switch (this.lastBlock) {
      case 'start':
      case 'blank':
      case 'atx':
      case 'hr':
      case 'setext':
      case 'fenceClosed':
      case 'indentedCode':
      case 'table':
      case 'linkDef':
        return true;
      default:
        return false;
    }
  }

  /**
   * A fenced block (top-level or single-level quote) was consumed whole by
   * the scanner. `col0` tells whether a column-0 opener provably exited a
   * possible list.
   */
  onFenceClosed(col0: boolean): void {
    this.lastBlock = 'fenceClosed';
    this.paragraphOpen = false;
    this.tableActive = false;
    if (col0) this.clearList();
  }

  /** Current list state, for the scanner's pre-header row-mode decision. */
  snapshot(): TableSnapshot {
    return {
      possibleList: this.possibleList,
      listBlankSeen: this.listBlankSeen,
      possibleListFamily: this.possibleListFamily,
    };
  }

  private clearList(): void {
    this.possibleList = false;
    this.listBlankSeen = false;
    this.possibleListFamily = null;
  }

  /**
   * Classify one emitted (protected) physical line. [rawSourceLine] is the
   * corresponding raw source line (null when unavailable) — used for table
   * column counting. Returns the resulting block kind; 'table' means this
   * line was accepted as a table delimiter/body row.
   */
  classifyLine(rawProtectedLine: string, rawSourceLine: string | null = null): BlockKind {
    const line = rawProtectedLine.endsWith('\r') ? rawProtectedLine.slice(0, -1) : rawProtectedLine;
    // Snapshot discipline (single source of truth): capture the list state
    // BEFORE this line mutates anything; the table branch below reads the
    // snapshot of the PREVIOUS line (the header) via tableHeaderEligible.
    const snapBeforeThisLine = this.snapshot();
    const snapBeforeHeader = this.snapBeforePrevLine ?? snapBeforeThisLine;
    this.snapBeforePrevLine = snapBeforeThisLine;
    // A CommonMark blank line may contain any amount of spaces/tabs —
    // `# h\n   \n    $x$` is heading + blank + indented code, not a
    // paragraph continuation.
    if (line.trim() === '') {
      this.lastBlock = 'blank';
      this.paragraphOpen = false;
      this.tableActive = false;
      if (this.possibleList) this.listBlankSeen = true;
      this.prevLine = line;
      this.prevRawLine = null;
      return 'blank';
    }
    // The scanner's own indented-code placeholder line (afterCode).
    if (this.codePlaceholderRe.test(line)) {
      this.lastBlock = 'indentedCode';
      this.paragraphOpen = false;
      this.tableActive = false;
      this.prevLine = line;
      this.prevRawLine = rawSourceLine;
      return 'indentedCode';
    }
    const sp = /^ */.exec(line)![0].length;
    const indent = sp;
    const t = line.slice(sp);

    if (indent <= 3 && FENCE_RE.test(t)) {
      // Emitted fence opener/closer lines (raw ones are consumed by
      // tryFence before ever reaching classification).
      this.lastBlock = 'fenceClosed';
      this.paragraphOpen = false;
      this.tableActive = false;
      if (indent === 0) this.clearList();
      this.prevLine = line;
      this.prevRawLine = rawSourceLine;
      return 'fenceClosed';
    }
    if (indent <= 3 && ATX_RE.test(t)) {
      this.lastBlock = 'atx';
      this.paragraphOpen = false;
      this.tableActive = false;
      if (indent === 0) this.clearList();
      this.prevLine = line;
      this.prevRawLine = rawSourceLine;
      return 'atx';
    }
    if (indent <= 3 && SETEXT_EQ_RE.test(t)) {
      if (this.paragraphOpen && !this.possibleList) {
        this.lastBlock = 'setext';
        this.paragraphOpen = false;
        this.tableActive = false;
        this.prevLine = line;
        this.prevRawLine = rawSourceLine;
        return 'setext';
      }
      // '=' with no open paragraph: ordinary paragraph text — do not guess.
      this.textLine(line, rawSourceLine);
      return 'paragraph';
    }
    if (indent <= 3 && SETEXT_DASH_RE.test(t)) {
      if (this.paragraphOpen && !this.possibleList) {
        // Valid setext underline: closes the heading's paragraph.
        this.lastBlock = 'setext';
        this.paragraphOpen = false;
        this.tableActive = false;
        this.prevLine = line;
        this.prevRawLine = rawSourceLine;
        return 'setext';
      }
      if (!this.paragraphOpen && HR_DASH_RE.test(t)) {
        // Thematic break — a dash run of 3 or more with no open paragraph.
        // ('--' is plain text and a single '-' is a list marker; both fall
        // through to their own branches below.)
        this.lastBlock = 'hr';
        this.tableActive = false;
        if (indent === 0) this.clearList();
        this.prevLine = line;
        this.prevRawLine = rawSourceLine;
        return 'hr';
      }
      // '--' in any context, or '-' (list marker) with an open paragraph:
      // fall through — the list-marker branch and plain text await below.
    }
    if (indent <= 3 && HR_RE.test(t)) {
      // '*'/'_' runs (and '-' runs already handled above): thematic break.
      this.lastBlock = 'hr';
      this.paragraphOpen = false;
      this.tableActive = false;
      if (indent === 0) this.clearList();
      this.prevLine = line;
      this.prevRawLine = rawSourceLine;
      return 'hr';
    }
    // List marker BEFORE table shape: `- | -` is a list item that merely
    // looks like a table delimiter row.
    if (indent <= 3 && LIST_RE.test(t)) {
      this.possibleList = true;
      this.possibleListFamily = listFamilyOf(line);
      this.paragraphOpen = true;
      this.tableActive = false;
      this.lastBlock = 'other';
      this.prevLine = line;
      this.prevRawLine = rawSourceLine;
      return 'other';
    }
    if (indent <= 3 && t.startsWith('>')) {
      // A quote line carrying only a bare fence run is a fence closer (the
      // scanner's quote-fence construct emits exactly this shape): after a
      // closed fence, markdown-it exits the quote on the next marker-less
      // line, so a following indented line IS top-level indented code.
      if (/^>[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.test(t)) {
        this.lastBlock = 'fenceClosed';
        this.paragraphOpen = false;
        this.tableActive = false;
        this.prevLine = line;
        this.prevRawLine = rawSourceLine;
        return 'fenceClosed';
      }
      // Quote paragraph: conservative — an indented follower may be a
      // lazy continuation, so never allow extraction after quote lines.
      this.lastBlock = 'other';
      this.paragraphOpen = true;
      this.tableActive = false;
      this.prevLine = line;
      this.prevRawLine = rawSourceLine;
      return 'other';
    }
    // Link reference definitions (leaf blocks): markdown-it consumes them
    // OUTSIDE any paragraph, so the block closes and a following indented
    // line is code — our gate must match or math tokens land in that code.
    // Recognized: complete single-line defs, `[label]:` + bare destination
    // on the next line, and one title continuation line. Anything less
    // shaped (multi-word "destinations", trailing junk) leaves the def
    // invalid and the lines stay paragraph text, matching the native parse.
    if (indent <= 3 && !this.paragraphOpen && !this.tableActive &&
        this.linkDefTokenRe.test(t)) {
      // The scanner consumed and rewrote a whole definition into this
      // single token line (linkrefs Pass 2); it closes the block like any
      // consumed definition. Definition-shaped text that was NOT rewritten
      // (rejected candidates, fragment mode) falls through to textLine —
      // exactly the native paragraph treatment.
      this.markLinkDef(line, rawSourceLine, indent);
      return 'linkDef';
    }
    if (
      indent <= 3 &&
      this.prevLine !== null &&
      this.prevRawLine !== null &&
      rawSourceLine !== null &&
      delimiterRowShape(rawSourceLine) &&
      tableHeaderEligible(this.prevRawLine, rawSourceLine, snapBeforeHeader)
    ) {
      // Valid GFM table via the SHARED tableHeaderEligible predicate (see
      // blockcontext docs): the snapshot is the one captured before the
      // HEADER line was classified — the exact state the scanner's
      // computeRowMode saw at the header line. List-shaped headers are
      // still headers natively; family rules live in the predicate.
      this.lastBlock = 'table';
      this.tableActive = true;
      this.paragraphOpen = false;
      this.clearList();
      this.prevLine = line;
      this.prevRawLine = rawSourceLine;
      return 'table';
    }
    if (this.tableActive) {
      // Plain non-blank line: a table body row. (Indented lines were
      // already offered to tryIndented at line start; when extracted they
      // classify as indentedCode above. markdown-it likewise ends a table
      // at an indented-code line.)
      this.lastBlock = 'table';
      this.paragraphOpen = false;
      this.prevLine = line;
      this.prevRawLine = rawSourceLine;
      return 'table';
    }
    this.textLine(line, rawSourceLine);
    return this.lastBlock;
  }

  private markLinkDef(line: string, rawSourceLine: string | null, indent: number): void {
    this.lastBlock = 'linkDef';
    this.paragraphOpen = false;
    this.tableActive = false;
    if (indent === 0) this.clearList();
    this.prevLine = line;
    this.prevRawLine = rawSourceLine;
  }

  private textLine(line: string, rawSourceLine: string | null): void {
    this.paragraphOpen = true;
    this.lastBlock = 'paragraph';
    // Provably outside a possible list: a blank line was seen and this is a
    // plain column-0 line (not a marker, not indented item content).
    if (
      this.possibleList &&
      this.listBlankSeen &&
      !line.startsWith(' ') &&
      !line.startsWith('\t')
    ) {
      this.clearList();
    }
    this.prevLine = line;
    this.prevRawLine = rawSourceLine;
  }
}
