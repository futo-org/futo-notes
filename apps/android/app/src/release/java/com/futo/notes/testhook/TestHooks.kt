package com.futo.notes.testhook

import android.content.Intent
import androidx.activity.ComponentActivity

/**
 * Release builds get no automation surface at all.
 *
 * The working implementation lives in the `debug` source set. Keeping both at the
 * same fully-qualified name lets MainActivity call `install` unconditionally while
 * a release build is compiled without a line of it — a stronger guarantee than a
 * `BuildConfig.DEBUG` branch, which would leave a shell-reachable way to move the
 * user's notes in the source and rely on R8 folding the constant to drop it.
 *
 * These signatures must match the debug ones; a mismatch fails the release
 * compile, which is exactly when it should be noticed.
 */
object TestHooks {
    fun install(activity: ComponentActivity, hooks: Map<String, (Intent) -> Map<String, Any?>?>) =
        Unit

    fun uninstall(activity: ComponentActivity) = Unit
}
