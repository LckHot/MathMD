#!/usr/bin/env node
/**
 * MathMD preview pipeline test harness (node).
 *
 * Emulates the WebView global environment: vendored markdown-it and KaTeX
 * are evaluated in a clean vm context (no module/exports, so their UMD
 * wrappers attach to the context global exactly like in a browser), then the
 * esbuild-bundled TypeScript pipeline is loaded and exercised.
 *
 * Usage: node tools/mdtest/run.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'app', 'src', 'main', 'assets', 'preview');
const SRC = path.join(ROOT, 'tools', 'preview-src');

// ---- bundle the TypeScript pipeline ----
const bundlePath = '/tmp/mathmd-preview-bundle.js';
const ESBUILD = path.join(SRC, '..', 'node_modules', '.bin', 'esbuild');
execSync(
  `${JSON.stringify(ESBUILD)} ` +
  `${JSON.stringify(path.join(SRC, 'src', 'host.ts'))} ` +
  `--bundle --format=iife --outfile=${JSON.stringify(bundlePath)}`,
  { stdio: 'inherit' },
);

// ---- emulate the WebView global scope ----
// Minimal DOM stub: the bundle registers a DOMContentLoaded hook and looks up
// #preview at render time; tests drive hostUpdate through this stub.
const previewEl = { innerHTML: '', childElementCount: 0 };
const styleProps = {};
const doc = {
  addEventListener() {},
  getElementById: (id) => (id === 'preview' ? previewEl : null),
  documentElement: {
    dataset: {},
    style: {
      setProperty(k, v) { styleProps[k] = v; },
      removeProperty(k) { delete styleProps[k]; },
    },
  },
};
const ctx = { console, setTimeout, clearTimeout, atob, btoa, document: doc, matchMedia: () => ({ matches: false }) };
ctx.window = ctx; // real browsers alias window === globalThis
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ASSETS, 'markdown-it.umd.min.js'), 'utf8'), ctx, { filename: 'markdown-it.umd.min.js' });
vm.runInContext(fs.readFileSync(path.join(ASSETS, 'katex', 'katex.min.js'), 'utf8'), ctx, { filename: 'katex.min.js' });
vm.runInContext(fs.readFileSync(bundlePath, 'utf8'), ctx, { filename: 'bundle.js' });

const { renderMarkdown, protectMath } = ctx.MathMD;

// ---- test battery ----
let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push({ name, detail });
}

const K = 'katex-html'; // KaTeX render output marker
const DISP = 'katex-display';

// 1. All four delimiter styles
{
  const r = renderMarkdown('Inline $a+b$ here.');
  check('inline $..$ renders', r.html.includes(K) && r.mathCount === 1, r.html);
}
{
  const r = renderMarkdown('Block $$a+b$$ here.');
  check('inline $$..$$ renders display', r.html.includes(K) && r.html.includes(DISP) && r.mathCount === 1, r.html);
}
{
  const r = renderMarkdown('Inline \\(a+b\\) here.');
  check('\\(..\\) renders', r.html.includes(K) && r.mathCount === 1, r.html);
}
{
  const r = renderMarkdown('Display \\[\nE=mc^2\n\\] done.');
  check('\\[..\\] renders display', r.html.includes(K) && r.html.includes(DISP) && r.mathCount === 1, r.html);
}
{
  const r = renderMarkdown('$$\n\\bar{\\mu}_{n}\n$$');
  check('fenced-style $$ block', r.html.includes(K) && r.mathCount === 1, r.html);
}

// 2. The upstream-killer cases
{
  const r = renderMarkdown('$\\{x\\}$');
  check('escaped braces preserved', r.html.includes(K) && !r.html.includes('${x}'), r.html);
}
{
  const r = renderMarkdown('where $x_i$ and $y_j$ differ');
  check('two inline formulas in one line', r.mathCount === 2, `count=${r.mathCount} html=${r.html}`);
}
{
  const r = renderMarkdown('$W^{1,p}_0(\\Omega)$ space');
  check('sobolev notation survives markdown', r.mathCount === 1 && r.html.includes(K), r.html);
}
{
  const r = renderMarkdown('a *em* $x^{y}_{z}$ b *em2*');
  check('emphasis around math intact', r.mathCount === 1 && r.html.includes('<em>em</em>') && r.html.includes('<em>em2</em>'), r.html);
}

// 3. $ pairing semantics (post-1.0.1: STRICT rule — every unescaped $ is a
//    math delimiter; no whitespace heuristics. Escape literal $ as \$.)
{
  // The two $ pair and are consumed; the trailing text stays prose.
  const r = renderMarkdown('it costs $100 and $200 total');
  check('first two unescaped $ pair, rest stays prose', r.mathCount === 1 && r.html.includes('200 total'), `count=${r.mathCount} html=${r.html}`);
}
{
  // A single unescaped $ with NO second $ anywhere has no partner -> stays
  // literal (pairing requires a closer; there is no end-of-text closing).
  const r = renderMarkdown('pay $5 now');
  check('lone $ without a second $ stays literal', r.mathCount === 0 && r.html.includes('$5'), `count=${r.mathCount} html=${r.html}`);
}
{
  const r = renderMarkdown('price is $5$ today');
  check('$..$ pairs as math', r.mathCount === 1, `count=${r.mathCount}`);
}
{
  // Owner-verified hazard (CJK): $ glued to CJK chars pairs across arbitrary
  // text — "3，你有" becomes a formula. This is why escaping is mandatory.
  const r = renderMarkdown('我有$3，你有$5。');
  check('CJK-adjacent $ pairs across arbitrary text (mandates escaping)', r.mathCount === 1, `count=${r.mathCount} html=${r.html.slice(0, 140)}`);
}
{
  const r = renderMarkdown('I paid $5 for X and got $3 back');
  check('second $ closes the first pair; remainder prose', r.mathCount === 1 && r.html.includes('3 back'), `count=${r.mathCount} html=${r.html}`);
}

// 4c. CJK emphasis (markdown-it-cjk-friendly): CommonMark rejects )**汉字
//     closers; the plugin must restore bold/italic in CJK prose.
{
  const r = renderMarkdown('经典线索为：Dyer−Edmunds (1970) 的初步结果；**Kim−Kozono (2006)**证明若 $u(x)=o(1/|x|)$ 成立');
  check('CJK: **X (2006)**证明 bolds despite ASCII-paren closer + CJK next',
    r.mathCount === 1 && r.html.includes('<strong>Kim−Kozono (2006)</strong>'), r.html.slice(0, 200));
  const i = renderMarkdown('结果 *重要*这里继续');
  check('CJK: *italic* before CJK char', i.html.includes('<em>重要</em>'), i.html);
}

// 4. Code constructs shield math
{
  const r = renderMarkdown('use `$x_i$` literally');
  check('code span shields math', r.mathCount === 0 && r.html.includes('<code>$x_i$</code>'), r.html);
}
{
  const r = renderMarkdown('```\n$$x$$\n```\nafter');
  check('fence shields math', r.mathCount === 0 && r.html.includes('<pre>') && r.html.includes('$$x$$'), r.html);
}
{
  const r = renderMarkdown('text\n\n    $x_i$ indented\n\nmore');
  check('indented block shields math', r.mathCount === 0 && r.html.includes('<pre>'), r.html);
}

// 4b. Review fixes: escaped backticks, code-restore shape, salt collisions
{
  // #1: \` must NOT open a code span; markdown-it renders it as a literal `
  const r = renderMarkdown('a \\`code\\` b');
  check('escaped backticks stay literal (no fake code span)', !r.html.includes('<code>') && r.html.includes('`code`'), r.html);
}
{
  // #4: fence/indented restores must not nest <code> inside markdown-it's
  // <pre><code>, and the 4-space indent marker must be stripped.
  const fence = renderMarkdown('```\n$$x$$\n```\nafter');
  check('fence restore: no nested <code>', !/<code><code>/.test(fence.html), fence.html);
  const ind = renderMarkdown('text\n\n    $x_i$ indented\n\nmore');
  check('indented restore: no nested <code>', !/<code><code>/.test(ind.html), ind.html);
  check('indented restore: indent marker stripped', ind.html.includes('<pre><code>$x_i$ indented'), ind.html);
}
{
  // #2: literal token-shaped text must survive the app render path
  // (hostUpdate now salts every render randomly; default K7 tokens in the
  // document are not this render's tokens and must pass through verbatim).
  previewEl.innerHTML = '';
  ctx.MathMD.hostUpdate('keep MMATHMDPHK70MMM and $x$ real');
  const html = String(previewEl.innerHTML);
  check('literal token-shaped text survives hostUpdate (random salt)',
    html.includes('MMATHMDPHK70MMM') && html.includes(K), html.slice(0, 200));
}

// 5. Escapes and fallbacks
{
  const r = renderMarkdown('price is \\$5 today');
  check('escaped dollar literal', r.html.includes('$5'), r.html);
}
{
  const r = renderMarkdown('no closing \\[x here');
  check('unmatched \\[ falls back to bracket literal', r.mathCount === 0 && r.html.includes('[x'), r.html);
}
{
  const r = renderMarkdown('[a link](https://example.com) and \\(x\\)');
  check('links still work alongside math', r.html.includes('<a href="https://example.com">') && r.mathCount === 1, r.html);
}

// 6. Errors surface, not crash
{
  const r = renderMarkdown('$\\thisIsNotACommand$');
  check('bad tex -> katex red fallback (no throw)', r.html.includes('#cc0000'), r.html.slice(0, 200));
}
{
  const r = renderMarkdown('$\\thisIsNotACommand$', { throwOnError: true });
  check('bad tex + throwOnError -> error span', r.errors.length === 1 && r.html.includes('math-error'), r.html.slice(0, 200));
}

// 7. Salt collision guard
{
  const literal = 'MMATHMDPHK70MMM';
  const r = renderMarkdown(`keep ${literal} and formula $x$`, { salt: 'ZZ' });
  check('salt bump avoids collision', r.mathCount === 1 && r.html.includes(literal), r.html);
}

// 8. protectMath unit sanity
{
  const p = protectMath('a $x$ b', 'T1');
  check('protectMath token shape', p.math.length === 1 && p.math[0].token === 'MMATHMDPHT10MMM' && p.text === `a ${p.math[0].token} b`, JSON.stringify(p));
}

// 9. hostUpdate bridge end-to-end (this was the missing function in v0.1)
{
  previewEl.innerHTML = '';
  ctx.MathMD.hostUpdate('# Title\\n\\n$x_i$ ok');
  const html = String(previewEl.innerHTML);
  check('hostUpdate renders into #preview', html.includes('Title') && html.includes(K) && !html.includes('Waiting for document'), html.slice(0, 160));
}
{
  previewEl.innerHTML = '';
  // Force a pipeline crash: stub katex to throw (KaTeX itself degrades to red
  // with throwOnError:false, so only a real bug should reach the catch).
  const realKatex = ctx.katex;
  ctx.katex = { renderToString: () => { throw new Error('stubbed engine crash'); } };
  ctx.MathMD.hostUpdate('hi $x$');
  ctx.katex = realKatex;
  // Engine crash is caught at formula level -> visible math-error span in page.
  check('hostUpdate fail-visible on engine crash', String(previewEl.innerHTML).includes('math-error'), String(previewEl.innerHTML).slice(0, 160));
}
{
  previewEl.innerHTML = '';
  ctx.MathMD.hostUpdate('hi $x$', { theme: 'dark' });
  check('hostUpdate applies theme+font opts', doc.documentElement.dataset.theme === 'dark', JSON.stringify(doc.documentElement.dataset));
}

// 10. Equation tags land in the inline flow after the formula (not absolute-
//     positioned at the right edge). CSS enforces the visual behavior; here we
//     pin the DOM/level facts that make it possible: tag is a sibling AFTER
//     the .katex-base content inside .katex-html.
{
  const r = renderMarkdown('$$x = y \\tag{L}$$');
  const html = String(r.html);
  const iBase = html.indexOf('katex-base');
  const iTag = html.indexOf('katex-tag');
  check('display \\tag renders tag inside katex-html after content', r.mathCount === 1 && iBase !== -1 && iTag > iBase, html.slice(0, 200));
}

// 11. Search bridge: MathMD.find must be registered for Kotlin and must
//     fail safe (no throw, zero count) on a DOM without TreeWalker — the
//     real matching/highlighting behavior is browser-only (Custom Highlight
//     API) and verified by hand per AGENTS.md policy.
{
  check('MathMD.find registered on the bridge', typeof ctx.MathMD.find === 'function', typeof ctx.MathMD.find);
  previewEl.innerHTML = '';
  ctx.MathMD.hostUpdate('hello $x$');
  let res = null, threw = null;
  try { res = ctx.MathMD.find('hello', 0); } catch (e) { threw = e.message; }
  check('find fails safe on the DOM stub', threw === null && res && res.total === 0 && res.active === -1, `threw=${threw} res=${JSON.stringify(res)}`);
}

// 12. Contract drift guards (blind-review #17 #18): the Kotlin bridge fallback
//     font stack and the +32px padding arithmetic must stay byte-identical to
//     what preview.css actually uses, or the chars->px viewport measurement
//     silently drifts from the rendered layout.
{
  const css = fs.readFileSync(path.join(ASSETS, 'preview.css'), 'utf8');
  const kt = fs.readFileSync(
    path.join(ROOT, 'app', 'src', 'main', 'java', 'io', 'github', 'lckhot', 'mathmd', 'PreviewPane.kt'),
    'utf8');
  const cssFallback = /--preview-font-family,\s*([^)]+)\)/.exec(css)?.[1] ?? '';
  const ktFallback = /cssFontFamily[\s\S]*?\?\:\s*"([^"]+)"/.exec(kt)?.[1] ?? '';
  const norm = (s) => s.replace(/["']/g, '').replace(/\s+/g, ' ').trim();
  check('Kotlin bridge font fallback == CSS fallback (drift guard)',
    cssFallback.length > 0 && norm(cssFallback) === norm(ktFallback),
    `css="${cssFallback}" kt="${ktFallback}"`);

  const html = fs.readFileSync(path.join(ASSETS, 'preview.html'), 'utf8');
  const cssPad = /#preview\s*\{[^}]*padding:\s*[\d.]+px\s+([\d.]+)px/.exec(css)?.[1] ?? '';
  const htmlPad = /\/\/ 32px = #preview horizontal padding/.test(html) &&
    /Math\.round\(chars \* chPx\) \+ 32/.test(html);
  check('boot +32px padding == 2x CSS #preview horizontal padding (drift guard)',
    (cssPad === '16.0' || cssPad === '16') && htmlPad, `cssPad=${cssPad} htmlContract=${htmlPad}`);
}

// 11. Page-width contract lives in preview.html's boot script (viewport is
//     locked BEFORE first layout; the bundle no longer touches it). Pin the
//     host<->page contract statically so a refactor cannot silently break it.
{
  const html = fs.readFileSync(path.join(ASSETS, 'preview.html'), 'utf8');
  check(
    'preview.html boot reads MathMDNative and rewrites viewport meta',
    html.includes('MathMDNative.getPageWidthChars') &&
      html.includes('MathMDNative.getPreviewFontFamily') &&
      html.includes('meta[name="viewport"]') &&
      html.includes('width='),
    'boot script contract changed',
  );
  check(
    'boot script pins fit scale via initial/minimum-scale (owner zoom model)',
    html.includes('initial-scale=') && html.includes('minimum-scale=') &&
      html.includes('maximum-scale=10'),
    'viewport scale contract changed',
  );
  check(
    'boot script runs before stylesheets',
    html.indexOf('MathMDNative') < html.indexOf('katex.min.css'),
    'viewport must be locked before first layout',
  );
}

// ---- report ----
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  for (const f of failures) {
    console.log(`\nFAIL: ${f.name}\n  ${f.detail}`);
  }
  process.exit(1);
}
