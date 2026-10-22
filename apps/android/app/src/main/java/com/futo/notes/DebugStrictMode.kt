package com.futo.notes

import android.os.StrictMode

/**
 * Debug-build main-thread policy. Call from `MainActivity.onCreate` under
 * `BuildConfig.DEBUG` only; release builds keep the platform default.
 */
internal fun installDebugStrictMode() {
    // Regression guard for F12/F13 (never gate render on disk I/O; no
    // blocking FFI on the main thread). StrictMode flags any disk read/write
    // that lands on the main thread on the hot paths — if the note scan or a
    // CRUD FFI call ever slips back onto the UI thread it shows up in logcat
    // (tag "StrictMode").
    // setThreadPolicy REPLACES the platform default (network detection with
    // death-on-network), so debug must restate it: debug may never be weaker
    // than release. 1.9.0 shipped a main-thread CRL fetch in TLS verification
    // that only release crashed on. Network throws; disk stays log-only.
    StrictMode.setThreadPolicy(
        StrictMode.ThreadPolicy.Builder()
            .detectDiskReads()
            .detectDiskWrites()
            .detectNetwork()
            .penaltyLog()
            .penaltyDeathOnNetwork()
            .build()
    )
}
