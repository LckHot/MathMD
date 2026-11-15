package io.github.lckhot.mathmd

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Search contract handed to EITHER pane (merged from the former identical
 * EditorSearchSpec/PreviewSearchSpec pair — two copies of one contract
 * invite silent drift). [tick] bumps on every (re)run-request (query
 * change, step, mode flip); the pane recomputes matches from its own text
 * and reports back via [onResult].
 *
 * SEMANTIC CONTRACT — the panes share the cursor/count but search
 * DIFFERENT texts:
 *  - Editor: matches the markdown SOURCE (raw TeX included; phrases match
 *    across inline formatting since the source is flat).
 *  - Preview: matches RENDERED text, one DOM Text node at a time — a
 *    phrase spanning <em>/<strong>/formula boundaries never matches, and
 *    `.katex-mathml` is excluded (it invisibly duplicates formula text).
 *  Totals can therefore legitimately differ between modes for the same
 *  query. An out-of-range [index] is CLAMPED by both panes (never wraps).
 */
internal class SearchSpec(
    val query: String,
    val index: Int,
    val tick: Int,
    val onResult: (total: Int, active: Int) -> Unit,
)

/** Minimum width reserved for the query pill before the bar wraps. */
private val MinQueryWidth = 144.dp

/** Icon-button touch target (never shrunk to force a single line). */
private val TouchTarget = 48.dp

/** Floor for the independent result-count slot so it does not jitter. */
private val MinCountWidth = 56.dp

/**
 * Compact search bar under the top bar (both modes). The owning screen
 * routes the query to whichever pane is visible; `result` is
 * (total, activeIndex) as reported by that pane.
 *
 * Layout: a filled pill query field (embedded Clear when non-empty), an
 * independent fixed-min-width result count, and Previous / Next / Close
 * icon buttons at full 48dp touch targets. Normally a single line; when
 * the available width cannot fit `MinQueryWidth + count + 3*48dp + gaps`
 * it wraps to two lines (query+Close, then count+Previous+Next) rather
 * than shrinking the font or the touch targets. Space restored -> single
 * line again. SearchSpec / MainActivity behavior is unchanged.
 */
@Composable
internal fun SearchBar(
    query: String,
    result: Pair<Int, Int>?,
    onQuery: (String) -> Unit,
    onStep: (Int) -> Unit, // -1 previous, +1 next
    onClose: () -> Unit,
) {
    val countText = when {
        query.isEmpty() -> ""
        result == null || result.first == 0 -> "no match"
        else -> "${result.second + 1}/${result.first}"
    }
    val countStyle = TextStyle(
        fontSize = 12.sp,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    val measurer = rememberTextMeasurer()

    BoxWithConstraints(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 4.dp),
    ) {
        // Measured count width (font-scale aware), floored so short counts
        // keep a stable slot. maxWidth here already excludes the padding.
        val countWidthPx = measurer.measure(countText, countStyle).size.width
        val countWidth = with(LocalDensity.current) { countWidthPx.toDp() }
        val countSlot = maxOf(countWidth, MinCountWidth)
        // 5 single-line children -> 4 gaps of 4dp.
        val requiredWidth = MinQueryWidth + countSlot + TouchTarget * 3 + 4.dp * 4
        val twoLines = maxWidth < requiredWidth

        if (!twoLines) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                QueryPill(
                    query = query,
                    onQuery = onQuery,
                    onNext = { onStep(1) },
                    onEscape = onClose,
                    modifier = Modifier.weight(1f).widthIn(min = MinQueryWidth),
                )
                CountLabel(countText, countStyle, Modifier.width(countSlot))
                IconButton(onClick = { onStep(-1) }) {
                    Icon(Icons.Filled.KeyboardArrowUp, contentDescription = "Previous match")
                }
                IconButton(onClick = { onStep(1) }) {
                    Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "Next match")
                }
                IconButton(onClick = onClose) {
                    Icon(Icons.Filled.Close, contentDescription = "Close search")
                }
            }
        } else {
            Column(modifier = Modifier.fillMaxWidth()) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    QueryPill(
                        query = query,
                        onQuery = onQuery,
                        onNext = { onStep(1) },
                        onEscape = onClose,
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(onClick = onClose) {
                        Icon(Icons.Filled.Close, contentDescription = "Close search")
                    }
                }
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CountLabel(countText, countStyle, Modifier.width(countSlot))
                    Spacer(modifier = Modifier.weight(1f))
                    IconButton(onClick = { onStep(-1) }) {
                        Icon(Icons.Filled.KeyboardArrowUp, contentDescription = "Previous match")
                    }
                    IconButton(onClick = { onStep(1) }) {
                        Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "Next match")
                    }
                }
            }
        }
    }
}

@Composable
private fun CountLabel(text: String, style: TextStyle, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = style,
        textAlign = TextAlign.Center,
        maxLines = 1,
        modifier = modifier,
    )
}

/**
 * Filled pill query field. The leading search glyph is decorative; Clear
 * appears inside the pill only when the query is non-empty. IME action is
 * Search and Enter/IME-search steps to the next match; a hardware Escape
 * closes the bar. The pill is at least [TouchTarget] tall and grows with
 * font scale so text is never clipped; the embedded Clear button keeps its
 * own 48dp target.
 */
@Composable
private fun QueryPill(
    query: String,
    onQuery: (String) -> Unit,
    onNext: () -> Unit,
    onEscape: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(24.dp)
    val background = MaterialTheme.colorScheme.surfaceContainerHighest
    val onSurface = MaterialTheme.colorScheme.onSurface
    val onVariant = MaterialTheme.colorScheme.onSurfaceVariant
    BasicTextField(
        value = query,
        onValueChange = onQuery,
        modifier = modifier
            .heightIn(min = TouchTarget)
            .onPreviewKeyEvent { event ->
                if (event.type == KeyEventType.KeyDown && event.key == Key.Escape) {
                    onEscape()
                    true
                } else {
                    false
                }
            },
        singleLine = true,
        textStyle = TextStyle(fontSize = 14.sp, color = onSurface),
        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
        keyboardOptions = KeyboardOptions(
            keyboardType = KeyboardType.Text,
            imeAction = ImeAction.Search,
        ),
        keyboardActions = KeyboardActions(onSearch = { onNext() }),
        decorationBox = { innerTextField ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = TouchTarget)
                    .background(background, shape)
                    .padding(start = 12.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Filled.Search,
                    contentDescription = null,
                    tint = onVariant,
                    modifier = Modifier.size(20.dp),
                )
                Spacer(modifier = Modifier.width(8.dp))
                Box(
                    modifier = Modifier.weight(1f),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    if (query.isEmpty()) {
                        Text("Search…", fontSize = 14.sp, color = onVariant)
                    }
                    innerTextField()
                }
                if (query.isNotEmpty()) {
                    IconButton(
                        onClick = { onQuery("") },
                        modifier = Modifier.size(TouchTarget),
                    ) {
                        Icon(
                            Icons.Filled.Clear,
                            contentDescription = "Clear search",
                            tint = onVariant,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
            }
        },
    )
}
