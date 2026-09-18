package com.futo.notes.ui

import android.app.ActivityManager
import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.core.content.getSystemService
import com.futo.notes.BuildConfig
import com.futo.notes.license.LICENSE_LOG_TAG

/**
 * Whether the supporter coin's 3D renderer is safe to start on this device.
 *
 * Filament does not degrade when a material fails to compile or link: it calls
 * `abort()`. There is no exception to catch and no return value to check, so
 * one bad driver turns a decoration into an app that dies the moment a licensed
 * user opens Settings — which is exactly what the CI emulator's SwiftShader did
 * (`Compilation error in fragment shader "fxaa"`, then `Fatal signal 6
 * (SIGABRT) in FEngine::loop`).
 *
 * Two guards, because one of them can only be right about drivers we have met:
 *
 * 1. **ES 3.1.** The driver that aborted reports OpenGL ES 3.0; the software
 *    driver that runs Filament happily reports 3.1. Filament calls ES 3.0 its
 *    feature level 1, the lowest tier it supports and the least travelled. A
 *    phone that still reports 3.0 in 2026 is a phone whose GL cannot carry a
 *    real-time PBR renderer anyway — every device this app supports (minSdk 28,
 *    2018) reports 3.1 or better.
 * 2. **The last attempt finished.** Guard 1 is a proxy and will not have heard
 *    of the next driver to fall over, so the coin also records that it is about
 *    to start Filament and clears that the moment a frame comes back. A launch
 *    that finds the record still standing is a launch after a render that never
 *    returned. Twice in a row and the coin stays flat for good on this device —
 *    twice, so that a user swiping the app away mid-render, or Android
 *    reclaiming it, cannot cost them the coin. The count is scoped to the
 *    build that made it, so a new version is always a fresh chance.
 *
 * Neither guard is a shader probe. Filament's post-process shaders were dug out
 * of `libfilament-jni.so` to write one, and the construct SwiftShader rejects —
 * a struct constructor with a field selected straight off it,
 * `output_color = PostProcessInputs(fxaa(...)).color` — takes the whole
 * emulator process down when compiled on its own. A probe that can kill the
 * GPU process is worse than the crash it is trying to avoid.
 */
internal object FilamentSupport {
    /// `ActivityManager.DeviceConfigurationInfo.reqGlEsVersion` packs the major
    /// version in the high 16 bits and the minor in the low 16, so ES 3.1 is
    /// 0x00030001.
    private const val REQUIRED_GL_ES_VERSION = 0x0003_0001

    private const val PREFERENCES = "coin-render"
    private const val UNFINISHED_ATTEMPTS = "unfinished_attempts"
    private const val RECORDED_FOR_VERSION = "recorded_for_version"

    /// One unfinished attempt is a coincidence — a kill, a swipe away. Two is
    /// this device.
    private const val ATTEMPTS_BEFORE_GIVING_UP = 2

    /** True when the coin's 3D renderer is safe to start here. */
    fun canRender(context: Context): Boolean = glIsNewEnough(context) && attemptsLookSafe(context)

    /** Guard 1: the driver reports at least ES 3.1. */
    fun glIsNewEnough(context: Context): Boolean {
        val reported = context.getSystemService<ActivityManager>()
            ?.deviceConfigurationInfo
            ?.reqGlEsVersion
            ?: 0
        if (reported < REQUIRED_GL_ES_VERSION) {
            Log.i(
                LICENSE_LOG_TAG,
                "GL ES ${reported shr 16}.${reported and 0xFFFF} is below 3.1 — flat coin",
            )
            return false
        }
        return true
    }

    /**
     * Guard 2: the last renders this device started came back.
     *
     * Separate from [glIsNewEnough] because it is the half that has to hold on
     * a device the first guard has never heard of, and because a test can only
     * exercise it on the device it is running on — which may well be one the
     * first guard turns away (the CI emulator is).
     */
    fun attemptsLookSafe(context: Context): Boolean {
        val unfinished = preferences(context).getInt(UNFINISHED_ATTEMPTS, 0)
        if (unfinished >= ATTEMPTS_BEFORE_GIVING_UP) {
            Log.i(LICENSE_LOG_TAG, "$unfinished coin renders never returned here — flat coin")
            return false
        }
        return true
    }

    /**
     * Records that Filament is about to be handed a surface.
     *
     * `commit()`, not `apply()`: the write has to be on disk before the driver
     * gets a chance to abort the process, and `apply()` is free to still be
     * queued when it does.
     */
    fun beginRenderAttempt(context: Context) {
        val preferences = preferences(context)
        val unfinished = preferences.getInt(UNFINISHED_ATTEMPTS, 0)
        preferences.edit().putInt(UNFINISHED_ATTEMPTS, unfinished + 1).commit()
    }

    /** Records that a frame came back, so the attempt above did not kill us. */
    fun renderSucceeded(context: Context) {
        val preferences = preferences(context)
        if (preferences.getInt(UNFINISHED_ATTEMPTS, 0) == 0) return
        preferences.edit().putInt(UNFINISHED_ATTEMPTS, 0).apply()
    }

    /**
     * The record, scoped to this build.
     *
     * Retiring the coin has to be recoverable, and the counter alone never
     * recovers: once it is up, nothing tries again, so nothing can ever put it
     * back down. Two renders that died because the user swiped the app away at
     * the wrong moment would cost them the coin permanently. A new version is a
     * new chance — the renderer, Filament or the guard itself may be the thing
     * that changed — so the count belongs to the build that made it.
     */
    private fun preferences(context: Context): SharedPreferences {
        val preferences =
            context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        if (preferences.getInt(RECORDED_FOR_VERSION, 0) != BuildConfig.VERSION_CODE) {
            preferences.edit()
                .putInt(RECORDED_FOR_VERSION, BuildConfig.VERSION_CODE)
                .putInt(UNFINISHED_ATTEMPTS, 0)
                .commit()
        }
        return preferences
    }
}
