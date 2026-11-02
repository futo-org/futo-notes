package com.futo.notes

import android.content.SharedPreferences
import com.futo.notes.storage.NotesStorage

object CrashlogEndpoint {
    private const val PRODUCTION_BASE_URL = "https://notes-crashlog.futo.org"
    private const val STAGING_BASE_URL = "https://staging-notes-crashlog.futo.org"
    private val localBaseUrl = "http://10.0.2.2:${BuildConfig.DEV_CRASHLOG_PORT}"

    @Volatile private var prefs: SharedPreferences? = null

    fun attach(prefs: SharedPreferences) {
        this.prefs = prefs
    }

    fun devBaseUrl(useStaging: Boolean): String =
        if (useStaging) STAGING_BASE_URL else localBaseUrl

    /** Dev installs (`.dev`, incl. the non-debuggable `.perf.dev`) never reach
     *  production; only the DEBUG-gated puppet verb/UI can flip [useStaging]. */
    fun baseUrlFor(isDevBuild: Boolean, useStaging: Boolean): String =
        if (isDevBuild) devBaseUrl(useStaging) else PRODUCTION_BASE_URL

    val baseUrl: String
        get() = baseUrlFor(
            NotesStorage.isDevBuild,
            prefs?.getBoolean(Prefs.CRASHLOG_STAGING, false) == true,
        )
}
