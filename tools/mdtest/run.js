#!/usr/bin/env node
/**
 * MathMD preview pipeline test harness (node).
 *
 * Emulates the WebView global environment: vendored markdown-it and KaTeX
 * are evaluated in a clean vm context (no module/exports, so their UMD
 * wrappers attach to the context global exactly like in a browser), then the
 * esbuild-bundled TypeScript pipeline is loaded and exercised.
 *
 * Asset gate (L4): the FRESH bundle (built here from tools/preview-src into
 * a private mkdtemp directory) and the COMMITTED bundle
 * (app/src/main/assets/preview/bundle.js) must both pass the SAME assertion
 * set, each in its own clean VM, and be byte-identical. A mismatch fails
 * the run with a pointer to ./scripts/build-preview.sh — the committed
 * bundle may never drift from the TypeScript sources.
 *
 * Usage: node tools/mdtest/run.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'app', 'src', 'main', 'assets', 'preview');
const COMMITTED_BUNDLE = path.join(ASSETS, 'bundle.js');
const SRC = path.join(ROOT, 'tools', 'preview-src');

// Private working directory so concurrent runs never collide (L4).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mathmd-mdtest-'));

let exitCode = 0;
try {
  // ---- bundle the TypeScript pipeline (fresh, into TMP) ----
  const bundlePath = path.join(TMP, 'fresh-bundle.js');
  const ESBUILD = path.join(SRC, '..', 'node_modules', '.bin', 'esbuild');
  execSync(
    `${JSON.stringify(ESBUILD)} ` +
    `${JSON.stringify(path.join(SRC, 'src', 'host.ts'))} ` +
    `--bundle --format=iife --outfile=${JSON.stringify(bundlePath)}`,
    { stdio: 'inherit' },
  );

  // ---- main gate: fresh and committed bundles must be byte-identical ----
  const freshBytes = fs.readFileSync(bundlePath);
  const committedBytes = fs.readFileSync(COMMITTED_BUNDLE);
  const bytesIdentical = Buffer.compare(freshBytes, committedBytes) === 0;

  const fresh = runBattery(bundlePath, 'fresh');
  const committed = runBattery(COMMITTED_BUNDLE, 'committed');

  console.log(
    `\nfresh: ${fresh.pass} passed, ${fresh.fail} failed` +
    ` | committed: ${committed.pass} passed, ${committed.fail} failed` +
    ` | bundle bytes ${bytesIdentical ? 'identical' : 'DIFFER'}`,
  );

  const report = (label, r) => {
    for (const f of r.failures) {
      console.log(`\nFAIL [${label}]: ${f.name}\n  ${f.detail}`);
    }
  };
  report('fresh', fresh);
  report('committed', committed);

  if (!bytesIdentical) {
    console.log(
      '\nFAIL: committed bundle.js differs from a fresh build of tools/preview-src.\n' +
      '  Run ./scripts/build-preview.sh and commit the regenerated bundle.');
  }

  exitCode = (fresh.fail === 0 && committed.fail === 0 && bytesIdentical) ? 0 : 1;
} finally {
  // Cleanup runs even on assertion failure or crash (L4).
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // A leftover temp dir never masks a test result.
  }
}

process.exit(exitCode);

// ---- emulate the WebView global scope ----
// Minimal DOM stub: the bundle registers a DOMContentLoaded hook and looks up
// #preview at render time; tests drive hostUpdate through this stub.
function makeContext() {
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
  return { ctx, previewEl, doc };
}

function loadBundle(bundlePath) {
  const { ctx, previewEl, doc } = makeContext();
  vm.runInContext(fs.readFileSync(path.join(ASSETS, 'markdown-it.umd.min.js'), 'utf8'), ctx, { filename: 'markdown-it.umd.min.js' });
  vm.runInContext(fs.readFileSync(path.join(ASSETS, 'katex', 'katex.min.js'), 'utf8'), ctx, { filename: 'katex.min.js' });
  vm.runInContext(fs.readFileSync(bundlePath, 'utf8'), ctx, { filename: path.basename(bundlePath) });
  return { ctx, previewEl, doc };
}

/** Run the full assertion battery against one bundle file. */
function runBattery(bundlePath, label) {
  const { ctx, previewEl, doc } = loadBundle(bundlePath);
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

  // 4. CJK emphasis (markdown-it-cjk-friendly): CommonMark rejects )**汉字
  //     closers; the plugin must restore bold/italic in CJK prose.
  {
    const r = renderMarkdown('经典线索为：Dyer−Edmunds (1970) 的初步结果；**Kim−Kozono (2006)**证明若 $u(x)=o(1/|x|)$ 成立');
    check('CJK: **X (2006)**证明 bolds despite ASCII-paren closer + CJK next',
      r.mathCount === 1 && r.html.includes('<strong>Kim−Kozono (2006)</strong>'), r.html.slice(0, 200));
    const i = renderMarkdown('结果 *重要*这里继续');
    check('CJK: *italic* before CJK char', i.html.includes('<em>重要</em>'), i.html);
  }

  // 5. Code constructs shield math
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

  // 6. Review fixes: escaped backticks, code-restore shape, salt collisions
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

  // 7. Escapes and fallbacks
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

  // 8. Errors surface, not crash
  {
    const r = renderMarkdown('$\\thisIsNotACommand$');
    check('bad tex -> katex red fallback (no throw)', r.html.includes('#cc0000'), r.html.slice(0, 200));
  }
  {
    const r = renderMarkdown('$\\thisIsNotACommand$', { throwOnError: true });
    check('bad tex + throwOnError -> error span', r.errors.length === 1 && r.html.includes('math-error'), r.html.slice(0, 200));
  }

  // 9. Salt collision guard
  {
    const literal = 'MMATHMDPHK70MMM';
    const r = renderMarkdown(`keep ${literal} and formula $x$`, { salt: 'ZZ' });
    check('salt bump avoids collision', r.mathCount === 1 && r.html.includes(literal), r.html);
  }

  // 10. protectMath unit sanity
  {
    const p = protectMath('a $x$ b', 'T1');
    check('protectMath token shape', p.math.length === 1 && p.math[0].token === 'MMATHMDPHT10MMM' && p.text === `a ${p.math[0].token} b`, JSON.stringify(p));
  }

  // 11. hostUpdate bridge end-to-end (this was the missing function in v0.1)
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

  // 12. Equation tags land in the inline flow after the formula (not absolute-
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

  // 13. Search bridge: MathMD.find must be registered for Kotlin and must
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

  // 14. Contract drift guards (blind-review #17 #18): the Kotlin bridge fallback
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

  // 15. Page-width contract lives in preview.html's boot script (viewport is
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

  // 16. Fence interior indentation survives restore (code-review R2): the
  //     restore pass dispatches on the segment's construct, so a fence whose
  //     interior is 4-space/tab-indented (syntactically meaningful in Python)
  //     keeps that indent; only genuine indented blocks lose their marker.
  {
    const r = renderMarkdown('```\n    line one keeps indent?\n    line two also\n```');
    check('fence: 4-space-indented interior preserved',
      r.html.includes('<pre><code>    line one keeps indent?\n    line two also'), r.html);
    const t = renderMarkdown('```\n\tline one tab\n\tline two tab\n```');
    check('fence: tab-indented interior preserved',
      t.html.includes('<pre><code>\tline one tab\n\tline two tab'), t.html);
    const ind = renderMarkdown('text\n\n    $x_i$ indented\n\nmore');
    check('indented block: 4-space marker still stripped',
      ind.html.includes('<pre><code>$x_i$ indented') && !/<code><code>/.test(ind.html), ind.html);
  }

  // 17. TSV tables (ChatGPT-style tab-separated blocks): ChatGPT's web client
  //     renders these as real tables; the pipeline converts them to pipe
  //     tables after math protection, before markdown-it.
  {
    // Motivating sample: header, blank line, data rows, math in cells.
    const tsv = [
      '时间\t结果\t对 Ding–Mossel question 的进展',
      '',
      '2014 Ding–Mossel\t\\(t_{\\rm mix}=O_\\varepsilon(n^3)\\)\t提出 \\(O_\\varepsilon(n\\log n)\\) conjecture',
      '2025 Fei–Ferreira Pinto\tsharp Poincaré / spectral gap \\(\\asymp 1/n\\)\t对所有 constant-density monotone sets 得到 \\(O(n^2)\\)',
      '2026 Santos–Tripathi–Youssef\ttypical random monotone set 的 \\(t_{\\rm LS}\\asymp n\\)\t对几乎所有 monotone sets 得到 \\(O(n\\log n)\\)',
    ].join('\n');
    const r = renderMarkdown(tsv);
    check('ChatGPT TSV sample: one table, 3 columns, 4 rows',
      (r.html.match(/<table>/g) || []).length === 1 &&
        (r.html.match(/<th>/g) || []).length === 3 &&
        (r.html.match(/<tr>/g) || []).length === 4, r.html.slice(0, 400));
    check('ChatGPT TSV sample: cell math renders after restore',
      r.mathCount === 6 && r.html.includes(K), `count=${r.mathCount} html=${r.html.slice(0, 200)}`);
  }
  {
    // A blank line between EVERY row still merges into one table.
    const r = renderMarkdown('a\tb\tc\n\n1\t2\t3\n\n4\t5\t6');
    check('blank-line-separated TSV rows merge into one table',
      (r.html.match(/<table>/g) || []).length === 1 && (r.html.match(/<tr>/g) || []).length === 3, r.html);
  }
  {
    // Tabs inside a fence never convert (fences are extracted first).
    const r = renderMarkdown('```\na\tb\nx\ty\n```');
    check('tabs inside a fence stay code',
      (r.html.match(/<table>/g) || []).length === 0 && r.html.includes('<pre>') && r.html.includes('a\tb'), r.html);
  }
  {
    // A lone tab-carrying line stays prose.
    const r = renderMarkdown('key\tvalue\n\nplain paragraph');
    check('single tab line stays prose', (r.html.match(/<table>/g) || []).length === 0, r.html);
  }
  {
    // Different cell counts across a blank line: two unrelated blocks, no table.
    const r = renderMarkdown('a\tb\n\nc\td\te');
    check('cell-count mismatch across blank line: no table', (r.html.match(/<table>/g) || []).length === 0, r.html);
  }
  {
    // A TSV block glued to prose forms its own block (blank lines inserted).
    // Explicit minRows=2: also pins the knob (default is 3).
    const r = renderMarkdown('prose line\nh1\th2\th3\nd1\td2\td3\nafter text', { tsvMinRows: 2 });
    check('TSV block glued to prose: table separated on both sides',
      (r.html.match(/<table>/g) || []).length === 1 &&
        r.html.includes('<p>prose line</p>') && r.html.includes('<p>after text</p>'), r.html);
  }
  {
    // Ordinary pipe tables pass through untouched.
    const r = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');
    check('pipe table unchanged by the TSV pass',
      (r.html.match(/<table>/g) || []).length === 1 && (r.html.match(/<th>/g) || []).length === 2, r.html);
  }
  {
    // Ragged rows are padded to the run's widest row (minRows=2 knob pinned).
    const r = renderMarkdown('a\tb\tc\n1\t2', { tsvMinRows: 2 });
    check('ragged TSV row padded to header width', (r.html.match(/<td>/g) || []).length === 3, r.html);
  }
  {
    // A literal pipe inside a cell is escaped, not treated as a column break.
    const r = renderMarkdown('a\tb\nx\ty|z', { tsvMinRows: 2 });
    check('pipe inside a TSV cell escapes to a literal |', r.html.includes('<td>y|z</td>'), r.html);
  }

  // 18. TSV threshold knobs (Settings dialog -> hostUpdate opts -> pipeline).
  //     Defaults: enabled, minRows 3, minCols 2 (>= 1 tab).
  {
    const two = 'h1\th2\nd1\td2';
    const three = 'h1\th2\nd1\td2\nd3\td4';
    const r2 = renderMarkdown(two);
    check('default minRows=3: 2-row TSV block stays prose',
      (r2.html.match(/<table>/g) || []).length === 0, r2.html);
    const r3 = renderMarkdown(three);
    check('default minRows=3: 3-row TSV block becomes a table',
      (r3.html.match(/<table>/g) || []).length === 1, r3.html.slice(0, 200));
    const rk = renderMarkdown(two, { tsvMinRows: 2 });
    check('tsvMinRows=2 converts a 2-row block',
      (rk.html.match(/<table>/g) || []).length === 1, rk.html.slice(0, 200));
  }
  {
    const two = 'a\tb\nx\ty\np\tq'; // 3 rows, only 2 cells per line
    const rc = renderMarkdown(two, { tsvMinCols: 3 });
    check('tsvMinCols=3 rejects 2-column rows',
      (rc.html.match(/<table>/g) || []).length === 0, rc.html);
    const rcDefault = renderMarkdown(two);
    check('default minCols=2 accepts the same block',
      (rcDefault.html.match(/<table>/g) || []).length === 1, rcDefault.html.slice(0, 200));
    const c3 = 'a\tb\tc\td\nx\ty\tz\tw\np\tq\tr\ts';
    const rk = renderMarkdown(c3, { tsvMinCols: 3 });
    check('tsvMinCols=3 accepts 3+-column rows',
      (rk.html.match(/<table>/g) || []).length === 1 && (rk.html.match(/<th>/g) || []).length === 4, rk.html.slice(0, 200));
  }
  {
    const r = renderMarkdown('h1\th2\nd1\td2\nd3\td4', { tsvTables: false });
    check('tsvTables=false disables conversion',
      (r.html.match(/<table>/g) || []).length === 0, r.html);
    // End-to-end through the bridge: hostUpdate forwards the options.
    previewEl.innerHTML = '';
    ctx.MathMD.hostUpdate('h1\th2\nd1\td2\nd3\td4', { tsvTables: false });
    check('hostUpdate forwards tsvTables=false',
      (String(previewEl.innerHTML).match(/<table>/g) || []).length === 0, String(previewEl.innerHTML).slice(0, 200));
    previewEl.innerHTML = '';
    ctx.MathMD.hostUpdate('h1\th2\nd1\td2\nd3\td4', { tsvMinRows: 3, tsvMinCols: 2 });
    check('hostUpdate forwards thresholds (defaults convert)',
      (String(previewEl.innerHTML).match(/<table>/g) || []).length === 1, String(previewEl.innerHTML).slice(0, 200));
  }

  // 19. Placeholder restore must never inject markup inside HTML attributes.
  //     Math/code in link destinations and image alt text stays literal; math in
  //     the link's visible text still renders normally.
  {
    const r = renderMarkdown('[x](https://example.com/$a$)');
    check('math in link destination stays literal inside href',
      r.html.includes('href="https://example.com/$a$"') &&
        !r.html.includes('href="https://example.com/<span'), r.html);
  }
  {
    const r = renderMarkdown('![$a$](img.png)');
    check('math in image alt stays literal inside attribute',
      r.html.includes('alt="$a$"') && !r.html.includes('alt="<span'), r.html);
  }
  {
    const r = renderMarkdown('[x $a$](https://example.com)');
    check('math in visible link text still renders',
      r.html.includes('href="https://example.com"') && r.html.includes(K), r.html);
  }
  {
    const r = renderMarkdown('[x](https://example.com/`a`)');
    check('code span in link destination cannot inject a code element',
      !r.html.includes('<code>') && !r.html.includes('href="https://example.com/<code>'), r.html);
  }

  // 20. Inline code spans follow CommonMark whitespace and block-boundary rules.
  {
    const r = renderMarkdown('`  `');
    check('code span consisting only of spaces is preserved',
      r.html.includes('<code>  </code>'), r.html);
  }
  {
    const r = renderMarkdown('`a\nb`');
    check('code span line ending normalizes to one space',
      r.html.includes('<code>a b</code>'), r.html);
  }
  {
    const r = renderMarkdown('before\n\n`a\n\nb`\n\nafter');
    check('code span cannot cross a blank-line block boundary',
      !r.html.includes('<code>') && r.html.includes('<p>b`</p>'), r.html);
  }

  // 21. H3: code-span bodies restore verbatim (no lazy \1 closer re-derivation).
  {
    // A longer backtick run INSIDE the span used to be truncated into a
    // fake closer, dropping "`` b" from the output entirely.
    const r = renderMarkdown('x `a ``` b` y');
    check('span containing a longer backtick run restores whole',
      r.html.includes('<code>a ``` b</code>') && r.html.includes('y'), r.html);
  }
  {
    // Pseudo-span: two-backtick opener, only a one-backtick "closer".
    // The whole opener run must stay literal and no inner retry may pair
    // the leftover single backticks into a fake span.
    const r = renderMarkdown('x ``a` y');
    check('unmatched opener run stays a dead string (no fake span)',
      !r.html.includes('<code>') && r.html.includes('x ``a` y'), r.html);
  }
  {
    const r = renderMarkdown('``a`b``');
    check('equal-length span with inner single backtick restores inner run',
      r.html.includes('<code>a`b</code>'), r.html);
  }
  {
    // A valid span whose opener run could be mistaken for a fence line —
    // the fence boundary guard must only match lines after a REAL newline.
    const r = renderMarkdown('```a```');
    check('inline span is not self-matched as a fence boundary',
      r.html.includes('<code>a</code>') && !r.html.includes('<pre>'), r.html);
  }
  {
    const r = renderMarkdown('[y `a ``` b` z](https://example.com/)');
    check('span with inner backtick run restores fully inside link text',
      r.html.includes('<code>a ``` b</code>'), r.html);
  }
  {
    // Salt-mismatched literal code-token text must survive the Map-based
    // restore exactly as it survived the linear find.
    const r = renderMarkdown('literal MCODEPHZZ9MMM here', { salt: 'K7' });
    check('salt-mismatched code token stays literal (Map restore)',
      r.html.includes('MCODEPHZZ9MMM'), r.html);
  }

  // 22. L1 first stage: span closer search stops at real block boundaries.
  {
    // The would-be span crosses a fence line; the opener must become a dead
    // string, the fence must stay a fence (its math literal, in <pre>).
    const r = renderMarkdown('para `x\n```\n$y$\n```\nz` end');
    check('span cannot swallow a following fence block',
      !r.html.includes('<code>x') && r.html.includes('<pre>') &&
        r.html.includes('$y$') && r.mathCount === 0, r.html);
  }
  {
    // Same for an ATX heading: the heading must render (with its math), the
    // span must not eat it.
    const r = renderMarkdown('q `a\n# H\n$x$\nb` z');
    check('span cannot swallow a following ATX heading',
      r.html.includes('<h1>') && r.mathCount === 1 && !r.html.includes('<code>'), r.html);
  }
  {
    // A span inside a blockquote paragraph: the boundary shapes apply after
    // the quote prefix; a prefix-less line may be a lazy continuation and
    // must not terminate the search.
    const r = renderMarkdown('> a `b\nc` d');
    check('multiline span inside a blockquote paragraph survives',
      r.html.includes('<code>b c</code>'), r.html);
  }
  {
    // A heading inside the quote DOES end the paragraph there.
    const r = renderMarkdown('> a `b\n> # H\n> c` d');
    check('span inside quote stops at an in-quote heading',
      r.html.includes('<h1>') && !r.html.includes('<code>'), r.html);
  }

  // 23. M1/M2 block context: indented-code gating (§6.2 matrix).
  {
    const cases = [
      // [name, src, expectCodeExtracted, expectMathCount]
      ['indented after ATX heading', '# Heading\n    $x$', true, 0],
      ['indented after setext heading', 'Heading\n===\n    $x$', true, 0],
      ['indented after thematic break', '---\n    $x$', true, 0],
      ['indented after closed fence', '```\ncode\n```\n    $x$', true, 0],
      ['indented after valid table', '| a |\n| --- |\n    $x$', true, 0],
      ['indented after table body row', '| a |\n| --- |\n| b |\n    $x$', true, 0],
      ['indented after table text row', '| a |\n| --- |\ntext row\n    $x$', true, 0],
      ['indented at document start', '    $x$', true, 0],
      ['indented after blank line', 'text\n\n    $x$', true, 0],
      ['indented after display math setext', '$$\n\\mu\n$$\n===\n    $x$', true, 1],
      ['indented after inline-math setext', 'Head $x$\n===\n    $y$', true, 1],
      ['indented after list exit ATX', '- a\n\n# H\n    $x$', true, 0],
      ['indented after list exit hr', '- a\n\n---\n    $x$', true, 0],
      ['indented after quote closed by blank', '> q\n\n    $x$', true, 0],
      ['indented after closed quote fence', '> ```\n> $x$\n> ```\n    $y$', true, 0],
      ['paragraph continuation stays paragraph', 'paragraph\n    $x$', false, 1],
      ['quote paragraph continuation', '> para\n>     $x$', false, 1],
      ['pipe header without delimiter', '| a |\n    $x$', false, 1],
      ['=== without open paragraph', '===\n    $x$', false, 1],
      ['table column count mismatch', '| a | b |\n| --- |\n    $x$', false, 1],
      ['list marker line beats table shape', 'head\n- | -\n    $x$', false, 1],
      ['list exit to plain paragraph', '- a\n\ntext\n    $x$', false, 1],
      ['list lazy paragraph', '- item\n    lazy\n\n    $x$', false, 1],
      ['ordered list second item paragraph', '1. a\n\n2. b\n\n    $x$', false, 1],
      ['quote lazy continuation', '> q\n    $x$', false, 1],
    ];
    for (const [name, src, wantCode, wantMath] of cases) {
      const r = renderMarkdown(src);
      const hasPre = r.html.includes('<pre>');
      check(`m1: ${name}`,
        r.mathCount === wantMath && hasPre === wantCode,
        `math=${r.mathCount} pre=${hasPre} html=${r.html}`);
    }
  }
  {
    // THE red line (Kimi): list-item paragraph math must never be hidden
    // inside a misdetected indented code block — every marker variant.
    const variants = ['- formula:', '* formula:', '+ formula:', '1. formula:', '1) formula:'];
    for (const v of variants) {
      const r = renderMarkdown(`${v}\n\n    $x$`);
      check(`m1: list paragraph math renders (${v.split(' ')[0]})`,
        r.mathCount === 1 && !r.html.includes('<pre>') && r.html.includes(K),
        `math=${r.mathCount} html=${r.html}`);
    }
  }
  {
    // `` `s`\n    *em* ``: the span token line is a PARAGRAPH, so the
    // indented follower is a paragraph continuation, not code.
    const r = renderMarkdown('`s`\n    *em*');
    check('m1: inline span line does not fake afterCode',
      r.html.includes('<code>s</code>') && r.html.includes('<em>em</em>') && !r.html.includes('<pre>'),
      r.html);
  }
  {
    // A literal token-shaped line (different salt) must not fake afterCode
    // either — only the scanner's own salted placeholder lines do.
    const r = renderMarkdown('MCODEPHZZ0MMM literal\n    *em*', { salt: 'K7' });
    check('m1: literal token-shaped line does not fake afterCode',
      !r.html.includes('<pre>') && r.html.includes('<em>em</em>'), r.html);
  }

  // 24. M2: single-level same-prefix blockquote fences.
  {
    const cases = [
      ['quote fence backticks', '> ```\n> $x$\n> ```'],
      ['quote fence tildes', '> ~~~\n> $x$\n> ~~~'],
      ['quote fence longer closer', '> ```\n> $x$\n> `````'],
      ['quote fence with info string', '> ```py\n> $x$\n> ```'],
      ['quote fence unclosed to EOF', '> ```\n> $x$\n> tail'],
      ['quote fence with 2-space lead', '>   ```\n>   $x$\n>   ```'],
      ['quote fence no space after marker', '>```\n>$x$\n>```'],
    ];
    for (const [name, src] of cases) {
      const r = renderMarkdown(src);
      check(`m2: ${name} extracts code, math stays literal`,
        r.mathCount === 0 && r.html.includes('<pre>') && r.html.includes('$x$') && r.html.includes('<blockquote>'),
        `math=${r.mathCount} html=${r.html}`);
    }
    // Unclosed quote fence ending at a container exit: the fence content is
    // literal code, math OUTSIDE the quote still renders.
    for (const [name, src] of [
      ['exit by blank line', '> ```\n> $x$\n\nafter $y$'],
      ['exit by marker-less text', '> ```\n> $x$\nafter $y$'],
    ]) {
      const r = renderMarkdown(src);
      check(`m2: quote fence unclosed, ${name}`,
        r.mathCount === 1 && r.html.includes('<pre>') && r.html.includes('$x$') && r.html.includes(K),
        `math=${r.mathCount} html=${r.html}`);
    }
    // Math OUTSIDE the exited quote still renders.
    const ex = renderMarkdown('> ```\n> $x$\n\nafter $y$');
    check('m2: math after quote-fence exit renders',
      ex.html.includes('$x$') && ex.mathCount === 1 && ex.html.includes(K), ex.html);
    // A different-char "closer" is not a closer (content keeps it).
    const dc = renderMarkdown('> ```\n> $x$\n> ~~~');
    check('m2: tilde line does not close a backtick quote fence',
      dc.html.includes('$x$') && dc.html.includes('~~~') && dc.mathCount === 0, dc.html);
    // Nested / heterogeneous prefixes: never guess — no extraction, the
    // markdown-it native parse stands (known residual, see corpus).
    const nested = protectMath('>> ```\n>> $x$\n>> ```');
    check('m2: nested quote fence not guessed at',
      nested.code.length === 0, JSON.stringify(nested.code));
    const hetero = protectMath('> ```\n> a\n>\n> b\n> ```');
    check('m2: hetero-prefix quote fence not guessed at',
      hetero.code.length === 0, JSON.stringify(hetero.code));
  }

  // 25. Differential corpus (B batch, hard condition): for every input the
  // scanner's code extraction must agree with what the VENDORED markdown-it
  // does on the PROTECTED text — that is exactly what production renders.
  // Divergence is only allowed for individually named knownResidual cases.
  {
    const mdOracle = ctx.markdownit({ html: false });
    // Any placeholder token (code or math) that markdown-it places inside a
    // fence/code_block. Code tokens there are EXPECTED (that is the
    // protection working); math tokens there are the M1/M2 hazard — KaTeX
    // would render inside <pre><code>.
    const protTokensIn = (s) => (s.match(/(?:MCODEPH|MMATHMDPH)[A-Z0-9]{1,8}[0-9]+MMM/g) || []);
    const isMathToken = (s) => s.startsWith('MMATHMDPH');
    const normBlock = (s) =>
      s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l !== '').join('\n');
    const normInline = (s) => {
      let b = s.replace(/\r\n?|\n/g, ' ');
      if (b.startsWith(' ') && b.endsWith(' ') && /[^ ]/.test(b)) b = b.slice(1, -1);
      return b;
    };
    // BLOCK code: compare what markdown-it does on the PROTECTED text (the
    // exact production input) with the scanner's fence/indented segments.
    // The oracle's fence/code_block contents are placeholder tokens; code
    // tokens must match the scanner's segment tokens exactly, and NO math
    // token may end up inside a code construct.
    const oracleBlockTokens = (protText) => {
      const code = [];
      const math = [];
      for (const t of mdOracle.parse(protText, {})) {
        if (t.type === 'fence' || t.type === 'code_block') {
          for (const tok of protTokensIn(t.content)) {
            (isMathToken(tok) ? math : code).push(tok);
          }
        }
      }
      return { code: code.sort(), math: math.sort() };
    };
    // SPANS: the scanner's decision must match markdown-it's own inline
    // parsing of the RAW source (code_inline contents). In table rows the
    // scanner keeps cross-cell delimiters literal, so markdown-it may form
    // its own NATIVE code spans from those literal fragments (in paragraph
    // fallbacks, e.g. a column-count mismatch) — count those too.
    const isPlaceholderToken = (s) => /(?:MCODEPH|MMATHMDPH)[A-Z0-9]{1,8}[0-9]+MMM/.test(s);
    const oracleNativeSpans = (protText) => {
      const found = [];
      for (const t of mdOracle.parse(protText, {})) {
        if (t.type === 'inline' && Array.isArray(t.children)) {
          for (const c of t.children) {
            if (c.type === 'code_inline' && !isPlaceholderToken(c.content)) {
              found.push(normInline(c.content));
            }
          }
        }
      }
      return found;
    };
    const oracleInlineBodies = (raw) => {
      const found = [];
      for (const t of mdOracle.parse(raw, {})) {
        if (t.type === 'inline' && Array.isArray(t.children)) {
          for (const c of t.children) if (c.type === 'code_inline') found.push(normInline(c.content));
        }
      }
      return found.sort();
    };

    const corpus = [
      { name: 'atx-then-indented', src: '# Heading\n    $x$' },
      { name: 'setext-then-indented', src: 'Heading\n===\n    $x$' },
      { name: 'hr-then-indented', src: '---\n    $x$' },
      { name: 'fence-then-indented', src: '```\ncode\n```\n    $x$' },
      { name: 'table-then-indented', src: '| a |\n| --- |\n    $x$' },
      { name: 'table-body-then-indented', src: '| a |\n| --- |\n| b |\n    $x$' },
      { name: 'table-textrow-then-indented', src: '| a |\n| --- |\ntext row\n    $x$' },
      { name: 'paragraph-continuation', src: 'paragraph\n    $x$' },
      { name: 'quote-para-continuation', src: '> para\n>     $x$' },
      { name: 'pipe-header-no-delimiter', src: '| a |\n    $x$' },
      { name: 'eq-no-paragraph', src: '===\n    $x$' },
      { name: 'table-colmismatch', src: '| a | b |\n| --- |\n    $x$' },
      { name: 'span-line-em-para', src: '`s`\n    *em*' },
      { name: 'list-para-dash', src: '- formula:\n\n    $x$' },
      { name: 'list-para-star', src: '* formula:\n\n    $x$' },
      { name: 'list-para-plus', src: '+ formula:\n\n    $x$' },
      { name: 'list-para-ordered-dot', src: '1. formula:\n\n    $x$' },
      { name: 'list-para-ordered-paren', src: '1) formula:\n\n    $x$' },
      { name: 'list-exit-atx', src: '- a\n\n# H\n    $x$' },
      { name: 'list-exit-plain', src: '- a\n\ntext\n    $x$' },
      { name: 'list-exit-hr', src: '- a\n\n---\n    $x$' },
      { name: 'quote-blank-exit', src: '> q\n\n    $x$' },
      { name: 'quote-lazy', src: '> q\n    $x$' },
      { name: 'quote-fence-backtick', src: '> ```\n> $x$\n> ```' },
      { name: 'quote-fence-tilde', src: '> ~~~\n> $x$\n> ~~~' },
      { name: 'quote-fence-longclose', src: '> ```\n> $x$\n> `````' },
      { name: 'quote-fence-unclosed-eof', src: '> ```\n> $x$\n> tail' },
      { name: 'quote-fence-unclosed-exit', src: '> ```\n> $x$\n\nafter $y$' },
      { name: 'quote-fence-info', src: '> ```py\n> $x$\n> ```' },
      { name: 'quote-fence-2space-lead', src: '>   ```\n>   $x$\n>   ```' },
      { name: 'quote-fence-nospace-marker', src: '>```\n>$x$\n>```' },
      { name: 'quote-fence-then-indented', src: '> ```\n> $x$\n> ```\n    $y$' },
      { name: 'start-indented', src: '    $x$' },
      { name: 'blank-then-indented', src: 'text\n\n    $x$' },
      { name: 'list-marker-line-priority', src: 'head\n- | -\n    $x$' },
      { name: 'displaymath-setext', src: '$$\n\\mu\n$$\n===\n    $x$' },
      { name: 'setext-with-inline-math', src: 'Head $x$\n===\n    $y$' },
      { name: 'list-lazy-para', src: '- item\n    lazy\n\n    $x$' },
      { name: 'ordered-list-second-item', src: '1. a\n\n2. b\n\n    $x$' },
      { name: 'table-math-cells', src: '| $a$ |\n| --- |\n| $b$ |' },
      { name: 'list-then-table-then-indented', src: '- x\n\n| a |\n| --- |\n    $y$' },
      { name: 'tab-indented-marker', src: '\t- x\n\n    $y$' },
      // markdown-it closes the '- ```' fence empty and keeps '- $x$' as an
      // item paragraph: no divergence, no extraction needed, math renders.
      { name: 'list-fence-marker-line-empty', src: '- item\n- ```\n- $x$' },
      { name: 'span-multiline-ok', src: 'a `b\nc` d' },
      { name: 'span-cross-blank', src: 'before\n\n`a\n\nb`\n\nafter' },
      { name: 'span-dead-run', src: 'x ``a` y' },
      { name: 'span-cross-atx', src: 'q `a\n# H\n$x$\nb` z' },
      { name: 'span-in-quote-multiline', src: '> a `b\nc` d' },
      // Lead review: whitespace-only blank lines are blank (CommonMark).
      { name: 'blank-spaces-line', src: '# h\n   \n    $x$' },
      { name: 'blank-tab-line', src: '# h\n\t\n    $x$' },
      { name: 'blank-mixed-line', src: '# h\n \t \n    $x$' },
      // Lead review: 4-space "block-looking" lines inside an OPEN paragraph
      // are continuations — legitimate multi-line spans must survive.
      { name: 'span-4space-atx-continuation', src: '`start\n    # not a heading\nend $x$`' },
      { name: 'span-4space-fence-continuation', src: '`start\n    ```\nend $x$`' },
      { name: 'span-4space-hr-continuation', src: '`start\n    ---\nend $x$`' },
      { name: 'span-4space-ordered-continuation', src: '`start\n    1. not a list\nend $x$`' },
      // Lead review: GFM splits table rows on unescaped pipes BEFORE inline
      // parsing — a pipe inside a code span still separates header cells.
      { name: 'table-span-pipe-header', src: '| `a|b` | h |\n| --- | --- | --- |\n    $x$' },
      { name: 'table-span-pipe-colmismatch', src: '| `a|b` | h |\n| --- | --- |\n    $x$' },
      // Lead review: GFM splits table rows on unescaped pipes BEFORE inline
      // parsing — cell-aware protection keeps cross-cell math/code literal,
      // in headers AND body rows, for MCODEPH and MMATH alike.
      { name: 'table-mathpipe-header', src: '| $a|b$ | h |\n| --- | --- | --- |\n    $x$' },
      { name: 'table-codepipe-body', src: '| a | b | c |\n| --- | --- | --- |\n| `x|y` | h |' },
      { name: 'table-mathpipe-body', src: '| a | b | c |\n| --- | --- | --- |\n| $x|y$ | h |' },
      { name: 'table-mixed-pipe-header', src: '| $m$ | $a|b$ | h |\n| --- | --- | --- | --- |\n    $x$' },
      { name: 'table-mixed-pipe-body', src: '| a | b | c | d |\n| --- | --- | --- | --- |\n| $m$ | $a|b$ | h |' },
      { name: 'table-code-math-mixed-header', src: '| `c` | $a|b$ |\n| --- | --- | --- |\n    $x$' },
      // Lead round 5: INVALID table candidates are ordinary paragraphs —
      // cross-pipe math pairs normally (mathCount=2, no table), and the
      // fake-table illusion breaker keeps markdown-it from building one on
      // the token-visible cell counts.
      { name: 'table-invalid-colmismatch', src: '| $a|b$ | h |\n| --- | --- |\n    $x$' },
      { name: 'table-invalid-delimiter-indent', src: '| $a|b$ | h |\n    | --- | --- | --- |\n    $x$' },
      { name: 'table-invalid-header-indent', src: 'paragraph\n    | $a|b$ | h |\n| --- | --- | --- |\n    $x$' },
      { name: 'table-invalid-list-delimiter', src: '| $a|b$ | h |\n- | - | - |\n    $x$' },
      { name: 'table-invalid-mixed-negative', src: '| $m$ | $a|b$ | h |\n| --- | --- |\n    $x$' },
      { name: 'table-invalid-delimiter-shape', src: '| $a|b$ | h |\n| --- | nope | --- |\n    $x$' },
      // Lead round 6: fence-closer at a line START is a block boundary —
      // spans must not swallow the fence marker of the next line.
      { name: 'fence-closer-len3', src: 'para ```x\n```\n$y$' },
      { name: 'fence-closer-len4', src: 'para ````x\n````\n$y$' },
      { name: 'fence-closer-len5', src: 'para `````x\n`````\n$y$' },
      // Lead round 6: link reference definitions close the block; a
      // following indented line is code (math must stay literal).
      { name: 'linkdef-then-indented', src: '[a]: /url\n    $x$' },
      { name: 'linkdef-2line-dest', src: '[a]:\n/url\n    $x$' },
      { name: 'linkdef-title-cont', src: '[a]: /url\n"t"\n    $x$' },
      { name: 'linkdef-midpara', src: 'foo\n[a]: /url\n    $x$' },
      // Lead round 6: list-SHAPED headers are still table headers.
      { name: 'table-list-header-ord1', src: '1. h | j\n--- | ---\n    $x$' },
      { name: 'table-list-header-ord2', src: '2. h | j\n--- | ---\n    $x$' },
      { name: 'table-list-header-dash', src: '- h | j\n--- | ---\n    $x$' },
      { name: 'table-list-header-after-para', src: 'para\n1. h | j\n--- | ---\n    $x$' },
      // Lead round 6: short dash runs — '--' is text, '-' is a list marker.
      { name: 'dashdash-paragraph', src: '--\n    $x$' },
      { name: 'single-dash-list', src: '-\n    $x$' },
      // Lead round 6: backtick fences with backticks in the info string.
      { name: 'fence-info-backtick', src: '```bad`info\n$y$\n```' },
      { name: 'quote-fence-info-backtick', src: '> ```bad`info\n> $y$\n> ```' },
      // Lead round 6: EOF without a final newline — same semantics as with.
      { name: 'table-invalid-eof-nolf', src: '| $a|b$ | h |\n| --- | --- |' },
      { name: 'table-valid-eof-nolf', src: '| a | h |\n| --- | --- |' },
      // CRLF variants of the same boundaries.
      { name: 'fence-closer-len3-crlf', src: 'para ```x\r\n```\r\n$y$' },
      { name: 'table-invalid-crlf', src: '| $a|b$ | h |\r\n| --- | --- |\r\n    $x$' },
      { name: 'linkdef-crlf', src: '[a]: /url\r\n    $x$' },
      // Spans in ordinary prose keep working (pipes pair freely outside rows).
      { name: 'span-with-pipe-in-prose', src: 'see `a|b` here and $y$ there' },
      // Known residuals — individually named, individually justified:
      { name: 'quote-fence-blank-marker-line', src: '> ```\n> $x$\n>\n> $y$\n> ```',
        residual: 'residual:quote-fence-marker-only-body-line (hetero prefix, plan says do not guess)' },
      { name: 'quote-fence-nested-marker', src: '> ```\n> $x$\n>> $y$\n> ```',
        residual: 'residual:quote-fence-nested-marker-line (nested prefix, plan says do not guess)' },
      { name: 'list-fence-indented-in-item', src: '- item\n\n    ```\n    $x$\n    ```',
        residual: 'residual:list-fence-in-item (list fence extraction is optional and corpus-gated; scanner forms a conservative span instead — math stays literal, never in real code)' },
    ];
    // RAW-native structural oracle (Lead round 6): for non-residual cases
    // the block structure markdown-it builds on the RAW source must equal
    // the structure it builds on the PROTECTED text — tables, fences and
    // code blocks included. This is independent of the protected-text
    // oracle above (which shares the implementation's view) and catches
    // scanner/classifier drift directly against native parsing.
    const structOf = (txt) => {
      const s = { table: 0, fence: 0, code_block: 0 };
      for (const t of mdOracle.parse(txt, {})) {
        if (t.type === 'table_open') s.table++;
        if (t.type === 'fence') s.fence++;
        if (t.type === 'code_block') s.code_block++;
      }
      return s;
    };
    for (const c of corpus) {
      const prot = protectMath(c.src);
      // No-orphan invariant (Lead round 3): every effective segment token
      // must appear in the protected text — mathCount and the restore pass
      // only ever see live tokens.
      const orphaned = [...prot.code, ...prot.math].filter((s) => !prot.text.includes(s.token));
      check(`corpus:${c.name} no orphan segments`,
        orphaned.length === 0, `orphaned=${JSON.stringify(orphaned.map((s) => s.token))}`);
      const scanBlocks = prot.code.filter((s) => s.construct !== 'span').map((s) => s.token).sort();
      const scanSpans = prot.code.filter((s) => s.construct === 'span').map((s) => normInline(s.body)).sort();
      const orac = oracleBlockTokens(prot.text);
      const oracSpans = oracleInlineBodies(c.src);
      const unionSpans = [...new Set([...scanSpans, ...oracleNativeSpans(prot.text)])].sort();
      const same =
        JSON.stringify(scanBlocks) === JSON.stringify(orac.code) &&
        orac.math.length === 0 &&
        JSON.stringify(unionSpans) === JSON.stringify([...new Set(oracSpans)].sort());
      if (c.residual) {
        // Pinned divergence: the scanner does not attempt the construct
        // (no block extraction), with the divergence observable at the
        // oracle. The known-residual direction is per the plan; everything
        // else must match exactly.
        check(`corpus:${c.name} [${c.residual}] stays a named residual`,
          scanBlocks.length === 0 && !same,
          `scannerBlocks=${JSON.stringify(scanBlocks)} scannerSpans=${JSON.stringify(scanSpans)} oracleCode=${JSON.stringify(orac.code)} oracleMathInCode=${JSON.stringify(orac.math)} unionSpans=${JSON.stringify(unionSpans)} oracleSpans=${JSON.stringify(oracSpans)}`);
      } else {
        check(`corpus:${c.name} scanner == markdown-it (no math in code)`,
          same,
          `scannerBlocks=${JSON.stringify(scanBlocks)} oracleCode=${JSON.stringify(orac.code)} oracleMathInCode=${JSON.stringify(orac.math)} unionSpans=${JSON.stringify(unionSpans)} oracleSpans=${JSON.stringify(oracSpans)}`);
        check(`corpus:${c.name} raw native structure == protected structure`,
          JSON.stringify(structOf(c.src)) === JSON.stringify(structOf(prot.text)),
          `raw=${JSON.stringify(structOf(c.src))} protected=${JSON.stringify(structOf(prot.text))}`);
      }
    }
  }

  // 26. L2: container-prefixed TSV runs are never converted.
  {
    const cases = [
      ['blockquote TSV run', '> h1\th2\n> d1\td2\n> d3\td4'],
      ['indented quote TSV run', '  > h1\th2\n  > d1\td2\n  > d3\td4'],
      ['list marker TSV run', '- a\tb\n- c\td\n- e\tf'],
      ['ordered list TSV run', '1. a\tb\n2. c\td\n3. e\tf'],
      ['indented (list content) TSV run', 'para\n    a\tb\n    c\td\n    e\tf'],
      ['two-space list content TSV run', '- x\n\n  a\tb\n  c\td\n  e\tf'],
    ];
    for (const [name, src] of cases) {
      const r = renderMarkdown(src);
      check(`l2: ${name} stays unchanged (no top-level table)`,
        (r.html.match(/<table>/g) || []).length === 0, r.html.slice(0, 200));
    }
    // Ordinary top-level TSV runs still convert.
    const plain = renderMarkdown('h1\th2\nd1\td2\nd3\td4');
    check('l2: plain TSV run still converts',
      (plain.html.match(/<table>/g) || []).length === 1, plain.html.slice(0, 200));
  }

  // 27. M3: case-fold owner mapping — the production fold/match functions
  // are exposed on the MathMD bridge, so these vectors test the exact code
  // the preview search uses. JS ranges are end-exclusive [start, end).
  {
    const { foldCaseWithMap, foldedMatchRanges } = ctx.MathMD;
    check('m3: fold/match functions registered on the bridge',
      typeof foldCaseWithMap === 'function' && typeof foldedMatchRanges === 'function',
      `${typeof foldCaseWithMap}/${typeof foldedMatchRanges}`);

    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const vectors = [
      // [text, query, expected ranges]
      ['Foo bar FOO', 'foo', [[0, 3], [8, 11]]],
      ['İ', 'i', [[0, 1]]],
      ['i̇', 'İ', [[0, 2]]],
      ['AİB', 'i', [[1, 2]]],
      ['😀İx', 'i', [[2, 3]]],
      ['ẞ', 'ß', [[0, 1]]],
      ['𐐀', '𐐨', [[0, 2]]],  // U+10400's lowercase is U+10428
      ['aaaa', 'aa', [[0, 2], [2, 4]]],
      ['İ ΟΣ', 'i', [[0, 1]]],
      ['İ ΟΣ', 'ΟΣ', [[2, 4]]],
      ['ΟΣΑ', 'οσα', [[0, 3]]],
    ];
    for (const [text, query, expected] of vectors) {
      const got = foldedMatchRanges(text, query).map(([a, b]) => [a, b]);
      check(`m3: ${JSON.stringify(text)} / ${JSON.stringify(query)}`,
        eq(got.map(([a, b]) => [a, b]), expected),
        `got=${JSON.stringify(got)} expected=${JSON.stringify(expected)}`);
    }
    check('m3: empty query matches nothing',
      eq(foldedMatchRanges('anything', ''), []), 'empty query');
    check('m3: missing query matches nothing',
      eq(foldedMatchRanges('abcdef', 'xyz'), []), 'no hit');
  }
  {
    // Slow-path direct assertions (not just end-to-end): İ ΟΣ must fold
    // with the whole-string Final-Sigma context rule and exact owners.
    const f = ctx.MathMD.foldCaseWithMap('İ ΟΣ');
    check('m3: İ ΟΣ slow-path folded text (Final Sigma)',
      f && f.folded === 'i̇ ος' && f.folded.length === 5, JSON.stringify(f && f.folded));
    check('m3: İ ΟΣ slow-path owner vectors',
      f &&
        JSON.stringify(f.ownerStart) === JSON.stringify([0, 0, 1, 2, 3]) &&
        JSON.stringify(f.ownerEnd) === JSON.stringify([1, 1, 2, 3, 4]),
      `start=${JSON.stringify(f && f.ownerStart)} end=${JSON.stringify(f && f.ownerEnd)}`);
    // Alignment gate unit tests (real misalignment, not masked): equal-width
    // character difference is accepted, width/count divergence is rejected.
    const aligned = ctx.MathMD.alignOwnerMap(
      ['i', '̇', ' ', 'ο', 'σ'], [0, 0, 1, 2, 3], [1, 1, 2, 3, 4], 'i̇ ος');
    check('m3: alignment gate accepts equal-width char difference (Final Sigma)',
      aligned &&
        JSON.stringify(aligned.ownerStart) === JSON.stringify([0, 0, 1, 2, 3]) &&
        JSON.stringify(aligned.ownerEnd) === JSON.stringify([1, 1, 2, 3, 4]),
      JSON.stringify(aligned));
    check('m3: alignment gate rejects width divergence',
      ctx.MathMD.alignOwnerMap(['ab'], [0], [2], 'abc') === null, 'width mismatch must be null');
    check('m3: alignment gate rejects count divergence',
      ctx.MathMD.alignOwnerMap(['a', '𝕏'], [0, 1], [1, 3], 'ab') === null,
      'per-step width mismatch must be null');
    // Identity fast path: only on full equality (no uppercase to fold).
    const id = ctx.MathMD.foldCaseWithMap('plain digits 123');
    check('m3: identity fast path owners',
      id.folded === 'plain digits 123' &&
        JSON.stringify(id.ownerStart) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
      JSON.stringify(id.ownerStart));
    // Cache-reuse probe: matchRangesInFolded never re-folds. Matching a
    // cached Folded repeatedly must leave the fold counter unchanged,
    // while the convenience wrapper folds once per call.
    {
      const text = 'Foo İ bar ΟΣ baz';
      const cached = ctx.MathMD.foldCaseWithMap(text);
      const q = 'ΟΣ'.toLowerCase();
      const before = ctx.MathMD.foldOperationCount();
      const r1 = JSON.stringify(ctx.MathMD.matchRangesInFolded(cached, text, q));
      const r2 = JSON.stringify(ctx.MathMD.matchRangesInFolded(cached, text, 'foo'));
      const r3 = JSON.stringify(ctx.MathMD.matchRangesInFolded(cached, text, q));
      const after = ctx.MathMD.foldOperationCount();
      check('m3: cached-Folded matching performs zero folds (host reuse proof)',
        before === after && r1 === r3,
        `before=${before} after=${after} r1=${r1} r3=${r3}`);
      check('m3: cached-Folded results equal the wrapper results',
        r1 === JSON.stringify(ctx.MathMD.foldedMatchRanges(text, 'ΟΣ').map(([a, b]) => [a, b])),
        `cached=${r1}`);
    }
    // General invariants on tricky inputs.
    let invariantsOk = true;
    let detail = '';
    const isHighH = (c) => c >= '\uD800' && c <= '\uDBFF';
    const isLowH = (c) => c >= '\uDC00' && c <= '\uDFFF';
    for (const text of ['İ ΟΣ', '😀İx', 'AİB', '𐐀b', 'ẞß', 'a😀b', '😀', '']) {
      for (const query of ['i', 'ß', '𐐨', 'οσ', 'x', '😀', '\uD83D', '\uDE00', '']) {
        let lastEnd = -1;
        for (const [s, e] of ctx.MathMD.foldedMatchRanges(text, query)) {
          if (s < 0 || e > text.length || s >= e || s < lastEnd) {
            invariantsOk = false;
            detail = `${JSON.stringify(text)}/${JSON.stringify(query)} -> [${s},${e}) lastEnd=${lastEnd}`;
          }
          lastEnd = e;
          // A range must not START or END inside a surrogate pair: compare
          // the unit BEFORE the start and the unit AT the end (the old
          // check compared a code unit with itself and could never fire).
          if (s > 0 && isLowH(text[s]) && isHighH(text[s - 1])) {
            invariantsOk = false;
            detail = `${JSON.stringify(text)}/${JSON.stringify(query)} starts mid-pair at ${s}`;
          }
          if (e < text.length && isHighH(text[e - 1]) && isLowH(text[e])) {
            invariantsOk = false;
            detail = `${JSON.stringify(text)}/${JSON.stringify(query)} ends mid-pair at ${e}`;
          }
        }
      }
    }
    check('m3: ranges in-bounds, ordered, non-overlapping, surrogate-safe', invariantsOk, detail);
  }

  // 28. Lead-review regressions: exact counterexamples, render-level.
  {
    // (1) A 4-space "block-looking" line inside an OPEN paragraph is a
    // continuation: the multi-line span survives and its math stays a
    // literal inside the restored <code> — never KaTeX inside real code.
    for (const [name, src] of [
      ['4-space ATX-lookalike', '`start\n    # not a heading\nend $x$`'],
      ['4-space fence-lookalike', '`start\n    ```\nend $x$`'],
      ['4-space hr-lookalike', '`start\n    ---\nend $x$`'],
      ['4-space ordered-list-lookalike', '`start\n    1. not a list\nend $x$`'],
    ]) {
      const r = renderMarkdown(src);
      check(`lead: span with ${name} line survives`,
        r.mathCount === 0 && r.html.includes('<code>') && r.html.includes('$x$') &&
          !r.html.includes('katex-html'),
        `math=${r.mathCount} html=${r.html}`);
    }
    // The positive direction still holds: a COLUMN-0 heading line really
    // is a boundary (dead string, heading renders with its math).
    const h = renderMarkdown('`a\n# H\n$b$`');
    check('lead: column-0 heading still ends a span',
      h.mathCount === 1 && h.html.includes('<h1>') && !h.html.includes('<code>'), h.html);
  }
  {
    // (2) Whitespace-only blank lines close paragraphs: indented code
    // follows, math literal inside it.
    for (const [name, blank] of [
      ['spaces', '   '],
      ['tab', '\t'],
      ['mixed', ' \t '],
    ]) {
      const r = renderMarkdown(`# h\n${blank}\n    $x$`);
      check(`lead: blank line of ${name} yields heading + literal-math code`,
        r.mathCount === 0 && r.html.includes('<h1>') && r.html.includes('<pre><code>$x$'),
        `math=${r.mathCount} html=${r.html}`);
    }
  }
  {
    // (3) Table header with a pipe inside a code span: GFM splits the row
    // on the raw pipe (3 columns), the indented line after the table is
    // code with literal math; column mismatch => no table, math renders.
    const good = renderMarkdown('| `a|b` | h |\n| --- | --- | --- |\n    $x$');
    check('lead: span-pipe header builds the native 3-column table + code',
      (good.html.match(/<th>/g) || []).length === 3 && good.mathCount === 0 &&
        good.html.includes('<pre><code>$x$') && !good.html.includes('katex-html'),
      `math=${good.mathCount} html=${good.html}`);
    const bad = renderMarkdown('| `a|b` | h |\n| --- | --- |\n    $x$');
    check('lead: span-pipe header column mismatch keeps math visible',
      (bad.html.match(/<table>/g) || []).length === 0 && bad.mathCount === 1 && bad.html.includes(K),
      `math=${bad.mathCount} html=${bad.html}`);
    // Ordinary prose spans with pipes keep their code rendering.
    const prose = renderMarkdown('see `a|b` here and $y$ there');
    check('lead: pipe-carrying span in prose still renders as code',
      prose.html.includes('<code>a|b</code>') && prose.mathCount === 1, prose.html);
  }

  // 29. Lead round 3: cell-aware table protection — exact column counts,
  // cell texts, mathCount and code constructs (not just table presence).
  {
    const cellsOf = (html) => (html.match(/<t[hd]>(?:<code>|<span class="katex">)?([^<]*)/g) || []);
    // A: math token crossing header cells.
    const a = renderMarkdown('| $a|b$ | h |\n| --- | --- | --- |\n    $x$');
    check('lead3: mathPipeHeader keeps 3 literal columns + code after',
      (a.html.match(/<th>/g) || []).length === 3 &&
        a.html.includes('<th>$a</th>') && a.html.includes('<th>b$</th>') &&
        a.mathCount === 0 && a.html.includes('<pre><code>$x$') &&
        !a.html.includes('katex-html'),
      `math=${a.mathCount} html=${a.html.slice(0, 220)}`);
    // B1: code span crossing body cells.
    const b1 = renderMarkdown('| a | b | c |\n| --- | --- | --- |\n| `x|y` | h |');
    check('lead3: codePipeBody splits into literal cells, no code element',
      (b1.html.match(/<td>/g) || []).length === 3 &&
        b1.html.includes('<td>`x</td>') && b1.html.includes('<td>y`</td>') &&
        !b1.html.includes('<code>') && b1.mathCount === 0,
      b1.html);
    // B2: math crossing body cells.
    const b2 = renderMarkdown('| a | b | c |\n| --- | --- | --- |\n| $x|y$ | h |');
    check('lead3: mathPipeBody stays literal fragments',
      b2.html.includes('<td>$x</td>') && b2.html.includes('<td>y$</td>') &&
        b2.mathCount === 0 && !b2.html.includes('katex-html'),
      `math=${b2.mathCount} html=${b2.html}`);
    // C: same-row mix — cell-local $m$ renders, cross-cell stays literal.
    const c = renderMarkdown('| $m$ | $a|b$ | h |\n| --- | --- | --- | --- |\n    $x$');
    check('lead3: mixed 4-column header renders $m$, literals and code',
      (c.html.match(/<th>/g) || []).length === 4 &&
        c.mathCount === 1 && c.html.includes(K) &&
        c.html.includes('<th>$a</th>') && c.html.includes('<th>b$</th>') &&
        c.html.includes('<pre><code>$x$') && cellsOf(c.html).length > 0 &&
        !/<pre><code>[\s\S]*?katex-html/.test(c.html),
      `math=${c.mathCount} html=${c.html.slice(0, 260)}`);
    // C body equivalent.
    const cb = renderMarkdown('| a | b | c | d |\n| --- | --- | --- | --- |\n| $m$ | $a|b$ | h |');
    check('lead3: mixed body row renders $m$ and keeps fragments literal',
      (cb.html.match(/<td>/g) || []).length === 4 &&
        cb.mathCount === 1 && cb.html.includes(K) &&
        cb.html.includes('<td>$a</td>') && cb.html.includes('<td>b$</td>'),
      `math=${cb.mathCount} html=${cb.html}`);
    // Code + math mixed header: cell-local span renders as code_inline,
    // cross-cell math stays literal, indented line after the table is code.
    const cm = renderMarkdown('| `c` | $a|b$ |\n| --- | --- | --- |\n    $x$');
    check('lead3: code+math mixed header keeps cell-local span protected',
      (cm.html.match(/<th>/g) || []).length === 3 &&
        cm.html.includes('<th><code>c</code></th>') &&
        cm.html.includes('<th>$a</th>') && cm.html.includes('<th>b$</th>') &&
        cm.mathCount === 0 && cm.html.includes('<pre><code>$x$'),
      `math=${cm.mathCount} html=${cm.html.slice(0, 260)}`);
    // Pipes in ordinary paragraphs still pair freely.
    const pp = renderMarkdown('see `a|b` here and $y$ there');
    check('lead3: paragraph pipes unaffected by row mode',
      pp.html.includes('<code>a|b</code>') && pp.mathCount === 1, pp.html);
  }

  // 30. Lead round 5: invalid table candidates stay paragraphs — cross-pipe
  // math renders in its own paragraph (mathCount=2, no table, both KaTeX).
  {
    const invalid = [
      ['column count mismatch', '| $a|b$ | h |\n| --- | --- |\n    $x$'],
      ['delimiter indented 4', '| $a|b$ | h |\n    | --- | --- | --- |\n    $x$'],
      ['header indented 4 in open paragraph', 'paragraph\n    | $a|b$ | h |\n| --- | --- | --- |\n    $x$'],
      ['delimiter is a list marker', '| $a|b$ | h |\n- | - | - |\n    $x$'],
      ['invalid delimiter cell shape', '| $a|b$ | h |\n| --- | nope | --- |\n    $x$'],
    ];
    for (const [name, src] of invalid) {
      const r = renderMarkdown(src);
      const katexCount = (r.html.match(/katex-html/g) || []).length;
      check(`lead5: invalid candidate (${name}) renders both paragraphs' math`,
        r.mathCount === 2 && !r.html.includes('<table>') && !r.html.includes('<pre>') &&
          katexCount === 2,
        `math=${r.mathCount} katex=${katexCount} html=${r.html.slice(0, 200)}`);
    }
    // Over-restriction guard: a cell-local $m$ in an invalid candidate
    // still renders (all three pair as ordinary paragraph math).
    const mix = renderMarkdown('| $m$ | $a|b$ | h |\n| --- | --- |\n    $x$');
    check('lead5: invalid candidate still renders cell-local $m$',
      mix.mathCount === 3 && !mix.html.includes('<table>') &&
        (mix.html.match(/katex-html/g) || []).length === 3,
      `math=${mix.mathCount} html=${mix.html.slice(0, 200)}`);
    // The escaped-pipe illusion breaker renders the delimiter as literal
    // paragraph text, byte-identical to the native rendering.
    const brk = renderMarkdown('| $a|b$ | h |\n| --- | --- |\n    $x$');
    check('lead5: broken delimiter row renders as literal paragraph text',
      brk.html.includes('| --- | --- |') && !brk.html.includes('\\|'),
      brk.html.slice(0, 200));
  }

  // 31. Lead round 6 render regressions (exact outcomes, not just shapes).
  {
    // (1) Span must not swallow a line-start fence closer: paragraph math
    // renders, the fence stays a fence with literal content.
    for (const [len, fence] of [[3, '```'], [4, '````'], [5, '`````']]) {
      const r = renderMarkdown(`para ${fence}x\n${fence}\n$y$`);
      check(`lead6: len-${len} closer line ends the span, fence keeps math literal`,
        r.mathCount === 0 && r.html.includes('<pre>') && r.html.includes('$y$') &&
          !r.html.includes('<code>x'),
        `math=${r.mathCount} html=${r.html}`);
    }
    // (2) Link reference definitions close the block; indented math after
    // them is literal code. Mid-paragraph "defs" stay paragraph text.
    for (const [name, src] of [
      ['single-line def', '[a]: /url\n    $x$'],
      ['two-line dest', '[a]:\n/url\n    $x$'],
      ['title continuation', '[a]: /url\n"t"\n    $x$'],
    ]) {
      const r = renderMarkdown(src);
      check(`lead6: linkdef (${name}) followed by literal code`,
        r.mathCount === 0 && r.html.includes('<pre><code>$x$') && !r.html.includes('katex-html'),
        `math=${r.mathCount} html=${r.html}`);
    }
    const midpara = renderMarkdown('foo\n[a]: /url\n    $x$');
    check('lead6: def-shaped line mid-paragraph stays paragraph math',
      midpara.mathCount === 1 && !midpara.html.includes('<pre>') && midpara.html.includes(K),
      `math=${midpara.mathCount} html=${midpara.html}`);
    // (3) List-shaped headers are tables; following indented line is code.
    for (const [name, src] of [
      ['ordered start 1', '1. h | j\n--- | ---\n    $x$'],
      ['ordered start 2', '2. h | j\n--- | ---\n    $x$'],
      ['dash', '- h | j\n--- | ---\n    $x$'],
      ['after a paragraph', 'para\n1. h | j\n--- | ---\n    $x$'],
    ]) {
      const r = renderMarkdown(src);
      check(`lead6: list-shaped header (${name}) builds the native table`,
        (r.html.match(/<th>/g) || []).length === 2 && r.mathCount === 0 &&
          r.html.includes('<pre><code>$x$') && !r.html.includes('katex-html'),
        `math=${r.mathCount} html=${r.html.slice(0, 220)}`);
    }
    // (4) Short dashes.
    const dd = renderMarkdown('--\n    $x$');
    check('lead6: "--" is plain paragraph text, math renders',
      dd.mathCount === 1 && !dd.html.includes('<pre>') && dd.html.includes(K), dd.html);
    const sd = renderMarkdown('-\n    $x$');
    check('lead6: single "-" is a list item, math renders',
      sd.mathCount === 1 && !sd.html.includes('<pre>') && sd.html.includes(K), sd.html);
    // (5) Backtick fence info containing a backtick: paragraph + math.
    const fb = renderMarkdown('```bad`info\n$y$\n```');
    check('lead6: backtick fence-info is a paragraph, math renders',
      fb.mathCount === 1 && fb.html.includes(K) && fb.html.includes('<p>```bad`info') &&
        !fb.html.includes('<code>bad'),
      `math=${fb.mathCount} html=${fb.html.slice(0, 180)}`);
    const qfb = renderMarkdown('> ```bad`info\n> $y$\n> ```');
    check('lead6: quote backtick fence-info is a quote paragraph, math renders',
      qfb.mathCount === 1 && qfb.html.includes(K) && qfb.html.includes('bad`info'),
      `math=${qfb.mathCount} html=${qfb.html.slice(0, 180)}`);
    // (6) EOF without final newline behaves like with.
    const eofBad = renderMarkdown('| $a|b$ | h |\n| --- | --- |');
    check('lead6: invalid table at EOF (no LF) stays a paragraph',
      eofBad.mathCount === 1 && !eofBad.html.includes('<table>') && eofBad.html.includes(K),
      `math=${eofBad.mathCount} html=${eofBad.html.slice(0, 180)}`);
    const eofGood = renderMarkdown('| a | h |\n| --- | --- |');
    check('lead6: valid table at EOF (no LF) still renders',
      (eofGood.html.match(/<th>/g) || []).length === 2, eofGood.html.slice(0, 180));
  }

  // 32. Lone-surrogate contract: a query containing an unpaired surrogate
  // half matches nothing; no range ever cuts a surrogate pair.
  {
    const j = (v) => JSON.stringify(v);
    check('m3: half-surrogate high query matches nothing',
      j(ctx.MathMD.foldedMatchRanges('😀', '\uD83D')) === '[]',
      j(ctx.MathMD.foldedMatchRanges('😀', '\uD83D')));
    check('m3: half-surrogate low query matches nothing',
      j(ctx.MathMD.foldedMatchRanges('😀', '\uDE00')) === '[]',
      j(ctx.MathMD.foldedMatchRanges('😀', '\uDE00')));
    check('m3: whole emoji query still matches',
      j(ctx.MathMD.foldedMatchRanges('a😀b', '😀')) === '[[1,3]]',
      j(ctx.MathMD.foldedMatchRanges('a😀b', '😀')));
  }

  // 33. linkrefs (P0 round): link reference definitions and references
  // with math inside labels; variant-token restoration; literal
  // destination/title; visible mathCount; live-token invariants in three
  // layers (protected intermediate, parser output, final HTML).
  {
    const normRef = ctx.MathMD.normalizeReference;
    const mdNative = ctx.markdownit({ html: false, linkify: true });
    const TOKENS = /MMATHMDPH|MCODEPH|MLABELPH|MLITPH/;

    // ---- normalizeReference: exact vendored replica ----
    {
      const vectors = [
        'a', 'A b', ' a  b ', 'İ ΟΣ', 'ẞ ß', 'ΣΣΑ', 'straße', 'STRASSE',
        'ᾼ', 'ǅungla', 'Ǆungla', 'ı', 'I', 'a\tb\nc', 'é', 'É',
        '𐐀', '𐐨', '\u00a0x', 'ﬁ', 'Å', 'Ω', 'ω',
      ];
      let ok = true;
      const bad = [];
      for (const v of vectors) {
        if (normRef(v) !== mdNative.utils.normalizeReference(v)) {
          ok = false; bad.push(v);
        }
      }
      // Fuzz: mixed random-ish strings over a Unicode-heavy alphabet.
      let seed = 42;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
      const alphabet = 'aAβßΣİı Ö\tdjangoǅǄﬁÅ𐐀𐐨😀é́xX0';
      for (let k = 0; k < 400; k++) {
        let s = '';
        const len = 1 + (rnd() % 12);
        for (let c = 0; c < len; c++) s += alphabet[rnd() % alphabet.length];
        if (normRef(s) !== mdNative.utils.normalizeReference(s)) {
          ok = false; bad.push(s);
        }
      }
      check('linkrefs: normalizeReference matches vendored (vectors + fuzz)',
        ok, `mismatches=${JSON.stringify(bad.slice(0, 8))}`);
      check('linkrefs: normalizeReference collapses/uppercases',
        normRef('  a \n b ') === 'A B' && normRef('ẞ') === 'SS', normRef('  a \n b '));
    }

    // ---- N9 and the definition-shape counterexamples ----
    {
      const cases = [
        // [name, src, expected mathCount, html probe]
        ['N9 pending dest 4-space', '[a]:\n    /url\n    $x$', 0, '<pre><code>$x$'],
        ['pending dest 8-space', '[a]:\n        /url\n    $x$', 0, '<pre><code>$x$'],
        ['pending dest tab', '[a]:\n\t/url\n    $x$', 0, '<pre><code>$x$'],
        ['dest 4sp + title 8sp', '[a]:\n    /url\n        "t"\n    $x$', 0, '<pre><code>$x$'],
        ['single-line dest+title', '[a]: /url "t"\n    $x$', 0, '<pre><code>$x$'],
        ['angle dest with space', '[a]: <a b>\n    $x$', 0, '<pre><code>$x$'],
        ['escaped bracket in label', '[a\\]]: /url\n    $x$', 0, '<pre><code>$x$'],
        ['escaped quote in title', '[a]: /url "a \\"title\\""\n    $x$', 0, '<pre><code>$x$'],
        ['multi-line label', '[a\nb]: /url\n    $x$', 0, '<pre><code>$x$'],
        ['multi-line title', '[a]: /url "one\ntwo"\n    $x$', 0, '<pre><code>$x$'],
        ['multiple defs with titles', '[a]: /a "one"\n[b]: /b "two"\n    $x$', 0, '<pre><code>$x$'],
        ['pending + blank fails', '[a]:\n\n/url\n    $x$', 1, 'katex'],
        ['pending lone dash is setext', '[a]:\n-\n$x$', 1, '<h2>'],
        ['pending lone dash-run is setext', '[a]:\n---\n$x$', 1, '<h2>'],
        ['pending pure list marker fails', '[a]:\n*\n    $x$', 1, 'katex'],
        ['pending bare -url dest works', '[a]:\n-url\n    $x$', 0, '<pre><code>$x$'],
        ['invalid unterminated angle', '[a]: <bad\n    $x$', 1, 'katex'],
        ['invalid unbalanced paren', '[a]: /url(\n    $x$', 1, 'katex'],
        ['second title is a paragraph', '[a]: /url "one"\n"two"\n    $x$', 1, 'katex'],
        ['junk after dest invalid', '[a]: /u junk\n    $x$', 1, 'katex'],
        ['mid-paragraph def stays text', 'foo\n[a]: /url\n    $x$', 1, 'katex'],
        ['no space after colon valid', '[a]:/url\n    $x$', 0, '<pre><code>$x$'],
        ['not-title falls back to indented code', '[a]: /u\n        "t" x\n    $y$', 0, '&quot;t&quot; x'],
        ['mixed-indent title continuation', '[a]: /u\n   \t "t"\n    $x$', 0, '<pre><code>$x$'],
        ['CRLF def', '[a]: /url\r\n    $x$', 0, '<pre><code>$x$'],
      ];
      for (const [name, src, m, probe] of cases) {
        const r = renderMarkdown(src, { tsvTables: false });
        check(`linkrefs: def shape (${name})`,
          r.mathCount === m && r.html.includes(probe) && !TOKENS.test(r.html),
          `math=${r.mathCount} want=${m} html=${r.html.slice(0, 160)}`);
      }
    }

    // ---- labels with math: resolution + visible restoration ----
    {
      // Definition BEFORE and AFTER the reference; all reference forms;
      // every raw variant restored at its own position.
      const before = renderMarkdown(
        '[a$x$]: /url.md "the title"\n' +
        'see [a$x$] plus [t][a$x$] plus [a$x$][] plus ![a$x$] and [q$x$][a$x$]',
        { tsvTables: false });
      check('linkrefs: pre-def references resolve with visible label math',
        before.html.includes('href="/url.md"') &&
          before.html.includes('title="the title"') &&
          (before.html.match(/katex-html/g) || []).length === 3 &&
          !TOKENS.test(before.html),
        before.html.slice(0, 400));
      const after = renderMarkdown(
        'see [a$x$] first\n\n[a$x$]: /url', { tsvTables: false });
      check('linkrefs: reference before its definition still resolves',
        after.html.includes('href="/url"') && after.mathCount === 1 && !TOKENS.test(after.html),
        `math=${after.mathCount} html=${after.html.slice(0, 200)}`);

      // Same normalized label, DIFFERENT raw variants: each occurrence
      // restores its own raw text (mixed-case variant tokens).
      const variants = renderMarkdown(
        '[A $x$]: /u\n' +
        'one [a $x$] two [A\t$x$] three [t][a $x$] four [a $x$][]',
        { tsvTables: false });
      check('linkrefs: per-occurrence raw variants restored',
        variants.mathCount === 3 && !TOKENS.test(variants.html) &&
          (variants.html.match(/<a href="\/u">/g) || []).length === 4,
        `math=${variants.mathCount} html=${variants.html.slice(0, 300)}`);

      // Undefined references and inline links keep their math visible and
      // never turn into broken links.
      const undef = renderMarkdown('[a$x$]: /u\n[nope$y$] and [k$x$](/i)', { tsvTables: false });
      check('linkrefs: undefined reference stays literal with visible math',
        undef.html.includes('[nope') && undef.mathCount === 2 && !TOKENS.test(undef.html),
        `math=${undef.mathCount} html=${undef.html.slice(0, 200)}`);
      const prio = renderMarkdown('[t$x$]: /r\n[t$x$](/inline)', { tsvTables: false });
      check('linkrefs: inline link wins over a same-label definition',
        prio.html.includes('href="/inline"') && prio.mathCount === 1 && !TOKENS.test(prio.html),
        prio.html.slice(0, 200));

      // Image alt (attribute): label restored as esc(raw), math NOT counted.
      const img = renderMarkdown('[a$x$]: /u\n![a$x$]', { tsvTables: false });
      check('linkrefs: image alt restores raw label, math not counted',
        img.html.includes('alt="a$x$"') && img.mathCount === 0 && !TOKENS.test(img.html),
        img.html.slice(0, 200));

      // Definitions in code constructs are never tokenized.
      const fenceDef = renderMarkdown('```\n[a$x$]: /u\n```\nsee [a$x$]', { tsvTables: false });
      check('linkrefs: fence-internal definition not recognized',
        fenceDef.html.includes('[a$x$]: /u') && fenceDef.mathCount === 1 &&
          !TOKENS.test(fenceDef.html),
        fenceDef.html.slice(0, 200));

      // All four delimiters inside labels.
      for (const [name, d] of [
        ['dollar', '[a$x$]: /u\n[a$x$]'],
        ['display', '[a$$x$$]: /u\n[a$$x$$]'],
        ['paren', '[a\\(x\\)]: /u\n[a\\(x\\)]'],
        ['bracket', '[a\\[x\\]]: /u\n[a\\[x\\]]'],
      ]) {
        const r = renderMarkdown(d, { tsvTables: false });
        check(`linkrefs: ${name} delimiter label resolves + restores`,
          r.html.includes('href="/u"') && !TOKENS.test(r.html),
          `math=${r.mathCount} html=${r.html.slice(0, 220)}`);
      }
    }

    // ---- three-layer live-token invariants ----
    {
      const src = '[a$x$]: /u "t"\nsee [a$x$] and [q][a$x$] and ![a$x$]';
      const prot = protectMath(src);
      // Layer 1: protected intermediate — exactly one definition rewrite,
      // three reference tokens, dest+title literals; no orphan tokens.
      const labelCount = (prot.text.match(/MLABELPH[A-Z0-9]{1,8}[0-9]+[aA]{32}MMM/g) || []).length;
      const litCount = (prot.text.match(/MLITPH[A-Z0-9]{1,8}[0-9]+MLM/g) || []).length;
      check('linkrefs: layer1 protected shape (1 def + 3 refs + 2 lits)',
        labelCount === 4 && litCount === 2 &&
          prot.labels.length === 4 && prot.lits.length === 2 &&
          prot.labels.every((s) => prot.text.includes(s.token)) &&
          prot.lits.every((s) => prot.text.includes(s.token)),
        `labels=${labelCount} lits=${litCount} text=${JSON.stringify(prot.text)}`);
      // Layer 2: parser output — no ordinary math/code tokens anywhere;
      // the consumed definition line is gone; the link/image href is the
      // literal token that the restore pass must replace.
      const env = {};
      const tokens = mdNative.parse(prot.text, env);
      const flat = JSON.stringify(tokens);
      check('linkrefs: layer2 parser output has no math/code placeholders',
        !/MMATHMDPH|MCODEPH/.test(flat), flat.slice(0, 200));
      const r = renderMarkdown(src, { tsvTables: false });
      // Layer 3: final HTML — no generated tokens survive; visible label
      // math counts once per visible occurrence; image alt does not.
      check('linkrefs: layer3 final html free of generated tokens',
        !TOKENS.test(r.html), r.html.slice(0, 200));
      // Visible: the shortcut label (1). The full reference's SECOND label
      // is consumed by the parser and the image alt restores as an
      // attribute literal — neither counts.
      check('linkrefs: layer3 mathCount is the restore-time visible count',
        r.mathCount === 1, `math=${r.mathCount} html=${r.html.slice(0, 300)}`);
    }

    // ---- list/table HIDE and INJECT, both directions (matrix) ----
    {
      // HIDE direction: cases where math MUST render (never code).
      const hide = [
        ['plain header no blank (lazy)', '- item\nh | j\n--- | ---\n    $x$'],
        ['same-family marker header', '- item\n- h | j\n--- | ---\n    $x$'],
        ['same ordered family', '2. item\n1. h | j\n--- | ---\n    $x$'],
        ['same family after blank', '- item\n\n- h | j\n--- | ---\n    $x$'],
      ];
      for (const [name, s] of hide) {
        const r = renderMarkdown(s, { tsvTables: false });
        check(`table: HIDE (${name}) — math renders, no table, no code`,
          r.mathCount === 1 && !r.html.includes('<table>') && !r.html.includes('<pre>') &&
            r.html.includes(K) && !TOKENS.test(r.html),
          `math=${r.mathCount} html=${r.html.slice(0, 200)}`);
      }
      // INJECT direction: native tables keep their math literal in code.
      const inject = [
        ['different family no blank (ordered)', '- item\n1. h | j\n--- | ---\n    $x$'],
        ['different family no blank (bullet)', '- item\n* h | j\n--- | ---\n    $x$'],
        ['ordered to bullet', '1. item\n- h | j\n--- | ---\n    $x$'],
        ['different family after blank', '- item\n\n1. h | j\n--- | ---\n    $x$'],
        ['plain header after blank', '- item\n\nh | j\n--- | ---\n    $x$'],
        ['no list at all', '1. h | j\n--- | ---\n    $x$'],
      ];
      for (const [name, s] of inject) {
        const r = renderMarkdown(s, { tsvTables: false });
        check(`table: INJECT (${name}) — table forms, math literal in code`,
          r.mathCount === 0 && r.html.includes('<table>') &&
            r.html.includes('<pre><code>$x$') && !r.html.includes('katex-html'),
          `math=${r.mathCount} html=${r.html.slice(0, 240)}`);
      }
      // Table body then code: an indented line after a table BODY is code.
      const bodyCode = renderMarkdown('h | j\n--- | ---\n| b |\n    $x$', { tsvTables: false });
      check('table: body row then indented code keeps math literal',
        bodyCode.mathCount === 0 && bodyCode.html.includes('<table>') &&
          bodyCode.html.includes('<pre><code>$x$'),
        bodyCode.html.slice(0, 200));

      // Native markdown-it forms a table inside the list item here. MathMD
      // preserves that container structure and renders the cell-local math;
      // this is a supported positive case, not a registered divergence.
      const inList = renderMarkdown('- h | j\n    | --- | --- |\n    $x$', { tsvTables: false });
      check('table: indented-delimiter list item preserves native table and renders cell math',
        inList.mathCount === 1 && inList.html.includes('<li>') &&
          inList.html.includes('<table>') && inList.html.includes('<td>') &&
          inList.html.includes(K) && !TOKENS.test(inList.html),
        `math=${inList.mathCount} html=${inList.html.slice(0, 200)}`);
    }
  }

  // 34. P1 round fixes: attribute-content literals (vendored
  // normalizeLink), CRLF logical EOLs, legacy-grammar removal (setext
  // priority after `[a]:`), multiline-title split semantics, and
  // token-collision adversarial cases.
  {
    const normRef = ctx.MathMD.normalizeReference;
    const mdNative2 = ctx.markdownit({ html: false, linkify: true });
    const TOKENS2 = /MMATHMDPH|MCODEPH|MLABELPH|MLITPH/;

    // ---- (1) attribute content: dest/title shells removed, dest
    // percent-encoded exactly like the vendored renderer ----
    {
      const attr = [
        // [name, def, expected href, expected title]
        ['plain dest', '[a]: /url', '/url', null],
        ['angle with space', '[a]: <a b>', 'a%20b', null],
        ['empty angle', '[a]: <>', '', null],
        ['unicode dest', '[a]: /中文', '/%E4%B8%AD%E6%96%87', null],
        // MathMD literal contract: math-delimiter escapes stay VERBATIM in
        // attribute content (href "/\(x\)/foo"), unlike bare markdown-it.
        ['escaped parens dest', '[a]: /\\(x\\)/foo', '/\\(x\\)/foo', null],
        ['escaped brackets dest', '[a]: /\\[x\\]/foo', '/\\[x\\]/foo', null],
        ['math delimiters in title', '[a]: /u "title \\(x\\)"', '/u', 'title \\(x\\)'],
        ['percent dest kept', '[a]: /sp%20ace', '/sp%20ace', null],
        ['double-quoted title', '[a]: /url "one"', '/url', 'one'],
        ['single-quoted title', '[a]: /url \'one\'', '/url', 'one'],
        ['paren title', '[a]: /url (one)', '/url', 'one'],
        ['escaped quote in title', '[a]: /url "a \\"q\\""', '/url', 'a &quot;q&quot;'],
      ];
      for (const [name, def, href, title] of attr) {
        const r = renderMarkdown(`${def}\n\n[a]`, { tsvTables: false });
        check(`linkrefs-attr: (${name}) matches native attribute content`,
          r.html.includes(`href="${href}"`) &&
            (title === null || r.html.includes(`title="${title}"`)) &&
            !TOKENS2.test(r.html),
          `want href="${href}" title="${title}" html=${r.html.slice(0, 160)}`);
      }
      // Four math delimiters inside labels still resolve with the new
      // attribute pipeline.
      for (const [name, d] of [
        ['dollar', '[a$x$]: /u "t"\n\n[a$x$]'],
        ['display', '[a$$x$$]: /u "t"\n\n[a$$x$$]'],
        ['paren', '[a\\(x\\)]: /u "t"\n\n[a\\(x\\)]'],
        ['bracket', '[a\\[x\\]]: /u "t"\n\n[a\\[x\\]]'],
      ]) {
        const r = renderMarkdown(d, { tsvTables: false });
        check(`linkrefs-attr: ${name}-delimited label + title restores`,
          r.html.includes('href="/u"') && r.html.includes('title="t"') &&
            !TOKENS2.test(r.html),
          r.html.slice(0, 200));
      }
    }

    // ---- (2) CRLF logical EOL: no trailing CR in attributes, no pseudo
    // code block from a CR in a pending destination ----
    {
      const full = renderMarkdown('[a]: /url\r\n\r\n[a]', { tsvTables: false });
      check('linkrefs-crlf: complete def has no trailing CR in href',
        full.html.includes('href="/url"') && !full.html.includes('\r') &&
          !TOKENS2.test(full.html),
        JSON.stringify(full.html.slice(0, 160)));
      const pend = renderMarkdown('[a]:\r\n    /url\r\n\r\n[a]', { tsvTables: false });
      check('linkrefs-crlf: pending dest 4-space + CRLF resolves, no code block',
        pend.html.includes('href="/url"') && !pend.html.includes('<pre>') &&
          !full.html.includes('\r'),
        JSON.stringify(pend.html.slice(0, 160)));
      const crlfTitle = renderMarkdown('[a]: /url\r\n    "t"\r\n\r\n[a]', { tsvTables: false });
      check('linkrefs-crlf: title continuation across CRLF',
        crlfTitle.html.includes('title="t"') && !crlfTitle.html.includes('\r'),
        JSON.stringify(crlfTitle.html.slice(0, 160)));
    }

    // ---- (3) legacy grammar gone: `[a]:` uncollected lines are
    // paragraphs, so setext/list priority is native again ----
    {
      const setext = renderMarkdown('[a]:\n-\n    $x$', { tsvTables: false });
      check('linkrefs-setext: `[a]:` + `-` is a setext heading + literal code',
        setext.html.includes('<h2>[a]:</h2>') && setext.mathCount === 0 &&
          setext.html.includes('<pre><code>$x$') && !setext.html.includes(K),
        `math=${setext.mathCount} html=${setext.html.slice(0, 160)}`);
      const equals = renderMarkdown('[a]:\n=\n    $x$', { tsvTables: false });
      check('linkrefs-setext: `[a]:` + `=` stays definition (native quirk)',
        equals.mathCount === 0 && equals.html.includes('<pre><code>$x$'),
        `math=${equals.mathCount} html=${equals.html.slice(0, 160)}`);
      for (const marker of ['*', '+', '1.']) {
        const r = renderMarkdown(`[a]:\n${marker}\n    $x$`, { tsvTables: false });
        check(`linkrefs-setext: pending + lone ${JSON.stringify(marker)} keeps math visible`,
          r.mathCount === 1 && r.html.includes(K),
          `math=${r.mathCount} html=${r.html.slice(0, 160)}`);
      }
      const bare = renderMarkdown('[a]:\n-url\n    $x$', { tsvTables: false });
      check('linkrefs-setext: legal bare -url destination still a definition',
        bare.mathCount === 0 && bare.html.includes('<pre><code>$x$'),
        `math=${bare.mathCount} html=${bare.html.slice(0, 160)}`);
      const good = renderMarkdown('[a]: /url\n    $x$', { tsvTables: false });
      check('linkrefs-setext: ordinary valid def regression',
        good.mathCount === 0 && good.html.includes('<pre><code>$x$'),
        good.html.slice(0, 120));
    }

    // ---- (4) multiline-title split: same-line open vs next-line open,
    // and first-closer-junk fails the candidate ----
    {
      // Same-line open + blank: whole candidate fails; the reference is
      // literal and the label math still renders in it.
      const f4a = renderMarkdown('[a$x$]: /url "one\n\ntwo"\n    $y$\n\n[a$x$]', { tsvTables: false });
      // Candidate failed: the def-line label, the $y$ paragraph, and the
      // (now literal) reference label each render their math visibly.
      check('linkrefs-mltitle: same-line open + blank fails whole candidate',
        !f4a.html.includes('href="/url"') && f4a.mathCount === 3 &&
          !TOKENS2.test(f4a.html),
        `math=${f4a.mathCount} html=${f4a.html.slice(0, 200)}`);
      // Next-line open + blank: the no-title definition survives.
      const f4b = renderMarkdown('[a$x$]: /url\n"one\n\ntwo"\n    $y$\n\n[a$x$]', { tsvTables: false });
      check('linkrefs-mltitle: next-line open + blank keeps no-title definition',
        f4b.html.includes('href="/url"') && !f4b.html.includes('title=') &&
          !TOKENS2.test(f4b.html),
        f4b.html.slice(0, 240));
      // First closer followed by junk on a CONTINUATION line: the
      // no-title definition SURVIVES (native), the title-shaped text is
      // an ordinary paragraph, and no later closer is used.
      const f5 = renderMarkdown('[a$x$]: /url\n"one\ntwo" junk\nthree\"\n    $y$\n\n[a$x$]', { tsvTables: false });
      check('linkrefs-mltitle: next-line open + closer-junk keeps no-title definition',
        f5.html.includes('href="/url"') && !f5.html.includes('title=') &&
          f5.mathCount === 2 && !TOKENS2.test(f5.html),
        `math=${f5.mathCount} html=${f5.html.slice(0, 260)}`);
      // Same-line open + closer-junk on a continuation line: whole
      // candidate fails; the reference is literal with its label math.
      const f5b = renderMarkdown('[a$x$]: /url "one\ntwo" junk\nthree\"\n    $y$\n\n[a$x$]', { tsvTables: false });
      check('linkrefs-mltitle: same-line open + closer-junk fails whole candidate',
        !f5b.html.includes('href="/url"') && !f5b.html.includes('title=') &&
          f5b.mathCount === 3 && !TOKENS2.test(f5b.html),
        `math=${f5b.mathCount} html=${f5b.html.slice(0, 260)}`);
      // Definition BEFORE and AFTER the reference, label math, same rules.
      const f5c = renderMarkdown('[a$x$]: /url\n"one\ntwo" junk\n[a$x$]\n[b]: /v', { tsvTables: false });
      check('linkrefs-mltitle: definition before reference with closer-junk',
        f5c.html.includes('href="/url"') && f5c.mathCount === 1 &&
          !TOKENS2.test(f5c.html),
        `math=${f5c.mathCount} html=${f5c.html.slice(0, 260)}`);
      // Definition AFTER the reference; same normalized label defined twice
      // (different raw variants) — the FIRST wins for every occurrence.
      const both = renderMarkdown(
        'see [a$x$]\n\n[A$x$]: /u "ta"\n\n[a$x$]: /w',
        { tsvTables: false });
      check('linkrefs-mltitle: def after ref resolves, first normalized wins',
        both.html.includes('href="/u"') && both.html.includes('title="ta"') &&
          !both.html.includes('href="/w"') && !TOKENS2.test(both.html),
        both.html.slice(0, 240));
    }

    // ---- (5) token-collision adversarial: all four token prefixes as
    // literal label text ----
    {
      for (const [prefix, tok] of [
        ['MMATHMDPH', 'MMATHMDPHK7F0MMM'],
        ['MCODEPH', 'MCODEPHK7F0MMM'],
        ['MLABELPH', 'MLABELPHK70aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaMMM'],
        ['MLITPH', 'MLITPHK70MLM'],
      ]) {
        const label = `a ${tok} $x$`;
        const src = `[${label}]: /u\n\nsee [${label}]`;
        const r = renderMarkdown(src, { tsvTables: false });
        // The document DELIBERATELY contains token-shaped literal text, so
        // the final-HTML token scan must exempt the literal itself: it must
        // appear exactly once (in the visible label) and never as rendered
        // math/code — only the real $x$ counts.
        const literalOnce = r.html.split(tok).length === 2;
        check(`linkrefs-collision: literal ${prefix} token in label stays literal`,
          literalOnce && r.mathCount === 1 &&
            r.html.includes('href="/u"') &&
            !TOKENS2.test(r.html.replace(tok, 'X')),
          `math=${r.mathCount} occurrences=${r.html.split(tok).length - 1} html=${r.html.slice(0, 260)}`);
      }
      // A literal token equal to the fragment's own first math token must
      // not double-render: only ONE formula, the literal stays text.
      const collide = renderMarkdown(
        '[a MMATHMDPHK7F0MMM $x$]: /u\n\n[a MMATHMDPHK7F0MMM $x$]',
        { tsvTables: false });
      const lit = 'MMATHMDPHK7F0MMM';
      check('linkrefs-collision: dynamic fragment salt avoids token collision',
        collide.mathCount === 1 &&
          collide.html.split(lit).length === 2 && // literal appears once, as text
          !TOKENS2.test(collide.html.replace(lit, 'X')),
        `math=${collide.mathCount} occurrences=${collide.html.split(lit).length - 1} html=${collide.html.slice(0, 260)}`);

      // ---- joint restore: a token-shaped LITERAL inside a restored
      // attribute (or any insertion) is never re-matched by another
      // family ----
      {
        const cross = [
          ['math token in dest', 'MMATHMDPHK70MMM', '[a]: /MMATHMDPHK70MMM\n\n[a]\n\n$x$'],
          ['code token in dest', 'MCODEPHK70MMM', '[a]: /MCODEPHK70MMM\n\n[a]\n\n`c` $x$'],
          ['lit token in dest', 'MLITPHK70MLM', '[a]: /MLITPHK70MLM\n\n[a]\n\n$x$'],
          ['label token in dest', 'MLABELPHK70aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaMMM', '[a]: /MLABELPHK70aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaMMM\n\n[a]\n\n$x$'],
        ];
        for (const [name, tokLit, src] of cross) {
          const r = renderMarkdown(src, { tsvTables: false });
          // The literal must survive verbatim inside the href; the REAL
          // math/code elsewhere must restore normally and count once.
          check(`linkrefs-joint: ${name} stays literal in href, real constructs restore`,
            r.html.includes(`href="/${tokLit}"`) &&
              !TOKENS2.test(r.html.replace(tokLit, 'X')) &&
              (src.includes('$x$') ? r.mathCount === 1 : true) &&
              (src.includes('`c`') ? r.html.includes('<code>c</code>') : true),
            `math=${r.mathCount} html=${r.html.slice(0, 260)}`);
        }
      }

      // ---- fragSalt exhaustion: a label carrying ALL 35 single-suffix
      // candidate shapes plus real math still finds a safe salt ----
      {
        let exhaust = 'x';
        for (const c of 'FGHIJKLMNOPQRSTUVWXYZ0123456789') {
          exhaust += ` MMATHMDPHK7${c}0MMM`;
        }
        exhaust += ' $x$';
        const r = renderMarkdown(`[${exhaust}]: /u\n\n[${exhaust}]`, { tsvTables: false });
        check('linkrefs-collision: all 35 single-suffix shapes + real math → one formula',
          r.mathCount === 1 && r.html.includes('href="/u"') &&
            !r.html.includes('katex-error'),
          `math=${r.mathCount} html=${r.html.slice(0, 300)}`);
      }
    }
  }

  // 35. P1 round 3: attribute inner protection — inline links and
  // reference-resolved attributes must agree; complete math/code spans
  // stay RAW (MathMD contract), lone escapes and literal %5C follow
  // native semantics.
  {
    const matrix = [
      // [name, definition-side source, inline-link source]
      ['paired parens dest', '[a]: /\\(x\\)/foo\n\n[a]', '[t](/\\(x\\)/foo)'],
      ['paired brackets dest', '[a]: /\\[x\\]\n\n[a]', '[t](/\\[x\\])'],
      ['paired TeX backslashes', '[a]: /\\(\\frac{1}{2}\\)\n\n[a]', '[t](/\\(\\frac{1}{2}\\))'],
      ['dollar span dest', '[a]: /$x$/y\n\n[a]', '[t](/$x$/y)'],
      ['display span dest', '[a]: /$$a b$$/y\n\n[a]', '[t](/$$a b$$/y)'],
      ['lone opener in angle', '[a]: <\\(>\n\n[a]', '[t](<\\(>)'],
      ['lone closer in title', '[a]: /u "a \\] b"\n\n[a]', '[t](/u "a \\] b")'],
      ['lone opener in title', '[a]: /u "a \\( b"\n\n[a]', '[t](/u "a \\( b")'],
      ['literal %5C( angle', '[a]: <%5C(>\n\n[a]', '[t](<%5C(>)'],
      ['literal %5C%5B bare', '[a]: /%5C%5B\n\n[a]', '[t](/%5C%5B)'],
      ['angle space dest', '[a]: <a b>\n\n[a]', '[t](<a b>)'],
      ['unicode dest', '[a]: /中文\n\n[a]', '[t](/中文)'],
      ['code span in title', '[a]: /u "`c` d"\n\n[a]', '[t](/u "`c` d")'],
    ];
    for (const [name, refSrc, inlineSrc] of matrix) {
      const ref = renderMarkdown(refSrc, { tsvTables: false });
      const inl = renderMarkdown(inlineSrc, { tsvTables: false });
      const refAttrs = (ref.html.match(/(?:href|title)="[^"]*"/g) || []).sort().join(' ');
      const inlAttrs = (inl.html.match(/(?:href|title)="[^"]*"/g) || []).sort().join(' ');
      check(`attr-matrix: (${name}) reference == inline attributes`,
        refAttrs === inlAttrs && refAttrs.length > 0 && !/MMATHMDPH|MCODEPH|MLABELPH|MLITPH/.test(refAttrs),
        `ref=${refAttrs} inline=${inlAttrs}`);
    }
    // Native-parity spot checks for the non-math cases.
    const mdN = ctx.markdownit({ html: false, linkify: true });
    for (const [name, src] of [
      ['%5C( angle', '[a]: <%5C(>\n\n[a]'],
      ['%5C%5B bare', '[a]: /%5C%5B\n\n[a]'],
      ['lone opener angle', '[a]: <\\(>\n\n[a]'],
      ['lone opener title', '[a]: /u "a \\( b"\n\n[a]'],
    ]) {
      const ours = renderMarkdown(src, { tsvTables: false }).html;
      const native = mdN.render(src);
      const nativeHref = (native.match(/href="[^"]*"/) || [''])[0];
      const nativeTitle = (native.match(/title="[^"]*"/) || [''])[0];
      check(`attr-matrix: (${name}) matches native`,
        nativeHref !== '' && ours.includes(nativeHref) &&
          (nativeTitle === '' || ours.includes(nativeTitle)),
        `ours=${ours.slice(0, 90)} native=${native.slice(0, 90)}`);
    }
  }

  // 36. P1 round 4: expanding inner-salt search (16k adversarial payloads
  // must render, never throw) and inline-only attribute re-protection
  // (isolated ```/~~~ never inject newlines into attributes).
  {
    const AL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    // All 1296 two-character salt shapes embedded in one destination
    // (~26k chars): the enumeration must escalate to longer salts.
    let dest = '/';
    for (const a of AL) for (const b of AL) dest += `MMATHMDPHK7${a}${b}`;
    const longDest = renderMarkdown(`[a]: ${dest}\n\n[a]`, { tsvTables: false });
    check('attr-inline: 26k-char dest with all 1296 two-char token shapes renders',
      longDest.html.includes(`href="/MMATHMDPHK7AA`) && !/MMATHMDPHK7[0-9A-Z]{2,8}[0-9]+MMM.*(MMATHMDPHK7AA)/.test('') &&
        longDest.html.includes(dest.slice(-24)),
      longDest.html.slice(0, 80));
    let title = 'x';
    for (const a of AL) for (const b of AL) title += ` MMATHMDPHK7${a}${b}`;
    const longTitle = renderMarkdown(`[a]: /u "${title}"\n\n[a]`, { tsvTables: false });
    check('attr-inline: long title with all 1296 two-char token shapes renders',
      longTitle.html.includes('title="x MMATHMDPHK7AA') && longTitle.html.includes(title.slice(-24)),
      longTitle.html.slice(0, 80));
    // Isolated fence/tilde runs inside attributes stay the literal text
    // they are — no synthetic newlines, inline and reference agreeing.
    for (const [name, refSrc, inlineSrc] of [
      ['backticks in title', '[a]: /u "```"\n\n[a]', '[t](/u "```")'],
      ['tildes in title', '[a]: /u "~~~"\n\n[a]', '[t](/u "~~~")'],
      ['backticks in dest', '[a]: <```>\n\n[a]', '[t](<```>)'],
      ['tildes in dest', '[a]: <~~~>\n\n[a]', '[t](<~~~>)'],
    ]) {
      const ref = renderMarkdown(refSrc, { tsvTables: false });
      const inl = renderMarkdown(inlineSrc, { tsvTables: false });
      const refAttrs = (ref.html.match(/(?:href|title)="[^"]*"/g) || []).sort().join(' ');
      const inlAttrs = (inl.html.match(/(?:href|title)="[^"]*"/g) || []).sort().join(' ');
      check(`attr-inline: isolated fence run (${name}) — reference == inline, no newline`,
        refAttrs === inlAttrs && refAttrs.length > 0 &&
          !/%0A/.test(ref.html) &&
          (name.includes('title')
            ? ref.html.includes('title="```"') || ref.html.includes('title="~~~"')
            : ref.html.includes('%60%60%60') || ref.html.includes('href="~~~"')),
        `ref=${ref.html.slice(0, 120)} inline=${inl.html.slice(0, 120)}`);
    }
    // EOF shapes: an unterminated title at EOF fails the candidate; a
    // pending destination at EOF still completes nothing.
    const eofTitle = renderMarkdown('[a]: /u "t', { tsvTables: false });
    check('attr-inline: unterminated title at EOF fails the definition',
      !eofTitle.html.includes('href=') && eofTitle.html.includes('[a]: /u &quot;t'),
      eofTitle.html.slice(0, 120));
    const eofPend = renderMarkdown('[a]:\n/url', { tsvTables: false });
    check('attr-inline: pending destination at EOF completes the definition',
      eofPend.html === '' || !eofPend.html.includes('[a]'),
      JSON.stringify(eofPend.html.slice(0, 120)));
    const mlEof = renderMarkdown('[a]: /u "one\ntwo"', { tsvTables: false });
    check('attr-inline: multiline title closing at EOF completes',
      !mlEof.html.includes('MMATHMDPH') && mlEof.html === '',
      JSON.stringify(mlEof.html.slice(0, 120)));
  }

  // 37. P1 round 5: CRLF / lone CR in multiline titles normalize to LF
  // (native semantics) while complete math/code spans keep their raw
  // bytes; inline and reference agree.
  {
    for (const [name, refSrc, inlineSrc] of [
      ['CRLF plain multiline title', '[a]: /u "one\r\ntwo"\r\n\r\n[a]', '[t](/u "one\r\ntwo")'],
      ['lone CR plain title', '[a]: /u "one\rtwo"\n\n[a]', '[t](/u "one\rtwo")'],
      ['CRLF title with paired math', '[a]: /u "one\r\n\\(x\\)"\r\n\r\n[a]', '[t](/u "one\r\n\\(x\\)")'],
      ['CRLF title with code span', '[a]: /u "one\r\n`c`"\r\n\r\n[a]', '[t](/u "one\r\n`c`")'],
    ]) {
      const ref = renderMarkdown(refSrc, { tsvTables: false });
      const inl = renderMarkdown(inlineSrc, { tsvTables: false });
      const refTitle = (ref.html.match(/title="[^"]*"/) || [''])[0];
      const inlTitle = (inl.html.match(/title="[^"]*"/) || [''])[0];
      check(`attr-crlf: (${name}) reference == inline, CRs normalized to LF`,
        refTitle === inlTitle && refTitle.includes('one\n') &&
          !refTitle.includes('\r') && !/%0D/.test(ref.html),
        `ref=${JSON.stringify(refTitle)} inline=${JSON.stringify(inlTitle)}`);
    }
    // Paired math span keeps its RAW bytes inside the normalized title.
    const mathTitle = renderMarkdown('[a]: /u "one\r\n\\(x\\)"\r\n\r\n[a]', { tsvTables: false });
    check('attr-crlf: paired math span stays raw inside a CRLF title',
      mathTitle.html.includes('title="one\n\\(x\\)"'),
      mathTitle.html.slice(0, 140));
  }

  return { label, pass, fail, failures };
}
