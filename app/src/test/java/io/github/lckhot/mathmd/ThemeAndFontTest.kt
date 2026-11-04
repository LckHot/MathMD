package io.github.lckhot.mathmd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThemeAndFontTest {
    @Test
    fun explicitThemeOverridesSystem() {
        assertFalse(isDarkTheme("light", systemDark = true))
        assertTrue(isDarkTheme("dark", systemDark = false))
    }

    @Test
    fun systemAndUnknownThemesFollowSystem() {
        assertTrue(isDarkTheme("system", systemDark = true))
        assertFalse(isDarkTheme("system", systemDark = false))
        assertTrue(isDarkTheme("unexpected", systemDark = true))
    }

    @Test
    fun defaultFontUsesBundleStack() {
        assertNull(cssFontFamily("default"))
    }

    @Test
    fun genericAndSafeCustomFamiliesAreSupported() {
        assertEquals("serif", cssFontFamily("serif"))
        assertEquals("'Noto Serif', sans-serif", cssFontFamily("Noto Serif"))
    }

    @Test
    fun unsafeFontNamesFallBackToBundleStack() {
        assertNull(cssFontFamily("bad';color:red;'"))
        assertNull(cssFontFamily("bad;family"))
        assertNull(cssFontFamily(""))
    }
}
