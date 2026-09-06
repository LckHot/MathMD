package io.github.lckhot.mathmd

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Search bar under the top bar (both modes). The owning screen routes the
 * query to whichever pane is visible; `result` is (total, activeIndex) as
 * reported by that pane.
 */
@Composable
internal fun SearchBar(
    query: String,
    result: Pair<Int, Int>?,
    onQuery: (String) -> Unit,
    onStep: (Int) -> Unit, // -1 previous, +1 next
    onClose: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OutlinedTextField(
            value = query,
            onValueChange = onQuery,
            singleLine = true,
            placeholder = { Text("Search…", fontSize = 14.sp) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
            textStyle = TextStyle(fontSize = 14.sp),
            modifier = Modifier.weight(1f),
        )
        Text(
            text = when {
                query.isEmpty() -> ""
                result == null || result.first == 0 -> "no match"
                else -> "${result.second + 1}/${result.first}"
            },
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 8.dp),
        )
        TextButton(onClick = { onStep(-1) }) { Text("▲") }
        TextButton(onClick = { onStep(1) }) { Text("▼") }
        IconButton(onClick = onClose) {
            Icon(Icons.Filled.Close, contentDescription = "Close search")
        }
    }
}
