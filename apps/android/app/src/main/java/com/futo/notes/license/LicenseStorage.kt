package com.futo.notes.license

import android.content.SharedPreferences
import com.futo.notes.Prefs
import uniffi.futo_notes_ffi.LicensePair

/**
 * Where the two plain strings of a license live on Android.
 *
 * `SharedPreferences`, not the vault (it would sync and surface as a note) and
 * not the Keystore (a license is a receipt, not a secret) —
 * docs/spec/license.md § Storage. The prefs file is app-private and the debug
 * build has its own package (`com.futo.notes.dev`), so the dev/prod split (M3)
 * is the Android sandbox itself: a dev build cannot see the release app's
 * license, or the other way round.
 *
 * This type stores and returns both strings **verbatim**. base64url is
 * case-sensitive and the activation is signed bytes, so anything that "tidies"
 * it on the way through stops the license verifying. Mirrors iOS
 * `LicenseStorage.swift`.
 */
class LicenseStorage(private val preferences: SharedPreferences) {
    /**
     * Both strings, or nothing at all. A half-written pair can never verify, so
     * it reads as "no license" rather than as a pair that fails an RSA check on
     * every launch.
     */
    fun read(): LicensePair? {
        val key = preferences.getString(Prefs.LICENSE_KEY, null)?.takeIf { it.isNotBlank() }
        val activation =
            preferences.getString(Prefs.LICENSE_ACTIVATION, null)?.takeIf { it.isNotBlank() }
        if (key == null || activation == null) return null
        return LicensePair(key = key, activation = activation)
    }

    fun write(pair: LicensePair) {
        preferences.edit()
            .putString(Prefs.LICENSE_KEY, pair.key)
            .putString(Prefs.LICENSE_ACTIVATION, pair.activation)
            .apply()
    }

    /**
     * Removing a license that was never stored is the state the user asked for,
     * not a failure — so this is idempotent. Full reset calls it too.
     */
    fun clear() {
        preferences.edit()
            .remove(Prefs.LICENSE_KEY)
            .remove(Prefs.LICENSE_ACTIVATION)
            .apply()
    }
}
