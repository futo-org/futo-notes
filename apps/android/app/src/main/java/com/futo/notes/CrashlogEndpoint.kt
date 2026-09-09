package com.futo.notes

import android.content.SharedPreferences

object CrashlogEndpoint {
    private const val PRODUCTION_BASE_URL = "https://notes-crashlog.futo.org"
    private const val STAGING_BASE_URL = "https://staging-notes-crashlog.futo.org"
    private const val LOCAL_BASE_URL = "http://10.0.2.2:5100"

    @Volatile private var prefs: SharedPreferences? = null

    fun attach(prefs: SharedPreferences) {
        this.prefs = prefs
    }

    fun devBaseUrl(useStaging: Boolean): String =
        if (useStaging) STAGING_BASE_URL else LOCAL_BASE_URL

    val baseUrl: String
        get() {
            if (!BuildConfig.DEBUG) return PRODUCTION_BASE_URL
            return devBaseUrl(prefs?.getBoolean(Prefs.CRASHLOG_STAGING, false) == true)
        }
}
