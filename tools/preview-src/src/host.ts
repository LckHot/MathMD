/**
 * MathMD preview host bridge.
 *
 * The Android side pushes documents via `MathMD.hostUpdate(markdown, opts)`.
 * Failures are rendered INTO the page (fail-visible, never a silent black
 * screen) and are also reported back through `MathMD.hostLog` if present.
 */

import { renderMarkdown } from './render';

export interface HostOptions {
  /** 'system' resolves via prefers-color-scheme at apply time. */
  theme?: 'system' | 'light' | 'dark';
  /** CSS font-family for preview text ('' = bundle default stack). */
  fontFamily?: string;
  /**
   * Content column width in CSS `ch` units (width of '0' in the body font).
   * 0/undefined = fill the viewport (default). Pinch-zoom scales the whole
   * page uniformly; it never re-lays-out content.
   */
  pageWidthCh?: number;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function applyHostOptions(o: HostOptions): void {
  const root = document.documentElement;
  const theme =
    o.theme === 'dark' ? 'dark'
      : o.theme === 'light' ? 'light'
        : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  root.dataset.theme = theme;
  if (typeof o.fontFamily === 'string' && o.fontFamily.length > 0) {
    root.style.setProperty('--preview-font-family', o.fontFamily);
  }
  applyPageWidth(o.pageWidthCh, typeof o.fontFamily === 'string' ? o.fontFamily : '');
}

const DEFAULT_VIEWPORT = 'width=device-width, initial-scale=1';
let lastWidthKey: string | null = null;

/**
 * Fixed content column: set the LAYOUT VIEWPORT to exactly N ch of the
 * preview font (+ the #preview horizontal padding) instead of the device
 * width. The page then lays out once at that width; Android WebView fits it
 * to the screen and pinch-zoom scales the whole page uniformly — it never
 * re-flows text. 0/undefined restores the normal device-width viewport.
 * hostUpdate runs on every keystroke, so the (ch, font) pair is memoized:
 * the probe reflow only happens when the answer could have changed.
 */
function applyPageWidth(ch: number | undefined, fontFamily: string): void {
  const root = document.documentElement;
  if (typeof ch !== 'number' || ch <= 0) {
    root.style.removeProperty?.('--page-width');
    setViewportMeta(DEFAULT_VIEWPORT);
    lastWidthKey = null;
    return;
  }
  root.style.setProperty('--page-width', `${ch}ch`);
  const key = `${ch}|${fontFamily}`;
  if (key === lastWidthKey) return;
  const doc = globalThis.document as Document & {
    createElement?: (tag: string) => HTMLElement;
  };
  const host = (document.getElementById('preview') ?? document.body) as
    | (HTMLElement & { appendChild?: (c: Node) => Node })
    | null;
  if (typeof doc.createElement !== 'function' || !host || typeof host.appendChild !== 'function') {
    return; // node harness stub: CSS var set, viewport untouched
  }
  // Measure 1ch in the preview body font with a zero-width probe inside
  // #preview (inherits its font-family/size); position:absolute keeps it
  // out of flow.
  const probe = doc.createElement('span');
  probe.style.cssText = 'display:block;width:100ch;height:0;overflow:hidden;position:absolute;top:0;left:0';
  host.appendChild(probe);
  const chPx = probe.getBoundingClientRect().width / 100;
  probe.remove();
  if (chPx > 0) {
    // 32px = #preview horizontal padding (16px each side)
    setViewportMeta(`width=${Math.round(ch * chPx) + 32}px`);
    lastWidthKey = key;
  }
}

function setViewportMeta(content: string): void {
  const doc = globalThis.document as Document & {
    querySelector?: (sel: string) => Element | null;
  };
  if (typeof doc.querySelector !== 'function') return; // node harness stub
  const meta = doc.querySelector('meta[name="viewport"]');
  if (meta) meta.setAttribute('content', content);
}

/**
 * Post-render DOM pass, run after every innerHTML update:
 *  1. Move KaTeX `\tag` labels out of the scrolling content box and make
 *     .katex-display a flex row [formula viewport | label] (see the
 *     .tagged rules in preview.css): label pinned to the right end of the
 *     fixed-width line, formula scrolls independently, zero overlap at
 *     scroll end guaranteed by the flex sizing.
 *  2. Detect formulas wider than their scroll viewport and add .wide:
 *     KaTeX centers display content, and centered overflow spills to BOTH
 *     sides — the left spill is unreachable by scrolling (classic
 *     overflow trap). .wide switches those lines to left alignment so all
 *     overflow is reachable.
 * The node test harness passes a stub without querySelector — guard for it.
 */
function postRender(root: HTMLElement): void {
  if (typeof root.querySelectorAll !== 'function') return;
  for (const display of Array.from(root.querySelectorAll('.katex-display'))) {
    const d = display as HTMLElement;
    const tag = d.querySelector('.katex-tag');
    let scroller: HTMLElement = d;
    if (tag) {
      d.classList.add('tagged');
      d.appendChild(tag);
      scroller = (d.querySelector(':scope > .katex') ?? d) as HTMLElement;
    }
    if (scroller.scrollWidth > scroller.clientWidth + 1) {
      d.classList.add('wide');
    }
  }
}

export function hostUpdate(markdown: string, opts?: HostOptions): void {
  const target = document.getElementById('preview');
  if (!target) return;
  try {
    if (opts) applyHostOptions(opts);
    const result = renderMarkdown(markdown);
    target.innerHTML = result.html;
    postRender(target);
    if (result.errors.length > 0) {
      const bad = result.errors.map((e) => `${e.message}`).join('\n');
      console.warn(`MathMD: ${result.errors.length} formula(s) failed: ${bad}`);
    }
  } catch (e) {
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    target.innerHTML =
      `<pre class="math-error">preview render failed\n${escapeHtml(message)}</pre>`;
    console.error('MathMD hostUpdate failed:', message);
  }
}

// Bridge registration (Kotlin calls these via evaluateJavascript).
const bridge = globalThis as unknown as Record<string, unknown>;
bridge.MathMD = { ...(bridge.MathMD as object | undefined ?? {}), hostUpdate };

// Initial state so the pane is never a mystery: show an explicit empty note
// until the first document arrives.
document.addEventListener('DOMContentLoaded', () => {
  const target = document.getElementById('preview');
  if (target && target.childElementCount === 0) {
    target.innerHTML = '<p><em>Waiting for document…</em></p>';
  }
});
