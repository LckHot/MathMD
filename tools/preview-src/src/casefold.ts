/**
 * Unicode case folding with owner-range mapping (M3).
 *
 * Both the preview search (TS, DOM Ranges) and the editor search (Kotlin,
 * IntRange) match case-insensitively. Folding changes string LENGTHS
 * (`İ` → `i` + U+0307; Deseret caps are astral), so a match offset in the
 * folded text is NOT an offset in the original — using it directly either
 * mis-highlights or throws (setEnd past the node end).
 *
 * foldCaseWithMap() folds the WHOLE string once (context-authoritative:
 * Final Sigma needs the surrounding word) and, when that differs from the
 * input, builds a per-code-point owner map — then EXPLICITLY aligns the
 * two folds (Lead review gate). Any width or count disagreement between
 * per-code-point folding and whole-string folding means the difference is
 * not safely attributable to a single original code point; the function
 * then returns null and callers must conservatively report NO match for
 * that text (never hand a folded offset to the DOM, never clamp).
 *
 * matchRangesInFolded() matches against an ALREADY-CACHED Folded — the
 * preview host builds the fold once per text node and reuses it for every
 * query (foldOperationCount() is the probe that proves it).
 *
 * The TS and Kotlin implementations share semantics and the test vectors
 * in tools/mdtest/run.js + CaseFoldTest.kt; keep them in sync.
 */

export interface Folded {
  readonly folded: string;
  /** For each UTF-16 unit of `folded`: the start of its owning original unit. */
  readonly ownerStart: readonly number[];
  /** For each UTF-16 unit of `folded`: the end (exclusive) of its owner. */
  readonly ownerEnd: readonly number[];
}

/** Diagnostic: total foldCaseWithMap invocations (cache-reuse probe). */
let foldOperations = 0;

export function foldOperationCount(): number {
  return foldOperations;
}

export function foldCaseWithMap(s: string): Folded | null {
  foldOperations++;
  const folded = s.toLowerCase();
  if (folded === s) {
    // Identity fast path — ONLY on full equality, never on equal lengths.
    const n = s.length;
    const ownerStart = new Array<number>(n);
    const ownerEnd = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      ownerStart[i] = i;
      ownerEnd[i] = i + 1;
    }
    return { folded, ownerStart, ownerEnd };
  }

  // Slow path: fold each ORIGINAL code point on its own.
  const pieces: string[] = [];
  const pieceStart: number[] = [];
  const pieceEnd: number[] = [];
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i)!;
    const size = cp > 0xffff ? 2 : 1;
    pieces.push(String.fromCodePoint(cp).toLowerCase());
    pieceStart.push(i);
    pieceEnd.push(i + size);
    i += size;
  }

  const aligned = alignOwnerMap(pieces, pieceStart, pieceEnd, folded);
  if (aligned === null) return null;
  return { folded, ownerStart: aligned.ownerStart, ownerEnd: aligned.ownerEnd };
}

/**
 * Alignment gate (Lead review; exported for unit tests). Walks the CODE
 * POINTS of the per-code-point fold and the whole-string fold in lockstep:
 * every step must have the same UTF-16 width. A piece may fold to several
 * code points (İ → i + U+0307) — all of them share the original code point
 * as owner. Equal-width character differences (Final Sigma σ vs ς) are
 * accepted: the whole-string character is authoritative and the owner
 * stays the whole original code point. Any width or count disagreement is
 * unattributable → null (conservative miss).
 */
export function alignOwnerMap(
  pieces: readonly string[],
  pieceStart: readonly number[],
  pieceEnd: readonly number[],
  folded: string,
): { ownerStart: number[]; ownerEnd: number[] } | null {
  const expWidths: number[] = [];
  const ownerOfCp: number[] = [];
  pieces.forEach((p, k) => {
    for (let u = 0; u < p.length; ) {
      const cp = p.codePointAt(u)!;
      const w = cp > 0xffff ? 2 : 1;
      expWidths.push(w);
      ownerOfCp.push(k);
      u += w;
    }
  });

  const ownerStart: number[] = [];
  const ownerEnd: number[] = [];
  let bi = 0; // cursor into folded
  for (let j = 0; j < expWidths.length; j++) {
    if (bi >= folded.length) return null;
    const fb = folded.codePointAt(bi)!;
    const fbSize = fb > 0xffff ? 2 : 1;
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

/**
 * True when [s] contains an unpaired UTF-16 surrogate half. Such a query
 * can never address a whole code point; matching it would return a range
 * that cuts a surrogate pair, so it matches nothing (shared TS/Kotlin
 * contract).
 */
export function hasUnpairedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const cu = s.charCodeAt(i);
    if (cu >= 0xd800 && cu <= 0xdbff) {
      const nx = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (!(nx >= 0xdc00 && nx <= 0xdfff)) return true;
      i++; // skip the low half of the pair
    } else if (cu >= 0xdc00 && cu <= 0xdfff) {
      return true; // lone low surrogate
    }
  }
  return false;
}

const isHighHalf = (c: string): boolean => c >= '\uD800' && c <= '\uDBFF';
const isLowHalf = (c: string): boolean => c >= '\uDC00' && c <= '\uDFFF';

/**
 * All case-insensitive non-overlapping matches of an ALREADY-FOLDED query
 * inside an ALREADY-CACHED [f] (built from [originalText]), as ORIGINAL
 * UTF-16 ranges [start, end). The fold is never recomputed here — callers
 * that have a Folded cache (the preview host) must use this entry point.
 * A query containing an unpaired surrogate matches nothing, and no
 * returned range may cut a surrogate pair in half.
 */
export function matchRangesInFolded(
  f: Folded,
  originalText: string,
  foldedQuery: string,
): Array<[number, number]> {
  if (foldedQuery.length === 0) return [];
  if (hasUnpairedSurrogate(foldedQuery)) return [];
  const out: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const first = f.folded.indexOf(foldedQuery, from);
    if (first === -1) break;
    const last = first + foldedQuery.length - 1;
    if (last >= f.ownerStart.length) break; // defensive; cannot happen
    const origStart = f.ownerStart[first];
    const origEnd = f.ownerEnd[last];
    if (origStart < 0 || origEnd > originalText.length || origStart >= origEnd) {
      break; // alignment invariant violated — do not guess a range
    }
    // Never return half of a surrogate pair (start/end mid-pair guards).
    const startMidPair =
      origStart > 0 && isLowHalf(originalText[origStart]) && isHighHalf(originalText[origStart - 1]);
    const endMidPair =
      origEnd < originalText.length &&
      isHighHalf(originalText[origEnd - 1]) &&
      isLowHalf(originalText[origEnd]);
    if (startMidPair || endMidPair) {
      from = first + foldedQuery.length; // skip this hit, keep scanning
      continue;
    }
    out.push([origStart, origEnd]);
    from = first + foldedQuery.length;
  }
  return out;
}

/**
 * Convenience wrapper: fold [text], fold [query] (same whole-string
 * semantics), match. Tests and one-shot callers use this; hot paths use
 * matchRangesInFolded with a cached Folded. An empty query matches
 * nothing; an unalignable text yields no matches (conservative — see
 * foldCaseWithMap).
 */
export function foldedMatchRanges(text: string, query: string): Array<[number, number]> {
  if (query.length === 0) return [];
  const t = foldCaseWithMap(text);
  if (t === null) return [];
  return matchRangesInFolded(t, text, query.toLowerCase());
}
