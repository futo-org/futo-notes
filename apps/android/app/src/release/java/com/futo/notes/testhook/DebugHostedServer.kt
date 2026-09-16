package com.futo.notes.testhook

import android.content.Intent

/**
 * A release build's hosted sync always talks to the baked address.
 *
 * The working implementation lives in the `debug` source set. Keeping both at
 * the same fully-qualified name lets MainActivity call `applyOverride`
 * unconditionally while a release build is compiled without a line of it — the
 * same guarantee [TestHooks] gets, and for the same reason.
 *
 * These signatures must match the debug ones; a mismatch fails the release
 * compile, which is exactly when it should be noticed.
 */
object DebugHostedServer {
    fun applyOverride(intent: Intent?) = Unit
}
