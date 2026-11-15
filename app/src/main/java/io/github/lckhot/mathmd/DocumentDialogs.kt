package io.github.lckhot.mathmd

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

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
 *
 * Visual hierarchy (state machine / callbacks unchanged): a single filled
 * primary action (Save), a destructive Discard rendered as an error-colored
 * TextButton (deliberately NOT more prominent than Save), and neutral
 * Keep-new-window / Cancel TextButtons. Actions are full-width, >=48dp tall,
 * and the column scrolls so large font scales stay reachable. No extra
 * confirmation step is introduced.
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
    val error = MaterialTheme.colorScheme.error
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = {
            Icon(
                Icons.Filled.Warning,
                contentDescription = null,
                tint = error,
            )
        },
        title = { Text("Unsaved changes") },
        confirmButton = {},
        dismissButton = {},
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                Text(
                    text = "Unsaved changes in",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = docName,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(modifier = Modifier.height(16.dp))
                // Primary action: the only filled button.
                Button(
                    onClick = onSaveAndContinue,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) {
                    Icon(
                        Icons.Filled.Check,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Save and $verb")
                }
                Spacer(modifier = Modifier.height(8.dp))
                // Destructive: error-colored TextButton, not outlined, and
                // not louder than the primary action.
                TextButton(
                    onClick = onDiscardAndContinue,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = error),
                ) {
                    Icon(
                        Icons.Filled.Delete,
                        contentDescription = null,
                        tint = error,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Discard changes and $verb")
                }
                Spacer(modifier = Modifier.height(4.dp))
                TextButton(
                    onClick = onKeepAndNewWindow,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) {
                    Text("Keep this, open in new window…")
                }
                TextButton(
                    onClick = onDismiss,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) {
                    Text("Cancel")
                }
            }
        },
    )
}
