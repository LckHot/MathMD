package io.github.lckhot.mathmd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EditorSearchTest {
    @Test
    fun emptyQueryHasNoMatches() {
        assertTrue(matchRanges("anything", "").isEmpty())
    }

    @Test
    fun matchingIsCaseInsensitive() {
        assertEquals(listOf(0..2, 8..10), matchRanges("Foo bar FOO", "foo"))
    }

    @Test
    fun matchesDoNotOverlap() {
        assertEquals(listOf(0..1, 2..3), matchRanges("aaaa", "aa"))
    }

    @Test
    fun missingQueryHasNoMatches() {
        assertTrue(matchRanges("abcdef", "xyz").isEmpty())
    }
}
