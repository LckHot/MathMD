package io.github.lckhot.mathmd

import android.content.ContentResolver
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

    // M4: both load and create go through the same best-effort grant policy.
    private val grants = DocumentGrants(
        take = { uri, flags ->
            resolver.takePersistableUriPermission(Uri.parse(uri), flags)
        },
        onFail = { uri, e ->
            android.util.Log.w("MathMD", "persistable grant failed for $uri", e)
        },
    )

    fun shutdown() = io.shutdown()

    /**
     * Best-effort display name. NEVER throws: a provider that returns a
     * null cursor, hides the column, or fails the query outright
     * (SecurityException, dead provider, ...) all degrade to the same
     * fallback — a URI often stays usable even when its metadata query
     * does not, and a fallback name beats aborting the operation.
     * Totality is load-bearing: callers run on the IO executor, where an
     * uncaught exception kills the whole process.
     */
    fun displayName(uri: Uri): String {
        val name = try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { c ->
                    val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (idx >= 0 && c.moveToFirst()) c.getString(idx) else null
                }
        } catch (e: Exception) {
            // Same degradation as a null cursor: a usable name beats a crash.
            android.util.Log.w("MathMD", "display-name query failed for $uri", e)
            null
        }
        return name ?: "untitled.md"
    }

    /** Async display-name lookup (provider query must not run on main). */
    fun resolveName(uri: Uri, onDone: (String) -> Unit) {
        io.execute {
            val name = displayName(uri)
            onUi { onDone(name) }
        }
    }

    /**
     * Queue a best-effort persistable grant for [uri] (M4). Call this the
     * moment a CreateDocument picker returns — do NOT wait for resolveName.
     */
    fun persistGrant(uri: Uri) {
        io.execute { grants.takeNow(uri.toString()) }
    }

    /** Async load; [onLoaded] runs on the UI thread with (name, content). */
    fun loadFromUri(uri: Uri, onLoaded: (name: String, content: String) -> Unit) {
        io.execute {
            try {
                val content = resolver.openInputStream(uri)?.use {
                    DocumentDecoder.decode(it.readBytes())
                } ?: throw IOException("no data")
                val name = displayName(uri)
                // Already inside the executor: take the grant directly, no
                // re-queue. Same READ|WRITE policy as the create path.
                grants.takeNow(uri.toString())
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

    /**
     * CreateDocument write, LIFECYCLE-DECOUPLED (Lead round 6, issue 9):
     * name resolution AND the write run as ONE executor task, so the
     * confirmed snapshot reaches the confirmed URI even when the Activity
     * is destroyed mid-flight (rotation used to kill the UI callback that
     * was the only place queueing the write — leaving a 0-byte orphan and
     * dropping the follow-up). [onDone] runs on the UI thread once, with
     * the resolved display name and whether the write succeeded; if the UI
     * is gone the post simply lands in a dead closure, which must no-op.
     */
    fun createAndWrite(uri: Uri, content: String, onDone: (name: String, saved: Boolean) -> Unit) {
        io.execute {
            val name = displayName(uri)
            val saved = try {
                resolver.openOutputStream(uri, "wt")?.use {
                    it.write(content.toByteArray(Charsets.UTF_8))
                } != null
            } catch (e: Exception) {
                onUi { toast("Save failed: ${e.message}") }
                false
            }
            onUi { onDone(name, saved) }
        }
    }
}
