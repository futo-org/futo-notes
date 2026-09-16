package com.futo.notes.testhook

import android.content.Intent
import android.system.Os
import android.util.Log

/**
 * Points a debug build's hosted sync at a local server.
 *
 * The engine already has this override — `futo_notes_sync::hosted_server()`
 * honours `FUTO_HOSTED_SERVER` in a debug build and a release build ignores it
 * entirely — but an Android app inherits no environment from the shell that
 * launched it, so there was no way to reach it. This carries the value across:
 *
 * ```
 * adb shell am start -n com.futo.notes.dev/com.futo.notes.MainActivity \
 *   --es futo_hosted_server http://10.0.2.2:3108
 * ```
 *
 * The `.so` must be built with `debug_assertions` on for the engine to read it
 * (`FUTO_ANDROID_FFI_PROFILE=dev just build-rust-android`); the shipped
 * `release-ffi` build compiles the override out, so setting the variable there
 * does nothing.
 *
 * Debug source set only. The release sibling at the same name is a no-op, so a
 * release APK carries none of this.
 */
object DebugHostedServer {
    fun applyOverride(intent: Intent?) {
        val url = intent?.getStringExtra(EXTRA)?.trim().orEmpty()
        if (url.isEmpty()) return
        runCatching { Os.setenv("FUTO_HOSTED_SERVER", url, true) }
            .onSuccess { Log.i("FutoStartup", "hosted sync pointed at $url (debug override)") }
            .onFailure { Log.e("FutoStartup", "could not set FUTO_HOSTED_SERVER", it) }
    }

    private const val EXTRA = "futo_hosted_server"
}
