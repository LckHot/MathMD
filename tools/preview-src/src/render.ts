/**
 * MathMD preview render pipeline.
 *
 *   source → protectMath() → markdown-it → restore code → KaTeX-restore math → HTML
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
} from './delimiters';
// MIT, https://github.com/tats-u/markdown-cjk-friendly — CommonMark's
// right-flanking rules reject `)**汉字` as a closing emphasis delimiter
// (the char after the closer is a LETTER in Unicode), silently breaking
// bold/italic in CJK prose. The plugin amends the emphasis rules for CJK;
// bundled into the pipeline below, no standalone artifact.
import cjkFriendly from 'markdown-it-cjk-friendly';

export { protectMath } from './delimiters';
export type { Protection, MathSegment, CodeSegment } from './delimiters';

export interface RenderOptions {
  /** Placeholder salt; must match /^[A-Z0-9]{1,8}$/. Change per render if the
   *  document itself contains MathMD placeholder-shaped text. */
  salt?: string;
  /** Passed to KaTeX (default false: bad formulas render red, not throw). */
  throwOnError?: boolean;
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
  const md = v.markdownit({ html: false, linkify: true });
  md.use(cjkFriendly);
  let html = md.render(prot.text);

  // ---- restore code constructs verbatim ----
  // Fence/indented tokens sit INSIDE markdown-it's <pre><code>, so they are
  // restored as plain escaped text (re-wrapping would nest <code> tags);
  // indented-block lines keep their original 4-space/tab marker, which
  // markdown-it stripped from the token line only — strip it per line here.
  // Inline-span tokens sit bare in a paragraph and get wrapped in <code>.
  html = html.replace(new RegExp(CODE_TOKEN_SOURCE, 'g'), (tok) => {
    const seg = prot.code.find((s) => s.token === tok);
    if (!seg) return tok; // salt-mismatched literal token-shaped text: keep verbatim
    if (seg.raw.startsWith('`')) {
      const m = /^(`+)([\s\S]*?)\1/.exec(seg.raw);
      let body = m ? m[2] : seg.raw;
      // CommonMark: strip one leading+trailing space if both present
      if (body.startsWith(' ') && body.endsWith(' ') && body.length >= 2) {
        body = body.slice(1, -1);
      }
      return `<code>${esc(body)}</code>`;
    }
    const isIndented = /^ {4}|^\t/.test(seg.raw);
    const body = isIndented
      ? seg.raw.replace(/^ {4}/gm, '').replace(/^\t/gm, '')
      : seg.raw;
    return esc(body);
  });

  // ---- restore math through KaTeX ----
  html = html.replace(new RegExp(MATH_TOKEN_SOURCE, 'g'), (tok) => {
    const seg = prot.math.find((s) => s.token === tok);
    if (!seg) return tok;
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

  return { html, mathCount: prot.math.length, errors };
}

// Self-register for the WebView and the node test harness.
(globalThis as unknown as Record<string, unknown>).MathMD = {
  renderMarkdown,
  protectMath,
};
