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
}

export function hostUpdate(markdown: string, opts?: HostOptions): void {
  const target = document.getElementById('preview');
  if (!target) return;
  try {
    if (opts) applyHostOptions(opts);
    const result = renderMarkdown(markdown);
    target.innerHTML = result.html;
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
