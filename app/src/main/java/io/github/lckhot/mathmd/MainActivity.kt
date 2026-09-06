@file:OptIn(ExperimentalMaterial3Api::class)

package io.github.lckhot.mathmd

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalMinimumInteractiveComponentEnforcement
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.io.IOException

class MainActivity : ComponentActivity() {
    /** Documents arriving via ACTION_VIEW (file manager, chat apps). */
    private val viewUri = mutableStateOf<Uri?>(null)

    /**
     * Bumped on every ACTION_VIEW so re-opening the SAME file (which lands
     * here via documentLaunchMode=intoExisting -> onNewIntent) re-triggers
     * the load effect; the Uri itself does not change.
     */
    private val viewRequest = mutableStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        viewUri.value = extractViewUri(intent)
        if (viewUri.value != null) viewRequest.value++
        setContent { MathMdApp(externalUri = viewUri.value, viewRequest = viewRequest.value) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        viewUri.value = extractViewUri(intent)
        viewRequest.value++
    }

    private fun extractViewUri(intent: Intent?): Uri? =
        if (intent?.action == Intent.ACTION_VIEW) intent.data else null
}

/** Editing modes: source editor and rendered preview. */
private enum class Mode { Edit, Preview }

/** MIME types offered by the Open document picker. */
private val OPEN_MIMES = arrayOf(
    "text/markdown", "text/x-markdown", "text/plain", "application/octet-stream",
)

/** Current backing document. */
private class DocState {
    var uri: Uri? = null
    var name: String = "untitled.md"
    var savedText: String = ""
}

private fun isDarkTheme(mode: String, systemDark: Boolean): Boolean = when (mode) {
    "light" -> false
    "dark" -> true
    else -> systemDark
}

@Composable
private fun MathMdApp(externalUri: Uri?, viewRequest: Int) {
    val context = LocalContext.current
    val settings = remember { Settings(context) }

    var themeMode by remember { mutableStateOf(settings.theme) }
    var editorFontSize by remember { mutableStateOf(settings.editorFontSize) }
    var editorFont by remember { mutableStateOf(settings.editorFont) }
    var previewFont by remember { mutableStateOf(settings.previewFont) }
    var pageWidthCh by remember { mutableStateOf(settings.pageWidthCh) }
    var startupMode by remember { mutableStateOf(settings.startupMode) }
    // The line-wrap standard is baked into the layout viewport at page load
    // (preview.html boot script), so changing it — or the font it is measured
    // in — reloads the page. The WebView itself stays alive (no black flash).
    var previewReloadKey by remember { mutableStateOf(0) }

    // Mode has no ordering: back always exits the app, never switches mode.
    var mode by remember {
        mutableStateOf(if (settings.startupMode == "preview") Mode.Preview else Mode.Edit)
    }
    var text by rememberSaveable { mutableStateOf("") }
    var showSettings by rememberSaveable { mutableStateOf(false) }
    var menuOpen by rememberSaveable { mutableStateOf(false) }

    val doc = remember { DocState() }
    val dirty = text != doc.savedText

    // Open-button guard flow: dirty buffer -> dialog FIRST, then the picker.
    var showOpenGuard by rememberSaveable { mutableStateOf(false) }
    var openInNewWindow by remember { mutableStateOf(false) }
    var pendingOpenAfterSave by remember { mutableStateOf(false) }

    val resolver = context.contentResolver
    // Single-threaded IO: quick successive opens complete in order
    // (last-writer-wins is the wanted semantics; raw threads raced).
    val io = remember { java.util.concurrent.Executors.newSingleThreadExecutor() }
    androidx.compose.runtime.DisposableEffect(io) { onDispose { io.shutdown() } }
    val mainHandler = remember { android.os.Handler(android.os.Looper.getMainLooper()) }
    fun onUi(block: () -> Unit) {
        mainHandler.post(block)
    }

    fun toast(message: String) {
        Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
    }

    fun displayName(uri: Uri): String =
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (idx >= 0 && c.moveToFirst()) c.getString(idx) else null
        } ?: "untitled.md"

    fun loadFromUri(uri: Uri) {
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
                onUi {
                    doc.uri = uri
                    doc.name = name
                    doc.savedText = content
                    text = content
                    // NOTE: mode is NOT touched here — it is governed solely by
                    // the startup-mode preference (set at composition and for
                    // external opens). Forcing Edit here overrides the pref.
                }
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

    val openLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri != null) {
            if (openInNewWindow) {
                // "Keep this instance, open in a new window": re-enter the app
                // via ACTION_VIEW — documentLaunchMode gives the file its own
                // instance (or focuses the one already showing it).
                openInNewWindow = false
                val view = Intent(Intent.ACTION_VIEW, uri).apply {
                    setPackage(context.packageName)
                    addFlags(
                        Intent.FLAG_GRANT_READ_URI_PERMISSION or
                            Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
                    )
                }
                try {
                    context.startActivity(view)
                } catch (e: Exception) {
                    toast("Could not open a new window: ${e.message}")
                    loadFromUri(uri) // fallback: open in this instance
                }
            } else {
                loadFromUri(uri)
            }
        }
    }

    // CreateDocument serves both first-time Save on an untitled buffer and
    // Save as…: in both cases the picked location becomes the document this
    // app saves to from now on.
    val createLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("text/markdown"),
    ) { uri ->
        if (uri != null) {
            val snapshot = text
            io.execute {
                val name = displayName(uri)
                onUi {
                    doc.uri = uri
                    doc.name = name
                    val reopenPicker = pendingOpenAfterSave
                    pendingOpenAfterSave = false
                    writeTo(uri, snapshot) {
                        doc.savedText = snapshot
                        if (reopenPicker) openLauncher.launch(OPEN_MIMES)
                    }
                }
            }
        }
    }

    fun save() {
        val uri = doc.uri
        val snapshot = text // pin NOW: keystrokes during the async write stay dirty
        if (uri == null) {
            createLauncher.launch(doc.name)
        } else {
            writeTo(uri, snapshot) {
                doc.savedText = snapshot
                toast("Saved")
            }
        }
    }

    /** Save, then continue into the file picker (Open-guard path). */
    fun saveThenOpen() {
        val uri = doc.uri
        val snapshot = text
        if (uri == null) {
            // Untitled + dirty: Save As first; picker follows once it lands.
            pendingOpenAfterSave = true
            createLauncher.launch(doc.name)
        } else {
            writeTo(uri, snapshot) {
                doc.savedText = snapshot
                toast("Saved")
                openLauncher.launch(OPEN_MIMES)
            }
        }
    }

    // Documents opened from outside the app: honor the startup-mode
    // preference. With documentLaunchMode=intoExisting each file gets its
    // own instance; re-shooting the same file lands here via onNewIntent
    // with a bumped viewRequest, so the reload still happens.
    LaunchedEffect(externalUri, viewRequest) {
        if (externalUri != null) {
            mode = if (settings.startupMode == "preview") Mode.Preview else Mode.Edit
            loadFromUri(externalUri)
        }
    }

    val systemDark = isSystemInDarkTheme()
    val appDark = isDarkTheme(themeMode, systemDark)

    MaterialTheme(colorScheme = if (appDark) darkColorScheme() else lightColorScheme()) {
        Scaffold(
            topBar = {
                TopAppBar(
                    expandedHeight = 48.dp,
                    title = {
                        Text(
                            if (dirty) "${doc.name} •" else doc.name,
                            fontSize = 14.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                    actions = {
                        ModeToggle(mode) { mode = it }
                        IconButton(onClick = { menuOpen = true }) {
                            Icon(Icons.Filled.Menu, contentDescription = "Menu")
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text("Open") },
                                onClick = {
                                    menuOpen = false
                                    // Dirty buffer: ask FIRST (save / discard /
                                    // new window), then show the picker.
                                    if (dirty) showOpenGuard = true
                                    else openLauncher.launch(OPEN_MIMES)
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("Save") },
                                onClick = {
                                    menuOpen = false
                                    save()
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("Save as…") },
                                onClick = {
                                    menuOpen = false
                                    createLauncher.launch(doc.name)
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("Settings") },
                                onClick = {
                                    menuOpen = false
                                    showSettings = true
                                },
                            )
                        }
                    },
                )
            },
        ) { padding ->
            Column(modifier = Modifier.padding(padding).fillMaxSize()) {
                // WebView stays alive across mode switches (no recreate + page
                // reload flash); Edit mode covers it with an opaque surface.
                Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                    PreviewPane(
                        text, appDark, previewFont,
                        reloadKey = previewReloadKey,
                        appSettings = settings,
                        visible = mode == Mode.Preview,
                        modifier = Modifier.fillMaxSize(),
                    )
                    if (mode == Mode.Edit) {
                        Surface(
                            color = MaterialTheme.colorScheme.background,
                            modifier = Modifier.fillMaxSize(),
                        ) {
                            EditorPane(
                                text, editorFontSize, editorFont,
                                Modifier.fillMaxSize(),
                            ) { text = it }
                        }
                    }
                }
            }
        }

        if (showOpenGuard) {
            AlertDialog(
                onDismissRequest = { showOpenGuard = false },
                title = { Text("Unsaved changes") },
                confirmButton = {},
                dismissButton = {},
                text = {
                    Column {
                        Text("Unsaved changes in ${doc.name}.")
                        TextButton(
                            modifier = Modifier.fillMaxWidth(),
                            onClick = {
                                showOpenGuard = false
                                saveThenOpen()
                            },
                        ) { Text("Save and open…", modifier = Modifier.fillMaxWidth()) }
                        TextButton(
                            modifier = Modifier.fillMaxWidth(),
                            onClick = {
                                showOpenGuard = false
                                openLauncher.launch(OPEN_MIMES) // discard: this buffer is replaced
                            },
                        ) { Text("Discard changes and open…", modifier = Modifier.fillMaxWidth()) }
                        TextButton(
                            modifier = Modifier.fillMaxWidth(),
                            onClick = {
                                showOpenGuard = false
                                openInNewWindow = true
                                openLauncher.launch(OPEN_MIMES)
                            },
                        ) { Text("Keep this, open in new window…", modifier = Modifier.fillMaxWidth()) }
                        TextButton(
                            modifier = Modifier.fillMaxWidth(),
                            onClick = { showOpenGuard = false },
                        ) { Text("Cancel", modifier = Modifier.fillMaxWidth()) }
                    }
                },
            )
        }

        if (showSettings) {
            SettingsDialog(
                themeMode = themeMode,
                editorFontSize = editorFontSize,
                editorFont = editorFont,
                previewFont = previewFont,
                pageWidthCh = pageWidthCh,
                onTheme = { themeMode = it; settings.theme = it },
                onEditorSize = { editorFontSize = it; settings.editorFontSize = it },
                onEditorFont = { editorFont = it; settings.editorFont = it },
                onPreviewFont = {
                    previewFont = it; settings.previewFont = it
                    previewReloadKey++ // ch->px measurement depends on the font
                },
                onPageWidth = {
                    pageWidthCh = it; settings.pageWidthCh = it
                    previewReloadKey++ // viewport is locked at load time
                },
                startupMode = startupMode,
                onStartupMode = { startupMode = it; settings.startupMode = it },
                onDismiss = { showSettings = false },
            )
        }
    }
}

/**
 * Compact mode toggle: a single standard IconButton showing the CURRENT mode
 * (eye = currently editing, tap to preview; pencil = currently previewing, tap
 * to edit). The whole control is the tap target.
 */
@Composable
private fun ModeToggle(mode: Mode, onMode: (Mode) -> Unit) {
    CompositionLocalProvider(LocalMinimumInteractiveComponentEnforcement provides false) {
        IconButton(onClick = { onMode(if (mode == Mode.Edit) Mode.Preview else Mode.Edit) }) {
            when (mode) {
                Mode.Edit -> Icon(
                    PreviewEyeIcon,
                    contentDescription = "Switch to preview",
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Mode.Preview -> Icon(
                    Icons.Filled.Edit,
                    contentDescription = "Switch to edit",
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
