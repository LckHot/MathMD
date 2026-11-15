/**
 * MathMD preview render pipeline.
 *
 *   source → protectMath() → tsv-table conversion → markdown-it
 *         → restore code → KaTeX-restore math → HTML
 *
 * This module is bundled by esbuild into an IIFE and loaded in the preview
 * WebView after the vendored markdown-it and KaTeX scripts. It registers
 * `globalThis.MathMD.renderMarkdown`.
 *
 * Self-written code is TypeScript; markdown-it and KaTeX are vendored
 * third-party prebuilt artifacts and are never modified.
 */

import {
  protectMath,
  MATH_TOKEN_SOURCE,
  CODE_TOKEN_SOURCE,
  LABEL_TOKEN_SOURCE,
  LIT_TOKEN_SOURCE,
  type Protection,
} from './delimiters';
import { normalizeReference, unescapeContent } from './linkrefs';
import { convertTsvTables } from './tsvtables';
// MIT, https://github.com/tats-u/markdown-cjk-friendly — CommonMark's
// right-flanking rules reject `)**汉字` as a closing emphasis delimiter
// (the char after the closer is a LETTER in Unicode), silently breaking
// bold/italic in CJK prose. The plugin amends the emphasis rules for CJK;
// bundled into the pipeline below, no standalone artifact.
import cjkFriendly from 'markdown-it-cjk-friendly';

export { protectMath } from './delimiters';
export { normalizeReference } from './linkrefs';
export type { Protection, MathSegment, CodeSegment } from './delimiters';
export type { LabelSegment, LiteralSegment } from './linkrefs';

export interface RenderOptions {
  /** Placeholder salt; must match /^[A-Z0-9]{1,8}$/. Change per render if the
   *  document itself contains MathMD placeholder-shaped text. */
  salt?: string;
  /** Passed to KaTeX (default false: bad formulas render red, not throw). */
  throwOnError?: boolean;
  /** ChatGPT-style TSV block → table conversion (default true).
   *  App plumbing: Settings dialog -> previewOptionsJson -> hostUpdate. */
  tsvTables?: boolean;
  /** Minimum consecutive TSV lines that form a table (default 3, floor 2). */
  tsvMinRows?: number;
  /** Minimum cells (tab-separated) per line (default 2, floor 2). */
  tsvMinCols?: number;
}

export interface MathError {
  readonly tex: string;
  readonly message: string;
}

export interface RenderResult {
  readonly html: string;
  /** Number of math segments rendered (all four delimiter styles). */
  readonly mathCount: number;
  readonly errors: readonly MathError[];
}

interface MarkdownItLike {
  render: (src: string) => string;
  renderInline: (src: string) => string;
  normalizeLink: (url: string) => string;
  use: (plugin: unknown, ...params: unknown[]) => MarkdownItLike;
}

interface VendorGlobals {
  markdownit?: (opts?: Record<string, unknown>) => MarkdownItLike;
  katex?: {
    renderToString: (tex: string, opts?: Record<string, unknown>) => string;
  };
}

function vendor(): VendorGlobals {
  return globalThis as unknown as VendorGlobals;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderMarkdown(source: string, opts: RenderOptions = {}): RenderResult {
  const v = vendor();
  if (typeof v.markdownit !== 'function' || typeof v.katex?.renderToString !== 'function') {
    throw new Error('MathMD.renderMarkdown requires the markdownit and katex vendor globals');
  }
  const salt = opts.salt ?? 'K7';
  const errors: MathError[] = [];

  const prot = protectMath(source, salt);
  // ChatGPT-style tab-separated blocks become GFM pipe tables BEFORE the
  // parser sees them (and AFTER protection: the text here carries math/code
  // placeholders, so cell splitting can never touch a formula or code).
  // Thresholds come from the app's Settings dialog; clamping lives in
  // convertTsvTables.
  const mdSource = (opts.tsvTables ?? true)
    ? convertTsvTables(prot.text, { minRows: opts.tsvMinRows, minCols: opts.tsvMinCols })
    : prot.text;
  const md = v.markdownit({ html: false, linkify: true });
  md.use(cjkFriendly);
  let html = md.render(mdSource);

  // A placeholder can land inside an HTML attribute (link destination, image
  // alt/title). Restoring KaTeX or <code> markup there would break the tag.
  // markdown-it has already escaped literal '<'/'>' in attribute values, so
  // the nearest bracket pair reliably distinguishes tags from text nodes.
  const insideTag = (offset: number): boolean =>
    html.lastIndexOf('<', offset) > html.lastIndexOf('>', offset);

  // ---- token -> segment maps (one lookup per placeholder) ----
  const codeByToken = new Map(prot.code.map((s) => [s.token, s] as const));
  const mathByToken = new Map(prot.math.map((s) => [s.token, s] as const));
  const labelByToken = new Map(prot.labels.map((s) => [s.token, s] as const));
  const litByToken = new Map(prot.lits.map((s) => [s.token, s] as const));

  // ---- visible-label fragment renderer (linkrefs) ----
  // A reference's raw label (e.g. "a$x$") must render as inline HTML with
  // its math/code intact when it is the link's VISIBLE text. The fragment
  // is protected with a salt that cannot collide with the fragment's OWN
  // literal text (any generated-token shape with that salt), the outer
  // render's salt, or the outer token shapes — chosen per label, never
  // fixed. Rendered with md.renderInline (never a block render), with the
  // linkdef/reference prepass DISABLED so a label can never recurse.
  const fragMd = v.markdownit({ html: false, linkify: true });
  fragMd.use(cjkFriendly);
  const SALT_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const saltCandidate = (idx: number, len: number): string => {
    let c = '';
    for (let pos = len - 1; pos >= 0; pos--) {
      c = SALT_ALPHABET[idx % 36] + c;
      idx = Math.floor(idx / 36);
    }
    return c;
  };
  /**
   * Collision-free inner salt for ANY raw string re-protected in isolation
   * (visible label fragments, linkdef destination/title inner content).
   * DETERMINISTIC, EXPANDING enumeration over the full [A-Z0-9] salt space
   * (lengths 2..8): every candidate is checked against the four token
   * prefixes embedded in this raw text, and the outer render's salt is
   * always skipped. Work is bounded by the raw text itself — each rejected
   * candidate consumes >= 12+len chars of one token shape, so the scan
   * for a given length visits at most (number of embedded shapes + 1)
   * candidates before succeeding or escalating. Exhausting ALL lengths up
   * to 8 requires a raw text of well over 10^12 token-shaped characters;
   * genuine exhaustion can only end in a safe error, never a known
   * collision (16k-char adversarial inputs render fine — the enumeration
   * simply escalates to length 3+).
   */
  const pickFragSalt = (raw: string): string => {
    const collides = (cand: string): boolean =>
      raw.includes('MMATHMDPH' + cand) || raw.includes('MCODEPH' + cand) ||
      raw.includes('MLABELPH' + cand) || raw.includes('MLITPH' + cand);
    for (let len = 2; len <= 8; len++) {
      const count = Math.pow(36, len);
      for (let idx = 0; idx < count; idx++) {
        const cand = saltCandidate(idx, len);
        if (cand === salt) continue; // never the outer salt itself
        if (collides(cand)) continue; // literal token-shaped text in this raw
        return cand;
      }
    }
    throw new Error('MathMD: no collision-free inner salt exists');
  };
  const renderLabelFragment = (raw: string): { html: string; mathCount: number } => {
    const fragSalt = pickFragSalt(raw);
    const fp = protectMath(raw, fragSalt, { inlineOnly: true });
    const fCode = new Map(fp.code.map((s) => [s.token, s] as const));
    const fMath = new Map(fp.math.map((s) => [s.token, s] as const));
    let fh = fragMd.renderInline(fp.text);
    const fInsideTag = (offset: number): boolean =>
      fh.lastIndexOf('<', offset) > fh.lastIndexOf('>', offset);
    fh = fh.replace(new RegExp(CODE_TOKEN_SOURCE, 'g'), (tok: string, offset: number) => {
      const seg = fCode.get(tok);
      if (!seg) return tok;
      if (fInsideTag(offset)) return esc(seg.raw);
      if (seg.construct === 'span') {
        let body = seg.body.replace(/\r\n?|\n/g, ' ');
        if (body.startsWith(' ') && body.endsWith(' ') && /[^ ]/.test(body)) {
          body = body.slice(1, -1);
        }
        return `<code>${esc(body)}</code>`;
      }
      return esc(seg.body);
    });
    let fragMathCount = 0;
    fh = fh.replace(new RegExp(MATH_TOKEN_SOURCE, 'g'), (tok: string, offset: number) => {
      const seg = fMath.get(tok);
      if (!seg) return tok;
      if (fInsideTag(offset)) return esc(seg.raw);
      fragMathCount++;
      try {
        return v.katex!.renderToString(seg.tex, {
          displayMode: seg.display,
          throwOnError: opts.throwOnError ?? false,
          strict: false,
          trust: false,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({ tex: seg.tex, message });
        return `<span class="math-error">${esc(seg.tex)}</span>`;
      }
    });
    return { html: fh, mathCount: fragMathCount };
  };

  /**
   * Restore one linkdef attribute value (destination or title) from its
   * RAW inner content. The inner text is re-protected with a
   * collision-free inner salt (noLinkRefs): COMPLETE math spans and code
   * spans become alphanumeric tokens — the fragments the product contract
   * keeps verbatim (e.g. href "/\(x\)/foo", TeX backslashes and all).
   * The remaining plain text gets a full CommonMark unescape (tokens have
   * no backslashes, so they are immune), giving native semantics for lone
   * escapes (`\(` -> `(`, `%5C(` untouched). Titles then restore tokens
   * to their raw spans; destinations first run the VENDORED normalizeLink
   * over the token-carrying string (tokens are [A-Z0-9] and provably
   * survive it) and restore the raw spans after — so a `$$a b$$` keeps
   * its literal space while everything else percent-encodes natively.
   * Attribute restores never touch mathCount or errors.
   */
  const restoreAttributeContent = (role: 'dest' | 'title', content: string): string => {
    const innerSalt = pickFragSalt(content);
    const ip = protectMath(content, innerSalt, { inlineOnly: true });
    const innerByToken = new Map<string, string>();
    for (const seg of ip.math) innerByToken.set(seg.token, seg.raw);
    for (const seg of ip.code) innerByToken.set(seg.token, seg.raw);
    const restoreTokens = (text: string): string =>
      text.replace(
        new RegExp(`${MATH_TOKEN_SOURCE}|${CODE_TOKEN_SOURCE}`, 'g'),
        (tok: string) => {
          const raw = innerByToken.get(tok);
          return raw !== undefined ? raw : tok;
        },
      );
    // Native attribute semantics normalize CRLF and lone CR to LF in
    // link titles (and any destination text). inlineOnly protection has
    // already replaced complete math/code spans with newline-free
    // alphanumeric tokens, so normalizing here touches ONLY the plain
    // text; the raw spans restored afterwards keep their literal bytes
    // (the established math/code literal contract).
    const lineNormalized = ip.text.replace(/\r\n?/g, '\n');
    const unescaped = unescapeContent(lineNormalized);
    return restoreTokens(role === 'title' ? unescaped : md.normalizeLink(unescaped));
  };

  // mathCount counts VISIBLE formulas (restore-time): ordinary text KaTeX
  // and math-error output, plus the sub-results of visible label
  // fragments. Attribute-position restores, linkdef literals, and labels
  // consumed by the parser (definitions, full-reference second labels)
  // render nothing and are not counted.
  let visibleMath = 0;

  // ---- joint single-pass token restore ----
  // ONE replace over the ORIGINAL parser HTML with an alternation of all
  // four token families. String.replace never rescans replacement text,
  // so a restored destination literal (or a fully restored label
  // fragment) can never be re-matched by a later family — the structural
  // end of cross-pass collisions like a math token restored inside an
  // href that a literal had just inserted. insideTag() offsets refer to
  // the original HTML. Token namespaces are disjoint by prefix, so at
  // most one map ever hits; unknown tokens are salt-mismatched literals
  // and stay verbatim.
  const ANY_TOKEN_RE = new RegExp(
    `${MATH_TOKEN_SOURCE}|${CODE_TOKEN_SOURCE}|${LABEL_TOKEN_SOURCE}|${LIT_TOKEN_SOURCE}`,
    'g',
  );
  html = html.replace(ANY_TOKEN_RE, (tok: string, offset: number): string => {
    const codeSeg = codeByToken.get(tok);
    if (codeSeg !== undefined) {
      // Code constructs, verbatim. Dispatch on the segment's construct
      // (never sniff the raw text: a fence interior indented 4 spaces —
      // meaningful in Python etc. — would match the indented-block
      // heuristic and lose that indent). Fence/indented tokens sit INSIDE
      // markdown-it's <pre><code>, so they are restored as plain escaped
      // text; inline-span tokens sit bare in a paragraph and get <code>.
      if (insideTag(offset)) return esc(codeSeg.raw);
      if (codeSeg.construct === 'span') {
        // H3: restore from the scanner-recorded body — never re-derive
        // the closer with a lazy regex (a longer backtick run inside the
        // span used to truncate it).
        let body = codeSeg.body.replace(/\r\n?|\n/g, ' ');
        // CommonMark: strip one leading+trailing space only when the body
        // is not entirely spaces; line endings became spaces above.
        if (body.startsWith(' ') && body.endsWith(' ') && /[^ ]/.test(body)) {
          body = body.slice(1, -1);
        }
        return `<code>${esc(body)}</code>`;
      }
      if (codeSeg.construct === 'fence') return esc(codeSeg.raw);
      return esc(codeSeg.body);
    }
    const litSeg = litByToken.get(tok);
    if (litSeg !== undefined) {
      // Linkdef destination/title literals surface only in resolved
      // link/image href/title attributes (the definitions themselves are
      // consumed by the parser). See restoreAttributeContent: complete
      // math/code spans stay RAW (product contract), plain text follows
      // native attribute semantics, `%5C` sequences are never rewritten.
      return esc(restoreAttributeContent(litSeg.role, litSeg.content));
    }
    const labelSeg = labelByToken.get(tok);
    if (labelSeg !== undefined) {
      // Visible occurrences (shortcut/collapsed/full text labels)
      // re-render the raw label as inline HTML with math/code intact —
      // the fragment is fully restored internally and inserted as ONE
      // replacement. Attribute occurrences (image alt) restore esc(raw).
      // Tokens the parser consumed (definitions, full-reference second
      // labels) never appear in the HTML.
      if (insideTag(offset)) return esc(labelSeg.raw);
      const frag = renderLabelFragment(labelSeg.raw);
      visibleMath += frag.mathCount;
      return frag.html;
    }
    const mathSeg = mathByToken.get(tok);
    if (mathSeg !== undefined) {
      if (insideTag(offset)) return esc(mathSeg.raw); // attribute: literal, not counted
      visibleMath++;
      try {
        return v.katex!.renderToString(mathSeg.tex, {
          displayMode: mathSeg.display,
          throwOnError: opts.throwOnError ?? false,
          strict: false,
          trust: false,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({ tex: mathSeg.tex, message });
        return `<span class="math-error">${esc(mathSeg.tex)}</span>`;
      }
    }
    return tok; // salt-mismatched literal token-shaped text: keep verbatim
  });

  return { html, mathCount: visibleMath, errors };
}

// Self-register for the WebView and the node test harness.
(globalThis as unknown as Record<string, unknown>).MathMD = {
  renderMarkdown,
  protectMath,
  normalizeReference,
};
