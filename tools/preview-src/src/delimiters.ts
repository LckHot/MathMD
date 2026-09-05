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
 * Rules (Pandoc-flavoured):
 *  - Inline `$` opener: unescaped, next char exists, is not whitespace and
 *    not `$`; closer: unescaped (odd backslash-run before it fails) and
 *    previous char not whitespace.
 *  - There is deliberately NO currency special-casing: `$` is a math
 *    delimiter whenever it pairs. Documents mixing literal dollar amounts
 *    with math can mis-pair — foreseeable, accepted (owner call, v1.0).
 *  - `\`` `` ` `` `\$` `\\` are stepped over so the markdown parser handles
 *    them natively and the scanner never opens math on an escaped `$`.
 *  - Fenced code blocks (``` / ~~~), indented code blocks and inline code
 *    spans are extracted verbatim; math inside them is never touched.
 *  - `\[` without a matching `\]` falls back to CommonMark's escaped-bracket
 *    rendering (links keep working).
 *
 * Placeholder tokens contain a caller-supplied salt ([A-Z0-9], 1-8 chars) so
 * literal token-shaped text in user documents cannot collide with real
 * placeholders.
 */

/** A math segment extracted from the source. */
export interface MathSegment {
  readonly token: string;
  readonly kind: 'math';
  /** true = display math ($$..$$ or \[..\]), false = inline. */
  readonly display: boolean;
  /** The TeX source between the delimiters, verbatim. */
  readonly tex: string;
}

/** A code construct (fence / indented block / inline span), verbatim. */
export interface CodeSegment {
  readonly token: string;
  readonly kind: 'code';
  /**
   * For fences: the interior lines. For indented blocks: the indented lines.
   * For inline spans: the full original text including backtick delimiters.
   */
  readonly raw: string;
}

export interface Protection {
  /** Markdown source with math/code replaced by placeholder tokens. */
  readonly text: string;
  readonly math: readonly MathSegment[];
  readonly code: readonly CodeSegment[];
}

/** Global (non-capturing-safe) matchers for placeholder tokens. */
export const MATH_TOKEN_SOURCE = 'MMATHMDPH[A-Z0-9]{1,8}[0-9]+MMM';
export const CODE_TOKEN_SOURCE = 'MCODEPH[A-Z0-9]{1,8}[0-9]+MMM';

const SALT_RE = /^[A-Z0-9]{1,8}$/;

function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

export function protectMath(source: string, salt = 'K7'): Protection {
  if (!SALT_RE.test(salt)) {
    throw new Error(`salt must match ${SALT_RE}, got "${salt}"`);
  }

  const math: MathSegment[] = [];
  const code: CodeSegment[] = [];
  let out = '';
  const n = source.length;

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
   */
  const scanCloser = (
    start: number,
    closer: string,
    requireNonWsBefore: boolean,
  ): number => {
    for (let j = start; j < n; j++) {
      if (!source.startsWith(closer, j)) continue;
      if (backslashRun(j) % 2 === 1) continue;
      if (requireNonWsBefore && j > start && isWhitespace(source[j - 1])) continue;
      return j;
    }
    return -1;
  };

  const pushMath = (p: number, openLen: number, closeIdx: number, closeLen: number, display: boolean): number => {
    const token = mathToken();
    math.push({ token, kind: 'math', display, tex: source.slice(p + openLen, closeIdx) });
    out += token;
    return closeIdx + closeLen;
  };

  /** Math openers, longest-first. Returns new index, or -1 if no opener here. */
  const tryMath = (p: number): number => {
    const two = source.substr(p, 2);
    if (two === '$$') {
      const c = scanCloser(p + 2, '$$', false);
      return c === -1 ? skipOne(p) : pushMath(p, 2, c, 2, true);
    }
    if (two === '\\[') {
      const c = scanCloser(p + 2, '\\]', false);
      return c === -1 ? skipOne(p) : pushMath(p, 2, c, 2, true);
    }
    if (two === '\\(') {
      const c = scanCloser(p + 2, '\\)', false);
      return c === -1 ? skipOne(p) : pushMath(p, 2, c, 2, false);
    }
    if (source[p] === '$') {
      const nx = source[p + 1];
      // opener: next char must exist, not be whitespace, not be '$'
      if (nx === undefined || /\s/.test(nx) || nx === '$') return skipOne(p);
      const c = scanCloser(p + 1, '$', true);
      if (c === -1 || c === p + 1) return skipOne(p);
      return pushMath(p, 1, c, 1, false);
    }
    return -1;
  };

  /** Emit one literal char (used when a math opener has no closer). */
  const skipOne = (p: number): number => {
    out += source[p];
    return p + 1;
  };

  /** Fenced code block (``` or ~~~). Returns new index or -1. */
  const tryFence = (p: number): number => {
    if (!lineStart(p)) return -1;
    const eol = endOfLine(p);
    const line = source.slice(p, eol);
    const m = /^ {0,3}(`{3,}|~{3,}).*$/.exec(line);
    if (!m) return -1;
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
    code.push({ token, kind: 'code', raw: source.slice(bodyStart, bodyEnd) });
    out += line;
    if (eol < n) out += '\n';
    out += token;
    if (closeIdx >= 0) out += '\n' + source.slice(closeIdx, closeEol);
    if (closeIdx === -1) return n;
    return closeEol < n ? closeEol : closeEol; // trailing \n (if any) handled by main loop
  };

  /**
   * Indented code block (>=4 spaces or a tab at line start, only when the
   * preceding line is blank/start-of-doc or directly after another code
   * placeholder — mirrors CommonMark "cannot interrupt a paragraph").
   * Emits a single normalized 4-space-indented placeholder line so
   * markdown-it still renders a <pre><code> block.
   */
  const tryIndented = (p: number): number => {
    if (!lineStart(p)) return -1;
    const eol = endOfLine(p);
    const line = source.slice(p, eol);
    if (!/^( {4}|\t)/.test(line)) return -1;

    const trimmed = out.endsWith('\n') ? out.slice(0, -1) : out;
    const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1);
    const blankBefore = out === '' || lastLine.trim() === '';
    const afterCode = lastLine.startsWith('MCODEPH');
    if (!blankBefore && !afterCode) return -1;

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
    code.push({ token, kind: 'code', raw: lines.join('\n') });
    out += '    ' + token + (endedAtEof ? '' : '\n');
    return q;
  };

  /** Inline code span (backtick run with matching run of equal length). */
  const tryCodeSpan = (p: number): number => {
    if (source[p] !== '`') return -1;
    let k = 1;
    while (p + k < n && source[p + k] === '`') k++;
    let q = p + k;
    for (;;) {
      const idx = source.indexOf('`', q);
      if (idx === -1) return -1;
      let k2 = 1;
      while (idx + k2 < n && source[idx + k2] === '`') k2++;
      if (k2 === k) {
        const token = codeToken();
        code.push({ token, kind: 'code', raw: source.slice(p, idx + k2) });
        out += token;
        return idx + k2;
      }
      q = idx + k2;
    }
  };

  let i = 0;
  while (i < n) {
    let ni = tryFence(i);
    if (ni >= 0) { i = ni; continue; }
    ni = tryIndented(i);
    if (ni >= 0) { i = ni; continue; }
    ni = tryCodeSpan(i);
    if (ni >= 0) { i = ni; continue; }
    ni = tryMath(i);
    if (ni >= 0) { i = ni; continue; }
    // stepped-over escapes: \$ and \\ stay for the markdown parser
    if (source[i] === '\\' && (source[i + 1] === '$' || source[i + 1] === '\\')) {
      out += source.substr(i, 2);
      i += 2;
      continue;
    }
    out += source[i];
    i++;
  }

  return { text: out, math, code };
}
