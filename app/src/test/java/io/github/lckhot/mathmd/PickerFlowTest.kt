package io.github.lckhot.mathmd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * H1: the picker terminal-state contract (see the review's table). Every
 * launcher terminal path must consume exactly its own flag and never leak
 * a stale action into a later, unrelated one.
 */
class PickerFlowTest {

    private val base = PickerFlags(openInNewWindow = false, pendingAfterSave = null)

    // ---- Open picker ----

    @Test
    fun openCancelClearsNewWindowFlagOnly() {
        val f = PickerFlow.openCancelled(base.copy(openInNewWindow = true, pendingAfterSave = GuardAction.Open))
        assertFalse(f.openInNewWindow)
        // pending is not the Open picker's flag: unchanged.
        assertEquals(GuardAction.Open, f.pendingAfterSave)
    }

    @Test
    fun openSuccessConsumesNewWindowFlag() {
        val f = PickerFlow.openConsumed(base.copy(openInNewWindow = true))
        assertFalse(f.openInNewWindow)
    }

    @Test
    fun openLaunchFailureClearsNewWindowFlag() {
        val f = PickerFlow.openLaunchFailed(base.copy(openInNewWindow = true))
        assertFalse(f.openInNewWindow)
    }

    // ---- Create picker ----

    @Test
    fun createCancelClearsPendingActionOnly() {
        val f = PickerFlow.createCancelled(base.copy(openInNewWindow = true, pendingAfterSave = GuardAction.New))
        assertNull(f.pendingAfterSave)
        assertTrue(f.openInNewWindow) // not the Create picker's flag
    }

    @Test
    fun createAcceptConsumesPendingAction() {
        val f = PickerFlow.createAccepted(base.copy(pendingAfterSave = GuardAction.Open))
        assertNull(f.pendingAfterSave)
    }

    @Test
    fun createLaunchFailureClearsPendingAction() {
        val f = PickerFlow.createLaunchFailed(base.copy(pendingAfterSave = GuardAction.New))
        assertNull(f.pendingAfterSave)
    }

    // ---- Guard answers ----

    @Test
    fun keepAndNewWindowSetsTheOpenDispatchFlag() {
        val f = PickerFlow.keepAndNewWindowChosen(base)
        assertTrue(f.openInNewWindow)
        assertNull(f.pendingAfterSave)
    }

    @Test
    fun saveThenUntitledRecordsTheFollowUp() {
        val f = PickerFlow.saveThenUntitled(base, GuardAction.Open)
        assertTrue(f.openInNewWindow.not())
        assertEquals(GuardAction.Open, f.pendingAfterSave)
    }

    @Test
    fun writeFailureLeavesNoRestoredPending() {
        // On a failed write onOk never runs; the follow-up must already be
        // consumed by the accept transition (it is not "restored").
        val accepted = PickerFlow.createAccepted(
            PickerFlow.saveThenUntitled(base, GuardAction.New),
        )
        assertNull(accepted.pendingAfterSave)
    }

    // ---- Red-line regressions ----

    @Test
    fun cancelThenLaterOrdinarySaveHasNoGhostAction() {
        // Cancel a Save-and-open flow, then do an ordinary create-based
        // save: no stale Open/New action may survive into it.
        var f = PickerFlow.saveThenUntitled(base, GuardAction.Open)
        f = PickerFlow.createCancelled(f)
        f = PickerFlow.createAccepted(f) // a later successful create
        assertNull(f.pendingAfterSave)
    }

    @Test
    fun openCancelThenNextOpenIsNotHijackedIntoANewWindow() {
        // 1) A dirty Open answered with "Keep this, open in a new window"
        //    arms the dispatch flag; the picker is cancelled — the flag is
        //    consumed, nothing loads.
        var f = PickerFlow.keepAndNewWindowChosen(base)
        f = PickerFlow.openCancelled(f)
        assertFalse(f.openInNewWindow)
        // 2) A LATER ordinary Open (no guard answer) must not inherit the
        //    cancelled dispatch: it stays an in-window open.
        f = PickerFlow.openConsumed(f)
        assertFalse(f.openInNewWindow)
    }
}
