package io.github.lckhot.mathmd

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.input.OutputTransformation
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.sp
import android.graphics.Typeface

/**
 * Search state handed to the editor pane. [tick] bumps on every
 * (re)run-request (query change, step, mode flip); the pane recomputes
 * matches from its own text and reports back via [onResult].
 */
internal class EditorSearchSpec(
    val query: String,
    val index: Int,
    val tick: Int,
    val onResult: (total: Int, active: Int) -> Unit,
)

/** Same contract for the preview pane (runs through the JS bridge). */
internal class PreviewSearchSpec(
    val query: String,
    val index: Int,
    val tick: Int,
    val onResult: (total: Int, active: Int) -> Unit,
)

private val HitAll = SpanStyle(background = Color(0x59FFC800)) // amber ~35%
private val HitActive = SpanStyle(background = Color(0xE6FF6E00)) // orange

private fun editorFontFamily(name: String): FontFamily = when (name) {
    "default" -> FontFamily.Default
    else -> FontFamily(Typeface.create(name, Typeface.NORMAL))
}

/** Case-insensitive all-match ranges of [query] in [text]. */
private fun matchRanges(text: String, query: String): List<IntRange> {
    if (query.isEmpty()) return emptyList()
    val t = text.lowercase()
    val q = query.lowercase()
    return buildList {
        var i = t.indexOf(q)
        while (i != -1) {
            add(i until i + q.length)
            i = t.indexOf(q, i + q.length)
        }
    }
}

@Composable
internal fun EditorPane(
    text: String,
    fontSize: Int,
    fontName: String,
    modifier: Modifier = Modifier,
    search: EditorSearchSpec? = null,
    onText: (String) -> Unit,
) {
    val state = remember { TextFieldState(text) }

    // External text changes (open a file) sync in; local edits flow out.
    if (state.text.toString() != text) {
        state.edit { replace(0, length, text) }
    }
    LaunchedEffect(state) {
        snapshotFlow { state.text.toString() }.collect { onText(it) }
    }

    // Recomputed each recomposition (cheap indexOf scan; text sizes here
    // are documents, not novels).
    val query = search?.query.orEmpty()
    val ranges = matchRanges(state.text.toString(), query)
    val active = if (search == null || ranges.isEmpty()) -1
    else search.index.coerceIn(0, ranges.lastIndex)

    // Report total/active (after clamping) on every request tick.
    LaunchedEffect(search?.tick, ranges.size, active) {
        search?.onResult(ranges.size, active)
    }

    // Navigation steps select the hit (the field scrolls to the selection).
    LaunchedEffect(search?.tick, active) {
        if (search != null && active >= 0) {
            val r = ranges[active]
            state.edit { selection = TextRange(r.first, r.last + 1) }
        }
    }

    // Hit backgrounds are a pure OUTPUT transformation: the underlying text
    // (and cursor semantics) never see them.
    val transformation = remember(ranges, active) {
        if (ranges.isEmpty()) {
            OutputTransformation { }
        } else {
            OutputTransformation {
                ranges.forEachIndexed { i, r ->
                    addStyle(if (i == active) HitActive else HitAll, r.first, r.last + 1)
                }
            }
        }
    }

    OutlinedTextField(
        state = state,
        outputTransformation = transformation,
        modifier = modifier.fillMaxWidth(),
        textStyle = TextStyle(
            fontSize = fontSize.sp,
            fontFamily = editorFontFamily(fontName),
        ),
    )
}
