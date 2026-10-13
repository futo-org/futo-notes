package com.futo.notes.ui

import android.util.Log
import com.futo.notes.BuildConfig

/**
 * Debug-only phase ledger for leaving a note: how long each step of the exit
 * takes from the Back press to the first frame of the screen underneath.
 * `docs/perf/mobile-close-baseline.md` reads these lines off logcat.
 *
 * Release builds do nothing: [BuildConfig.DEBUG] is a compile-time constant,
 * so every call folds to an early return. A phase costs one `nanoTime` and one
 * log line in a debug build, far below the frame it describes.
 */
internal object CloseLedger {
    private const val TAG = "FutoClose"

    @Volatile
    private var startedAt = 0L

    @Volatile
    private var listDrawn = true

    /** The exit began (Back received). Restarts the clock. */
    fun begin(noteId: String) {
        if (!BuildConfig.DEBUG) return
        startedAt = System.nanoTime()
        listDrawn = false
        Log.i(TAG, "begin $noteId")
    }

    /** One named phase, at its offset in milliseconds since [begin]. */
    fun mark(phase: String) {
        if (!BuildConfig.DEBUG) return
        val t0 = startedAt
        if (t0 == 0L) return
        Log.i(TAG, "$phase ${"%.1f".format((System.nanoTime() - t0) / 1_000_000.0)}")
    }

    /**
     * The screen underneath painted; the exit is over for the user. Logged once
     * per exit. The clock keeps running: the body and title commits finish
     * after this frame, and their phases are part of the same exit.
     */
    fun end() {
        if (!BuildConfig.DEBUG || listDrawn) return
        listDrawn = true
        mark("listFrame")
    }
}
