package io.github.lckhot.mathmd

import android.graphics.Typeface
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.sp

private fun editorFontFamily(name: String): FontFamily = when (name) {
    "default" -> FontFamily.Default
    else -> FontFamily(Typeface.create(name, Typeface.NORMAL))
}

@Composable
internal fun EditorPane(
    text: String,
    fontSize: Int,
    fontName: String,
    modifier: Modifier = Modifier,
    onText: (String) -> Unit,
) {
    OutlinedTextField(
        value = text,
        onValueChange = onText,
        modifier = modifier.fillMaxWidth(),
        textStyle = TextStyle(
            fontSize = fontSize.sp,
            fontFamily = editorFontFamily(fontName),
        ),
    )
}
