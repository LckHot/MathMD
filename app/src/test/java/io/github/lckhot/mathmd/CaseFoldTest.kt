package io.github.lckhot.mathmd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M3 shared vectors (mirrored by tools/mdtest/run.js §27). Ranges are
 * inclusive-last IntRanges in ORIGINAL UTF-16 units; the JS side asserts
 * the end-exclusive equivalents.
 */
class CaseFoldTest {

    private fun ranges(text: String, query: String) = CaseFold.matchRanges(text, query)

    @Test
    fun asciiCaseInsensitive() {
        assertEquals(listOf(0..2, 8..10), ranges("Foo bar FOO", "foo"))
    }

    @Test
    fun expandedLetterIsHighlightedWhole() {
        // İ lowers to i + U+0307 (2 units); a hit inside it covers the
        // whole original code point.
        assertEquals(listOf(0..0), ranges("İ", "i"))
        assertEquals(listOf(1..1), ranges("AİB", "i"))
        assertEquals(listOf(2..2), ranges("😀İx", "i")) // after a surrogate pair
    }

    @Test
    fun expandedQueryMatchesComposedOriginal() {
        // Query İ folds to 2 units and matches the composed original text.
        assertEquals(listOf(0..1), ranges("i̇", "İ"))
    }

    @Test
    fun sharpSAndDeseret() {
        assertEquals(listOf(0..0), ranges("ẞ", "ß"))
        // U+10400's lowercase is U+10428 (astral, 2 UTF-16 units).
        assertEquals(listOf(0..1), ranges("𐐀", "𐐨"))
    }

    @Test
    fun nonOverlappingProgress() {
        assertEquals(listOf(0..1, 2..3), ranges("aaaa", "aa"))
    }

    @Test
    fun emptyQueryHasNoMatches() {
        assertTrue(ranges("anything", "").isEmpty())
    }

    @Test
    fun finalSigmaSlowPathFoldAndOwners() {
        // Direct slow-path assertions, not just end-to-end search: İ ΟΣ
        // must fold with the whole-string Final-Sigma context rule.
        val f = CaseFold.foldCaseWithMap("İ ΟΣ")
        assertNotNull(f)
        assertEquals("i\u0307 ος", f!!.folded)
        assertEquals(5, f.folded.length)
        assertEquals(
            listOf(0, 0, 1, 2, 3),
            f.ownerStart.toList(),
        )
        assertEquals(
            listOf(1, 1, 2, 3, 4),
            f.ownerEnd.toList(),
        )
    }

    @Test
    fun finalSigmaSearchVectors() {
        assertEquals(listOf(0..0), ranges("İ ΟΣ", "i"))
        // Query folds with the same whole-string semantics as the text, so
        // ΟΣ matches its folded image regardless of the sigma variant.
        assertEquals(listOf(2..3), ranges("İ ΟΣ", "ΟΣ"))
    }

    @Test
    fun nonFinalSigmaMatchesFully() {
        assertEquals(listOf(0..2), ranges("ΟΣΑ", "οσα"))
    }

    @Test
    fun identityFastPathIsIdentity() {
        // No uppercase to fold — folds to itself, owners are the identity.
        val f = CaseFold.foldCaseWithMap("plain digits 123")
        assertNotNull(f)
        assertEquals("plain digits 123", f!!.folded)
        assertEquals((0 until f.folded.length).toList(), f.ownerStart.toList())
        assertEquals((1..f.folded.length).toList(), f.ownerEnd.toList())
    }

    @Test
    fun invariantsHoldOnTrickyInputs() {
        for (text in listOf("İ ΟΣ", "😀İx", "AİB", "𐐀b", "ẞß", "")) {
            for (query in listOf("i", "ß", "𐐨", "οσ", "x", "")) {
                var lastEnd = -1
                for (r in ranges(text, query)) {
                    assertTrue(r.first >= 0)
                    assertTrue(r.last + 1 <= text.length)
                    assertTrue(r.first <= r.last)
                    assertTrue(r.first > lastEnd) // ordered, non-overlapping
                    lastEnd = r.last
                    // Never half of a surrogate pair.
                    if (r.last + 1 < text.length) {
                        assertTrue(
                            !(Character.isHighSurrogate(text[r.last]) &&
                                Character.isLowSurrogate(text[r.last + 1])),
                        )
                    }
                }
            }
        }
    }

    @Test
    fun alignmentGateAcceptsEqualWidthCharacterDifference() {
        // Final Sigma: per-code-point fold of Σ is σ, whole-string fold is
        // ς — equal width, whole-string character wins, owner unchanged.
        val aligned = CaseFold.alignOwnerMap(
            listOf("i", "̇", " ", "ο", "σ"),
            listOf(0, 0, 1, 2, 3),
            listOf(1, 1, 2, 3, 4),
            "i̇ ος",
        )
        assertNotNull(aligned)
        assertEquals(listOf(0, 0, 1, 2, 3), aligned!!.first.toList())
        assertEquals(listOf(1, 1, 2, 3, 4), aligned.second.toList())
    }

    @Test
    fun alignmentGateRejectsWidthDivergence() {
        // Whole-string fold one code point SHORTER than the per-code-point
        // fold: not attributable to any single original code point.
        val shorter = CaseFold.alignOwnerMap(
            listOf("ab"),
            listOf(0),
            listOf(2),
            "abc", // per-cp has 2 units, whole has 3 → width mismatch
        )
        assertNull(shorter)
        // And one code point LONGER:
        val longer = CaseFold.alignOwnerMap(
            listOf("abc"),
            listOf(0),
            listOf(3),
            "ab",
        )
        assertNull(longer)
    }

    @Test
    fun alignmentGateRejectsCountDivergence() {
        // Same total width, different per-code-point widths: piece 2 folds
        // to a surrogate pair (2 units) but the whole-string fold offers a
        // 1-unit code point there — unattributable.
        val countDiverged = CaseFold.alignOwnerMap(
            listOf("a", "𝕏"), // widths [1, 2]
            listOf(0, 1),
            listOf(1, 3),
            "ab", // two 1-unit code points
        )
        assertNull(countDiverged)
    }

    @Test
    fun unalignableFoldYieldsNoMatchesConservatively() {
        // The gate itself is covered above; here the CONTRACT: whatever the
        // gate rejects reports NO ranges rather than wrong ones. A null
        // fold from foldCaseWithMap surfaces as an empty match list.
        val f = CaseFold.foldCaseWithMap("plain text without hits")
        assertNotNull(f)
        assertTrue(CaseFold.matchRanges("plain text without hits", "zzz").isEmpty())
    }

    @Test
    fun loneSurrogateQueriesMatchNothing() {
        // Shared TS/Kotlin contract: a query carrying an unpaired surrogate
        // half can never address a whole code point.
        assertTrue(CaseFold.hasUnpairedSurrogate("\uD83D"))
        assertTrue(CaseFold.hasUnpairedSurrogate("\uDE00"))
        assertFalse(CaseFold.hasUnpairedSurrogate("😀"))
        assertFalse(CaseFold.hasUnpairedSurrogate("a😀b"))
        assertTrue(CaseFold.matchRanges("😀", "\uD83D").isEmpty())
        assertTrue(CaseFold.matchRanges("😀", "\uDE00").isEmpty())
        assertEquals(listOf(1..2), CaseFold.matchRanges("a😀b", "😀"))
    }

    @Test
    fun matchRangesInFoldedReusesTheCachedFold() {
        // Mirrors the host.ts contract: matching against a cached Folded
        // gives exactly the wrapper's results.
        val text = "Foo İ bar ΟΣ baz"
        val f = CaseFold.foldCaseWithMap(text)
        assertNotNull(f)
        val viaCache = CaseFold.matchRangesInFolded(f!!, text, "ΟΣ".lowercase())
        val viaWrapper = CaseFold.matchRanges(text, "ΟΣ")
        assertEquals(viaWrapper, viaCache)
        assertEquals(listOf(10..11), viaCache)
    }
}
