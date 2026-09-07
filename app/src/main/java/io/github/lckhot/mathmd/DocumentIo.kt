package io.github.lckhot.mathmd

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Document IO, off the UI thread. A single-threaded executor makes quick
 * successive opens complete in order (last-writer-wins is the wanted
 * semantics; raw threads raced). [onUi] posts results back to the main
 * thread; [toast] is the only user-facing error channel.
 */
internal class DocumentIo(
    private val resolver: ContentResolver,
    private val onUi: (() -> Unit) -> Unit,
    private val toast: (String) -> Unit,
) {
    private val io: ExecutorService = Executors.newSingleThreadExecutor()

    fun shutdown() = io.shutdown()

    fun displayName(uri: Uri): String =
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (idx >= 0 && c.moveToFirst()) c.getString(idx) else null
        } ?: "untitled.md"

    /** Async display-name lookup (provider query must not run on main). */
    fun resolveName(uri: Uri, onDone: (String) -> Unit) {
        io.execute {
            val name = displayName(uri)
            onUi { onDone(name) }
        }
    }

    /** Async load; [onLoaded] runs on the UI thread with (name, content). */
    fun loadFromUri(uri: Uri, onLoaded: (name: String, content: String) -> Unit) {
        io.execute {
            try {
                val content = resolver.openInputStream(uri)?.use {
                    it.readBytes().toString(Charsets.UTF_8)
                } ?: throw IOException("no data")
                val name = displayName(uri)
                try {
                    resolver.takePersistableUriPermission(
                        uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
                    )
                } catch (_: SecurityException) {
                    // ACTION_VIEW grants are often session-scoped; save falls back to Save As.
                }
                onUi { onLoaded(name, content) }
            } catch (e: Exception) {
                onUi { toast("Open failed: ${e.message}") }
            }
        }
    }

    /**
     * Async write. [content] is the snapshot to persist; [onOk] runs on the
     * UI thread after a successful write. NOTE: "wt" truncates before
     * writing — a mid-write provider failure leaves the file emptied
     * (accepted: SAF offers no atomic replace; retry restores content).
     */
    fun writeTo(uri: Uri, content: String, onOk: () -> Unit) {
        io.execute {
            try {
                resolver.openOutputStream(uri, "wt")?.use {
                    it.write(content.toByteArray(Charsets.UTF_8))
                } ?: throw IOException("no output stream")
                onUi { onOk() }
            } catch (e: SecurityException) {
                onUi { toast("No write permission for this file") }
            } catch (e: Exception) {
                onUi { toast("Save failed: ${e.message}") }
            }
        }
    }
}
