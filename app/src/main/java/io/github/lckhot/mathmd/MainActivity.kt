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
 *  only the text MIME types: adding application/octet-stream there would
 *  offer MathMD as a handler for EVERY unknown-type file system-wide. The
 *  asymmetry is intended — in-app users can still pick such files here, and
 *  they load as text or fail with a toast. */
private val OPEN_MIMES = arrayOf(
    "text/markdown", "text/x-markdown", "text/plain", "application/octet-stream",
)

internal fun isDarkTheme(mode: String, systemDark: Boolean): Boolean = when (mode) {
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
    // TSV-table compatibility: live here so the dialog edits them like the
    // other settings, and travel to the preview as per-render options (a
    // change re-pushes the document — no page reload needed).
    var tsvTables by remember { mutableStateOf(settings.tsvTables) }
    var tsvMinRows by remember { mutableStateOf(settings.tsvMinRows) }
    var tsvMinCols by remember { mutableStateOf(settings.tsvMinCols) }
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
    // H1: both picker-flow flags must survive configuration changes and
    // process restoration — DocumentsUI is a separate activity, and this
    // process can be recycled (or recreated by a dark-mode/font/density
    // change) while the picker is up. A lost flag used to turn the
    // ActivityResult callback into an unconditional loadFromUri that
    // clobbered the restored dirty buffer.
    // (restoredViewHandled below deliberately stays a PLAIN remember: it
    // must be false again after every restoration to intercept the stale
    // launch-intent redelivery.)
    var openInNewWindow by rememberSaveable { mutableStateOf(false) }
    var pendingActionAfterSave by rememberSaveable { mutableStateOf<GuardAction?>(null) }
    // Durable record of an in-flight Create flow: set at accept (naming
    // the gate ticket's generation), cleared by its OWN live callback, a
    // document switch (New/Load), or a newer Create. A recreated
    // composition only surfaces the UNKNOWN outcome once — never rebinds.
    var pendingCreate by rememberSaveable { mutableStateOf<String?>(null) }

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
    // H2: request gate for every async document callback. Plain remember on
    // purpose — it manages only requests of THIS live instance; after
    // process death there is nothing to resurrect, and the restored buffer
    // must not be clobbered by a resurrected "ticket".
    val gate = remember { DocumentRequestGate() }
    DisposableEffect(documentIo) {
        onDispose {
            // Fixed order (H2): invalidate every in-flight callback first,
            // THEN shut the executor down — a resolveName callback landing
            // in between must not submit new work to a dead executor.
            gate.invalidateAll()
            documentIo.shutdown()
        }
    }

    // H1: picker flag plumbing goes through the pure PickerFlow reducer so
    // the terminal-state contract is the unit-tested one.
    fun pickerFlags() = PickerFlags(openInNewWindow, pendingActionAfterSave)
    fun applyPickerFlags(f: PickerFlags) {
        openInNewWindow = f.openInNewWindow
        pendingActionAfterSave = f.pendingAfterSave
    }

    fun loadFromUri(uri: Uri) {
        // Single load entry point (H2): in-app Open and external ACTION_VIEW
        // share it, so both are generation-tracked. A document switch ends
        // any in-flight Create's ownership of this window.
        pendingCreate = null
        val ticket = gate.beginLoad(uri.toString(), text)
        documentIo.loadFromUri(uri) { name, content ->
            when (gate.classifyLoad(ticket, uri.toString(), text)) {
                DocumentRequestGate.LoadDecision.Apply -> {
                    doc.uri = uri
                    doc.name = name
                    doc.savedText = content
                    text = content
                    // A document replacement invalidates the previous pane's matches.
                    if (searchOpen) requestSearch()
                    // NOTE: mode is NOT touched here — it is governed solely by the
                    // startup-mode preference (set at composition and for external
                    // opens). Forcing Edit here overrides the pref.
                }
                DocumentRequestGate.LoadDecision.KeepEdits ->
                    // Typed during the read: the edits win, the load is dropped.
                    toast("Document changed while loading; kept your edits")
                DocumentRequestGate.LoadDecision.Discard -> Unit
            }
        }
    }

    val openLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri ->
        // A follow-up flag set before a launcher must be cleared on EVERY
        // terminal path of that launcher — cancel included — or it fires on
        // a later, unrelated action (review R1).
        if (uri == null) {
            applyPickerFlags(PickerFlow.openCancelled(pickerFlags()))
            return@rememberLauncherForActivityResult
        }
        // H1: capture the dispatch decision into a local BEFORE consuming
        // the flag, then apply the terminal transition.
        val inNewWindow = openInNewWindow
        applyPickerFlags(PickerFlow.openConsumed(pickerFlags()))
        if (inNewWindow) {
            // "Keep this instance, open in a new window": re-enter the app
            // via ACTION_VIEW — documentLaunchMode gives the file its own
            // instance (or focuses the one already showing it).
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
                // The user chose KEEP: never fall back to replacing this dirty
                // buffer in the current window.
                toast("Could not open a new window: ${e.message}")
            }
        } else {
            loadFromUri(uri)
        }
    }

    /** Reset this window to a fresh blank document (New). */
    fun newDocument() {
        // H2: bump BEFORE clearing, so in-flight callbacks for the previous
        // document cannot write into the fresh one. New also ends any
        // in-flight Create's ownership of this window.
        gate.beginNewDocument()
        pendingCreate = null
        doc.uri = null
        doc.name = "untitled.md"
        doc.savedText = ""
        text = ""
        if (searchOpen) requestSearch()
        // mode is NOT touched here either — same rule as loadFromUri.
    }

    /**
     * Launch helpers (H1): a launcher that fails to START must consume its
     * flag too, or the next unrelated picker action inherits a stale one.
     */
    fun launchOpenPicker() {
        try {
            openLauncher.launch(OPEN_MIMES)
        } catch (e: Exception) {
            applyPickerFlags(PickerFlow.openLaunchFailed(pickerFlags()))
            toast("Could not open the file picker: ${e.message}")
        }
    }

    /** The follow-up a guard decision unlocks for action [action]. */
    fun afterGuardAction(action: GuardAction) {
        when (action) {
            GuardAction.Open -> launchOpenPicker()
            GuardAction.New -> newDocument()
        }
    }

    // CreateDocument serves both first-time Save on an untitled buffer and
    // Save as…: in both cases the picked location becomes the document this
    // app saves to from now on.
    val createLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("text/markdown"),
    ) { uri ->
        // Cancel consumes ONLY this picker's pending flag; a durable record
        // of an earlier still-in-flight create stays untouched (it may
        // still be cleared by its own callback or a document switch).
        if (uri == null) {
            applyPickerFlags(PickerFlow.createCancelled(pickerFlags()))
            return@rememberLauncherForActivityResult
        }
        // M4: request the persistable grant IMMEDIATELY. The WRITE is one
        // lifecycle-decoupled executor task (name resolution + write
        // together) — the confirmed snapshot must reach the confirmed URI
        // even if this Activity is destroyed mid-flight.
        documentIo.persistGrant(uri)
        val snapshot = text
        val followUp = pendingActionAfterSave
        applyPickerFlags(PickerFlow.createAccepted(pickerFlags()))
        val ticket = gate.beginCreate(uri.toString(), snapshot)
        // Durable record (v2, names THIS operation): a recreated
        // composition learns "a create was in flight, outcome unknown";
        // it replaces any record of an older unfinished create.
        pendingCreate = CreateFlow.encode(ticket.generation, uri.toString(), followUp)
        documentIo.createAndWrite(uri, snapshot) { name, saved ->
            // Dead closures (recreated Activity) no-op: gate.disposed.
            if (gate.disposed) return@createAndWrite
            // Only this operation's own record may be cleared — a late
            // callback for create A must never clear create B's record.
            if (CreateFlow.owns(pendingCreate, ticket.generation)) {
                pendingCreate = null
            }
            if (!saved) return@createAndWrite // failure toast already shown; no rebind
            if (gate.isCurrent(ticket)) {
                doc.uri = uri
                doc.name = name
                doc.savedText = snapshot
                if (followUp != null) {
                    // A2: only an unedited buffer lets the original action
                    // run; otherwise re-open the dirty guard for it.
                    when (gate.classifyFollowUp(ticket, text)) {
                        DocumentRequestGate.FollowUpDecision.Execute ->
                            afterGuardAction(followUp)
                        DocumentRequestGate.FollowUpDecision.ReGuard ->
                            guardAction = followUp
                    }
                }
            } else {
                // A1 (late create = background copy): the confirmed URI got
                // the confirmed snapshot; this document stays as it is.
                toast("Saved a copy to the chosen file; this document stayed open")
            }
        }
    }

    fun launchCreatePicker(name: String) {
        try {
            createLauncher.launch(name)
        } catch (e: Exception) {
            applyPickerFlags(PickerFlow.createLaunchFailed(pickerFlags()))
            toast("Could not open the save-as picker: ${e.message}")
        }
    }

    fun save() {
        val uri = doc.uri
        val snapshot = text // pin NOW: keystrokes during the async write stay dirty
        if (uri == null) {
            launchCreatePicker(doc.name)
        } else {
            // H2: plain saves do not bump the generation — editing during
            // the write is legal. The ticket binds the callback to THIS
            // document; the write itself always targets the captured URI.
            val ticket = gate.saveTicket(uri.toString(), snapshot)
            documentIo.writeTo(uri, snapshot) {
                if (gate.shouldApplySaveOnOk(ticket, doc.uri?.toString())) {
                    doc.savedText = snapshot
                    toast("Saved")
                }
            }
        }
    }

    /** Save, then continue with the guarded action (Open/New-guard path). */
    fun saveThen(action: GuardAction) {
        val uri = doc.uri
        val snapshot = text
        if (uri == null) {
            // Untitled + dirty: Save As first; the action follows once it lands.
            applyPickerFlags(PickerFlow.saveThenUntitled(pickerFlags(), action))
            launchCreatePicker(doc.name)
        } else {
            // Issue 10: saveThen carries an operation identity — when two
            // Save-and-continue flows overlap, only the LATEST may run its
            // follow-up, so the two converge to ONE end state instead of
            // firing both actions in completion order. Older operations
            // still apply their savedText above (their write targeted the
            // captured URI and is already on disk).
            val op = gate.beginSaveThen(uri.toString(), snapshot)
            documentIo.writeTo(uri, snapshot) {
                if (gate.shouldApplySaveOnOk(op.ticket, doc.uri?.toString())) {
                    doc.savedText = snapshot
                    toast("Saved")
                    if (gate.isLatestSaveThen(op)) {
                        when (gate.classifyFollowUp(op.ticket, text)) {
                            // A2: only an unedited buffer lets the original
                            // Open/New action run; otherwise re-open the
                            // dirty guard for it (latest guard wins).
                            DocumentRequestGate.FollowUpDecision.Execute -> afterGuardAction(action)
                            DocumentRequestGate.FollowUpDecision.ReGuard -> guardAction = action
                        }
                    }
                }
                // Stale (New/another open won): write went to the captured
                // URI; the new document's state stays untouched.
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
            // As with Open, KEEP must never turn into a destructive fallback.
            toast("Could not open a new window: ${e.message}")
        }
    }

    // Documents opened from outside the app: honor the startup-mode
    // preference. With documentLaunchMode=intoExisting each file gets its
    // own instance; re-shooting the same file lands here via onNewIntent
    // with a bumped viewRequest. A clean buffer reloads (picking up external
    // edits), but a dirty one is kept rather than silently overwritten.
    //
    // PROCESS RESTORE (blind-audit CRITICAL; widened after review found the
    // different-Uri case): after the process is killed and recreated — or
    // any recreation with saved state — the system redelivers the ORIGINAL
    // launch intent, which is stale once the user switched documents in
    // this instance (Open to another file, or New): rememberSaveable has
    // already restored the buffer AND DocumentState, edits included, and
    // the redelivered Uri may belong to a document this window is no longer
    // showing. So the FIRST run after a restore never loads when any
    // session was restored; loading would silently clobber it. A genuinely
    // new ACTION_VIEW arrives later via onNewIntent (bumped viewRequest),
    // by which time restoredViewHandled is true — only a restore-time run
    // can be the stale launch intent.
    var restoredViewHandled by remember { mutableStateOf(false) }

    // ONE-TIME notice for an in-flight Create flow destroyed by a
    // configuration change or process death. The new composition has NO
    // operation owner: the executor write may or may not have run, and the
    // outcome cannot be observed from here — the result is UNKNOWN, and we
    // do not claim exactly-once anything. Recovery therefore only clears
    // the record and tells the user ONCE. The buffer text is kept as
    // restored (no rebind, no savedText change, no duplicate write, no
    // automatic Open/New, and no re-armed old dirty guard); the live
    // follow-up flow keeps working in the composition that owns it.
    LaunchedEffect(Unit) {
        val record = pendingCreate ?: return@LaunchedEffect
        pendingCreate = null
        // Malformed (or foreign-version) records carry no actionable
        // information beyond their own removal.
        if (CreateFlow.decode(record) == null) return@LaunchedEffect
        toast("A save to the chosen file may or may not have completed; check it before saving again")
    }
    LaunchedEffect(externalUri, viewRequest) {        if (externalUri != null) {
            val sameDocument = externalUri == doc.uri
            // Anything restored worth keeping? An empty untitled buffer has
            // nothing to lose — loading the redelivered Uri then simply
            // recreates the original open.
            val restoredSession = doc.uri != null || text.isNotEmpty()
            val wouldClobberRestore =
                processRestored && !restoredViewHandled && restoredSession
            val wouldClobberDirty = sameDocument && dirty
            if (!wouldClobberRestore && !wouldClobberDirty) {
                mode = if (settings.startupMode == "preview") Mode.Preview else Mode.Edit
                loadFromUri(externalUri)
            } else if (wouldClobberDirty && !wouldClobberRestore) {
                toast("Keeping unsaved changes; reload skipped")
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
                                    else launchOpenPicker()
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
                                    launchCreatePicker(doc.name)
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
                        tsvEnabled = tsvTables,
                        tsvMinRows = tsvMinRows,
                        tsvMinCols = tsvMinCols,
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
                        applyPickerFlags(PickerFlow.keepAndNewWindowChosen(pickerFlags()))
                        launchOpenPicker()
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
                tsvTables = tsvTables,
                tsvMinRows = tsvMinRows,
                tsvMinCols = tsvMinCols,
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
                onTsvTables = { tsvTables = it; settings.tsvTables = it },
                onTsvMinRows = { tsvMinRows = it; settings.tsvMinRows = it },
                onTsvMinCols = { tsvMinCols = it; settings.tsvMinCols = it },
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
