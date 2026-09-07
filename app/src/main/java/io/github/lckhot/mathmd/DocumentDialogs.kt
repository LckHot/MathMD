package io.github.lckhot.mathmd

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/**
 * Open-guard dialog (owner spec): shown BEFORE the file picker when the
 * current buffer is dirty — checked at Open-press time, not after picking.
 */
@Composable
internal fun UnsavedChangesDialog(
    docName: String,
    onSaveAndOpen: () -> Unit,
    onDiscardAndOpen: () -> Unit,
    onKeepAndNewWindow: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Unsaved changes") },
        confirmButton = {},
        dismissButton = {},
        text = {
            Column {
                Text("Unsaved changes in $docName.")
                TextButton(modifier = Modifier.fillMaxWidth(), onClick = onSaveAndOpen) {
                    Text("Save and open…", modifier = Modifier.fillMaxWidth())
                }
                TextButton(modifier = Modifier.fillMaxWidth(), onClick = onDiscardAndOpen) {
                    Text("Discard changes and open…", modifier = Modifier.fillMaxWidth())
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
