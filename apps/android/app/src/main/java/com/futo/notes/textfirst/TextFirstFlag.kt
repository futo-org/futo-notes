package com.futo.notes.textfirst

import android.content.Context
import android.content.Intent
import com.futo.notes.storage.NotesStorage

/**
 * Which editor a note opens in. Dev builds (the `.dev` app ids, debuggable or
 * not) open the text-first editor by default; release builds never do. Not
 * BuildConfig.DEBUG: a `-PfutoDebuggable=false` dev build has DEBUG false. Launch with
 * `adb shell am start -n com.futo.notes.dev/com.futo.notes.MainActivity --ez futo.textFirstEditor false`
 * to go back to the WebView editor (remembered until set again).
 */
object TextFirstFlag {
    private const val PREFS = "text_first_editor"
    private const val KEY = "enabled"
    const val EXTRA = "futo.textFirstEditor"

    fun enabled(context: Context): Boolean =
        NotesStorage.isDevBuild && context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY, true)

    /** Persist the launch intent's choice, if it carries one. */
    fun readIntent(context: Context, intent: Intent?) {
        if (!NotesStorage.isDevBuild || intent == null || !intent.hasExtra(EXTRA)) return
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY, intent.getBooleanExtra(EXTRA, true)).apply()
    }
}
