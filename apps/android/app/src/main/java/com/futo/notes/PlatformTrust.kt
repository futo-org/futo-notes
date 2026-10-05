package com.futo.notes

import android.content.Context
import android.util.Log

object PlatformTrust {
    @Volatile
    var isBound: Boolean = false
        private set

    @JvmStatic
    private external fun initialize(context: Context): Boolean

    fun install(context: Context) {
        isBound = runCatching {
            System.loadLibrary("futo_notes_ffi")
            initialize(context.applicationContext)
        }.getOrElse { error ->
            Log.e("PlatformTrust", "could not bind the TLS verifier to the Android runtime", error)
            false
        }
    }
}
