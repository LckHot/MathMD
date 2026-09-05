package io.github.lckhot.mathmd

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * Official Material "visibility" glyph (Apache-2.0; path data verbatim from
 * google/material-design-icons classic 24px filled visibility_24px.svg),
 * converted command-by-command to the ImageVector DSL. Single path +
 * even-odd fill: lens outline (filled band) + pupil ring (r5 with r3 hole).
 */
internal val PreviewEyeIcon: ImageVector = ImageVector.Builder(
    name = "PreviewEye",
    defaultWidth = 24.dp,
    defaultHeight = 24.dp,
    viewportWidth = 24f,
    viewportHeight = 24f,
).apply {
    path(
        fill = SolidColor(Color.Black),
        pathFillType = PathFillType.EvenOdd,
    ) {
        // M12 4.5 C7 4.5 2.73 7.61 1 12
        moveTo(12f, 4.5f)
        curveTo(7f, 4.5f, 2.73f, 7.61f, 1f, 12f)
        // c 1.73 4.39 6 7.5 11 7.5
        curveToRelative(1.73f, 4.39f, 6f, 7.5f, 11f, 7.5f)
        // s 9.27 -3.11 11 -7.5  (reflected control: (17,19.5))
        curveTo(17f, 19.5f, 21.27f, 16.39f, 23f, 12f)
        // c -1.73 -4.39 -6 -7.5 -11 -7.5
        curveToRelative(-1.73f, -4.39f, -6f, -7.5f, -11f, -7.5f)
        close()
        // pupil outer ring: M12 17 c-2.76 0 -5 -2.24 -5 -5 s2.24 -5 5 -5 s5 2.24 5 5 s-2.24 5 -5 5 z
        moveTo(12f, 17f)
        curveToRelative(-2.76f, 0f, -5f, -2.24f, -5f, -5f)
        curveTo(7f, 9.24f, 9.24f, 7f, 12f, 7f)
        curveTo(14.76f, 7f, 17f, 9.24f, 17f, 12f)
        curveTo(17f, 14.76f, 14.76f, 17f, 12f, 17f)
        close()
        // pupil hole: m0 -8 c-1.66 0 -3 1.34 -3 3 s1.34 3 3 3 s3 -1.34 3 -3 s-1.34 -3 -3 -3 z
        moveTo(12f, 9f)
        curveToRelative(-1.66f, 0f, -3f, 1.34f, -3f, 3f)
        curveTo(9f, 13.66f, 10.34f, 15f, 12f, 15f)
        curveTo(13.66f, 15f, 15f, 13.66f, 15f, 12f)
        curveTo(15f, 10.34f, 13.66f, 9f, 12f, 9f)
        close()
    }
}.build()
