package io.github.lckhot.mathmd

import android.content.Intent
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import org.json.JSONObject

/** Per-WebView state across recompositions. */
private class PreviewState {
    var ready: Boolean = false
    var latestMarkdown: String = ""
    var latestOptions: String = "{}"
}

@Composable
internal fun PreviewPane(
    source: String,
    appDark: Boolean,
    fontSize: Int,
    fontName: String,
    visible: Boolean,
    modifier: Modifier = Modifier,
) {
    val state = remember { PreviewState() }
    AndroidView(
        modifier = modifier.fillMaxWidth(),
        factory = { ctx ->
            WebView(ctx).apply {
                tag = state
                // Transparent so the theme-colored surface shows until first paint.
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
                settings.javaScriptEnabled = true
                settings.cacheMode = WebSettings.LOAD_NO_CACHE
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.blockNetworkLoads = true
                webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView, url: String) {
                        val st = view.tag as PreviewState
                        st.ready = true
                        pushDocument(view, st.latestMarkdown, st.latestOptions)
                    }

                    override fun shouldOverrideUrlLoading(
                        view: WebView,
                        request: WebResourceRequest,
                    ): Boolean {
                        val url = request.url
                        if (url.scheme == "http" || url.scheme == "https") {
                            ctx.startActivity(Intent(Intent.ACTION_VIEW, url))
                        }
                        return true
                    }
                }
                loadUrl("file:///android_asset/preview/preview.html")
            }
        },
        update = { view ->
            val st = view.tag as PreviewState
            val options = previewOptionsJson(appDark, fontSize, fontName)
            st.latestMarkdown = source
            st.latestOptions = options
            if (st.ready && visible) pushDocument(view, source, options)
        },
    )
}

/** CSS font-family for a platform family name (null = bundle default). */
private fun cssFontFamily(name: String): String? = when (name) {
    "default" -> null
    "sans-serif" -> "sans-serif"
    "serif" -> "serif"
    "monospace" -> "monospace"
    "cursive" -> "cursive"
    else -> "'$name', sans-serif"
}

/** JSON options object passed to MathMD.hostUpdate. */
private fun previewOptionsJson(appDark: Boolean, fontSize: Int, fontName: String): String {
    val o = JSONObject()
        .put("theme", if (appDark) "dark" else "light")
        .put("fontSizePx", fontSize)
    cssFontFamily(fontName)?.let { o.put("fontFamily", it) }
    return o.toString()
}

/** Send markdown + options to the page; strings quoted via org.json. */
private fun pushDocument(view: WebView, markdown: String, optionsJson: String) {
    val js = "MathMD.hostUpdate(${JSONObject.quote(markdown)}, $optionsJson)"
    view.evaluateJavascript(js, null)
}
