"use strict";
(() => {
  // tools/preview-src/src/linkrefs.ts
  function normalizeReference(label) {
    return label.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase();
  }
  var MAX_LABEL = 1e3;
  var isBlankLine = (line) => line.trim() === "";
  function listFamilyOf(line) {
    const m = /^ {0,3}([-+*]|(\d{1,9})([.)]))(?:[ \t]+|$)/.exec(line);
    if (!m) return null;
    if (m[2] !== void 0) return m[3];
    return m[1];
  }
  function isPureListMarker(line) {
    const m = /^ {0,3}([-+*]|\d{1,9}[.)])[ \t]*$/.exec(line);
    return m !== null;
  }
  function isSetextShaped(line) {
    return /^ {0,3}(=+|-+)[ \t]*$/.test(line);
  }
  function parseDestination(src, pos, eol) {
    if (pos >= eol) return null;
    if (src[pos] === "<") {
      let j2 = pos + 1;
      let destRaw2 = "";
      while (j2 < eol) {
        const c = src[j2];
        if (c === "\\" && j2 + 1 < eol) {
          destRaw2 += src.slice(j2, j2 + 2);
          j2 += 2;
          continue;
        }
        if (c === "<") return null;
        if (c === ">") {
          const raw = src.slice(pos, j2 + 1);
          return { destRaw: raw, content: raw.slice(1, -1), after: j2 + 1 };
        }
        destRaw2 += c;
        j2++;
      }
      return null;
    }
    let depth = 0;
    let j = pos;
    let destRaw = "";
    while (j < eol) {
      const c = src[j];
      if (c === "\\" && j + 1 < eol) {
        destRaw += src.slice(j, j + 2);
        j += 2;
        continue;
      }
      if (c === " " || c === "	") break;
      if (c === "(") {
        depth++;
      } else if (c === ")") {
        if (depth === 0) break;
        depth--;
      }
      destRaw += c;
      j++;
    }
    if (destRaw.length === 0 || depth !== 0) return null;
    return { destRaw, content: destRaw, after: j };
  }
  function parseTitleStart(src, pos, eol) {
    if (pos >= eol) return { kind: "none" };
    const q = src[pos];
    if (q !== '"' && q !== "'" && q !== "(") return { kind: "none" };
    const close = q === "(" ? ")" : q;
    let j = pos + 1;
    while (j < eol) {
      const c = src[j];
      if (c === "\\" && j + 1 < eol) {
        j += 2;
        continue;
      }
      if (c === close) {
        if (src.slice(j + 1, eol).trim() !== "") return { kind: "none" };
        return {
          kind: "complete",
          titleRaw: src.slice(pos, j + 1),
          content: src.slice(pos + 1, j),
          after: j + 1
        };
      }
      j++;
    }
    return { kind: "open", quote: close };
  }
  function collectLinkDefs(source) {
    const candidates = [];
    const byStart = /* @__PURE__ */ new Map();
    const byLabel = /* @__PURE__ */ new Map();
    const n = source.length;
    const endOfLine = (p) => {
      const idx = source.indexOf("\n", p);
      return idx === -1 ? n : idx;
    };
    const lineEnd = (p) => {
      const e = endOfLine(p);
      if (e > p && source[e - 1] === "\r") return e - 1;
      return e;
    };
    const nextLineStart = (p) => {
      const eol = endOfLine(p);
      return eol >= n ? n : eol + 1;
    };
    const lineText = (p, eol) => {
      const s = source.slice(p, eol);
      return s.endsWith("\r") ? s.slice(0, -1) : s;
    };
    const isBlankAt = (p) => {
      if (p >= n) return false;
      return isBlankLine(lineText(p, endOfLine(p)));
    };
    let state = "none";
    let pending = null;
    let mlTitle = null;
    const finalize = (start, labelRaw, destRaw, destContent, titleRaw, titleContent, extentEnd) => {
      const normalized = normalizeReference(labelRaw);
      const idx = candidates.length;
      candidates.push({ start, labelRaw, destRaw, destContent, titleRaw, titleContent, extentEnd });
      byStart.set(start, idx);
      if (!byLabel.has(normalized)) byLabel.set(normalized, idx);
    };
    const tryStart = (bracket, lineStart) => {
      const p = bracket;
      if (source[p] !== "[") return "no";
      let j = p + 1;
      let labelRaw = "";
      while (j < n) {
        const c = source[j];
        if (c === "\\" && j + 1 < n) {
          labelRaw += source.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (c === "[") return "no";
        if (c === "]") break;
        if (c === "\n") {
          if (isBlankAt(j + 1)) return "no";
          labelRaw += "\n";
          j++;
          continue;
        }
        labelRaw += c;
        j++;
      }
      if (j >= n) return "no";
      if (labelRaw.length < 1 || labelRaw.length > MAX_LABEL) return "no";
      if (labelRaw.trim() === "") return "no";
      const afterLabel = j + 1;
      if (source[afterLabel] !== ":") return "no";
      const eol = lineEnd(afterLabel);
      let q = afterLabel + 1;
      while (q < eol && (source[q] === " " || source[q] === "	")) q++;
      if (q >= eol) {
        pending = { start: lineStart, labelRaw };
        return "started-pending";
      }
      const dest = parseDestination(source, q, eol);
      if (!dest) return "no";
      let r = dest.after;
      while (r < eol && (source[r] === " " || source[r] === "	")) r++;
      const title = parseTitleStart(source, r, eol);
      if (title.kind === "none") {
        if (source.slice(r, eol).trim() !== "") return "no";
        finalize(lineStart, labelRaw, dest.destRaw, dest.content, null, null, eol);
        return "started-complete";
      }
      if (title.kind === "complete") {
        finalize(lineStart, labelRaw, dest.destRaw, dest.content, title.titleRaw, title.content, eol);
        return "started-titled";
      }
      mlTitle = {
        start: lineStart,
        labelRaw,
        destRaw: dest.destRaw,
        destContent: dest.content,
        titleStart: r,
        quote: title.quote,
        sameLineOpen: true
      };
      return "started-complete";
    };
    let i = 0;
    while (i < n) {
      const rawEol = endOfLine(i);
      const eol = lineEnd(i);
      const line = lineText(i, eol);
      if (state === "none") {
        if (isBlankLine(line)) {
          i = nextLineStart(i);
          continue;
        }
        const m = /^ {0,3}\[/.exec(line);
        let started = false;
        if (m) {
          const res = tryStart(i + m[0].length - 1, i);
          if (res === "started-pending") {
            state = "await-dest";
            started = true;
          } else if (res === "started-complete") {
            started = true;
            state = mlTitle ? "multiline-title" : "title-allowed";
          }
        }
        i = nextLineStart(i);
        if (started) continue;
        continue;
      }
      if (state === "await-dest") {
        const pend = pending;
        if (isBlankLine(line)) {
          state = "none";
          pending = null;
          i = nextLineStart(i);
          continue;
        }
        if (isSetextShaped(line) || isPureListMarker(line)) {
          state = "none";
          pending = null;
          i = nextLineStart(i);
          continue;
        }
        let q = i;
        while (q < eol && (source[q] === " " || source[q] === "	")) q++;
        const dest = parseDestination(source, q, eol);
        if (!dest) {
          state = "none";
          pending = null;
          continue;
        }
        let r = dest.after;
        while (r < eol && (source[r] === " " || source[r] === "	")) r++;
        const title = parseTitleStart(source, r, eol);
        if (title.kind === "complete") {
          finalize(pend.start, pend.labelRaw, dest.destRaw, dest.content, title.titleRaw, title.content, eol);
          state = "none";
          pending = null;
          i = nextLineStart(i);
          continue;
        }
        if (title.kind === "open") {
          mlTitle = {
            start: pend.start,
            labelRaw: pend.labelRaw,
            destRaw: dest.destRaw,
            destContent: dest.content,
            titleStart: r,
            quote: title.quote,
            sameLineOpen: false
          };
          state = "multiline-title";
          pending = null;
          i = nextLineStart(i);
          continue;
        }
        if (source.slice(r, eol).trim() !== "") {
          state = "none";
          pending = null;
          continue;
        }
        finalize(pend.start, pend.labelRaw, dest.destRaw, dest.content, null, null, eol);
        state = "title-allowed";
        pending = null;
        i = nextLineStart(i);
        continue;
      }
      if (state === "title-allowed") {
        if (isBlankLine(line)) {
          state = "none";
          i = nextLineStart(i);
          continue;
        }
        let q = i;
        while (q < eol && (source[q] === " " || source[q] === "	")) q++;
        const title = parseTitleStart(source, q, eol);
        if (title.kind === "complete") {
          const cand = candidates[candidates.length - 1];
          candidates[candidates.length - 1] = {
            ...cand,
            titleRaw: title.titleRaw,
            titleContent: title.content,
            extentEnd: eol
          };
          state = "none";
          i = nextLineStart(i);
          continue;
        }
        if (title.kind === "open") {
          const cand = candidates[candidates.length - 1];
          mlTitle = {
            start: cand.start,
            labelRaw: cand.labelRaw,
            destRaw: cand.destRaw,
            destContent: cand.destContent,
            titleStart: q,
            quote: title.quote,
            sameLineOpen: false
          };
          state = "multiline-title";
          i = nextLineStart(i);
          continue;
        }
        state = "none";
        continue;
      }
      {
        const mt = mlTitle;
        const failCandidate = () => {
          const last = candidates[candidates.length - 1];
          if (last && last.start === mt.start) {
            candidates.pop();
            byStart.delete(mt.start);
            const normalized = normalizeReference(mt.labelRaw);
            if (byLabel.get(normalized) === candidates.length) byLabel.delete(normalized);
          }
        };
        if (isBlankLine(line)) {
          if (mt.sameLineOpen) failCandidate();
          state = "none";
          mlTitle = null;
          i = nextLineStart(i);
          continue;
        }
        let j = i;
        let closed = -1;
        while (j < eol) {
          const c = source[j];
          if (c === "\\" && j + 1 < eol) {
            j += 2;
            continue;
          }
          if (c === mt.quote) {
            closed = j;
            break;
          }
          j++;
        }
        if (closed >= 0) {
          if (source.slice(closed + 1, eol).trim() !== "") {
            if (mt.sameLineOpen) failCandidate();
            state = "none";
            mlTitle = null;
            i = nextLineStart(i);
            continue;
          }
          const titleRaw = source.slice(mt.titleStart, closed + 1);
          const titleContent = source.slice(mt.titleStart + 1, closed);
          finalize(mt.start, mt.labelRaw, mt.destRaw, mt.destContent, titleRaw, titleContent, eol);
          state = "none";
          mlTitle = null;
        }
        i = nextLineStart(i);
        continue;
      }
    }
    return { candidates, byStart, byLabel };
  }
  var LABEL_TOKEN_SOURCE = "MLABELPH[A-Z0-9]{1,8}[0-9]+[aA]{32}MMM";
  var LIT_TOKEN_SOURCE = "MLITPH[A-Z0-9]{1,8}[0-9]+MLM";
  function variantSuffix(occurrenceId) {
    const bits = new Array(32);
    for (let b = 0; b < 32; b++) {
      bits[b] = (occurrenceId & 1 << b) !== 0 ? "A" : "a";
    }
    return bits.join("");
  }
  function labelToken(salt, baseId, occurrenceId) {
    return `MLABELPH${salt}${baseId}${variantSuffix(occurrenceId)}MMM`;
  }
  function litToken(salt, index) {
    return `MLITPH${salt}${index}MLM`;
  }
  function unescapeContent(s) {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "\\" && i + 1 < s.length && isAsciiPunctuation(s[i + 1])) {
        out += s[i + 1];
        i++;
        continue;
      }
      out += s[i];
    }
    return out;
  }
  function isAsciiPunctuation(c) {
    return /[!-/:-@\[-`{-~]/.test(c);
  }

  // tools/preview-src/src/blockcontext.ts
  var ATX_RE = /^#{1,6}(?:[ \t]+|$)/;
  var SETEXT_EQ_RE = /^=+[ \t]*$/;
  var SETEXT_DASH_RE = /^-+[ \t]*$/;
  var HR_RE = /^([-*_])([ \t]*\1){2,}[ \t]*$/;
  var LIST_RE = /^([-+*]|\d{1,9}[.)])(?:[ \t]+|$)/;
  var FENCE_RE = /^(`{3,}|~{3,})/;
  var HR_DASH_RE = /^-{3,}[ \t]*$/;
  function countTrailingBackslashes(s) {
    let k = 0;
    while (k < s.length && s[s.length - 1 - k] === "\\") k++;
    return k;
  }
  function splitUnescapedPipes(s) {
    const parts = [];
    let cur = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "|" && countTrailingBackslashes(cur) % 2 === 0) {
        parts.push(cur);
        cur = "";
        continue;
      }
      cur += c;
    }
    parts.push(cur);
    return parts;
  }
  function tableCells(line) {
    if (!line.includes("|")) return null;
    let cells = splitUnescapedPipes(line);
    if (cells.length > 1 && cells[0].trim() === "") cells = cells.slice(1);
    if (cells.length > 1 && cells[cells.length - 1].trim() === "") cells = cells.slice(0, -1);
    return cells;
  }
  function isTableDelimiter(t) {
    const cells = tableCells(t);
    if (!cells) return false;
    return cells.every((c) => /^:?-+:?$/.test(c.trim()));
  }
  function headerMatchesDelimiter(header, delim) {
    const h = tableCells(header);
    const d = tableCells(delim);
    if (!h || !d) return false;
    return h.length === d.length;
  }
  function delimiterRowShape(delimiter) {
    const dsp = /^ */.exec(delimiter)[0].length;
    if (dsp > 3) return false;
    const dt = delimiter.slice(dsp);
    if (LIST_RE.test(dt)) return false;
    return isTableDelimiter(dt);
  }
  function isValidRawTable(header, delimiter) {
    const hsp = /^ */.exec(header)[0].length;
    if (hsp > 3) return false;
    if (!delimiterRowShape(delimiter)) return false;
    const dsp = /^ */.exec(delimiter)[0].length;
    return headerMatchesDelimiter(header.slice(hsp), delimiter.slice(dsp));
  }
  function tableHeaderEligible(headerRaw, delimiterRaw, snap) {
    if (!isValidRawTable(headerRaw, delimiterRaw)) return false;
    if (!snap.possibleList) return true;
    const hf = listFamilyOf(headerRaw);
    const headerCol0 = !/^[ \t]/.test(headerRaw);
    const headerBlockShaped = /^ {0,3}(`{3,}|~{3,})/.test(headerRaw) || /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(headerRaw) || /^ {0,3}>/.test(headerRaw) || /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/.test(headerRaw) || /^ {0,3}(=+|-+)[ \t]*$/.test(headerRaw);
    const headerIsPlainCol0 = headerCol0 && hf === null && !headerBlockShaped;
    const suppressed = !(snap.listBlankSeen && headerIsPlainCol0) && !(hf !== null && hf !== snap.possibleListFamily);
    return !suppressed;
  }
  var BlockContext = class {
    constructor(salt) {
      this.lastBlock = "start";
      this.paragraphOpen = false;
      /** A list marker was seen and no provable container exit since. */
      this.possibleList = false;
      /** A blank line was seen inside the possible-list span. */
      this.listBlankSeen = false;
      /** Inside the body of a recognized GFM table. */
      this.tableActive = false;
      /**
       * Marker family ('-', '+', '*', '.', ')') of the most recent list marker
       * while a list is possible; null outside list context. List-continuation
       * semantics for table headers depend on the FAMILY (a different-family
       * marker interrupts the list; the same family continues it).
       */
      this.possibleListFamily = null;
      /**
       * List state captured before the PREVIOUS classified line — i.e. before
       * the header line, when the line being classified is a delimiter row.
       */
      this.snapBeforePrevLine = null;
      this.prevLine = null;
      /**
       * The RAW source line corresponding to [prevLine], or null when that line
       * swallowed a multi-line construct (its raw shape is not a single source
       * line) or was blank. Table COLUMN counting uses the raw line: GFM splits
       * header/delimiter rows on unescaped pipes BEFORE inline parsing, so a
       * pipe inside a code span still separates cells even though the span was
       * tokenized (M1 issue: protected-only counting dropped columns).
       */
      this.prevRawLine = null;
      this.codePlaceholderRe = new RegExp(`^ {4}MCODEPH${salt}[0-9]+MMM$`);
      this.linkDefTokenRe = new RegExp(
        `^\\[MLABELPH${salt}[0-9]+[aA]{32}MMM\\]:[ \\t]+MLITPH${salt}[0-9]+MLM(?:[ \\t]+"MLITPH${salt}[0-9]+MLM")?[ \\t]*$`
      );
    }
    /** May an indented line starting here open an indented code block? */
    allowIndented() {
      if (this.paragraphOpen || this.possibleList) return false;
      switch (this.lastBlock) {
        case "start":
        case "blank":
        case "atx":
        case "hr":
        case "setext":
        case "fenceClosed":
        case "indentedCode":
        case "table":
        case "linkDef":
          return true;
        default:
          return false;
      }
    }
    /**
     * A fenced block (top-level or single-level quote) was consumed whole by
     * the scanner. `col0` tells whether a column-0 opener provably exited a
     * possible list.
     */
    onFenceClosed(col0) {
      this.lastBlock = "fenceClosed";
      this.paragraphOpen = false;
      this.tableActive = false;
      if (col0) this.clearList();
    }
    /** Current list state, for the scanner's pre-header row-mode decision. */
    snapshot() {
      return {
        possibleList: this.possibleList,
        listBlankSeen: this.listBlankSeen,
        possibleListFamily: this.possibleListFamily
      };
    }
    clearList() {
      this.possibleList = false;
      this.listBlankSeen = false;
      this.possibleListFamily = null;
    }
    /**
     * Classify one emitted (protected) physical line. [rawSourceLine] is the
     * corresponding raw source line (null when unavailable) — used for table
     * column counting. Returns the resulting block kind; 'table' means this
     * line was accepted as a table delimiter/body row.
     */
    classifyLine(rawProtectedLine, rawSourceLine = null) {
      const line = rawProtectedLine.endsWith("\r") ? rawProtectedLine.slice(0, -1) : rawProtectedLine;
      const snapBeforeThisLine = this.snapshot();
      const snapBeforeHeader = this.snapBeforePrevLine ?? snapBeforeThisLine;
      this.snapBeforePrevLine = snapBeforeThisLine;
      if (line.trim() === "") {
        this.lastBlock = "blank";
        this.paragraphOpen = false;
        this.tableActive = false;
        if (this.possibleList) this.listBlankSeen = true;
        this.prevLine = line;
        this.prevRawLine = null;
        return "blank";
      }
      if (this.codePlaceholderRe.test(line)) {
        this.lastBlock = "indentedCode";
        this.paragraphOpen = false;
        this.tableActive = false;
        this.prevLine = line;
        this.prevRawLine = rawSourceLine;
        return "indentedCode";
      }
      const sp = /^ */.exec(line)[0].length;
      const indent = sp;
      const t = line.slice(sp);
      if (indent <= 3 && FENCE_RE.test(t)) {
        this.lastBlock = "fenceClosed";
        this.paragraphOpen = false;
        this.tableActive = false;
        if (indent === 0) this.clearList();
        this.prevLine = line;
        this.prevRawLine = rawSourceLine;
        return "fenceClosed";
      }
      if (indent <= 3 && ATX_RE.test(t)) {
        this.lastBlock = "atx";
        this.paragraphOpen = false;
        this.tableActive = false;
        if (indent === 0) this.clearList();
        this.prevLine = line;
        this.prevRawLine = rawSourceLine;
        return "atx";
      }
      if (indent <= 3 && SETEXT_EQ_RE.test(t)) {
        if (this.paragraphOpen && !this.possibleList) {
          this.lastBlock = "setext";
          this.paragraphOpen = false;
          this.tableActive = false;
          this.prevLine = line;
          this.prevRawLine = rawSourceLine;
          return "setext";
        }
        this.textLine(line, rawSourceLine);
        return "paragraph";
      }
      if (indent <= 3 && SETEXT_DASH_RE.test(t)) {
        if (this.paragraphOpen && !this.possibleList) {
          this.lastBlock = "setext";
          this.paragraphOpen = false;
          this.tableActive = false;
          this.prevLine = line;
          this.prevRawLine = rawSourceLine;
          return "setext";
        }
        if (!this.paragraphOpen && HR_DASH_RE.test(t)) {
          this.lastBlock = "hr";
          this.tableActive = false;
          if (indent === 0) this.clearList();
          this.prevLine = line;
          this.prevRawLine = rawSourceLine;
          return "hr";
        }
      }
      if (indent <= 3 && HR_RE.test(t)) {
        this.lastBlock = "hr";
        this.paragraphOpen = false;
        this.tableActive = false;
        if (indent === 0) this.clearList();
        this.prevLine = line;
        this.prevRawLine = rawSourceLine;
        return "hr";
      }
      if (indent <= 3 && LIST_RE.test(t)) {
        this.possibleList = true;
        this.possibleListFamily = listFamilyOf(line);
        this.paragraphOpen = true;
        this.tableActive = false;
        this.lastBlock = "other";
        this.prevLine = line;
        this.prevRawLine = rawSourceLine;
        return "other";
      }
      if (indent <= 3 && t.startsWith(">")) {
        if (/^>[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.test(t)) {
          this.lastBlock = "fenceClosed";
          this.paragraphOpen = false;
          this.tableActive = false;
          this.prevLine = line;
          this.prevRawLine = rawSourceLine;
          return "fenceClosed";
        }
        this.lastBlock = "other";
        this.paragraphOpen = true;
        this.tableActive = false;
        this.prevLine = line;
        this.prevRawLine = rawSourceLine;
        return "other";
      }
      if (indent <= 3 && !this.paragraphOpen && !this.tableActive && this.linkDefTokenRe.test(t)) {
        this.markLinkDef(line, rawSourceLine, indent);
        return "linkDef";
      }
      if (indent <= 3 && this.prevLine !== null && this.prevRawLine !== null && rawSourceLine !== null && delimiterRowShape(rawSourceLine) && tableHeaderEligible(this.prevRawLine, rawSourceLine, snapBeforeHeader)) {
        this.lastBlock = "table";
        this.tableActive = true;
        this.paragraphOpen = false;
        this.clearList();
        this.prevLine = line;
        this.prevRawLine = rawSourceLine;
        return "table";
      }
      if (this.tableActive) {
        this.lastBlock = "table";
        this.paragraphOpen = false;
        this.prevLine = line;
        this.prevRawLine = rawSourceLine;
        return "table";
      }
      this.textLine(line, rawSourceLine);
      return this.lastBlock;
    }
    markLinkDef(line, rawSourceLine, indent) {
      this.lastBlock = "linkDef";
      this.paragraphOpen = false;
      this.tableActive = false;
      if (indent === 0) this.clearList();
      this.prevLine = line;
      this.prevRawLine = rawSourceLine;
    }
    textLine(line, rawSourceLine) {
      this.paragraphOpen = true;
      this.lastBlock = "paragraph";
      if (this.possibleList && this.listBlankSeen && !line.startsWith(" ") && !line.startsWith("	")) {
        this.clearList();
      }
      this.prevLine = line;
      this.prevRawLine = rawSourceLine;
    }
  };

  // tools/preview-src/src/delimiters.ts
  var MATH_TOKEN_SOURCE = "MMATHMDPH[A-Z0-9]{1,8}[0-9]+MMM";
  var CODE_TOKEN_SOURCE = "MCODEPH[A-Z0-9]{1,8}[0-9]+MMM";
  var SALT_RE = /^[A-Z0-9]{1,8}$/;
  var isSpanBoundaryLine = (line, quoted, prefix) => {
    const l = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (l.trim() === "") return true;
    if (quoted) {
      if (l.startsWith(prefix)) {
        const body = l.slice(prefix.length);
        if (body.trim() === "") return true;
        return isSpanBoundaryShape(body);
      }
      return /^ {0,3}>[ \t]*$/.test(l);
    }
    if (/^ {0,3}>/.test(l)) return true;
    return isSpanBoundaryShape(l);
  };
  var isSpanBoundaryShape = (body) => {
    if (/^ {0,3}(`{3,}|~{3,})/.test(body)) return true;
    if (/^ {0,3}#{1,6}(?:[ \t]+|$)/.test(body)) return true;
    if (/^ {0,3}(=+|-+)[ \t]*$/.test(body)) return true;
    if (/^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/.test(body)) return true;
    if (/^ {0,3}(?:[-+*]|1[.)])(?:[ \t]+|$)/.test(body)) return true;
    if (isTableDelimiter(body)) return true;
    return false;
  };
  function protectMath(source, salt = "K7", opts = {}) {
    if (!SALT_RE.test(salt)) {
      throw new Error(`salt must match ${SALT_RE}, got "${salt}"`);
    }
    const math = [];
    const code = [];
    const labels = [];
    const lits = [];
    const inline = opts.inlineOnly === true;
    const linkIndex = opts.noLinkRefs || inline ? null : collectLinkDefs(source);
    let occurrence = 0;
    let out = "";
    const n = source.length;
    const ctx = new BlockContext(salt);
    let outLineStart = 0;
    let rawBuf = "";
    let rawLineStart = 0;
    let lineUncertain = false;
    let prevOutLineText = null;
    const cellCount = (l) => {
      if (!hasUnescapedPipe(l)) return null;
      let cells = splitUnescapedPipes(l);
      if (cells.length > 1 && cells[0].trim() === "") cells = cells.slice(1);
      if (cells.length > 1 && cells[cells.length - 1].trim() === "") cells = cells.slice(0, -1);
      return cells.length;
    };
    const escapeFirstUnescapedPipe = (l) => {
      for (let i2 = 0; i2 < l.length; i2++) {
        if (l[i2] === "|" && backslashRunIn(l, i2) % 2 === 0) {
          return `${l.slice(0, i2)}\\|${l.slice(i2 + 1)}`;
        }
      }
      return l;
    };
    let rowPipeMode = false;
    const stripCR = (l) => l.endsWith("\r") ? l.slice(0, -1) : l;
    const hasUnescapedPipe = (l) => {
      for (let i2 = 0; i2 < l.length; i2++) {
        if (l[i2] === "|" && backslashRunIn(l, i2) % 2 === 0) return true;
      }
      return false;
    };
    const backslashRunIn = (s, j) => {
      let k = 0;
      while (j - 1 - k >= 0 && s[j - 1 - k] === "\\") k++;
      return k;
    };
    const blockOpenerShape = (l) => /^ {0,3}(`{3,}|~{3,})/.test(l) || /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(l) || /^ {0,3}(=+|-+)[ \t]*$/.test(l) || /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/.test(l) || /^ {0,3}([-+*]|\d{1,9}[.)])(?:[ \t]+|$)/.test(l) || /^ {0,3}>/.test(l);
    const computeRowMode = (p) => {
      const eol = endOfLine(p);
      const line = stripCR(source.slice(p, eol));
      if (line.trim() === "") return false;
      if (hasUnescapedPipe(line) && eol < n) {
        const neol = endOfLine(eol + 1);
        const next = stripCR(source.slice(eol + 1, neol));
        if (delimiterRowShape(next)) {
          if (tableHeaderEligible(line, next, ctx.snapshot())) return true;
        }
      }
      if (blockOpenerShape(line)) return false;
      return ctx.tableActive;
    };
    const handleLine = (lineText, rawLine) => {
      ctx.classifyLine(lineText, rawLine);
      let replacement = null;
      if (rawLine !== null && !ctx.tableActive && prevOutLineText !== null && delimiterRowShape(rawLine) && hasUnescapedPipe(prevOutLineText)) {
        const protCells = cellCount(prevOutLineText);
        const delimCells = cellCount(rawLine);
        if (protCells !== null && delimCells !== null && protCells === delimCells) {
          replacement = escapeFirstUnescapedPipe(lineText);
        }
      }
      prevOutLineText = lineText;
      return replacement;
    };
    const emit = (s, rawOverride) => {
      if (inline) {
        out += s;
        return;
      }
      out += s;
      if (rawOverride === void 0 || rawOverride !== null) {
        rawBuf += rawOverride === void 0 ? s : rawOverride;
      } else {
        lineUncertain = true;
      }
      let rel = s.indexOf("\n");
      while (rel !== -1) {
        const nlPos = out.length - s.length + rel;
        const outLine = out.slice(outLineStart, nlPos);
        const rawSlice = lineUncertain ? null : rawBuf.slice(rawLineStart, rawBuf.length - s.length + rel);
        const rawLine = rawSlice === null ? null : rawSlice.replace(/\r$/, "");
        const replacement = handleLine(outLine, rawLine);
        if (replacement !== null) {
          out = out.slice(0, outLineStart) + replacement + out.slice(nlPos);
        }
        const suffix = s.length - rel - 1;
        outLineStart = out.length - suffix;
        rawLineStart = rawBuf.length - suffix;
        lineUncertain = false;
        rel = s.indexOf("\n", rel + 1);
      }
    };
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
        if (rowPipeMode && (source[j] === "\n" || source[j] === "|" && backslashRun(j) % 2 === 0)) {
          return -1;
        }
        if (!source.startsWith(closer, j)) continue;
        if (backslashRun(j) % 2 === 1) continue;
        return j;
      }
      return -1;
    };
    const pushMath = (p, openLen, closeIdx, closeLen, display) => {
      const token = mathToken();
      const raw = source.slice(p, closeIdx + closeLen);
      math.push({
        token,
        kind: "math",
        display,
        tex: source.slice(p + openLen, closeIdx),
        raw
      });
      emit(token, raw.includes("\n") ? null : raw);
      return closeIdx + closeLen;
    };
    const tryMath = (p) => {
      const two = source.substring(p, p + 2);
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
      emit(source[p]);
      return p + 1;
    };
    const tryFence = (p) => {
      if (!lineStart(p)) return -1;
      const eol = endOfLine(p);
      const line = source.slice(p, eol);
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(
        line.endsWith("\r") ? line.slice(0, -1) : line
      );
      if (!m) return -1;
      if (m[1][0] === "`" && m[2].includes("`")) return -1;
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
      const rawBody = source.slice(bodyStart, bodyEnd);
      code.push({ token, kind: "code", construct: "fence", raw: rawBody, body: rawBody });
      emit(line);
      emit("\n");
      emit(token, null);
      if (closeIdx >= 0) emit("\n" + source.slice(closeIdx, closeEol));
      ctx.onFenceClosed(/^ {0,3}/.exec(line)[0].length === 0);
      if (closeIdx === -1) return n;
      return closeEol;
    };
    const tryQuoteFence = (p) => {
      if (!lineStart(p)) return -1;
      const eol = endOfLine(p);
      const line = source.slice(p, eol);
      const m = /^( {0,3}> ?)[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(
        line.endsWith("\r") ? line.slice(0, -1) : line
      );
      if (!m) return -1;
      if (m[2][0] === "`" && m[3].includes("`")) return -1;
      const prefix = m[1];
      const fch = m[2][0];
      const flen = m[2].length;
      const closeRe = new RegExp(`^[ \\t]{0,3}[${fch === "`" ? "`" : "~"}]{${flen},}[ \\t]*$`);
      let q = eol < n ? eol + 1 : n;
      const bodyLines = [];
      let closeIdx = -1;
      let closeEol = -1;
      while (q < n) {
        const qeol = endOfLine(q);
        const l = source.slice(q, qeol);
        if (l.startsWith(prefix)) {
          const rest = l.slice(prefix.length);
          if (closeRe.test(rest)) {
            closeIdx = q;
            closeEol = qeol;
            break;
          }
          bodyLines.push(rest);
          q = qeol + 1;
          continue;
        }
        if (/^ {0,3}>/.test(l)) return -1;
        break;
      }
      if (closeIdx === -1 && bodyLines.length === 0) return -1;
      const token = codeToken();
      const rawBody = bodyLines.join("\n");
      code.push({ token, kind: "code", construct: "fence", raw: rawBody, body: rawBody });
      emit(line);
      emit("\n");
      emit(prefix + token, null);
      if (closeIdx >= 0) {
        emit("\n" + source.slice(closeIdx, closeEol));
        return closeEol;
      }
      emit("\n");
      return q;
    };
    const tryLinkDef = (p) => {
      if (linkIndex === null) return -1;
      if (!lineStart(p)) return -1;
      const ci = linkIndex.byStart.get(p);
      if (ci === void 0) return -1;
      if (ctx.paragraphOpen || ctx.tableActive) return -1;
      const cand = linkIndex.candidates[ci];
      if (cand.extentEnd <= p) return -1;
      const base = linkIndex.byLabel.get(normalizeReference(cand.labelRaw));
      if (base === void 0) return -1;
      const lt = labelToken(salt, base, occurrence++);
      labels.push({ token: lt, kind: "label", raw: cand.labelRaw });
      const d0 = litToken(salt, lits.length);
      lits.push({
        token: d0,
        kind: "literal",
        raw: cand.destRaw,
        role: "dest",
        content: cand.destContent
      });
      let emitted = `[${lt}]: ${d0}`;
      if (cand.titleRaw !== null) {
        const t0 = litToken(salt, lits.length);
        lits.push({
          token: t0,
          kind: "literal",
          raw: cand.titleRaw,
          role: "title",
          content: cand.titleContent ?? ""
        });
        emitted += ` "${t0}"`;
      }
      emit(emitted, null);
      return cand.extentEnd;
    };
    const tryReference = (p) => {
      if (linkIndex === null) return -1;
      if (source[p] !== "[") return -1;
      if (backslashRun(p) % 2 === 1) return -1;
      let j = p + 1;
      while (j < n) {
        const c = source[j];
        if (c === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (c === "[") return -1;
        if (c === "]") break;
        if (c === "\n") {
          if (rowPipeMode) return -1;
          const eol = endOfLine(j + 1);
          if (stripCR(source.slice(j + 1, eol)).trim() === "") return -1;
          j++;
          continue;
        }
        if (rowPipeMode && c === "|" && backslashRun(j) % 2 === 0) return -1;
        j++;
      }
      if (j >= n) return -1;
      const labelRaw = source.slice(p + 1, j);
      if (labelRaw.length < 1 || labelRaw.length > 1e3) return -1;
      if (labelRaw.trim() === "") return -1;
      const after = j + 1;
      const next = source[after];
      if (next === "(") return -1;
      if (next === "[") {
        let k = after + 1;
        if (k < n && source[k] === "]") {
          const base2 = linkIndex.byLabel.get(normalizeReference(labelRaw));
          if (base2 === void 0) return -1;
          const lt2 = labelToken(salt, base2, occurrence++);
          labels.push({ token: lt2, kind: "label", raw: labelRaw });
          emit(`[${lt2}][]`);
          return k + 1;
        }
        return -1;
      }
      const base = linkIndex.byLabel.get(normalizeReference(labelRaw));
      if (base === void 0) return -1;
      const lt = labelToken(salt, base, occurrence++);
      labels.push({ token: lt, kind: "label", raw: labelRaw });
      emit(`[${lt}]`);
      return after;
    };
    const tryIndented = (p) => {
      if (!lineStart(p)) return -1;
      const eol = endOfLine(p);
      const line = source.slice(p, eol);
      if (!/^( {4}|\t)/.test(line)) return -1;
      if (line.trim() === "") return -1;
      if (!ctx.allowIndented()) return -1;
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
      const rawBody = lines.join("\n");
      code.push({
        token,
        kind: "code",
        construct: "indented",
        raw: rawBody,
        // Restore content: the scanner strips the 4-space/tab markers exactly
        // like the old restore pass did (kept here so restore is data-driven).
        body: rawBody.replace(/^ {4}/gm, "").replace(/^\t/gm, "")
      });
      emit("    " + token, null);
      if (!endedAtEof) emit("\n");
      return q;
    };
    const tryCodeSpan = (p) => {
      if (source[p] !== "`") return -1;
      if (backslashRun(p) % 2 === 1) return -1;
      let k = 1;
      while (p + k < n && source[p + k] === "`") k++;
      let ls = p;
      while (ls > 0 && source[ls - 1] !== "\n") ls--;
      const openerLineText = source.slice(ls, endOfLine(ls));
      const qm = /^( {0,3}> ?)/.exec(openerLineText);
      const quoted = qm !== null && openerLineText[qm[1].length] !== ">";
      const qprefix = qm ? qm[1] : "";
      let guardPos = source.indexOf("\n", p + k);
      guardPos = guardPos === -1 ? n : guardPos + 1;
      const boundaryBefore = (to) => {
        while (guardPos <= to) {
          const eolIdx = endOfLine(guardPos);
          if (isSpanBoundaryLine(source.slice(guardPos, eolIdx), quoted, qprefix)) return true;
          if (eolIdx >= n) break;
          guardPos = eolIdx + 1;
        }
        return false;
      };
      let q = p + k;
      for (; ; ) {
        const idx = source.indexOf("`", q);
        if (idx === -1) break;
        let k2 = 1;
        while (idx + k2 < n && source[idx + k2] === "`") k2++;
        if (boundaryBefore(idx)) break;
        if (rowPipeMode) {
          let cellBoundary = false;
          for (let j = p + k; j < idx && !cellBoundary; j++) {
            cellBoundary = source[j] === "\n" || source[j] === "|" && backslashRun(j) % 2 === 0;
          }
          if (cellBoundary) break;
        }
        if (k2 === k) {
          const token = codeToken();
          const raw = source.slice(p, idx + k2);
          code.push({
            token,
            kind: "code",
            construct: "span",
            raw,
            body: source.slice(p + k, idx)
          });
          emit(token, raw.includes("\n") ? null : raw);
          return idx + k2;
        }
        q = idx + k2;
      }
      emit(source.slice(p, p + k));
      return p + k;
    };
    let i = 0;
    while (i < n) {
      if (lineStart(i)) rowPipeMode = inline ? false : computeRowMode(i);
      let ni = inline ? -1 : tryFence(i);
      if (ni >= 0) {
        i = ni;
        continue;
      }
      ni = inline ? -1 : tryQuoteFence(i);
      if (ni >= 0) {
        i = ni;
        continue;
      }
      ni = inline ? -1 : tryLinkDef(i);
      if (ni >= 0) {
        i = ni;
        continue;
      }
      ni = inline ? -1 : tryIndented(i);
      if (ni >= 0) {
        i = ni;
        continue;
      }
      ni = tryCodeSpan(i);
      if (ni >= 0) {
        i = ni;
        continue;
      }
      ni = inline ? -1 : tryReference(i);
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
        emit(source.substring(i, i + 2));
        i += 2;
        continue;
      }
      emit(source[i]);
      i++;
    }
    if (!inline && outLineStart < out.length) {
      const outLine = out.slice(outLineStart);
      const rawSlice = lineUncertain ? null : rawBuf.slice(rawLineStart);
      const rawLine = rawSlice === null ? null : rawSlice.replace(/\r$/, "");
      const replacement = handleLine(outLine, rawLine);
      if (replacement !== null) {
        out = out.slice(0, outLineStart) + replacement;
      }
    }
    return { text: out, math, code, labels, lits };
  }

  // tools/preview-src/src/tsvtables.ts
  var DEFAULTS = { minRows: 3, minCols: 2 };
  var looksContainerLine = (line) => /^[\t >]/.test(line) || /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/.test(line);
  function clamp(value, fallback) {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.max(2, Math.floor(value));
  }
  function convertTsvTables(text, opts) {
    const minRows = clamp(opts?.minRows, DEFAULTS.minRows);
    const minCols = clamp(opts?.minCols, DEFAULTS.minCols);
    const isTsvLine = (line) => line.indexOf("	") !== -1 && line.split("	").length >= minCols;
    const lines = text.split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      if (!isTsvLine(lines[i])) {
        out.push(lines[i]);
        i++;
        continue;
      }
      const paras = [];
      let cols = minCols;
      let end = i;
      let containsContainerLine = looksContainerLine(lines[i]);
      for (; ; ) {
        const rows = [];
        while (end < lines.length && isTsvLine(lines[end])) {
          if (looksContainerLine(lines[end])) containsContainerLine = true;
          const cells = lines[end].split("	");
          if (cells.length > cols) cols = cells.length;
          rows.push(cells);
          end++;
        }
        paras.push({ rows, cols });
        let next = end;
        while (next < lines.length && lines[next].trim() === "") next++;
        if (next < lines.length && isTsvLine(lines[next]) && lines[next].split("	").length === cols) {
          end = next;
          continue;
        }
        break;
      }
      const totalRows = paras.reduce((s, p) => s + p.rows.length, 0);
      if (totalRows < minRows) {
        for (let k = i; k < end; k++) out.push(lines[k]);
        i = end;
        continue;
      }
      if (containsContainerLine) {
        for (let k = i; k < end; k++) out.push(lines[k]);
        i = end;
        continue;
      }
      const escapeCell = (c) => c.trim().replace(/\|/g, "\\|");
      const tableLine = (cells) => {
        const cs = cells.map(escapeCell);
        while (cs.length < cols) cs.push("");
        return `| ${cs.join(" | ")} |`;
      };
      let first = true;
      if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
      for (const p of paras) {
        for (const cells of p.rows) {
          out.push(tableLine(cells));
          if (first) {
            first = false;
            out.push(`|${" --- |".repeat(cols)}`);
          }
        }
      }
      if (end < lines.length && lines[end].trim() !== "") out.push("");
      i = end;
    }
    return out.join("\n");
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
    const mdSource = opts.tsvTables ?? true ? convertTsvTables(prot.text, { minRows: opts.tsvMinRows, minCols: opts.tsvMinCols }) : prot.text;
    const md = v.markdownit({ html: false, linkify: true });
    md.use(markdownItCjkFriendlyPlugin);
    let html = md.render(mdSource);
    const insideTag = (offset) => html.lastIndexOf("<", offset) > html.lastIndexOf(">", offset);
    const codeByToken = new Map(prot.code.map((s) => [s.token, s]));
    const mathByToken = new Map(prot.math.map((s) => [s.token, s]));
    const labelByToken = new Map(prot.labels.map((s) => [s.token, s]));
    const litByToken = new Map(prot.lits.map((s) => [s.token, s]));
    const fragMd = v.markdownit({ html: false, linkify: true });
    fragMd.use(markdownItCjkFriendlyPlugin);
    const SALT_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const saltCandidate = (idx, len) => {
      let c = "";
      for (let pos = len - 1; pos >= 0; pos--) {
        c = SALT_ALPHABET[idx % 36] + c;
        idx = Math.floor(idx / 36);
      }
      return c;
    };
    const pickFragSalt = (raw) => {
      const collides = (cand) => raw.includes("MMATHMDPH" + cand) || raw.includes("MCODEPH" + cand) || raw.includes("MLABELPH" + cand) || raw.includes("MLITPH" + cand);
      for (let len = 2; len <= 8; len++) {
        const count = Math.pow(36, len);
        for (let idx = 0; idx < count; idx++) {
          const cand = saltCandidate(idx, len);
          if (cand === salt) continue;
          if (collides(cand)) continue;
          return cand;
        }
      }
      throw new Error("MathMD: no collision-free inner salt exists");
    };
    const renderLabelFragment = (raw) => {
      const fragSalt = pickFragSalt(raw);
      const fp = protectMath(raw, fragSalt, { inlineOnly: true });
      const fCode = new Map(fp.code.map((s) => [s.token, s]));
      const fMath = new Map(fp.math.map((s) => [s.token, s]));
      let fh = fragMd.renderInline(fp.text);
      const fInsideTag = (offset) => fh.lastIndexOf("<", offset) > fh.lastIndexOf(">", offset);
      fh = fh.replace(new RegExp(CODE_TOKEN_SOURCE, "g"), (tok, offset) => {
        const seg = fCode.get(tok);
        if (!seg) return tok;
        if (fInsideTag(offset)) return esc(seg.raw);
        if (seg.construct === "span") {
          let body = seg.body.replace(/\r\n?|\n/g, " ");
          if (body.startsWith(" ") && body.endsWith(" ") && /[^ ]/.test(body)) {
            body = body.slice(1, -1);
          }
          return `<code>${esc(body)}</code>`;
        }
        return esc(seg.body);
      });
      let fragMathCount = 0;
      fh = fh.replace(new RegExp(MATH_TOKEN_SOURCE, "g"), (tok, offset) => {
        const seg = fMath.get(tok);
        if (!seg) return tok;
        if (fInsideTag(offset)) return esc(seg.raw);
        fragMathCount++;
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
      return { html: fh, mathCount: fragMathCount };
    };
    const restoreAttributeContent = (role, content) => {
      const innerSalt = pickFragSalt(content);
      const ip = protectMath(content, innerSalt, { inlineOnly: true });
      const innerByToken = /* @__PURE__ */ new Map();
      for (const seg of ip.math) innerByToken.set(seg.token, seg.raw);
      for (const seg of ip.code) innerByToken.set(seg.token, seg.raw);
      const restoreTokens = (text) => text.replace(
        new RegExp(`${MATH_TOKEN_SOURCE}|${CODE_TOKEN_SOURCE}`, "g"),
        (tok) => {
          const raw = innerByToken.get(tok);
          return raw !== void 0 ? raw : tok;
        }
      );
      const lineNormalized = ip.text.replace(/\r\n?/g, "\n");
      const unescaped = unescapeContent(lineNormalized);
      return restoreTokens(role === "title" ? unescaped : md.normalizeLink(unescaped));
    };
    let visibleMath = 0;
    const ANY_TOKEN_RE = new RegExp(
      `${MATH_TOKEN_SOURCE}|${CODE_TOKEN_SOURCE}|${LABEL_TOKEN_SOURCE}|${LIT_TOKEN_SOURCE}`,
      "g"
    );
    html = html.replace(ANY_TOKEN_RE, (tok, offset) => {
      const codeSeg = codeByToken.get(tok);
      if (codeSeg !== void 0) {
        if (insideTag(offset)) return esc(codeSeg.raw);
        if (codeSeg.construct === "span") {
          let body = codeSeg.body.replace(/\r\n?|\n/g, " ");
          if (body.startsWith(" ") && body.endsWith(" ") && /[^ ]/.test(body)) {
            body = body.slice(1, -1);
          }
          return `<code>${esc(body)}</code>`;
        }
        if (codeSeg.construct === "fence") return esc(codeSeg.raw);
        return esc(codeSeg.body);
      }
      const litSeg = litByToken.get(tok);
      if (litSeg !== void 0) {
        return esc(restoreAttributeContent(litSeg.role, litSeg.content));
      }
      const labelSeg = labelByToken.get(tok);
      if (labelSeg !== void 0) {
        if (insideTag(offset)) return esc(labelSeg.raw);
        const frag = renderLabelFragment(labelSeg.raw);
        visibleMath += frag.mathCount;
        return frag.html;
      }
      const mathSeg = mathByToken.get(tok);
      if (mathSeg !== void 0) {
        if (insideTag(offset)) return esc(mathSeg.raw);
        visibleMath++;
        try {
          return v.katex.renderToString(mathSeg.tex, {
            displayMode: mathSeg.display,
            throwOnError: opts.throwOnError ?? false,
            strict: false,
            trust: false
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          errors.push({ tex: mathSeg.tex, message });
          return `<span class="math-error">${esc(mathSeg.tex)}</span>`;
        }
      }
      return tok;
    });
    return { html, mathCount: visibleMath, errors };
  }
  globalThis.MathMD = {
    renderMarkdown,
    protectMath,
    normalizeReference
  };

  // tools/preview-src/src/casefold.ts
  var foldOperations = 0;
  function foldOperationCount() {
    return foldOperations;
  }
  function foldCaseWithMap(s) {
    foldOperations++;
    const folded = s.toLowerCase();
    if (folded === s) {
      const n = s.length;
      const ownerStart = new Array(n);
      const ownerEnd = new Array(n);
      for (let i = 0; i < n; i++) {
        ownerStart[i] = i;
        ownerEnd[i] = i + 1;
      }
      return { folded, ownerStart, ownerEnd };
    }
    const pieces = [];
    const pieceStart = [];
    const pieceEnd = [];
    for (let i = 0; i < s.length; ) {
      const cp = s.codePointAt(i);
      const size = cp > 65535 ? 2 : 1;
      pieces.push(String.fromCodePoint(cp).toLowerCase());
      pieceStart.push(i);
      pieceEnd.push(i + size);
      i += size;
    }
    const aligned = alignOwnerMap(pieces, pieceStart, pieceEnd, folded);
    if (aligned === null) return null;
    return { folded, ownerStart: aligned.ownerStart, ownerEnd: aligned.ownerEnd };
  }
  function alignOwnerMap(pieces, pieceStart, pieceEnd, folded) {
    const expWidths = [];
    const ownerOfCp = [];
    pieces.forEach((p, k) => {
      for (let u = 0; u < p.length; ) {
        const cp = p.codePointAt(u);
        const w = cp > 65535 ? 2 : 1;
        expWidths.push(w);
        ownerOfCp.push(k);
        u += w;
      }
    });
    const ownerStart = [];
    const ownerEnd = [];
    let bi = 0;
    for (let j = 0; j < expWidths.length; j++) {
      if (bi >= folded.length) return null;
      const fb = folded.codePointAt(bi);
      const fbSize = fb > 65535 ? 2 : 1;
      if (fbSize !== expWidths[j]) return null;
      const k = ownerOfCp[j];
      for (let u = 0; u < fbSize; u++) {
        ownerStart.push(pieceStart[k]);
        ownerEnd.push(pieceEnd[k]);
      }
      bi += fbSize;
    }
    if (bi !== folded.length) return null;
    return { ownerStart, ownerEnd };
  }
  function hasUnpairedSurrogate(s) {
    for (let i = 0; i < s.length; i++) {
      const cu = s.charCodeAt(i);
      if (cu >= 55296 && cu <= 56319) {
        const nx = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
        if (!(nx >= 56320 && nx <= 57343)) return true;
        i++;
      } else if (cu >= 56320 && cu <= 57343) {
        return true;
      }
    }
    return false;
  }
  var isHighHalf = (c) => c >= "\uD800" && c <= "\uDBFF";
  var isLowHalf = (c) => c >= "\uDC00" && c <= "\uDFFF";
  function matchRangesInFolded(f, originalText, foldedQuery) {
    if (foldedQuery.length === 0) return [];
    if (hasUnpairedSurrogate(foldedQuery)) return [];
    const out = [];
    let from = 0;
    for (; ; ) {
      const first = f.folded.indexOf(foldedQuery, from);
      if (first === -1) break;
      const last = first + foldedQuery.length - 1;
      if (last >= f.ownerStart.length) break;
      const origStart = f.ownerStart[first];
      const origEnd = f.ownerEnd[last];
      if (origStart < 0 || origEnd > originalText.length || origStart >= origEnd) {
        break;
      }
      const startMidPair = origStart > 0 && isLowHalf(originalText[origStart]) && isHighHalf(originalText[origStart - 1]);
      const endMidPair = origEnd < originalText.length && isHighHalf(originalText[origEnd - 1]) && isLowHalf(originalText[origEnd]);
      if (startMidPair || endMidPair) {
        from = first + foldedQuery.length;
        continue;
      }
      out.push([origStart, origEnd]);
      from = first + foldedQuery.length;
    }
    return out;
  }
  function foldedMatchRanges(text, query) {
    if (query.length === 0) return [];
    const t = foldCaseWithMap(text);
    if (t === null) return [];
    return matchRangesInFolded(t, text, query.toLowerCase());
  }

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
    paintedRanges = null;
  }
  var findNodes = null;
  var findFolded = [];
  var findNodesRoot = null;
  var findQuery = null;
  var findRanges = [];
  var paintedRanges = null;
  function invalidateFindIndex() {
    findNodes = null;
    findFolded = [];
    findNodesRoot = null;
    findQuery = null;
    findRanges = [];
    paintedRanges = null;
  }
  function paint(ranges, active) {
    const g = globalThis;
    if (g.CSS?.highlights && g.Highlight) {
      if (paintedRanges !== ranges) {
        g.CSS.highlights.set("mathmd-find", new g.Highlight(...ranges));
        paintedRanges = ranges;
      }
      if (ranges[active]) g.CSS.highlights.set("mathmd-find-active", new g.Highlight(ranges[active]));
      else g.CSS.highlights.delete("mathmd-find-active");
      return;
    }
    const sel = window.getSelection?.();
    sel?.removeAllRanges();
    if (ranges[active]) sel?.addRange(ranges[active]);
  }
  function scrollToRange(range) {
    let el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
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
    window.scrollTo(Math.max(0, left), Math.max(0, top));
  }
  function find(query, active) {
    const target = document.getElementById("preview");
    if (!target || !query || typeof document.createTreeWalker !== "function") {
      clearFind();
      return { total: 0, active: -1 };
    }
    if (findNodesRoot !== target || findNodes === null) {
      findNodes = textNodesUnder(target);
      findFolded = findNodes.map((n) => {
        const f = foldCaseWithMap(n.nodeValue ?? "");
        if (f === null) {
          console.warn("MathMD find: text node could not be case-folded safely; skipped");
        }
        return f;
      });
      findNodesRoot = target;
      findQuery = null;
      findRanges = [];
    }
    const nodes = findNodes;
    const q = query.toLowerCase();
    if (findQuery !== q) {
      const ranges2 = [];
      for (let k = 0; k < nodes.length; k++) {
        const folded = findFolded[k];
        if (folded === null) continue;
        for (const [origStart, origEnd] of matchRangesInFolded(folded, nodes[k].nodeValue ?? "", q)) {
          const r = document.createRange();
          r.setStart(nodes[k], origStart);
          r.setEnd(nodes[k], origEnd);
          ranges2.push(r);
        }
      }
      findQuery = q;
      findRanges = ranges2;
    }
    const ranges = findRanges;
    if (ranges.length === 0) {
      clearFind();
      return { total: 0, active: -1 };
    }
    const idx = active < 0 ? 0 : Math.min(active, ranges.length - 1);
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
      invalidateFindIndex();
      const result = renderMarkdown(markdown, {
        salt: randomSalt(),
        tsvTables: opts?.tsvTables,
        tsvMinRows: opts?.tsvMinRows,
        tsvMinCols: opts?.tsvMinCols
      });
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
  bridge.MathMD = {
    ...bridge.MathMD ?? {},
    hostUpdate,
    find,
    foldCaseWithMap,
    foldedMatchRanges,
    matchRangesInFolded,
    alignOwnerMap,
    foldOperationCount
  };
  document.addEventListener("DOMContentLoaded", () => {
    const target = document.getElementById("preview");
    if (target && target.childElementCount === 0) {
      target.innerHTML = "<p><em>Waiting for document\u2026</em></p>";
    }
  });
})();
