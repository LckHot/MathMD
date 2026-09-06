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

  // tools/node_modules/get-east-asian-width/lookup-data.js
  var ambiguousMinimalCodePoint = 161;
  var ambiguousMaximumCodePoint = 1114109;
  var ambiguousRanges = [161, 161, 164, 164, 167, 168, 170, 170, 173, 174, 176, 180, 182, 186, 188, 191, 198, 198, 208, 208, 215, 216, 222, 225, 230, 230, 232, 234, 236, 237, 240, 240, 242, 243, 247, 250, 252, 252, 254, 254, 257, 257, 273, 273, 275, 275, 283, 283, 294, 295, 299, 299, 305, 307, 312, 312, 319, 322, 324, 324, 328, 331, 333, 333, 338, 339, 358, 359, 363, 363, 462, 462, 464, 464, 466, 466, 468, 468, 470, 470, 472, 472, 474, 474, 476, 476, 593, 593, 609, 609, 708, 708, 711, 711, 713, 715, 717, 717, 720, 720, 728, 731, 733, 733, 735, 735, 768, 879, 913, 929, 931, 937, 945, 961, 963, 969, 1025, 1025, 1040, 1103, 1105, 1105, 8208, 8208, 8211, 8214, 8216, 8217, 8220, 8221, 8224, 8226, 8228, 8231, 8240, 8240, 8242, 8243, 8245, 8245, 8251, 8251, 8254, 8254, 8308, 8308, 8319, 8319, 8321, 8324, 8364, 8364, 8451, 8451, 8453, 8453, 8457, 8457, 8467, 8467, 8470, 8470, 8481, 8482, 8486, 8486, 8491, 8491, 8531, 8532, 8539, 8542, 8544, 8555, 8560, 8569, 8585, 8585, 8592, 8601, 8632, 8633, 8658, 8658, 8660, 8660, 8679, 8679, 8704, 8704, 8706, 8707, 8711, 8712, 8715, 8715, 8719, 8719, 8721, 8721, 8725, 8725, 8730, 8730, 8733, 8736, 8739, 8739, 8741, 8741, 8743, 8748, 8750, 8750, 8756, 8759, 8764, 8765, 8776, 8776, 8780, 8780, 8786, 8786, 8800, 8801, 8804, 8807, 8810, 8811, 8814, 8815, 8834, 8835, 8838, 8839, 8853, 8853, 8857, 8857, 8869, 8869, 8895, 8895, 8978, 8978, 9312, 9449, 9451, 9547, 9552, 9587, 9600, 9615, 9618, 9621, 9632, 9633, 9635, 9641, 9650, 9651, 9654, 9655, 9660, 9661, 9664, 9665, 9670, 9672, 9675, 9675, 9678, 9681, 9698, 9701, 9711, 9711, 9733, 9734, 9737, 9737, 9742, 9743, 9756, 9756, 9758, 9758, 9792, 9792, 9794, 9794, 9824, 9825, 9827, 9829, 9831, 9834, 9836, 9837, 9839, 9839, 9886, 9887, 9919, 9919, 9926, 9933, 9935, 9939, 9941, 9953, 9955, 9955, 9960, 9961, 9963, 9969, 9972, 9972, 9974, 9977, 9979, 9980, 9982, 9983, 10045, 10045, 10102, 10111, 11094, 11097, 12872, 12879, 57344, 63743, 65024, 65039, 65533, 65533, 127232, 127242, 127248, 127277, 127280, 127337, 127344, 127373, 127375, 127376, 127387, 127404, 917760, 917999, 983040, 1048573, 1048576, 1114109];
  var fullwidthMinimalCodePoint = 12288;
  var fullwidthMaximumCodePoint = 65510;
  var fullwidthRanges = [12288, 12288, 65281, 65376, 65504, 65510];
  var halfwidthMinimalCodePoint = 8361;
  var halfwidthMaximumCodePoint = 65518;
  var halfwidthRanges = [8361, 8361, 65377, 65470, 65474, 65479, 65482, 65487, 65490, 65495, 65498, 65500, 65512, 65518];
  var narrowMinimalCodePoint = 32;
  var narrowMaximumCodePoint = 10630;
  var narrowRanges = [32, 126, 162, 163, 165, 166, 172, 172, 175, 175, 10214, 10221, 10629, 10630];
  var wideMinimalCodePoint = 4352;
  var wideMaximumCodePoint = 262141;
  var wideRanges = [4352, 4447, 8986, 8987, 9001, 9002, 9193, 9196, 9200, 9200, 9203, 9203, 9725, 9726, 9748, 9749, 9776, 9783, 9800, 9811, 9855, 9855, 9866, 9871, 9875, 9875, 9889, 9889, 9898, 9899, 9917, 9918, 9924, 9925, 9934, 9934, 9940, 9940, 9962, 9962, 9970, 9971, 9973, 9973, 9978, 9978, 9981, 9981, 9989, 9989, 9994, 9995, 10024, 10024, 10060, 10060, 10062, 10062, 10067, 10069, 10071, 10071, 10133, 10135, 10160, 10160, 10175, 10175, 11035, 11036, 11088, 11088, 11093, 11093, 11904, 11929, 11931, 12019, 12032, 12245, 12272, 12287, 12289, 12350, 12353, 12438, 12441, 12543, 12549, 12591, 12593, 12686, 12688, 12773, 12783, 12830, 12832, 12871, 12880, 42124, 42128, 42182, 43360, 43388, 44032, 55203, 63744, 64255, 65040, 65049, 65072, 65106, 65108, 65126, 65128, 65131, 94176, 94180, 94192, 94198, 94208, 101589, 101631, 101662, 101760, 101874, 110576, 110579, 110581, 110587, 110589, 110590, 110592, 110882, 110898, 110898, 110928, 110930, 110933, 110933, 110948, 110951, 110960, 111355, 119552, 119638, 119648, 119670, 126980, 126980, 127183, 127183, 127374, 127374, 127377, 127386, 127488, 127490, 127504, 127547, 127552, 127560, 127568, 127569, 127584, 127589, 127744, 127776, 127789, 127797, 127799, 127868, 127870, 127891, 127904, 127946, 127951, 127955, 127968, 127984, 127988, 127988, 127992, 128062, 128064, 128064, 128066, 128252, 128255, 128317, 128331, 128334, 128336, 128359, 128378, 128378, 128405, 128406, 128420, 128420, 128507, 128591, 128640, 128709, 128716, 128716, 128720, 128722, 128725, 128728, 128732, 128735, 128747, 128748, 128756, 128764, 128992, 129003, 129008, 129008, 129292, 129338, 129340, 129349, 129351, 129535, 129648, 129660, 129664, 129674, 129678, 129734, 129736, 129736, 129741, 129756, 129759, 129770, 129775, 129784, 131072, 196605, 196608, 262141];

  // tools/node_modules/get-east-asian-width/utilities.js
  var isInRange = (ranges, codePoint) => {
    let low = 0;
    let high = Math.floor(ranges.length / 2) - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const i = mid * 2;
      if (codePoint < ranges[i]) {
        high = mid - 1;
      } else if (codePoint > ranges[i + 1]) {
        low = mid + 1;
      } else {
        return true;
      }
    }
    return false;
  };

  // tools/node_modules/get-east-asian-width/lookup.js
  var commonCjkCodePoint = 19968;
  var [wideFastPathStart, wideFastPathEnd] = /* @__PURE__ */ findWideFastPathRange(wideRanges);
  function findWideFastPathRange(ranges) {
    let fastPathStart = ranges[0];
    let fastPathEnd = ranges[1];
    for (let index = 0; index < ranges.length; index += 2) {
      const start = ranges[index];
      const end = ranges[index + 1];
      if (commonCjkCodePoint >= start && commonCjkCodePoint <= end) {
        return [start, end];
      }
      if (end - start > fastPathEnd - fastPathStart) {
        fastPathStart = start;
        fastPathEnd = end;
      }
    }
    return [fastPathStart, fastPathEnd];
  }
  var isAmbiguous = (codePoint) => {
    if (codePoint < ambiguousMinimalCodePoint || codePoint > ambiguousMaximumCodePoint) {
      return false;
    }
    return isInRange(ambiguousRanges, codePoint);
  };
  var isFullWidth = (codePoint) => {
    if (codePoint < fullwidthMinimalCodePoint || codePoint > fullwidthMaximumCodePoint) {
      return false;
    }
    return isInRange(fullwidthRanges, codePoint);
  };
  var isHalfWidth = (codePoint) => {
    if (codePoint < halfwidthMinimalCodePoint || codePoint > halfwidthMaximumCodePoint) {
      return false;
    }
    return isInRange(halfwidthRanges, codePoint);
  };
  var isNarrow = (codePoint) => {
    if (codePoint < narrowMinimalCodePoint || codePoint > narrowMaximumCodePoint) {
      return false;
    }
    return isInRange(narrowRanges, codePoint);
  };
  var isWide = (codePoint) => {
    if (codePoint >= wideFastPathStart && codePoint <= wideFastPathEnd) {
      return true;
    }
    if (codePoint < wideMinimalCodePoint || codePoint > wideMaximumCodePoint) {
      return false;
    }
    return isInRange(wideRanges, codePoint);
  };
  function getCategory(codePoint) {
    if (isAmbiguous(codePoint)) {
      return "ambiguous";
    }
    if (isFullWidth(codePoint)) {
      return "fullwidth";
    }
    if (isHalfWidth(codePoint)) {
      return "halfwidth";
    }
    if (isNarrow(codePoint)) {
      return "narrow";
    }
    if (isWide(codePoint)) {
      return "wide";
    }
    return "neutral";
  }

  // tools/node_modules/get-east-asian-width/index.js
  function validate(codePoint) {
    if (!Number.isSafeInteger(codePoint)) {
      throw new TypeError(`Expected a code point, got \`${typeof codePoint}\`.`);
    }
  }
  function eastAsianWidthType(codePoint) {
    validate(codePoint);
    return getCategory(codePoint);
  }

  // tools/node_modules/markdown-it-cjk-friendly/dist/index.js
  function isEmoji(uc) {
    return /^\p{Emoji_Presentation}/u.test(String.fromCodePoint(uc));
  }
  function isCjkBase(uc) {
    if (uc < 4352) return false;
    switch (eastAsianWidthType(uc)) {
      case "fullwidth":
      case "halfwidth":
        return true;
      case "wide":
        return !isEmoji(uc);
      case "narrow":
        return false;
      case "ambiguous":
        return null;
      case "neutral":
        return /^\p{sc=Hangul}/u.test(String.fromCodePoint(uc));
    }
  }
  function is2PreviousCjk(uc, prev) {
    return isCjkBase(uc) ?? (prev === 65025 && isQuotationMark(uc));
    function isQuotationMark(uc2) {
      return uc2 === 8216 || uc2 === 8217 || uc2 === 8220 || uc2 === 8221;
    }
  }
  function isPreviousCjk(uc) {
    return isCjkBase(uc) ?? (917760 <= uc && uc <= 917999);
  }
  function isNextCjk(uc) {
    return isCjkBase(uc) ?? false;
  }
  function nonEmojiGeneralUseVS(uc) {
    return uc >= 65024 && uc <= 65038;
  }
  function markdownItCjkFriendlyPlugin(md) {
    const PreviousState = md.inline.State;
    class CjkFriendlyState extends PreviousState {
      scanDelims(start, canSplitWord) {
        const max = this.posMax;
        const marker = this.src.charCodeAt(start);
        const [lastChar, lastCharPos] = getLastCharCode(this.src, start);
        let lastMainChar = lastChar;
        let twoPrevChar = null;
        if (nonEmojiGeneralUseVS(lastChar)) {
          twoPrevChar = getLastCharCode(this.src, lastCharPos)[0];
          if (!/^\p{Zs}/u.test(String.fromCodePoint(twoPrevChar))) lastMainChar = twoPrevChar;
        }
        let pos = start;
        while (pos < max && this.src.charCodeAt(pos) === marker) pos++;
        const count = pos - start;
        const nextChar = pos < max ? this.src.codePointAt(pos) : 32;
        const isLastWhiteSpace = md.utils.isWhiteSpace(lastMainChar);
        const isNextWhiteSpace = md.utils.isWhiteSpace(nextChar);
        if (isLastWhiteSpace || isNextWhiteSpace) return {
          can_open: !isNextWhiteSpace,
          can_close: !isLastWhiteSpace,
          length: count
        };
        const isLastPunctChar = md.utils.isMdAsciiPunct(lastMainChar) || md.utils.isPunctChar(String.fromCodePoint(lastMainChar));
        const isNextPunctChar = md.utils.isMdAsciiPunct(nextChar) || md.utils.isPunctChar(String.fromCodePoint(nextChar));
        let left_flanking = isLastPunctChar;
        let right_flanking = isNextPunctChar;
        if (canSplitWord) {
          const isEitherCJKChar = isNextCjk(nextChar) || (twoPrevChar !== null ? is2PreviousCjk(twoPrevChar, lastChar) : isPreviousCjk(lastChar));
          left_flanking ||= isEitherCJKChar || !isNextPunctChar;
          right_flanking ||= isEitherCJKChar || !isLastPunctChar;
        }
        return {
          can_open: left_flanking,
          can_close: right_flanking,
          length: count
        };
        function getLastCharCode(str, pos2) {
          if (pos2 <= 0) return [32, -1];
          const charCode = str.charCodeAt(pos2 - 1);
          if ((charCode & 64512) !== 56320) return [charCode, pos2 - 1];
          const codePoint = str.codePointAt(pos2 - 2);
          return codePoint > 65535 ? [codePoint, pos2 - 2] : [charCode, pos2 - 1];
        }
      }
    }
    md.inline.State = CjkFriendlyState;
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
    md.use(markdownItCjkFriendlyPlugin);
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
    for (const table of Array.from(root.querySelectorAll(":scope > table"))) {
      const wrap = document.createElement("div");
      wrap.className = "table-scroll";
      root.insertBefore(wrap, table);
      wrap.appendChild(table);
    }
  }
  function randomSalt() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let s = "";
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
  function textNodesUnder(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let p = node.parentElement;
        while (p && p !== root) {
          const cn = p.className;
          if (typeof cn === "string" && cn.includes("katex-mathml") || p.tagName === "SCRIPT" || p.tagName === "STYLE") {
            return NodeFilter.FILTER_REJECT;
          }
          p = p.parentElement;
        }
        return node.nodeValue && node.nodeValue.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const out = [];
    while (walker.nextNode()) out.push(walker.currentNode);
    return out;
  }
  function clearFind() {
    const g = globalThis;
    if (g.CSS?.highlights) {
      g.CSS.highlights.delete("mathmd-find");
      g.CSS.highlights.delete("mathmd-find-active");
    } else {
      const sel = window.getSelection?.();
      sel?.removeAllRanges();
    }
  }
  function paint(ranges, active) {
    const g = globalThis;
    if (g.CSS?.highlights && g.Highlight) {
      const others = ranges.filter((_, i) => i !== active);
      g.CSS.highlights.set("mathmd-find", new g.Highlight(...others));
      if (ranges[active]) g.CSS.highlights.set("mathmd-find-active", new g.Highlight(ranges[active]));
      else g.CSS.highlights.delete("mathmd-find-active");
      return;
    }
    const sel = window.getSelection?.();
    sel?.removeAllRanges();
    if (ranges[active]) sel?.addRange(ranges[active]);
  }
  function scrollToRange(range) {
    const marker = document.createElement("span");
    marker.style.cssText = "display:inline;width:0;height:0";
    const r = range.cloneRange();
    r.collapse(true);
    r.insertNode(marker);
    marker.scrollIntoView({ block: "center", inline: "center" });
    marker.remove();
  }
  function find(query, active) {
    const target = document.getElementById("preview");
    if (!target || !query || typeof document.createTreeWalker !== "function") {
      clearFind();
      return { total: 0, active: -1 };
    }
    const q = query.toLowerCase();
    const ranges = [];
    for (const node of textNodesUnder(target)) {
      const data = (node.nodeValue ?? "").toLowerCase();
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
  function hostUpdate(markdown, opts) {
    const target = document.getElementById("preview");
    if (!target) return;
    try {
      if (opts) applyHostOptions(opts);
      clearFind();
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
  bridge.MathMD = { ...bridge.MathMD ?? {}, hostUpdate, find };
  document.addEventListener("DOMContentLoaded", () => {
    const target = document.getElementById("preview");
    if (target && target.childElementCount === 0) {
      target.innerHTML = "<p><em>Waiting for document\u2026</em></p>";
    }
  });
})();
