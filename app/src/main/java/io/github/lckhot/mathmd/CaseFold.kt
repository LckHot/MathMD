package io.github.lckhot.mathmd

/**
 * Unicode case folding with owner-range mapping (M3), mirroring
 * tools/preview-src/src/casefold.ts — same semantics, same vectors
 * (CaseFoldTest.kt / tools/mdtest/run.js keep the two honest).
 *
 * The whole-string lowercase is context-authoritative (Final Sigma), and
 * per-code-point folding is only accepted when it aligns with it — same
 * code-point count, same per-step UTF-16 width. Otherwise the text is
 * unsearchable-conservatively (null): a folded offset must never become a
 * selection range, and no clamping may paper over a misalignment.
 */
internal object CaseFold {

    class Folded(val folded: String, val ownerStart: IntArray, val ownerEnd: IntArray)

    fun foldCaseWithMap(s: String): Folded? {
        val folded = s.lowercase()
        if (folded == s) {
            // Identity fast path — only on full equality.
            val n = s.length
            val start = IntArray(n) { it }
            val end = IntArray(n) { it + 1 }
            return Folded(folded, start, end)
        }

        // Slow path: fold each original code point on its own.
        val pieces = ArrayList<String>()
        val pieceStart = ArrayList<Int>()
        val pieceEnd = ArrayList<Int>()
        var i = 0
        while (i < s.length) {
            val size = if (i + 1 < s.length && Character.isHighSurrogate(s[i]) &&
                Character.isLowSurrogate(s[i + 1])
            ) 2 else 1
            pieces.add(s.substring(i, i + size).lowercase())
            pieceStart.add(i)
            pieceEnd.add(i + size)
            i += size
        }

        val aligned = alignOwnerMap(pieces, pieceStart, pieceEnd, folded) ?: return null
        return Folded(folded, aligned.first, aligned.second)
    }

    /**
     * Alignment gate (Lead review; internal so it is unit-testable
     * directly). Walks the CODE POINTS of the per-code-point fold and the
     * whole-string fold in lockstep; every step must have the same UTF-16
     * width. A piece may fold to several code points (İ → i + U+0307) —
     * all share the original as owner. Equal-width character differences
     * (Final Sigma σ vs ς) are accepted: the whole-string character is
     * authoritative. Returns null on any width/count disagreement.
     */
    internal fun alignOwnerMap(
        pieces: List<String>,
        pieceStart: List<Int>,
        pieceEnd: List<Int>,
        folded: String,
    ): Pair<IntArray, IntArray>? {
        val expWidths = ArrayList<Int>()
        val ownerOfCp = ArrayList<Int>()
        pieces.indices.forEach { k ->
            var u = 0
            val p = pieces[k]
            while (u < p.length) {
                val w = if (Character.isHighSurrogate(p[u]) &&
                    u + 1 < p.length && Character.isLowSurrogate(p[u + 1])
                ) 2 else 1
                expWidths.add(w)
                ownerOfCp.add(k)
                u += w
            }
        }

        val start = ArrayList<Int>()
        val end = ArrayList<Int>()
        var bi = 0 // cursor into the whole-string fold
        for (j in expWidths.indices) {
            if (bi >= folded.length) return null
            val fbSize = if (Character.isHighSurrogate(folded[bi]) &&
                bi + 1 < folded.length && Character.isLowSurrogate(folded[bi + 1])
            ) 2 else 1
            if (fbSize != expWidths[j]) return null
            val k = ownerOfCp[j]
            repeat(fbSize) {
                start.add(pieceStart[k])
                end.add(pieceEnd[k])
            }
            bi += fbSize
        }
        if (bi != folded.length) return null
        return start.toIntArray() to end.toIntArray()
    }

    /**
     * True when [s] contains an unpaired UTF-16 surrogate half — such a
     * query can never address a whole code point and matches nothing
     * (shared TS/Kotlin contract).
     */
    fun hasUnpairedSurrogate(s: String): Boolean {
        var i = 0
        while (i < s.length) {
            val cu = s[i]
            if (cu.isHighSurrogate()) {
                if (i + 1 >= s.length || !s[i + 1].isLowSurrogate()) return true
                i += 2
                continue
            }
            if (cu.isLowSurrogate()) return true // lone low half
            i++
        }
        return false
    }

    /**
     * All case-insensitive non-overlapping matches of an ALREADY-FOLDED
     * query inside an ALREADY-CACHED [f] (built from [text]), as ORIGINAL
     * UTF-16 ranges (inclusive first..last, matching the editor's
     * selection logic). An unpaired-surrogate query matches nothing, and
     * no returned range may cut a surrogate pair in half.
     */
    fun matchRangesInFolded(f: Folded, text: String, foldedQuery: String): List<IntRange> {
        if (foldedQuery.isEmpty()) return emptyList()
        if (hasUnpairedSurrogate(foldedQuery)) return emptyList()
        val out = ArrayList<IntRange>()
        var from = 0
        while (true) {
            val first = f.folded.indexOf(foldedQuery, from)
            if (first == -1) break
            val last = first + foldedQuery.length - 1
            if (last >= f.ownerStart.size) break // defensive; cannot happen
            val origStart = f.ownerStart[first]
            val origEnd = f.ownerEnd[last]
            if (origStart < 0 || origEnd > text.length || origStart >= origEnd) {
                break // alignment invariant violated — never guess a range
            }
            // Never return half of a surrogate pair.
            val startMidPair = origStart > 0 &&
                text[origStart].isLowSurrogate() && text[origStart - 1].isHighSurrogate()
            val endMidPair = origEnd < text.length &&
                text[origEnd - 1].isHighSurrogate() && text[origEnd].isLowSurrogate()
            if (startMidPair || endMidPair) {
                from = first + foldedQuery.length // skip this hit, keep scanning
                continue
            }
            out.add(origStart until origEnd)
            from = first + foldedQuery.length
        }
        return out
    }

    /**
     * Convenience wrapper: fold [text] and [query] (same whole-string
     * semantics) and match. Empty query → empty list; unalignable text →
     * empty list (conservative miss).
     */
    fun matchRanges(text: String, query: String): List<IntRange> {
        if (query.isEmpty()) return emptyList()
        val t = foldCaseWithMap(text) ?: return emptyList()
        return matchRangesInFolded(t, text, query.lowercase())
    }
}
