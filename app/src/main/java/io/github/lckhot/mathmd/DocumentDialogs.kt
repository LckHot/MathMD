package io.github.lckhot.mathmd

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/**
 * What the user asked to do while the buffer was dirty. Open and New share
 * the guard flow (owner spec: an unsaved document is handled identically by
 * both); only the follow-up action differs.
 */
internal enum class GuardAction { Open, New }

/**
 * Unsaved-changes guard dialog (owner spec): shown BEFORE the follow-up
 * action (file picker for Open, blank document for New) when the current
 * buffer is dirty — checked at press time, not after picking.
 */
@Composable
internal fun UnsavedChangesDialog(
    docName: String,
    action: GuardAction,
    onSaveAndContinue: () -> Unit,
    onDiscardAndContinue: () -> Unit,
    onKeepAndNewWindow: () -> Unit,
    onDismiss: () -> Unit,
) {
    val verb = if (action == GuardAction.Open) "open…" else "create new"
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Unsaved changes") },
        confirmButton = {},
        dismissButton = {},
        text = {
            Column {
                Text("Unsaved changes in $docName.")
                TextButton(modifier = Modifier.fillMaxWidth(), onClick = onSaveAndContinue) {
                    Text("Save and $verb", modifier = Modifier.fillMaxWidth())
                }
                TextButton(modifier = Modifier.fillMaxWidth(), onClick = onDiscardAndContinue) {
                    Text("Discard changes and $verb", modifier = Modifier.fillMaxWidth())
                }
                TextButton(modifier = Modifier.fillMaxWidth(), onClick = onKeepAndNewWindow) {
                    Text("Keep this, open in new window…", modifier = Modifier.fillMaxWidth())
                }
                TextButton(modifier = Modifier.fillMaxWidth(), onClick = onDismiss) {
                    Text("Cancel", modifier = Modifier.fillMaxWidth())
                }
            }
        },
    )
}
