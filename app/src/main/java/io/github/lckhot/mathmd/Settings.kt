package io.github.lckhot.mathmd

import android.content.Context

/** Persisted user settings (theme, editor font size/family, preview font family, startup mode). */
internal class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var theme: String
        get() = prefs.getString("theme", "system") ?: "system"
        set(v) = prefs.edit().putString("theme", v).apply()

    var editorFontSize: Int
        get() = prefs.getInt("editorFontSize", 16)
        set(v) = prefs.edit().putInt("editorFontSize", v).apply()

    var editorFont: String
        get() = prefs.getString("editorFont", "default") ?: "default"
        set(v) = prefs.edit().putString("editorFont", v).apply()

    var previewFont: String
        get() = prefs.getString("previewFont", "default") ?: "default"
        set(v) = prefs.edit().putString("previewFont", v).apply()

    /** Fixed content column width in `ch` units; 0 = fill the viewport. */
    var pageWidthCh: Int
        get() = prefs.getInt("pageWidthCh", 0)
        set(v) = prefs.edit().putInt("pageWidthCh", v).apply()

    /** Mode shown at launch: "edit" or "preview". */
    var startupMode: String
        get() = prefs.getString("startupMode", "edit") ?: "edit"
        set(v) = prefs.edit().putString("startupMode", v).apply()

    // TSV-table compatibility: ChatGPT-style tab-separated blocks render as
    // real tables. Threshold ranges are clamped in the SettingsDialog; the
    // values travel to the WebView per render via previewOptionsJson.

    var tsvTables: Boolean
        get() = prefs.getBoolean("tsvTables", true)
        set(v) = prefs.edit().putBoolean("tsvTables", v).apply()

    /** Minimum consecutive TSV lines that form a table (dialog clamps 2..20). */
    var tsvMinRows: Int
        get() = prefs.getInt("tsvMinRows", 3)
        set(v) = prefs.edit().putInt("tsvMinRows", v).apply()

    /** Minimum tab-separated cells per line (dialog clamps 2..10). */
    var tsvMinCols: Int
        get() = prefs.getInt("tsvMinCols", 2)
        set(v) = prefs.edit().putInt("tsvMinCols", v).apply()
}
