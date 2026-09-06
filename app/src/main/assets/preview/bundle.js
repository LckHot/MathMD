"use strict";
(() => {
  // tools/preview-src/src/delimiters.ts
  var MATH_TOKEN_SOURCE = "MMATHMDPH[A-Z0-9]{1,8}[0-9]+MMM";
  var CODE_TOKEN_SOURCE = "MCODEPH[A-Z0-9]{1,8}[0-9]+MMM";
  var SALT_RE = /^[A-Z0-9]{1,8}$/;
  function protectMath(source, salt = "K7") {
    if (!SALT_RE.test(salt)) {
      throw new Error(`salt must match ${SALT_RE}, got "${salt}"`);
    }
    const math = [];
    const code = [];
    let out = "";
    const n = source.length;
    const mathToken = () => `MMATHMDPH${salt}${math.length}MMM`;
    const codeToken = () => `MCODEPH${salt}${code.length}MMM`;
    const lineStart = (p) => p === 0 || source[p - 1] === "\n";
    const endOfLine = (p) => {
      const idx = source.indexOf("\n", p);
      return idx === -1 ? n : idx;
    };
    const backslashRun = (j) => {
      let k = 0;
      while (j - 1 - k >= 0 && source[j - 1 - k] === "\\") k++;
      return k;
    };
    const scanCloser = (start, closer) => {
      for (let j = start; j < n; j++) {
        if (!source.startsWith(closer, j)) continue;
        if (backslashRun(j) % 2 === 1) continue;
        return j;
      }
      return -1;
    };
    const pushMath = (p, openLen, closeIdx, closeLen, display) => {
      const token = mathToken();
      math.push({ token, kind: "math", display, tex: source.slice(p + openLen, closeIdx) });
      out += token;
      return closeIdx + closeLen;
    };
    const tryMath = (p) => {
      const two = source.substr(p, 2);
      if (two === "$$") {
        const c = scanCloser(p + 2, "$$");
        return c === -1 ? skipOne(p) : pushMath(p, 2, c, 2, true);
      }
      if (two === "\\[") {
        const c = scanCloser(p + 2, "\\]");
        return c === -1 ? skipOne(p) : pushMath(p, 2, c, 2, true);
      }
      if (two === "\\(") {
        const c = scanCloser(p + 2, "\\)");
        return c === -1 ? skipOne(p) : pushMath(p, 2, c, 2, false);
      }
      if (source[p] === "$") {
        const nx = source[p + 1];
        if (nx === void 0 || nx === "$") return skipOne(p);
        const c = scanCloser(p + 1, "$");
        if (c === -1 || c === p + 1) return skipOne(p);
        return pushMath(p, 1, c, 1, false);
      }
      return -1;
    };
    const skipOne = (p) => {
      out += source[p];
      return p + 1;
    };
    const tryFence = (p) => {
      if (!lineStart(p)) return -1;
      const eol = endOfLine(p);
      const line = source.slice(p, eol);
      const m = /^ {0,3}(`{3,}|~{3,}).*$/.exec(line);
      if (!m) return -1;
      const fch = m[1][0];
      const flen = m[1].length;
      const closeRe = new RegExp(`^ {0,3}[${fch === "`" ? "`" : "~"}]{${flen},}\\s*$`);
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
      code.push({ token, kind: "code", raw: source.slice(bodyStart, bodyEnd) });
      out += line;
      if (eol < n) out += "\n";
      out += token;
      if (closeIdx >= 0) out += "\n" + source.slice(closeIdx, closeEol);
      if (closeIdx === -1) return n;
      return closeEol;
    };
    const tryIndented = (p) => {
      if (!lineStart(p)) return -1;
      const eol = endOfLine(p);
      const line = source.slice(p, eol);
      if (!/^( {4}|\t)/.test(line)) return -1;
      const trimmed = out.endsWith("\n") ? out.slice(0, -1) : out;
      const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
      const blankBefore = out === "" || lastLine.trim() === "";
      const afterCode = lastLine.startsWith("MCODEPH");
      if (!blankBefore && !afterCode) return -1;
      const lines = [];
      let q = p;
      let endedAtEof = false;
      for (; ; ) {
        const qeol = endOfLine(q);
        const l = source.slice(q, qeol);
        if (/^( {4}|\t)/.test(l)) {
          lines.push(l);
          if (qeol >= n) {
            q = n;
            endedAtEof = true;
            break;
          }
          q = qeol + 1;
          continue;
        }
        if (l.trim() === "") {
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
      code.push({ token, kind: "code", raw: lines.join("\n") });
      out += "    " + token + (endedAtEof ? "" : "\n");
      return q;
    };
    const tryCodeSpan = (p) => {
      if (source[p] !== "`") return -1;
      if (backslashRun(p) % 2 === 1) return -1;
      let k = 1;
      while (p + k < n && source[p + k] === "`") k++;
      let q = p + k;
      for (; ; ) {
        const idx = source.indexOf("`", q);
        if (idx === -1) return -1;
        let k2 = 1;
        while (idx + k2 < n && source[idx + k2] === "`") k2++;
        if (k2 === k) {
          const token = codeToken();
          code.push({ token, kind: "code", raw: source.slice(p, idx + k2) });
          out += token;
          return idx + k2;
        }
        q = idx + k2;
      }
    };
    let i = 0;
    while (i < n) {
      let ni = tryFence(i);
      if (ni >= 0) {
        i = ni;
        continue;
      }
      ni = tryIndented(i);
      if (ni >= 0) {
        i = ni;
        continue;
      }
      ni = tryCodeSpan(i);
      if (ni >= 0) {
        i = ni;
        continue;
      }
      ni = tryMath(i);
      if (ni >= 0) {
        i = ni;
        continue;
      }
      if (source[i] === "\\" && (source[i + 1] === "$" || source[i + 1] === "\\" || source[i + 1] === "`")) {
        out += source.substr(i, 2);
        i += 2;
        continue;
      }
      out += source[i];
      i++;
    }
    return { text: out, math, code };
  }

  // tools/preview-src/src/render.ts
  function vendor() {
    return globalThis;
  }
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function renderMarkdown(source, opts = {}) {
    const v = vendor();
    if (typeof v.markdownit !== "function" || typeof v.katex?.renderToString !== "function") {
      throw new Error("MathMD.renderMarkdown requires the markdownit and katex vendor globals");
    }
    const salt = opts.salt ?? "K7";
    const errors = [];
    const prot = protectMath(source, salt);
    const md = v.markdownit({ html: false, linkify: true });
    let html = md.render(prot.text);
    html = html.replace(new RegExp(CODE_TOKEN_SOURCE, "g"), (tok) => {
      const seg = prot.code.find((s) => s.token === tok);
      if (!seg) return tok;
      if (seg.raw.startsWith("`")) {
        const m = /^(`+)([\s\S]*?)\1/.exec(seg.raw);
        let body2 = m ? m[2] : seg.raw;
        if (body2.startsWith(" ") && body2.endsWith(" ") && body2.length >= 2) {
          body2 = body2.slice(1, -1);
        }
        return `<code>${esc(body2)}</code>`;
      }
      const isIndented = /^ {4}|^\t/.test(seg.raw);
      const body = isIndented ? seg.raw.replace(/^ {4}/gm, "").replace(/^\t/gm, "") : seg.raw;
      return esc(body);
    });
    html = html.replace(new RegExp(MATH_TOKEN_SOURCE, "g"), (tok) => {
      const seg = prot.math.find((s) => s.token === tok);
      if (!seg) return tok;
      try {
        return v.katex.renderToString(seg.tex, {
          displayMode: seg.display,
          throwOnError: opts.throwOnError ?? false,
          strict: false,
          trust: false
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({ tex: seg.tex, message });
        return `<span class="math-error">${esc(seg.tex)}</span>`;
      }
    });
    return { html, mathCount: prot.math.length, errors };
  }
  globalThis.MathMD = {
    renderMarkdown,
    protectMath
  };

  // tools/preview-src/src/host.ts
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function applyHostOptions(o) {
    const root = document.documentElement;
    const theme = o.theme === "dark" ? "dark" : o.theme === "light" ? "light" : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    root.dataset.theme = theme;
    if (typeof o.fontFamily === "string" && o.fontFamily.length > 0) {
      root.style.setProperty("--preview-font-family", o.fontFamily);
    }
  }
  function postRender(root) {
    if (typeof root.querySelectorAll !== "function") return;
    for (const display of Array.from(root.querySelectorAll(".katex-display"))) {
      const d = display;
      const tag = d.querySelector(".katex-tag");
      let scroller = d;
      if (tag) {
        d.classList.add("tagged");
        d.appendChild(tag);
        scroller = d.querySelector(":scope > .katex") ?? d;
      }
      if (scroller.scrollWidth > scroller.clientWidth + 1) {
        d.classList.add("wide");
      }
    }
  }
  function randomSalt() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let s = "";
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
  function hostUpdate(markdown, opts) {
    const target = document.getElementById("preview");
    if (!target) return;
    try {
      if (opts) applyHostOptions(opts);
      const result = renderMarkdown(markdown, { salt: randomSalt() });
      target.innerHTML = result.html;
      postRender(target);
      if (result.errors.length > 0) {
        const bad = result.errors.map((e) => `${e.message}`).join("\n");
        console.warn(`MathMD: ${result.errors.length} formula(s) failed: ${bad}`);
      }
    } catch (e) {
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      target.innerHTML = `<pre class="math-error">preview render failed
${escapeHtml(message)}</pre>`;
      console.error("MathMD hostUpdate failed:", message);
    }
  }
  var bridge = globalThis;
  bridge.MathMD = { ...bridge.MathMD ?? {}, hostUpdate };
  document.addEventListener("DOMContentLoaded", () => {
    const target = document.getElementById("preview");
    if (target && target.childElementCount === 0) {
      target.innerHTML = "<p><em>Waiting for document\u2026</em></p>";
    }
  });
})();
