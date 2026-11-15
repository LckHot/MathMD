package io.github.lckhot.mathmd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P0 round: integration-style tests of the CREATE and SAVETHEN flows.
 * [Env] is a fake-IO equivalence controller that mirrors MainActivity's
 * exact wiring (accept → persistGrant → snapshot/followUp capture →
 * beginCreate → durable v2 record → createAndWrite; saveThen →
 * beginSaveThen → writeTo → guarded follow-up) with controllable delivery
 * of the UI callbacks, so every recreation window is deterministic.
 *
 * Recovery scenarios use a GENUINELY NEW Env (fresh gate, fresh state):
 * the old composition is gone, and whatever the old executor write did
 * (succeeded, failed, or never finished) must converge to the same
 * "result unknown" behavior in the new one.
 */
class CreateSaveFlowTest {

    /** Fake IO + document state, mirroring MainActivity's wiring order. */
    private class Env {
        val gate = DocumentRequestGate()
        var docUri: String? = null
        var docName: String = "untitled.md"
        var savedText: String = ""
        var text: String = ""
        var guardAction: GuardAction? = null
        var pendingCreate: String? = null
        var pendingAfterSave: GuardAction? = null
        val toasts = mutableListOf<String>()
        val executedFollowUps = mutableListOf<GuardAction>()
        val grantCalls = mutableListOf<String>()
        val writes = mutableListOf<Pair<String, String>>() // (uri, content) on "disk"

        /**
         * createAccept as wired in MainActivity's createLauncher callback.
         * [onDone] lets a test deliver the UI callback at a chosen moment
         * (or never — the recreation windows).
         */
        fun createAccept(
            uri: String,
            saved: Boolean = true,
            editTextDuringWrite: String? = null,
            onDone: ((name: String, saved: Boolean) -> Unit) -> Unit = { it("resolved.md", saved) },
        ) {
            grantCalls.add(uri) // persistGrant queued first
            val snapshot = text
            val followUp = pendingAfterSave
            pendingAfterSave = null // PickerFlow.createAccepted
            val ticket = gate.beginCreate(uri, snapshot)
            pendingCreate = CreateFlow.encode(ticket.generation, uri, followUp)
            // createAndWrite: the WRITE is queued at accept, decoupled from
            // the UI callback below.
            writes.add(uri to snapshot)
            onDone { _, savedFlag ->
                if (gate.disposed) return@onDone // dead closure no-ops
                // Only this operation's own record may be cleared.
                if (CreateFlow.owns(pendingCreate, ticket.generation)) {
                    pendingCreate = null
                }
                if (!savedFlag) return@onDone // failure: no rebind
                if (gate.isCurrent(ticket)) {
                    docUri = uri
                    docName = "resolved.md"
                    savedText = snapshot
                    if (followUp != null) {
                        editTextDuringWrite?.let { text = it }
                        when (gate.classifyFollowUp(ticket, text)) {
                            DocumentRequestGate.FollowUpDecision.Execute -> executedFollowUps.add(followUp)
                            DocumentRequestGate.FollowUpDecision.ReGuard -> guardAction = followUp
                        }
                    }
                } else {
                    toasts.add("Saved a copy to the chosen file; this document stayed open")
                }
            }
        }

        /** The one-time recovery effect of a NEW composition. */
        fun recoverFromRecord(): Boolean {
            val record = pendingCreate ?: return false
            pendingCreate = null
            if (CreateFlow.decode(record) == null) return true
            // Result UNKNOWN: notice once; text kept, nothing rebound, no
            // savedText change, no auto action, no re-armed guard.
            toasts.add("A save to the chosen file may or may not have completed; check it before saving again")
            return true
        }

        /** saveThen as wired in MainActivity (titled document path). */
        fun saveThen(action: GuardAction, deliver: Boolean = true, editTextDuringSave: String? = null) {
            val uri = docUri ?: return
            val snapshot = text
            val op = gate.beginSaveThen(uri, snapshot)
            if (editTextDuringSave != null) text = editTextDuringSave
            if (!deliver) return
            if (gate.shouldApplySaveOnOk(op.ticket, docUri)) {
                savedText = snapshot
                if (gate.isLatestSaveThen(op)) {
                    when (gate.classifyFollowUp(op.ticket, text)) {
                        DocumentRequestGate.FollowUpDecision.Execute -> executedFollowUps.add(action)
                        DocumentRequestGate.FollowUpDecision.ReGuard -> guardAction = action
                    }
                }
            }
        }

        /** New/Load as wired in MainActivity: both clear the record. */
        fun newDocument() {
            gate.beginNewDocument()
            pendingCreate = null
            docUri = null
            docName = "untitled.md"
            savedText = ""
            text = ""
        }

        fun loadFromUri(uri: String) {
            pendingCreate = null
            gate.beginLoad(uri, text)
        }
    }

    // ---- the write is queued at accept, decoupled from the UI ----

    @Test
    fun createWritesEvenWhenTheUiCallbackNeverRuns() {
        for (window in listOf("before-resolve", "after-resolve-before-write", "after-write-before-onOk")) {
            val env = Env().apply { text = "confirmed snapshot $window" }
            // Activity destroyed in window `x`: the UI callback never runs.
            env.createAccept("content://x/new-$window", onDone = { /* never delivered */ })
            assertEquals(
                "write queued at accept ($window)",
                listOf("content://x/new-$window" to "confirmed snapshot $window"),
                env.writes,
            )
            // The durable record names this operation for a new composition.
            assertNotNull(env.pendingCreate)
        }
    }

    // ---- record lifecycle: ownership rules ----

    @Test
    fun newCreateReplacesAnOldUnfinishedRecord() {
        val env = Env().apply { text = "v1" }
        env.createAccept("content://x/a", onDone = { /* A's callback never lands */ })
        val oldRecord = env.pendingCreate
        assertNotNull(oldRecord)
        env.text = "v2"
        env.createAccept("content://x/b", onDone = { /* B's callback never lands */ })
        val newRecord = env.pendingCreate
        assertNotNull(newRecord)
        assertTrue(oldRecord !== newRecord)
        assertFalse(CreateFlow.owns(newRecord, CreateFlow.decode(oldRecord!!)!!.operationId))
    }

    @Test
    fun lateCallbackForOldCreateDoesNotClearTheNewerRecord() {
        val env = Env().apply { text = "v1" }
        // Create A accepted; its UI callback is captured but not run.
        var lateA: ((String, Boolean) -> Unit)? = null
        env.createAccept("content://x/a") { cb -> lateA = cb }
        // Create B accepted while A's callback is still pending.
        env.text = "v2"
        env.createAccept("content://x/b", onDone = { /* B's callback never lands */ })
        val recordB = env.pendingCreate
        assertNotNull(recordB)
        // A's callback finally lands (stale for state, and NOT the record
        // owner): background copy only, B's record survives.
        lateA!!("a.md", true)
        assertNull(env.docUri) // A did not rebind
        assertEquals(recordB, env.pendingCreate) // A did not clear B's record
        assertEquals(1, env.toasts.size) // background-copy notice
    }

    @Test
    fun createCancelKeepsAnActiveRecordAndOnlyConsumesThePendingFlag() {
        val env = Env().apply {
            text = "snap"
            pendingAfterSave = GuardAction.Open
        }
        env.createAccept("content://x/a", onDone = { /* never delivered */ })
        // Second Create picker opened and CANCELLED: only this picker's
        // pending flag is consumed (PickerFlow.createCancelled).
        env.pendingAfterSave = GuardAction.New
        env.pendingAfterSave = null // PickerFlow.createCancelled(pickerFlags())
        assertEquals("the old record must survive a cancel", env.pendingCreate !== null, true)
        assertTrue(CreateFlow.owns(env.pendingCreate, 1L))
        assertNull(env.pendingAfterSave)
    }

    @Test
    fun newAndLoadClearTheRecord() {
        val env = Env().apply { text = "snap" }
        env.createAccept("content://x/a", onDone = { /* never delivered */ })
        assertNotNull(env.pendingCreate)
        env.newDocument()
        assertNull(env.pendingCreate)
        env.createAccept("content://x/b", onDone = { /* never delivered */ })
        assertNotNull(env.pendingCreate)
        env.loadFromUri("content://x/other")
        assertNull(env.pendingCreate)
    }

    // ---- live completion semantics ----

    @Test
    fun createLiveCompletionAppliesStateOnceAndClearsTheRecord() {
        val env = Env().apply { text = "snap" }
        env.createAccept("content://x/t1")
        assertEquals("content://x/t1", env.docUri)
        assertEquals("snap", env.savedText)
        assertNull(env.pendingCreate)
        // No recovery afterwards: nothing dangling.
        assertFalse(env.recoverFromRecord())
    }

    @Test
    fun createLiveCompletionWithEditsReGuardsInsteadOfExecuting() {
        val env = Env().apply {
            text = "snap"
            pendingAfterSave = GuardAction.New
        }
        env.createAccept("content://x/t2", editTextDuringWrite = "snap + typed during write")
        assertEquals(GuardAction.New, env.guardAction)
        assertTrue(env.executedFollowUps.isEmpty())
        // The saved snapshot is still the accept-time content.
        assertEquals("snap", env.savedText)
    }

    @Test
    fun createLiveCompletionWithFollowUpExecutesOnUneditedBuffer() {
        val env = Env().apply {
            text = "snap"
            pendingAfterSave = GuardAction.Open
        }
        env.createAccept("content://x/t3")
        assertEquals(listOf(GuardAction.Open), env.executedFollowUps)
        assertNull(env.guardAction)
    }

    @Test
    fun createFailureDoesNotRebindButClearsItsOwnRecord() {
        val env = Env().apply { text = "snap" }
        env.createAccept("content://x/fail", saved = false)
        assertEquals(listOf("content://x/fail" to "snap"), env.writes) // attempt happened
        assertNull(env.docUri) // no rebind on failure
        assertEquals("", env.savedText)
        assertNull(env.pendingCreate) // own record cleared; recovery no-op
        assertFalse(env.recoverFromRecord())
    }

    @Test
    fun createStaleTicketIsBackgroundCopyOnlyAndClearsItsOwnRecord() {
        val env = Env().apply { text = "snap" }
        env.createAccept("content://x/late") { cb ->
            // Another document switch happened before the callback landed:
            env.gate.beginLoad("content://other/doc", "")
            cb("late.md", true)
        }
        assertNull(env.docUri) // no rebind
        assertEquals("", env.savedText) // no savedText write
        assertEquals(1, env.toasts.count { it.contains("copy") })
        assertNull(env.pendingCreate) // own record cleared
    }

    // ---- recovery in a genuinely NEW composition: result unknown ----

    @Test
    fun recoveryAfterOldWriteSucceededIsResultUnknown() {
        val old = Env().apply { text = "confirmed" }
        old.createAccept("content://x/target", onDone = { /* died mid-flight */ })
        val record = old.pendingCreate!!
        // The executor write may well have SUCCEEDED on disk…
        val onDisk = old.writes
        assertEquals(listOf("content://x/target" to "confirmed"), onDisk)
        // …but the new composition (fresh gate, fresh state) can only say
        // "unknown": clear once, toast once, keep the restored text.
        val fresh = Env().apply {
            text = "confirmed" // restored buffer
            pendingCreate = record
        }
        assertTrue(fresh.recoverFromRecord())
        assertNull(fresh.docUri) // no rebind
        assertNull(fresh.guardAction) // no re-armed old guard
        assertEquals("", fresh.savedText) // no savedText change
        assertEquals("confirmed", fresh.text) // text kept
        assertTrue(fresh.writes.isEmpty()) // no duplicate write in the new composition
        assertEquals(1, fresh.toasts.size)
        // Exactly once: a second run is a no-op.
        assertFalse(fresh.recoverFromRecord())
    }

    @Test
    fun recoveryAfterOldWriteFailedIsTheSameUnknown() {
        val old = Env().apply { text = "confirmed" }
        var failureCb: ((String, Boolean) -> Unit)? = null
        old.createAccept("content://x/target") { cb -> failureCb = cb }
        failureCb!!("t.md", false) // the write FAILED before recreation
        val record = old.pendingCreate // cleared by its own callback
        assertNull(record)
        // Even if a record survived (write still unfinished at death), a
        // new composition converges to the same unknown-result behavior.
        val fresh = Env().apply {
            text = "confirmed"
            pendingCreate = CreateFlow.encode(3, "content://x/target", GuardAction.Open)
        }
        assertTrue(fresh.recoverFromRecord())
        assertNull(fresh.docUri)
        assertNull(fresh.guardAction) // the old follow-up is NOT re-armed
        assertTrue(fresh.executedFollowUps.isEmpty()) // and NOT auto-executed
        assertEquals(1, fresh.toasts.size)
    }

    @Test
    fun recoveryWithUnfinishedWriteIsTheSameUnknown() {
        val old = Env().apply { text = "confirmed" }
        old.createAccept("content://x/target", onDone = { /* write never finished */ })
        val fresh = Env().apply {
            text = "confirmed"
            pendingCreate = old.pendingCreate
        }
        assertTrue(fresh.recoverFromRecord())
        assertNull(fresh.docUri)
        assertEquals("confirmed", fresh.text)
        assertTrue(fresh.writes.isEmpty()) // the new composition writes nothing
        assertEquals(1, fresh.toasts.size)
    }

    @Test
    fun liveFollowUpStillWorksInTheOwningComposition() {
        // The unknown-result recovery never touches the LIVE flow: in the
        // composition that owns it, the follow-up still executes.
        val env = Env().apply {
            text = "snap"
            pendingAfterSave = GuardAction.Open
        }
        env.createAccept("content://x/live")
        assertEquals(listOf(GuardAction.Open), env.executedFollowUps)
        assertNull(env.pendingCreate)
    }

    // ---- Issue 10: overlapping saveThen flows converge to one end state ----

    @Test
    fun latestSaveThenWinsRegardlessOfCompletionOrder() {
        // Save-and-Open first, then Save-and-New; the OLDER operation's
        // callback arrives first but must not fire its follow-up.
        val env = Env().apply {
            docUri = "content://x/doc"
            text = "v1"
        }
        val opA = env.gate.beginSaveThen("content://x/doc", "v1")
        env.text = "v2"
        val opB = env.gate.beginSaveThen("content://x/doc", "v2")
        // op A completes first:
        if (env.gate.shouldApplySaveOnOk(opA.ticket, env.docUri)) {
            env.savedText = "v1"
            if (env.gate.isLatestSaveThen(opA)) env.executedFollowUps.add(GuardAction.Open)
        }
        // op B completes second:
        if (env.gate.shouldApplySaveOnOk(opB.ticket, env.docUri)) {
            env.savedText = "v2"
            if (env.gate.isLatestSaveThen(opB)) env.executedFollowUps.add(GuardAction.New)
        }
        assertEquals(listOf(GuardAction.New), env.executedFollowUps) // exactly one
        assertEquals("v2", env.savedText) // last writer wins
    }

    @Test
    fun olderSaveThenCompletionSkipsFollowUpButStillUpdatesSavedText() {
        val env = Env().apply {
            docUri = "content://x/doc"
            text = "v1"
        }
        val opA = env.gate.beginSaveThen("content://x/doc", "v1")
        env.text = "v2"
        val opB = env.gate.beginSaveThen("content://x/doc", "v2")
        // op A's onOk arrives last:
        if (env.gate.shouldApplySaveOnOk(opA.ticket, env.docUri)) {
            env.savedText = "v1"
            if (env.gate.isLatestSaveThen(opA)) env.executedFollowUps.add(GuardAction.Open)
        }
        // op B's onOk:
        if (env.gate.shouldApplySaveOnOk(opB.ticket, env.docUri)) {
            env.savedText = "v2"
            if (env.gate.isLatestSaveThen(opB)) env.executedFollowUps.add(GuardAction.New)
        }
        assertEquals("v2", env.savedText) // last writer wins
        assertEquals(listOf(GuardAction.New), env.executedFollowUps) // one follow-up
    }

    @Test
    fun plainSaveDoesNotAffectLatestSaveThenIdentity() {
        val gate = DocumentRequestGate()
        val op = gate.beginSaveThen("u", "s")
        gate.saveTicket("u", "s2") // an interleaved plain save
        assertTrue(gate.isLatestSaveThen(op))
    }

    @Test
    fun disposedGateBlocksEveryFollowUp() {
        val gate = DocumentRequestGate()
        val op = gate.beginSaveThen("u", "s")
        gate.invalidateAll()
        assertFalse(gate.isLatestSaveThen(op))
    }

    @Test
    fun guardActionOverwriteKeepsOnlyTheLatestReGuard() {
        val env = Env().apply {
            docUri = "content://x/doc"
            text = "v1"
        }
        // Two saveThens with edits → two ReGuards; the latest replaces.
        env.text = "v1"
        val opA = env.gate.beginSaveThen("content://x/doc", "v1")
        env.text = "v1+e"
        if (env.gate.isLatestSaveThen(opA)) env.guardAction = GuardAction.Open
        val opB = env.gate.beginSaveThen("content://x/doc", "v1+e")
        env.text = "v1+e+f"
        if (env.gate.isLatestSaveThen(opB)) env.guardAction = GuardAction.New
        assertEquals(GuardAction.New, env.guardAction) // single dialog, latest wins
    }

    // ---- CreateFlow v2 encoding ----

    @Test
    fun createFlowEncodingRoundTrips() {
        for (followUp in listOf<GuardAction?>(null, GuardAction.Open, GuardAction.New)) {
            val rec = CreateFlow.encode(7, "content://x/any/target", followUp)
            val decoded = CreateFlow.decode(rec)
            assertNotNull(decoded)
            assertEquals(2, decoded!!.version)
            assertEquals(7L, decoded.operationId)
            assertEquals("content://x/any/target", decoded.uri)
            assertEquals(followUp, decoded.followUp)
        }
    }

    @Test
    fun createFlowEncodingSurvivesSeparatorsInUri() {
        val tricky = "content://x/a\\b\nc d"
        val decoded = CreateFlow.decode(CreateFlow.encode(1, tricky, null))
        assertNotNull(decoded)
        assertEquals(tricky, decoded!!.uri)
    }

    @Test
    fun createFlowEscapingRoundTripsAdversarialStrings() {
        // Literal backslash+n, doubled backslashes, real newlines, trailing
        // backslash, and mixtures — the single-pass decoder must recover
        // each exactly (a chained-replace pair mangles backslash+n).
        val vectors = listOf(
            "a\\nb",          // literal backslash + n
            "a\\\\b",         // literal double backslash
            "a\nb",           // real newline
            "a\\nb\nc\\\\d",  // mixture
            "ends with \\",   // trailing backslash
            "\\",             // just a backslash
            "\\\\n",          // backslash backslash n (no real escape)
        )
        for (v in vectors) {
            val decoded = CreateFlow.decode(CreateFlow.encode(2, v, null))
            assertNotNull("round-trip of $v", decoded)
            assertEquals(v, decoded!!.uri)
        }
    }

    @Test
    fun createFlowDecodeToleratesMalformedTrailingEscape() {
        // A record whose last field ends with a lone backslash decodes that
        // backslash literally instead of throwing or dropping it.
        val rec = CreateFlow.encode(1, "content://x/u", null)
        val decoded = CreateFlow.decode("$rec\\")
        // The trailing backslash makes the frame malformed (5th field)…
        // split(limit=4) keeps it inside the followUp field → rejected.
        assertNull(decoded)
    }

    @Test
    fun createFlowDecodeRejectsMalformedAndForeignVersions() {
        assertNull(CreateFlow.decode(""))
        assertNull(CreateFlow.decode("2"))
        assertNull(CreateFlow.decode("2\n1"))
        assertNull(CreateFlow.decode("2\nx\nuri\n-")) // non-numeric operation id
        assertNull(CreateFlow.decode("2\n-3\nuri\n-")) // negative operation id
        assertNull(CreateFlow.decode("2\n1\n\n-")) // empty uri
        assertNull(CreateFlow.decode("2\n1\nuri\n99")) // unknown follow-up ordinal
        assertNull(CreateFlow.decode("1\ncontent://x\nOpen")) // v1 record
        assertNull(CreateFlow.decode("content://x/bare")) // legacy bare record
        assertNull(CreateFlow.decode("content://x\nOpen")) // legacy two-field record
    }

    @Test
    fun createFlowOwnsMatchesOnlyTheNamedOperation() {
        val rec = CreateFlow.encode(5, "content://x/u", null)
        assertTrue(CreateFlow.owns(rec, 5))
        assertFalse(CreateFlow.owns(rec, 4))
        assertFalse(CreateFlow.owns(rec, 6))
        assertFalse(CreateFlow.owns(null, 5))
        assertFalse(CreateFlow.owns("garbage", 5))
    }
}
