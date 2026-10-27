package com.futo.notes.puppet

import android.content.SharedPreferences
import androidx.compose.runtime.Composable
import com.futo.notes.NotesStore
import com.futo.notes.SyncManager
import com.futo.notes.ui.navigation.AppNavigator

/**
 * Release builds get no puppet listener at all.
 *
 * The working implementation lives in the `debug` source set. Keeping both at
 * the same fully-qualified name lets the shell call this unconditionally while a
 * release build is compiled without a line of it — a stronger guarantee than a
 * `BuildConfig.DEBUG` branch, which would leave a socket that can move the
 * user's notes in the source and rely on R8 folding the constant to drop it.
 * This is the same split `com.futo.notes.testhook.TestHooks` uses.
 *
 * The signature must match the debug one; a mismatch fails the release compile,
 * which is exactly when it should be noticed.
 */
@Composable
@Suppress("UNUSED_PARAMETER")
internal fun PuppetServerStart(
    navigator: AppNavigator,
    store: NotesStore,
    sync: SyncManager,
    prefs: SharedPreferences,
) = Unit
