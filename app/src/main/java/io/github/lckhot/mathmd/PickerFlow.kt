package io.github.lckhot.mathmd

/**
 * Picker flow terminal-state transitions (H1).
 *
 * `openInNewWindow` and `pendingActionAfterSave` must survive
 * configuration changes and process restoration (rememberSaveable), and
 * every terminal path of a launcher — cancel, success, launch failure —
 * must consume its flag so no stale action fires later. The transitions
 * are pure so the contract is unit-tested without Compose; MainActivity
 * only applies them.
 */
internal data class PickerFlags(
    val openInNewWindow: Boolean = false,
    val pendingAfterSave: GuardAction? = null,
)

internal object PickerFlow {

    /** Open picker cancelled: clear the new-window dispatch, keep pending. */
    fun openCancelled(f: PickerFlags): PickerFlags = f.copy(openInNewWindow = false)

    /**
     * Open picker returned a URI: the caller must have captured the flag
     * into a local BEFORE applying this — afterwards it is consumed.
     */
    fun openConsumed(f: PickerFlags): PickerFlags = f.copy(openInNewWindow = false)

    /** Open launcher failed to start: no dispatch, dirty buffer untouched. */
    fun openLaunchFailed(f: PickerFlags): PickerFlags = f.copy(openInNewWindow = false)

    /** Create picker cancelled: no write, no follow-up. */
    fun createCancelled(f: PickerFlags): PickerFlags = f.copy(pendingAfterSave = null)

    /**
     * Create picker returned a URI: the follow-up is captured into a local
     * synchronously and consumed here, so a late callback can never read a
     * newer action by accident.
     */
    fun createAccepted(f: PickerFlags): PickerFlags = f.copy(pendingAfterSave = null)

    /** Create launcher failed to start: keep editing, no pending action. */
    fun createLaunchFailed(f: PickerFlags): PickerFlags = f.copy(pendingAfterSave = null)

    /** "Keep this, open in new window" answer for a dirty Open guard. */
    fun keepAndNewWindowChosen(f: PickerFlags): PickerFlags = f.copy(openInNewWindow = true)

    /** Untitled Save-and-continue: the action follows once the save lands. */
    fun saveThenUntitled(f: PickerFlags, action: GuardAction): PickerFlags =
        f.copy(pendingAfterSave = action)
}
