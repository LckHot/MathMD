/**
 * MathMD preview host bridge.
 *
 * The Android side pushes documents via `MathMD.hostUpdate(markdown, opts)`.
 * Failures are rendered INTO the page (fail-visible, never a silent black
 * screen); the Kotlin bridge logs the error string returned by its wrapped
 * call.
 */

import { renderMarkdown } from './render';

export interface HostOptions {
  /** 'system' resolves via prefers-color-scheme at apply time. */
  theme?: 'system' | 'light' | 'dark';
  /** CSS font-family for preview text ('' = bundle default stack). */
  fontFamily?: string;
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
  // NOTE: the page/line width is NOT handled here. It is baked into the
  // layout viewport by the boot script in preview.html (before first
  // layout), so text wraps once at the configured column and pinch-zoom
  // only scales. Changing the setting reloads the page.
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
  // Tables: a wide table's min-content width would stretch the whole page
  // past the locked viewport (breaking the "no global horizontal panning"
  // guarantee at minimum zoom). Wrap top-level tables in a scroll container
  // so they clip to the page width and scroll under the finger, like
  // over-wide formulas. (innerHTML is replaced every render, so tables are
  // always fresh children of root; nested ones are left alone.)
  for (const table of Array.from(root.querySelectorAll(':scope > table'))) {
    const wrap = document.createElement('div');
    wrap.className = 'table-scroll';
    root.insertBefore(wrap, table);
    wrap.appendChild(table);
  }
}

/**
 * Collision-proof placeholder salt: a fresh random [A-Z0-9] salt per render
 * makes it impossible for literal token-shaped text in the user's document
 * (e.g. "MMATHMDPHK70MMM") to collide with this render's real placeholders —
 * such literals then survive verbatim through the restore pass.
 */
function randomSalt(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/**
 * In-document search for the preview (owner feature). STATELESS: the caller
 * (Kotlin) owns the cursor; this paints all matches with the CSS Custom
 * Highlight API (Chromium >= 105; zero DOM mutation, so KaTeX layout never
 * re-flows), the active match in its own color, clamps `active` into range,
 * and scrolls it into view through every nested scroll container (formulas
 * and tables scroll internally). Fallback on engines without the API:
 * native selection of the active match only (counting is a pure text walk
 * and always works). `.katex-mathml` is skipped: it duplicates every
 * formula's text invisibly and would double-count.
 */
export interface FindResult {
  total: number;
  active: number;
}

function textNodesUnder(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      let p = node.parentElement;
      while (p && p !== root) {
        const cn = p.className;
        if (
          (typeof cn === 'string' && cn.includes('katex-mathml')) ||
          p.tagName === 'SCRIPT' ||
          p.tagName === 'STYLE'
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        p = p.parentElement;
      }
      return node.nodeValue && node.nodeValue.length
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const out: Text[] = [];
  while (walker.nextNode()) out.push(walker.currentNode as Text);
  return out;
}

function clearFind(): void {
  const g = globalThis as {
    CSS?: { highlights?: Map<string, unknown> };
  };
  if (g.CSS?.highlights) {
    g.CSS.highlights.delete('mathmd-find');
    g.CSS.highlights.delete('mathmd-find-active');
  } else {
    const sel = window.getSelection?.();
    sel?.removeAllRanges();
  }
}

function paint(ranges: Range[], active: number): void {
  const g = globalThis as {
    CSS?: { highlights?: Map<string, unknown> };
    Highlight?: new (...nodes: (Range | Node)[]) => unknown;
  };
  if (g.CSS?.highlights && g.Highlight) {
    const others = ranges.filter((_, i) => i !== active);
    g.CSS.highlights.set('mathmd-find', new g.Highlight(...others));
    if (ranges[active]) g.CSS.highlights.set('mathmd-find-active', new g.Highlight(ranges[active]));
    else g.CSS.highlights.delete('mathmd-find-active');
    return;
  }
  const sel = window.getSelection?.();
  sel?.removeAllRanges();
  if (ranges[active]) sel?.addRange(ranges[active]);
}

/** Scroll `range` into view through ALL nested scrollers via a marker. */
function scrollToRange(range: Range): void {
  const marker = document.createElement('span');
  marker.style.cssText = 'display:inline;width:0;height:0';
  const r = range.cloneRange();
  r.collapse(true);
  r.insertNode(marker);
  marker.scrollIntoView({ block: 'center', inline: 'center' });
  marker.remove();
}

export function find(query: string, active: number): FindResult {
  const target = document.getElementById('preview');
  if (!target || !query || typeof document.createTreeWalker !== 'function') {
    clearFind();
    return { total: 0, active: -1 };
  }
  const q = query.toLowerCase();
  const ranges: Range[] = [];
  for (const node of textNodesUnder(target)) {
    const data = (node.nodeValue ?? '').toLowerCase();
    let i = data.indexOf(q);
    while (i !== -1) {
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + q.length);
      ranges.push(r);
      i = data.indexOf(q, i + q.length);
    }
  }
  if (ranges.length === 0) {
    clearFind();
    return { total: 0, active: -1 };
  }
  const idx = active >= 0 && active < ranges.length ? active : 0;
  paint(ranges, idx);
  scrollToRange(ranges[idx]);
  return { total: ranges.length, active: idx };
}

export function hostUpdate(markdown: string, opts?: HostOptions): void {
  const target = document.getElementById('preview');
  if (!target) return;
  try {
    if (opts) applyHostOptions(opts);
    // innerHTML replacement orphans old match ranges/highlights.
    clearFind();
    const result = renderMarkdown(markdown, { salt: randomSalt() });
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
bridge.MathMD = { ...(bridge.MathMD as object | undefined ?? {}), hostUpdate, find };

// Initial state so the pane is never a mystery: show an explicit empty note
// until the first document arrives.
document.addEventListener('DOMContentLoaded', () => {
  const target = document.getElementById('preview');
  if (target && target.childElementCount === 0) {
    target.innerHTML = '<p><em>Waiting for document…</em></p>';
  }
});
