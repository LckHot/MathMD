package io.github.lckhot.mathmd

import android.content.Intent

/**
 * Best-effort persistable-grant acquisition (M4).
 *
 * Both the load path and the CreateDocument/Save-As path must request the
 * SAME READ|WRITE grant. Grant failure is logged and swallowed: a provider
 * that refuses persistence must not crash the process or block a save that
 * the temporary grant still allows. Pure JVM types so the policy is
 * unit-testable; DocumentIo supplies the platform call.
 */
internal class DocumentGrants(
    private val take: (uri: String, flags: Int) -> Unit,
    private val onFail: (uri: String, error: Exception) -> Unit = { _, _ -> },
) {

    fun takeNow(uri: String) {
        try {
            take(uri, PERSIST_GRANT_FLAGS)
        } catch (e: Exception) {
            onFail(uri, e)
        }
    }

    companion object {
        /**
         * READ|WRITE persistable flags. Persisted across restarts so a
         * document created via Save As stays writable after reboot (M4's
         * acceptance: Save As → restart → Save must still work).
         */
        const val PERSIST_GRANT_FLAGS: Int =
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
    }
}
