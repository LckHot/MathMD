@file:OptIn(ExperimentalMaterial3Api::class)

package io.github.lckhot.mathmd

import android.content.Intent
import android.net.Uri
import android.os.Bundle
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
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
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
        setContent {
            MathMdApp(
                externalUri = viewUri.value,
                viewRequest = viewRequest.value,
                processRestored = savedInstanceState != null,
            )
        }
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

/** MIME types offered by the Open document picker.
 *
 *  Deliberately wider than the manifest's VIEW intent-filter, which takes
 *  only the text/* types: adding application/octet-stream there would offer
 *  MathMD as a handler for EVERY unknown-type file system-wide. The
 *  asymmetry is intended — in-app users can still pick such files here, and
 *  they load as text or fail with a toast. */
private val OPEN_MIMES = arrayOf(
    "text/markdown", "text/x-markdown", "text/plain", "application/octet-stream",
)

private fun isDarkTheme(mode: String, systemDark: Boolean): Boolean = when (mode) {
    "light" -> false
    "dark" -> true
    else -> systemDark
}

@Composable
private fun MathMdApp(externalUri: Uri?, viewRequest: Int, processRestored: Boolean) {
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

    val doc = rememberSaveable(saver = DocumentState.Saver) {
        DocumentState(null, "untitled.md", "")
    }
    val dirty = text != doc.savedText

    // Open/New-button guard flow: dirty buffer -> dialog FIRST, then the
    // follow-up action (picker for Open, blank document for New). Open and
    // New handle an unsaved document identically (owner spec); only the
    // "continue" action differs.
    var guardAction by rememberSaveable { mutableStateOf<GuardAction?>(null) }
    var openInNewWindow by remember { mutableStateOf(false) }
    var pendingActionAfterSave by remember { mutableStateOf<GuardAction?>(null) }

    // Search: cursor lives HERE, shared by both panes (owner spec: search
    // works in Edit and Preview; flipping modes re-runs the same query).
    var searchOpen by rememberSaveable { mutableStateOf(false) }
    var searchQuery by rememberSaveable { mutableStateOf("") }
    var searchIndex by remember { mutableStateOf(0) }
    var searchTick by remember { mutableStateOf(0) }
    var searchResult by remember { mutableStateOf<Pair<Int, Int>?>(null) }
    fun requestSearch() { searchTick++ }

    val resolver = context.contentResolver
    val mainHandler = remember { android.os.Handler(android.os.Looper.getMainLooper()) }

    fun toast(message: String) {
        Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
    }

    val documentIo = remember {
        DocumentIo(resolver, { block -> mainHandler.post(block) }, { msg -> toast(msg) })
    }
    DisposableEffect(documentIo) { onDispose { documentIo.shutdown() } }

    fun loadFromUri(uri: Uri) = documentIo.loadFromUri(uri) { name, content ->
        doc.uri = uri
        doc.name = name
        doc.savedText = content
        text = content
        // NOTE: mode is NOT touched here — it is governed solely by the
        // startup-mode preference (set at composition and for external
        // opens). Forcing Edit here overrides the pref.
    }

    val openLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri ->
        // A follow-up flag set before a launcher must be cleared on EVERY
        // terminal path of that launcher — cancel included — or it fires on
        // a later, unrelated action (review R1).
        if (uri == null) {
            openInNewWindow = false
            return@rememberLauncherForActivityResult
        }
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

    /** Reset this window to a fresh blank document (New). */
    fun newDocument() {
        doc.uri = null
        doc.name = "untitled.md"
        doc.savedText = ""
        text = ""
        // mode is NOT touched here either — same rule as loadFromUri.
    }

    /** The follow-up a guard decision unlocks for action [action]. */
    fun afterGuardAction(action: GuardAction) {
        when (action) {
            GuardAction.Open -> openLauncher.launch(OPEN_MIMES)
            GuardAction.New -> newDocument()
        }
    }

    // CreateDocument serves both first-time Save on an untitled buffer and
    // Save as…: in both cases the picked location becomes the document this
    // app saves to from now on.
    val createLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("text/markdown"),
    ) { uri ->
        // Same cancel-path invariant as openLauncher (review R1): a stale
        // pendingActionAfterSave would fire the guard's follow-up (e.g. the
        // Open picker) after an ordinary save.
        if (uri == null) {
            pendingActionAfterSave = null
            return@rememberLauncherForActivityResult
        }
        val snapshot = text
        documentIo.resolveName(uri) { name ->
            doc.uri = uri
            doc.name = name
            val followUp = pendingActionAfterSave
            pendingActionAfterSave = null
            documentIo.writeTo(uri, snapshot) {
                doc.savedText = snapshot
                if (followUp != null) afterGuardAction(followUp)
            }
        }
    }

    fun save() {
        val uri = doc.uri
        val snapshot = text // pin NOW: keystrokes during the async write stay dirty
        if (uri == null) {
            createLauncher.launch(doc.name)
        } else {
            documentIo.writeTo(uri, snapshot) {
                doc.savedText = snapshot
                toast("Saved")
            }
        }
    }

    /** Save, then continue with the guarded action (Open/New-guard path). */
    fun saveThen(action: GuardAction) {
        val uri = doc.uri
        val snapshot = text
        if (uri == null) {
            // Untitled + dirty: Save As first; the action follows once it lands.
            pendingActionAfterSave = action
            createLauncher.launch(doc.name)
        } else {
            documentIo.writeTo(uri, snapshot) {
                doc.savedText = snapshot
                toast("Saved")
                afterGuardAction(action)
            }
        }
    }

    /**
     * "Keep this, new window" for New: a blank document has no Uri to
     * ACTION_VIEW, so launch a fresh MainActivity instance instead.
     * documentLaunchMode=intoExisting turns it into its own document task;
     * MULTIPLE_TASK forces a NEW task even if an earlier blank one exists.
     */
    fun openBlankInNewWindow() {
        val blank = Intent(Intent.ACTION_MAIN).apply {
            setClass(context, MainActivity::class.java)
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK,
            )
        }
        try {
            context.startActivity(blank)
        } catch (e: Exception) {
            toast("Could not open a new window: ${e.message}")
            newDocument() // fallback: new document in this instance
        }
    }

    // Documents opened from outside the app: honor the startup-mode
    // preference. With documentLaunchMode=intoExisting each file gets its
    // own instance; re-shooting the same file lands here via onNewIntent
    // with a bumped viewRequest, so the reload still happens.
    //
    // PROCESS RESTORE (blind-audit CRITICAL): after the process is killed
    // and recreated, the original ACTION_VIEW intent is redelivered — but
    // rememberSaveable has already restored the buffer AND the DocumentState
    // (with unsaved edits). Re-loading the SAME uri from disk here would
    // silently clobber those edits, so skip it; a DIFFERENT uri is a
    // genuine new open and always loads.
    var restoredViewHandled by remember { mutableStateOf(false) }
    LaunchedEffect(externalUri, viewRequest) {
        if (externalUri != null) {
            val wouldClobberRestore =
                processRestored && !restoredViewHandled && externalUri == doc.uri
            if (!wouldClobberRestore) {
                mode = if (settings.startupMode == "preview") Mode.Preview else Mode.Edit
                loadFromUri(externalUri)
            }
            restoredViewHandled = true
        }
    }

    val systemDark = isSystemInDarkTheme()
    val appDark = isDarkTheme(themeMode, systemDark)

    // One search spec always live; query collapses to "" when the bar is
    // closed so either pane clears its highlights on the final run.
    val editorSearch = SearchSpec(
        query = if (searchOpen) searchQuery else "",
        index = searchIndex,
        tick = searchTick,
        onResult = { total, active ->
            searchResult = total to active
            searchIndex = active.coerceAtLeast(0)
        },
    )
    val previewSearch = SearchSpec(
        query = editorSearch.query,
        index = searchIndex,
        tick = searchTick,
        onResult = editorSearch.onResult,
    )

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
                        ModeToggle(mode) {
                            mode = it
                            // Preview re-pushes its document on flip (clearing
                            // highlights); bump the tick so find re-runs. The
                            // editor re-enters composition and re-runs itself.
                            if (searchOpen) requestSearch()
                        }
                        IconButton(onClick = { menuOpen = true }) {
                            Icon(Icons.Filled.Menu, contentDescription = "Menu")
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text("New") },
                                onClick = {
                                    menuOpen = false
                                    // Same guard as Open (owner spec): dirty
                                    // buffer asks first, then the blank doc.
                                    if (dirty) guardAction = GuardAction.New
                                    else newDocument()
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("Open") },
                                onClick = {
                                    menuOpen = false
                                    // Dirty buffer: ask FIRST (save / discard /
                                    // new window), then show the picker.
                                    if (dirty) guardAction = GuardAction.Open
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
                                text = { Text("Search") },
                                onClick = {
                                    menuOpen = false
                                    searchOpen = true
                                    requestSearch()
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
                if (searchOpen) {
                    SearchBar(
                        query = searchQuery,
                        result = searchResult,
                        onQuery = {
                            searchQuery = it
                            searchIndex = 0
                            requestSearch()
                        },
                        onStep = { dir ->
                            val total = searchResult?.first ?: 0
                            if (total > 0) {
                                searchIndex = (searchIndex + dir + total) % total
                            }
                            requestSearch()
                        },
                        onClose = {
                            searchOpen = false
                            searchResult = null
                            requestSearch() // panes clear highlights
                        },
                    )
                }
                // WebView stays alive across mode switches (no recreate + page
                // reload flash); Edit mode covers it with an opaque surface.
                Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                    PreviewPane(
                        text, appDark, previewFont,
                        reloadKey = previewReloadKey,
                        appSettings = settings,
                        visible = mode == Mode.Preview,
                        search = previewSearch,
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
                                search = editorSearch,
                            ) { text = it }
                        }
                    }
                }
            }
        }

        if (guardAction != null) {
            val action = guardAction!!
            UnsavedChangesDialog(
                docName = doc.name,
                action = action,
                onSaveAndContinue = {
                    guardAction = null
                    saveThen(action)
                },
                onDiscardAndContinue = {
                    guardAction = null
                    // discard: this buffer is replaced (by the picked file /
                    // the blank document)
                    afterGuardAction(action)
                },
                onKeepAndNewWindow = {
                    guardAction = null
                    if (action == GuardAction.Open) {
                        openInNewWindow = true
                        openLauncher.launch(OPEN_MIMES)
                    } else {
                        openBlankInNewWindow()
                    }
                },
                onDismiss = { guardAction = null },
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
