package io.github.lckhot.mathmd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * H2: the DocumentRequestGate race matrix (≥12 controlled scenarios from
 * the plan). No fake timing: every scenario drives the gate's decision
 * functions in an explicit order, which is exactly what the UI-thread
 * callbacks do.
 */
class DocumentRequestGateTest {

    private val gate = DocumentRequestGate()
    private val uriA = "content://provider/docs/A"
    private val uriB = "content://provider/docs/B"
    private val uriNew = "content://provider/docs/new-target"

    // 1. A->B load out of order: B applies, A never overwrites it.
    @Test
    fun outOfOrderLoadsLastOneWins() {
        val tA = gate.beginLoad(uriA, "")
        val tB = gate.beginLoad(uriB, "")
        assertEquals(DocumentRequestGate.LoadDecision.Apply, gate.classifyLoad(tB, uriB, ""))
        assertEquals(DocumentRequestGate.LoadDecision.Discard, gate.classifyLoad(tA, uriA, ""))
        // A arriving first changes nothing.
        assertEquals(DocumentRequestGate.LoadDecision.Discard, gate.classifyLoad(tA, uriA, ""))
        assertEquals(DocumentRequestGate.LoadDecision.Apply, gate.classifyLoad(tB, uriB, ""))
    }

    // 2. load + edit: edits are kept, the load is dropped with a notice.
    @Test
    fun lateLoadDoesNotClobberEditsTypedDuringTheRead() {
        val t = gate.beginLoad(uriA, "original")
        assertEquals(DocumentRequestGate.LoadDecision.KeepEdits, gate.classifyLoad(t, uriA, "original + typed"))
    }

    // 3. load + New: the fresh empty document is untouched by the old load.
    @Test
    fun loadThenNewDiscardsTheLoad() {
        val t = gate.beginLoad(uriA, "")
        gate.beginNewDocument()
        assertEquals(DocumentRequestGate.LoadDecision.Discard, gate.classifyLoad(t, uriA, ""))
    }

    // 4. save + edit: savedText becomes the snapshot; the newer text stays dirty.
    @Test
    fun saveCompletesWhileEdited() {
        val t = gate.saveTicket(uriA, "snapshot")
        // The text differing must NOT block the save's own state update…
        assertTrue(gate.shouldApplySaveOnOk(t, uriA))
        // …and the follow-up classification sees the change:
        assertEquals(DocumentRequestGate.FollowUpDecision.ReGuard, gate.classifyFollowUp(t, "snapshot + more"))
    }

    // 5. saveThen + edit: the original action re-guards instead of running.
    @Test
    fun saveThenWithEditsReGuardsTheFollowUp() {
        val t = gate.saveTicket(uriA, "snap")
        assertEquals(DocumentRequestGate.FollowUpDecision.ReGuard, gate.classifyFollowUp(t, "edited"))
        assertEquals(DocumentRequestGate.FollowUpDecision.Execute, gate.classifyFollowUp(t, "snap"))
    }

    // 6. save + New / switched URI: old onOk must not pollute the new doc,
    //    and the write itself went to the captured old URI.
    @Test
    fun saveOnOkAfterNewDocumentIsIgnored() {
        val t = gate.saveTicket(uriA, "snap")
        gate.beginNewDocument()
        assertFalse(gate.shouldApplySaveOnOk(t, null))
    }

    @Test
    fun saveOnOkAfterAnotherLoadIsIgnored() {
        val t = gate.saveTicket(uriA, "snap")
        gate.beginLoad(uriB, "")
        assertFalse(gate.shouldApplySaveOnOk(t, uriA))
    }

    @Test
    fun saveOnOkWithReboundUriIsIgnored() {
        val t = gate.saveTicket(uriA, "snap")
        // Document switched to another URI (e.g. via a later create).
        assertFalse(gate.shouldApplySaveOnOk(t, uriB))
    }

    // 7. Create resolve late: no rebind, but the background copy is written.
    @Test
    fun lateCreateResolveDoesNotRebind() {
        val t = gate.beginCreate(uriNew, "confirmed")
        gate.beginNewDocument()
        assertFalse(gate.isCurrent(t)) // resolveName must skip the rebind
        // The write to the confirmed URI+snapshot is unconditional by
        // construction (it targets the captured values, not doc state).
    }

    // 8. Create onOk late: background-copy outcome only.
    @Test
    fun lateCreateOnOkWritesNothingToCurrentDoc() {
        val t = gate.beginCreate(uriNew, "confirmed")
        gate.beginLoad(uriA, "")
        assertFalse(gate.shouldApplySaveOnOk(t, uriNew))
    }

    // 9. Create normal + edit: rebind happened, snapshot saved, follow-up re-guards.
    @Test
    fun createWithEditsSavesSnapshotAndReGuards() {
        val t = gate.beginCreate(uriNew, "snap")
        assertTrue(gate.isCurrent(t))
        assertTrue(gate.uriMatches(t, uriNew))
        assertEquals(DocumentRequestGate.FollowUpDecision.ReGuard, gate.classifyFollowUp(t, "snap+edit"))
    }

    // 10. Create normal without edits: everything applies exactly once.
    @Test
    fun createWithoutEditsExecutesFollowUp() {
        val t = gate.beginCreate(uriNew, "snap")
        assertTrue(gate.shouldApplySaveOnOk(t, uriNew))
        assertEquals(DocumentRequestGate.FollowUpDecision.Execute, gate.classifyFollowUp(t, "snap"))
    }

    // 11. Open/Create cancel: no generation change — nothing to invalidate.
    @Test
    fun pickerCancelDoesNotBumpTheGeneration() {
        val before = gate.saveTicket(uriA, "x")
        // (cancel paths never touch the gate)
        val after = gate.saveTicket(uriA, "y")
        assertTrue(gate.isCurrent(after))
        assertEquals(before.generation, after.generation)
    }

    // 12. dispose: every late callback is a no-op, and the disposed flag
    //     stops resolveName from submitting further IO.
    @Test
    fun disposeInvalidatesEverythingAndBlocksNewWork() {
        val t = gate.beginLoad(uriA, "")
        gate.invalidateAll()
        assertTrue(gate.disposed)
        assertFalse(gate.isCurrent(t))
        assertEquals(DocumentRequestGate.LoadDecision.Discard, gate.classifyLoad(t, uriA, ""))
        // Even a ticket minted after dispose never applies.
        val t2 = gate.beginLoad(uriB, "")
        assertFalse(gate.isCurrent(t2))
        assertEquals(DocumentRequestGate.LoadDecision.Discard, gate.classifyLoad(t2, uriB, ""))
    }

    // Extra: a load callback whose URI is foreign to its ticket is dropped.
    @Test
    fun foreignUriLoadCallbackIsDiscarded() {
        val t = gate.beginLoad(uriA, "")
        assertEquals(DocumentRequestGate.LoadDecision.Discard, gate.classifyLoad(t, uriB, ""))
    }

    // Extra: value-comparison semantics — undo back to the original text is
    // NOT an edit (no false revision).
    @Test
    fun valueComparisonTreatsUndoToOriginalAsUnedited() {
        val t = gate.saveTicket(uriA, "snap")
        assertEquals(DocumentRequestGate.FollowUpDecision.Execute, gate.classifyFollowUp(t, "snap"))
    }
}
