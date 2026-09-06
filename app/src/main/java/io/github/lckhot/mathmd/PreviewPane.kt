package io.github.lckhot.mathmd

import android.annotation.SuppressLint
import android.content.Intent
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
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

/**
 * Bridge read by preview.html's boot script BEFORE first layout: the fixed
 * line-wrap standard (chars per line, 0 = fill screen) and the preview font
 * family used to convert chars to CSS px. Changes require a page reload
 * (the host bumps `reloadKey`), which re-runs the boot script.
 */
private class PreviewBridge(private val settings: Settings) {
    @JavascriptInterface
    fun getPageWidthChars(): Int = settings.pageWidthCh

    @JavascriptInterface
    fun getPreviewFontFamily(): String =
        // Must match preview.css #preview exactly, or the ch measurement
        // (chars -> CSS px) drifts from the real layout.
        cssFontFamily(settings.previewFont)
            ?: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
internal fun PreviewPane(
    source: String,
    appDark: Boolean,
    fontName: String,
    reloadKey: Any,
    appSettings: Settings,
    visible: Boolean,
    modifier: Modifier = Modifier,
) {
    val state = remember { PreviewState() }
    // Changing key (page-width/font setting) disposes and recreates the
    // WebView so the boot script re-runs with the new value.
    key(reloadKey) {
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
                    // Honor the <meta viewport> tag: the boot script locks the
                    // layout viewport to the configured line width; overview
                    // mode then fits that width to the screen as the default
                    // (minimum) zoom, and pinch scales the fixed page without
                    // re-flow.
                    settings.useWideViewPort = true
                    settings.loadWithOverviewMode = true
                    addJavascriptInterface(PreviewBridge(appSettings), "MathMDNative")
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
                val options = previewOptionsJson(appDark, fontName)
                st.latestMarkdown = source
                st.latestOptions = options
                if (st.ready && visible) pushDocument(view, source, options)
            },
        )
    }
}

/** CSS font-family for a platform family name (null = bundle default). */
internal fun cssFontFamily(name: String): String? = when (name) {
    "default" -> null
    "sans-serif" -> "sans-serif"
    "serif" -> "serif"
    "monospace" -> "monospace"
    "cursive" -> "cursive"
    else -> "'$name', sans-serif"
}

/** JSON options object passed to MathMD.hostUpdate. */
private fun previewOptionsJson(appDark: Boolean, fontName: String): String {
    val o = JSONObject()
        .put("theme", if (appDark) "dark" else "light")
    cssFontFamily(fontName)?.let { o.put("fontFamily", it) }
    return o.toString()
}

/** Send markdown + options to the page; strings quoted via org.json. */
private fun pushDocument(view: WebView, markdown: String, optionsJson: String) {
    val js = "MathMD.hostUpdate(${JSONObject.quote(markdown)}, $optionsJson)"
    view.evaluateJavascript(js, null)
}
