package com.futo.notes.textfirst

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.futo.notes.BuildConfig

/**
 * Debug builds: when the main thread stops answering for [thresholdMs], log
 * its stack under `TextFirstWatchdog`. A phone without root cannot dump a
 * hung app's threads any other way.
 */
internal object MainThreadWatchdog {
    @Volatile private var started = false

    fun start(thresholdMs: Long = 700) {
        if (!BuildConfig.DEBUG || started) return
        started = true
        val main = Handler(Looper.getMainLooper())
        Thread({
            while (true) {
                val answered = java.util.concurrent.atomic.AtomicBoolean(false)
                main.post { answered.set(true) }
                Thread.sleep(thresholdMs)
                if (!answered.get()) {
                    val stack = Looper.getMainLooper().thread.stackTrace.joinToString("\n  at ")
                    Log.w("TextFirstWatchdog", "main thread blocked > ${thresholdMs}ms:\n  at $stack")
                    while (!answered.get()) Thread.sleep(50)
                }
            }
        }, "futo-main-watchdog").apply { isDaemon = true; start() }
    }
}
