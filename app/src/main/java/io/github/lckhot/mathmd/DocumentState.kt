package io.github.lckhot.mathmd

import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.setValue

/**
 * Backing-document state (uri / display name / last-saved snapshot).
 *
 * Two hard requirements, both blind-audit findings:
 *  - SNAPSHOT state: a plain-var version of this class never triggered
 *    recomposition on write, so after a successful Save the dirty "•" and
 *    the Open guard kept reading stale values (false "Unsaved changes"
 *    dialog right after saving).
 *  - PROCESS-DEATH SAVEABLE: the editing buffer (`text` in MainActivity)
 *    is rememberSaveable and comes back WITH unsaved edits; losing this
 *    metadata half fell the title back to "untitled.md" and degraded the
 *    next Save into a Save As.
 *
 * Bundle budget: `text` + [savedText] put up to ~2x the document into the
 * saved-state Binder transaction (~1MB ceiling, TransactionTooLargeException
 * past it). Markdown notes here are kilobytes; the ceiling is documented,
 * not engineered for.
 */
internal class DocumentState(uri: Uri?, name: String, savedText: String) {
    var uri by mutableStateOf(uri)
    var name by mutableStateOf(name)
    var savedText by mutableStateOf(savedText)

    companion object {
        val Saver = listSaver<DocumentState, Any?>(
            save = { listOf(it.uri, it.name, it.savedText) },
            restore = { r ->
                DocumentState(r[0] as Uri?, r[1] as String, r[2] as String)
            },
        )
    }
}
