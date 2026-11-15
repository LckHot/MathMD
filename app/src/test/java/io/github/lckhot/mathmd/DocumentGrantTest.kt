package io.github.lckhot.mathmd

import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M4: the persistable-grant policy — READ|WRITE flags, best-effort
 * failure handling, and the shared-implementation requirement for load
 * and create. (DocumentIo itself touches ContentResolver and cannot be
 * constructed in a plain JVM test; the policy object it delegates to is
 * exercised here.)
 */
class DocumentGrantTest {

    @Test
    fun flagsAreReadAndWritePersistable() {
        assertEquals(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            DocumentGrants.PERSIST_GRANT_FLAGS,
        )
    }

    @Test
    fun takeNowPassesUriAndFlagsToThePlatform() {
        var seen: Pair<String, Int>? = null
        val grants = DocumentGrants(take = { uri, flags -> seen = uri to flags })
        grants.takeNow("content://x/y")
        assertEquals("content://x/y" to DocumentGrants.PERSIST_GRANT_FLAGS, seen)
    }

    @Test
    fun securityExceptionIsSwallowedAndReported() {
        var reported: Pair<String, Exception>? = null
        val grants = DocumentGrants(
            take = { _, _ -> throw SecurityException("provider refuses persistence") },
            onFail = { uri, e -> reported = uri to e },
        )
        // Must not throw — grant failure never blocks the save flow.
        grants.takeNow("content://x/y")
        assertEquals("content://x/y", reported?.first)
        assertTrue(reported?.second is SecurityException)
    }

    @Test
    fun anyProviderExceptionIsSwallowed() {
        val grants = DocumentGrants(
            take = { _, _ -> throw IllegalStateException("dead provider") },
            onFail = { _, _ -> },
        )
        grants.takeNow("content://x/y") // no throw
    }
}
