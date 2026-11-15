@file:OptIn(ExperimentalMaterial3Api::class)

package io.github.lckhot.mathmd

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

private val FONT_FAMILIES = listOf(
    "default", "sans-serif", "sans-serif-light", "sans-serif-condensed",
    "sans-serif-thin", "sans-serif-medium", "sans-serif-black",
    "sans-serif-small-caps", "serif", "monospace", "cursive",
)

/**
 * Settings dialog. All callbacks apply instantly and keep their existing
 * clamp / previewReloadKey semantics (owned by MainActivity); this file only
 * restructures the presentation: lightweight Appearance / Editor / Preview /
 * Tables sections (no heavy cards), FilterChip single-selects that wrap on
 * narrow screens, a Switch for the boolean TSV toggle, exact numeric inputs
 * with range helper text, full-width value pickers, and a Done button.
 */
@Composable
internal fun SettingsDialog(
    themeMode: String,
    editorFontSize: Int,
    editorFont: String,
    previewFont: String,
    pageWidthCh: Int,
    tsvTables: Boolean,
    tsvMinRows: Int,
    tsvMinCols: Int,
    onTheme: (String) -> Unit,
    onEditorSize: (Int) -> Unit,
    onEditorFont: (String) -> Unit,
    onPreviewFont: (String) -> Unit,
    onPageWidth: (Int) -> Unit,
    onStartupMode: (String) -> Unit,
    onTsvTables: (Boolean) -> Unit,
    onTsvMinRows: (Int) -> Unit,
    onTsvMinCols: (Int) -> Unit,
    startupMode: String,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("Done") }
        },
        title = { Text("Settings") },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                Section("Appearance", first = true)
                SettingRow("Theme") {
                    ChoiceChips(
                        options = listOf("system", "light", "dark"),
                        selected = themeMode,
                        onSelect = onTheme,
                    )
                }
                SettingRow("Open documents in") {
                    ChoiceChips(
                        options = listOf("edit", "preview"),
                        selected = startupMode,
                        onSelect = onStartupMode,
                    )
                }

                Section("Editor")
                SettingRow("Editor font size") {
                    SizeField(editorFontSize, onEditorSize, min = 8, max = 40, helper = "8–40")
                }
                SettingRow("Editor font") {
                    PickerField(
                        value = editorFont,
                        title = "Editor font",
                        options = FONT_FAMILIES,
                        onPick = onEditorFont,
                    )
                }

                Section("Preview")
                SettingRow("Preview font") {
                    PickerField(
                        value = previewFont,
                        title = "Preview font",
                        options = FONT_FAMILIES,
                        onPick = onPreviewFont,
                    )
                }
                SettingRow("Line width in characters") {
                    SizeField(pageWidthCh, onPageWidth, min = 0, max = 200, helper = "0–200 · 0 = fill screen")
                }

                Section("Tables")
                SwitchRow(
                    label = "TSV tables (ChatGPT-style)",
                    checked = tsvTables,
                    onCheckedChange = onTsvTables,
                )
                if (tsvTables) {
                    SettingRow("TSV minimum rows") {
                        SizeField(tsvMinRows, onTsvMinRows, min = 2, max = 20, helper = "2–20")
                    }
                    SettingRow("TSV minimum columns") {
                        SizeField(tsvMinCols, onTsvMinCols, min = 2, max = 10, helper = "2–10")
                    }
                }
            }
        },
    )
}

/** Lightweight section header: a thin divider (except the first) + title. */
@Composable
private fun Section(title: String, first: Boolean = false) {
    if (!first) {
        HorizontalDivider(
            modifier = Modifier.padding(top = 16.dp),
            color = MaterialTheme.colorScheme.outlineVariant,
        )
    }
    Text(
        text = title,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(top = if (first) 0.dp else 12.dp, bottom = 8.dp),
    )
}

/** Label above its control; full width so pickers/fields can expand. */
@Composable
private fun SettingRow(label: String, content: @Composable () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Spacer(modifier = Modifier.height(4.dp))
        content()
    }
}

/** Single-select FilterChips that wrap to the next line on narrow screens. */
@Composable
private fun ChoiceChips(options: List<String>, selected: String, onSelect: (String) -> Unit) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for (option in options) {
            FilterChip(
                selected = selected == option,
                onClick = { onSelect(option) },
                label = { Text(option.replaceFirstChar { it.uppercase() }) },
            )
        }
    }
}

/** Boolean setting: label left, Switch right, full-width >=48dp row. */
@Composable
private fun SwitchRow(label: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f).padding(end = 16.dp),
        )
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

/** Exact numeric input with a range helper; only in-range values propagate. */
@Composable
private fun SizeField(value: Int, onChange: (Int) -> Unit, min: Int, max: Int, helper: String) {
    val maxDigits = max.toString().length
    var txt by remember(value) { mutableStateOf(value.toString()) }
    OutlinedTextField(
        value = txt,
        onValueChange = { s ->
            val filtered = s.filter { it.isDigit() }.take(maxDigits)
            txt = filtered
            filtered.toIntOrNull()?.let { if (it in min..max) onChange(it) }
        },
        modifier = Modifier.width(140.dp),
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        supportingText = { Text(helper) },
    )
}

/** Full-width tappable field showing the current value; opens a radio list. */
@Composable
private fun PickerField(
    value: String,
    title: String,
    options: List<String>,
    onPick: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    OutlinedButton(
        onClick = { open = true },
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            text = value,
            modifier = Modifier.weight(1f),
            textAlign = TextAlign.Start,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Icon(Icons.Filled.KeyboardArrowDown, contentDescription = null)
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
                            .heightIn(min = 48.dp)
                            .padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = o == current, onClick = { onPick(o); onDismiss() })
                        Text(o, modifier = Modifier.padding(start = 8.dp))
                    }
                }
            }
        },
    )
}
