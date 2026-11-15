package io.github.lckhot.mathmd

/**
 * Binds asynchronous document IO callbacks to the request that started
 * them (H2), so late callbacks can never clobber newer edits or a
 * different open document.
 *
 * Design (per the review consensus):
 *  - Pure Kotlin, main-thread confined, no Compose and no Android types —
 *    the whole race matrix is plain-JUnit testable. Tickets capture only
 *    immutable values (generation, expected URI string, expected text
 *    snapshot); they never capture the mutable DocumentState.
 *  - Value comparison instead of an edit counter: an IME echo or an undo
 *    back to the original text must not look like an edit.
 *
 * Generation bumps: load start, newDocument (BEFORE clearing the
 * document), Create/Save-As accepting a non-empty URI. Plain saves do NOT
 * bump — editing while a save is in flight is legal.
 */
internal class DocumentRequestGate {

    data class Ticket(
        val generation: Long,
        val expectedUri: String,
        val expectedText: String,
    )

    enum class LoadDecision { Apply, KeepEdits, Discard }

    enum class FollowUpDecision { Execute, ReGuard }

    /**
     * A save-then-continue operation: the plain-save ticket PLUS a
     * monotonically increasing operation id. Only the LATEST saveThen
     * operation may run its follow-up — two overlapping Save-and-Open /
     * Save-and-New flows must converge to ONE consistent end state instead
     * of firing both actions in completion order (Lead round 6, issue 10).
     */
    data class SaveThenOp(val ticket: Ticket, val opId: Long)

    private var generation = 0L
    private var saveThenSeq = 0L

    /** Set by [invalidateAll]; every subsequent or in-flight decision fails. */
    var disposed = false
        private set

    /** A load starts: everything earlier (load/save/create) is invalidated. */
    fun beginLoad(uri: String, currentText: String): Ticket =
        Ticket(++generation, uri, currentText)

    /** New document: call BEFORE clearing state; old callbacks must not write into it. */
    fun beginNewDocument() {
        generation++
    }

    /** Create/Save-As accepted a non-empty URI: snapshot fixed at accept time. */
    fun beginCreate(uri: String, snapshot: String): Ticket =
        Ticket(++generation, uri, snapshot)

    /**
     * Plain save / saveThen ticket: NO generation bump — keystrokes during
     * the write are legal and must not invalidate the save's own callback.
     */
    fun saveTicket(uri: String, snapshot: String): Ticket =
        Ticket(generation, uri, snapshot)

    /**
     * Save-then-continue operation: a save ticket plus a fresh operation
     * id. The write shares plain-save semantics (never bumps generation);
     * only follow-up execution is gated on being the LATEST operation.
     */
    fun beginSaveThen(uri: String, snapshot: String): SaveThenOp =
        SaveThenOp(saveTicket(uri, snapshot), ++saveThenSeq)

    /** True when [op] is still the most recent saveThen operation. */
    fun isLatestSaveThen(op: SaveThenOp): Boolean = !disposed && op.opId == saveThenSeq

    fun isCurrent(t: Ticket): Boolean = !disposed && t.generation == generation

    fun uriMatches(t: Ticket, uri: String?): Boolean = t.expectedUri == uri

    fun textMatches(t: Ticket, text: String): Boolean = t.expectedText == text

    /**
     * Load completion decision:
     *  - Apply — the request is current, belongs to this URI, and the
     *    buffer still equals the text at load start;
     *  - KeepEdits — current and ours, but the user typed during the read:
     *    keep the edits, drop the load, notify;
     *  - Discard — stale or foreign: change nothing at all.
     */
    fun classifyLoad(t: Ticket, uri: String, currentText: String): LoadDecision = when {
        !isCurrent(t) || t.expectedUri != uri -> LoadDecision.Discard
        t.expectedText != currentText -> LoadDecision.KeepEdits
        else -> LoadDecision.Apply
    }

    /**
     * Save completion: shared state may update only when the request is
     * current AND this document is still the one bound at save time. The
     * write itself always went to the URI captured at initiation.
     */
    fun shouldApplySaveOnOk(t: Ticket, currentDocUri: String?): Boolean =
        isCurrent(t) && uriMatches(t, currentDocUri)

    /**
     * Follow-up (Open/New after save-and-continue): execute only when the
     * buffer still equals the saved snapshot; otherwise re-open the dirty
     * guard for the original action instead of switching documents.
     */
    fun classifyFollowUp(t: Ticket, currentText: String): FollowUpDecision =
        if (textMatches(t, currentText)) FollowUpDecision.Execute else FollowUpDecision.ReGuard

    /** onDispose: invalidate everything first, then shut the IO executor down. */
    fun invalidateAll() {
        generation++
        disposed = true
    }
}
