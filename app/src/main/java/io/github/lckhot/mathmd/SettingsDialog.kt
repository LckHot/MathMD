@file:OptIn(ExperimentalMaterial3Api::class)

package io.github.lckhot.mathmd

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val FONT_FAMILIES = listOf(
    "default", "sans-serif", "sans-serif-light", "sans-serif-condensed",
    "sans-serif-thin", "sans-serif-medium", "sans-serif-black",
    "sans-serif-small-caps", "serif", "monospace", "cursive",
)

@Composable
internal fun SettingsDialog(
    themeMode: String,
    editorFontSize: Int,
    editorFont: String,
    previewFont: String,
    pageWidthCh: Int,
    onTheme: (String) -> Unit,
    onEditorSize: (Int) -> Unit,
    onEditorFont: (String) -> Unit,
    onPreviewFont: (String) -> Unit,
    onPageWidth: (Int) -> Unit,
    onStartupMode: (String) -> Unit,
    startupMode: String,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {},
        title = { Text("Settings") },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                SettingRow("Theme") {
                    for (t in listOf("system", "light", "dark")) {
                        FilterChip(
                            selected = themeMode == t,
                            onClick = { onTheme(t) },
                            label = { Text(t.replaceFirstChar { it.uppercase() }) },
                            modifier = Modifier.padding(end = 6.dp),
                        )
                    }
                }
                SettingRow("Open documents in") {
                    for (m in listOf("edit", "preview")) {
                        FilterChip(
                            selected = startupMode == m,
                            onClick = { onStartupMode(m) },
                            label = { Text(m.replaceFirstChar { it.uppercase() }) },
                            modifier = Modifier.padding(end = 6.dp),
                        )
                    }
                }
                SettingRow("Editor font size (8–40)") {
                    SizeField(editorFontSize, onEditorSize, min = 8, max = 40)
                }
                SettingRow("Editor font") {
                    PickerField(
                        value = editorFont,
                        title = "Editor font",
                        options = FONT_FAMILIES,
                        onPick = onEditorFont,
                    )
                }
                SettingRow("Preview font") {
                    PickerField(
                        value = previewFont,
                        title = "Preview font",
                        options = FONT_FAMILIES,
                        onPick = onPreviewFont,
                    )
                }
                SettingRow("Page width in characters (0 = fill screen)") {
                    SizeField(pageWidthCh, onPageWidth, min = 0, max = 200)
                }
            }
        },
    )
}

@Composable
private fun SizeField(value: Int, onChange: (Int) -> Unit, min: Int, max: Int) {
    val maxDigits = max.toString().length
    var txt by remember(value) { mutableStateOf(value.toString()) }
    OutlinedTextField(
        value = txt,
        onValueChange = { s ->
            val filtered = s.filter { it.isDigit() }.take(maxDigits)
            txt = filtered
            filtered.toIntOrNull()?.let { if (it in min..max) onChange(it) }
        },
        modifier = Modifier.width(120.dp),
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
    )
}

/** Tappable field showing the current value; opens a radio-list dialog. */
@Composable
private fun PickerField(
    value: String,
    title: String,
    options: List<String>,
    onPick: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    OutlinedButton(onClick = { open = true }) {
        Text(value)
    }
    if (open) {
        ListPickerDialog(title = title, current = value, options = options, onPick = onPick, onDismiss = { open = false })
    }
}

@Composable
private fun ListPickerDialog(
    title: String,
    current: String,
    options: List<String>,
    onPick: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
        title = { Text(title) },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                for (o in options) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onPick(o); onDismiss() }
                            .padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = o == current, onClick = { onPick(o); onDismiss() })
                        Text(o, modifier = Modifier.padding(start = 4.dp))
                    }
                }
            }
        },
    )
}

@Composable
private fun SettingRow(label: String, content: @Composable () -> Unit) {
    Column(modifier = Modifier.padding(vertical = 6.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium)
        Row(modifier = Modifier.padding(top = 4.dp)) { content() }
    }
}
