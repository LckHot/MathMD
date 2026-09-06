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

/** Per-WebView render state; survives WebView recreation (settings reload)
 *  so the document queued before page load is not lost. */
private class PreviewState {
    var ready: Boolean = false
    var latestMarkdown: String = ""
    var latestOptions: String = "{}"
    var lastSearchTick: Int = -1
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
    search: PreviewSearchSpec? = null,
    modifier: Modifier = Modifier,
) {
    val state = remember { PreviewState() }
    // Changing key (page-width/font setting) disposes and recreates the
    // WebView so the boot script re-runs with the new value.
    key(reloadKey) {
        AndroidView(
            modifier = modifier.fillMaxWidth(),
            onRelease = { view ->
                // Full teardown: without destroy() the page + JS interface
                // leak on every reload/dispose.
                view.stopLoading()
                view.destroy()
            },
            factory = { ctx ->
                WebView(ctx).apply {
                    tag = state
                    // A fresh page is not ready until onPageFinished says so
                    // (stale true would inject into a half-loaded document).
                    state.ready = false
                    // Transparent so the theme-colored surface shows until first paint.
                    setBackgroundColor(android.graphics.Color.TRANSPARENT)
                    settings.javaScriptEnabled = true
                    settings.cacheMode = WebSettings.LOAD_NO_CACHE
                    settings.allowFileAccess = false
                    settings.allowContentAccess = false
                    settings.blockNetworkLoads = true
                    // Honor the <meta viewport> tag: the boot script locks
                    // the layout viewport to the configured line width and
                    // sets initial/minimum scale so that width exactly fills
                    // the screen (the minimum zoom, no panning); pinch-out
                    // scales the fixed page and reveals global panning.
                    settings.useWideViewPort = true
                    // Pinch-zoom is OFF by default in WebView — the gesture
                    // needs builtInZoomControls; only the +/- widgets are
                    // suppressed. (Owner bug report: pinch did nothing.)
                    settings.builtInZoomControls = true
                    settings.displayZoomControls = false
                    settings.setSupportZoom(true)
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
                                // No browser installed (or no handler) must not
                                // crash the app.
                                try {
                                    ctx.startActivity(Intent(Intent.ACTION_VIEW, url))
                                } catch (_: android.content.ActivityNotFoundException) {
                                    android.widget.Toast.makeText(
                                        ctx, "No app can open this link", android.widget.Toast.LENGTH_SHORT,
                                    ).show()
                                }
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
                // Search request: run when a fresh tick arrives while the
                // page is visible and ready (mode flip re-pushes the doc and
                // bumps the tick, so the highlight follows).
                if (search != null && st.ready && visible && search.tick != st.lastSearchTick) {
                    st.lastSearchTick = search.tick
                    findInPreview(view, search.query, search.index) { t, a -> search.onResult(t, a) }
                }
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
    // Wrapped in a JS try/catch: a missing/late bundle throws, and the
    // callback can then tell success ("ok") from failure (our marker
    // string) — the fail-visible principle applies to the bridge too.
    val js = "try { MathMD.hostUpdate(${JSONObject.quote(markdown)}, $optionsJson); 'ok' } " +
        "catch (e) { 'MATHMD-BRIDGE-ERR: ' + (e && e.message ? e.message : String(e)) }"
    view.evaluateJavascript(js) { result ->
        if (result != null && result.contains("MATHMD-BRIDGE-ERR")) {
            android.util.Log.e("MathMD", "preview bridge failure: $result")
        }
    }
}

/**
 * Run/find in the rendered preview via MathMD.find (CSS Custom Highlight
 * API on the page side). Reports (total, active) back on the UI thread;
 * a bridge failure reports (0, -1) instead of hanging the UI.
 */
internal fun findInPreview(
    view: WebView,
    query: String,
    index: Int,
    onResult: (total: Int, active: Int) -> Unit,
) {
    val expr = "JSON.stringify(MathMD.find(${JSONObject.quote(query)}, $index))"
    view.evaluateJavascript(expr) { result ->
        // evaluateJavascript returns a JSON-quoted string for string results
        val json = result?.removeSurrounding("\"")?.replace("\\\"", "\"")
        try {
            val o = JSONObject(json ?: "{}")
            onResult(o.optInt("total"), o.optInt("active"))
        } catch (_: Exception) {
            android.util.Log.e("MathMD", "find bridge failure: $result")
            onResult(0, -1)
        }
    }
}
