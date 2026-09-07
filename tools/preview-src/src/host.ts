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
 * In-document search for the preview (owner feature). The caller (Kotlin)
 * owns the cursor (active index); this paints all matches with the CSS
 * Custom Highlight API (Chromium >= 105; zero DOM mutation, so KaTeX
 * layout never re-flows), the active match in its own color, clamps
 * `active` into range, and scrolls it into view through every nested
 * scroll container (formulas and tables scroll internally). Fallback on
 * engines without the API: native selection of the active match only
 * (counting is a pure text walk and always works). `.katex-mathml` is
 * skipped: it duplicates every formula's text invisibly and would
 * double-count. Matching state is cached per document (see below);
 * hostUpdate invalidates it.
 *
 * CONTRACT with the editor pane (kept in SearchBar.kt's SearchSpec doc):
 * this searches RENDERED text, one Text node at a time — phrases spanning
 * element boundaries never match — while the editor searches the flat
 * markdown source; totals can legitimately differ. `active` is CLAMPED,
 * never wrapped.
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
  paintedRanges = null;
}

/**
 * Per-document search index. Measured on the owner's real document (3.5k
 * text nodes, desktop Chromium): the per-call TreeWalker with its per-node
 * ancestor climb was ~6ms of a ~6.5ms warm find — i.e. tens of ms PER
 * KEYSTROKE on a phone, the visible jump lag. Nodes and their LOWERCASED
 * text are cached once per rendered document, so a keystroke degenerates
 * to a pure string scan (like the Kotlin editor side), and a step (same
 * query) reuses the previous ranges wholesale. hostUpdate replaces
 * innerHTML, so it must invalidate the index.
 */
let findNodes: Text[] | null = null;
let findData: string[] = [];
let findNodesRoot: HTMLElement | null = null;
let findQuery: string | null = null;
let findRanges: Range[] = [];
let paintedRanges: Range[] | null = null;

function invalidateFindIndex(): void {
  findNodes = null;
  findData = [];
  findNodesRoot = null;
  findQuery = null;
  findRanges = [];
  paintedRanges = null;
}

function paint(ranges: Range[], active: number): void {
  const g = globalThis as {
    CSS?: { highlights?: Map<string, unknown> };
    Highlight?: new (...nodes: (Range | Node)[]) => unknown;
  };
  if (g.CSS?.highlights && g.Highlight) {
    // ALL matches live in one highlight; the active match overlays it in
    // its own color. Registry insertion order is fixed on first paint
    // (mathmd-find before mathmd-find-active) and Map.set preserves it,
    // so the active style always paints on top. When only `active` moved
    // (stepping), the big highlight is left untouched — one 1-range
    // update instead of rebuilding hundreds of ranges.
    if (paintedRanges !== ranges) {
      g.CSS.highlights.set('mathmd-find', new g.Highlight(...ranges));
      paintedRanges = ranges;
    }
    if (ranges[active]) g.CSS.highlights.set('mathmd-find-active', new g.Highlight(ranges[active]));
    else g.CSS.highlights.delete('mathmd-find-active');
    return;
  }
  const sel = window.getSelection?.();
  sel?.removeAllRanges();
  if (ranges[active]) sel?.addRange(ranges[active]);
}

/**
 * Scroll `range` into view WITHOUT mutating the DOM. The old marker-span
 * trick dirtied the tree twice per jump (insert + remove), and each
 * mutation forced a full style/layout pass over the KaTeX-heavy page —
 * that was the visible jump lag while stepping/typing. getBoundingClientRect
 * forces layout only when the tree is already dirty, and highlight painting
 * (CSS Custom Highlight) never dirties it, so repeat jumps cost ~nothing.
 */
function scrollToRange(range: Range): void {
  // Center the match inside any nested overflow-x scroller that clips it
  // (wide formulas, .table-scroll) — window.scrollTo alone can't reach
  // content hidden inside a nested scroller.
  let el: Element | null =
    range.startContainer.nodeType === 1
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  while (el !== null && el !== document.body) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const er = el.getBoundingClientRect();
      const r = range.getBoundingClientRect();
      if (r.left < er.left || r.right > er.right) {
        el.scrollLeft += r.left - er.left - (el.clientWidth - r.width) / 2;
      }
    }
    el = el.parentElement;
  }
  const rect = range.getBoundingClientRect();
  const top = window.scrollY + rect.top - (window.innerHeight - rect.height) / 2;
  const left = window.scrollX + rect.left - (window.innerWidth - rect.width) / 2;
  window.scrollTo(Math.max(0, left), Math.max(0, top)); // instant (no CSS smooth)
}

export function find(query: string, active: number): FindResult {
  const target = document.getElementById('preview');
  if (!target || !query || typeof document.createTreeWalker !== 'function') {
    clearFind();
    return { total: 0, active: -1 };
  }
  // Build the per-document index once; reuse it across keystrokes/steps.
  if (findNodesRoot !== target || findNodes === null) {
    findNodes = textNodesUnder(target);
    findData = findNodes.map((n) => (n.nodeValue ?? '').toLowerCase());
    findNodesRoot = target;
    findQuery = null;
    findRanges = [];
  }
  const nodes = findNodes;
  const q = query.toLowerCase();
  if (findQuery !== q) {
    const ranges: Range[] = [];
    for (let k = 0; k < nodes.length; k++) {
      const data = findData[k];
      let i = data.indexOf(q);
      while (i !== -1) {
        const r = document.createRange();
        r.setStart(nodes[k], i);
        r.setEnd(nodes[k], i + q.length);
        ranges.push(r);
        i = data.indexOf(q, i + q.length);
      }
    }
    findQuery = q;
    findRanges = ranges;
  }
  const ranges = findRanges;
  if (ranges.length === 0) {
    clearFind();
    return { total: 0, active: -1 };
  }
  // CLAMP (shared contract with the editor pane): out-of-range indexes pin
  // to the nearest valid hit; the Kotlin side does the same via coerceIn.
  const idx = active < 0 ? 0 : Math.min(active, ranges.length - 1);
  paint(ranges, idx);
  scrollToRange(ranges[idx]);
  return { total: ranges.length, active: idx };
}

export function hostUpdate(markdown: string, opts?: HostOptions): void {
  const target = document.getElementById('preview');
  if (!target) return;
  try {
    if (opts) applyHostOptions(opts);
    // innerHTML replacement orphans old match ranges/highlights AND every
    // cached text node — drop the search index with the highlights.
    clearFind();
    invalidateFindIndex();
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
