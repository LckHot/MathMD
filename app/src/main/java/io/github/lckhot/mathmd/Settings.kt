package io.github.lckhot.mathmd

import android.content.Context

/** Persisted user settings (theme, per-pane font size/family, startup mode). */
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

    var previewFontSize: Int
        get() = prefs.getInt("previewFontSize", 16)
        set(v) = prefs.edit().putInt("previewFontSize", v).apply()

    var previewFont: String
        get() = prefs.getString("previewFont", "default") ?: "default"
        set(v) = prefs.edit().putString("previewFont", v).apply()

    /** Mode shown at launch: "edit" or "preview". */
    var startupMode: String
        get() = prefs.getString("startupMode", "edit") ?: "edit"
        set(v) = prefs.edit().putString("startupMode", v).apply()
}
