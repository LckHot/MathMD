package io.github.lckhot.mathmd

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.input.OutputTransformation
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.sp
import android.graphics.Typeface
import kotlin.math.roundToInt

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
    search: SearchSpec? = null,
    onText: (String) -> Unit,
) {
    val state = remember { TextFieldState(text) }

    // Echo-guarded external sync (blind-audit MEDIUM): writing the
    // TextFieldState DURING composition is an anti-pattern that can swallow
    // a keystroke / IME composition in flight (a recomposition landing
    // between the edit and the snapshotFlow echo would replace the buffer
    // with the stale parent value). Our own keystrokes travel
    // state -> snapshotFlow -> parent -> back here, so only a text that did
    // NOT come from this field (open/reload) may replace the buffer.
    var lastEmitted by remember { mutableStateOf(text) }
    // The buffer as a plain String, updated only when the field's text flow
    // emits; the search scan below keys its memoization on this. Reading
    // state.text.toString() directly in composition instead re-copied the
    // whole buffer on every unrelated recomposition (search tick, mode
    // flip, menu open) — the same pattern the lowercase copy below avoids.
    var currentText by remember { mutableStateOf(text) }
    LaunchedEffect(state) {
        snapshotFlow { state.text.toString() }.collect {
            lastEmitted = it
            currentText = it
            onText(it)
        }
    }
    LaunchedEffect(text) {
        if (text != lastEmitted && text != state.text.toString()) {
            state.edit { replace(0, length, text) }
        }
    }

    // Match scan memoized on (text, query): the old per-recomposition scan
    // rebuilt the lowercase copy and the Range list on EVERY frame and made
    // remember(ranges, active) below useless — the same cache the preview
    // side built for its find index. Content-equal String keys, so edits
    // and query changes still recompute exactly once.
    val query = search?.query.orEmpty()
    val ranges = remember(currentText, query) { matchRanges(currentText, query) }
    val active = if (search == null || ranges.isEmpty()) -1
    else search.index.coerceIn(0, ranges.lastIndex)

    // Report total/active (after clamping) on every request tick.
    LaunchedEffect(search?.tick, ranges.size, active) {
        search?.onResult(ranges.size, active)
    }

    val scrollState = rememberScrollState()
    var textLayout by remember { mutableStateOf<TextLayoutResult?>(null) }

    // Navigation selects the hit AND scrolls it into view. The field only
    // auto-scrolls to the selection while FOCUSED — during a search focus
    // lives in the search bar — so drive the ScrollState from the layout
    // geometry ourselves (getBoundingBox uses layout coordinates, which the
    // internal scroll offsets 1:1 apart from the small top content padding).
    LaunchedEffect(search?.tick, active) {
        if (search == null || active < 0) return@LaunchedEffect
        val r = ranges[active]
        state.edit { selection = TextRange(r.first, r.last + 1) }
        val layout = textLayout ?: return@LaunchedEffect
        val viewport = scrollState.viewportSize
        if (viewport <= 0) return@LaunchedEffect
        val box = layout.getBoundingBox(r.first)
        val visibleTop = scrollState.value.toFloat()
        val visibleBottom = visibleTop + viewport
        if (box.top < visibleTop + 8f || box.bottom > visibleBottom - 8f) {
            val target = (box.top - viewport * 0.25f).roundToInt()
                .coerceIn(0, scrollState.maxValue)
            scrollState.animateScrollTo(target)
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
        onTextLayout = { getResult -> textLayout = getResult() },
        scrollState = scrollState,
        modifier = modifier.fillMaxWidth(),
        textStyle = TextStyle(
            fontSize = fontSize.sp,
            fontFamily = editorFontFamily(fontName),
        ),
    )
}
