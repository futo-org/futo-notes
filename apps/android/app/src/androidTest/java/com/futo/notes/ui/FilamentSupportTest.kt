package com.futo.notes.ui

import android.content.Context
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The coin gives up on Filament after two renders that never came back.
 *
 * This is the only fallback available for a renderer that aborts the process
 * rather than failing: there is nothing to catch, so the coin writes down that
 * it is about to start and reads that note back on the next launch. What the
 * test is really holding is the SHAPE of that promise — one unfinished attempt
 * is forgiven, because a user swiping the app away mid-render looks exactly
 * like a driver killing it, and losing the coin over that would be a worse bug
 * than the one being avoided.
 */
@RunWith(AndroidJUnit4::class)
class FilamentSupportTest {
    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val preferences =
        context.getSharedPreferences("coin-render", Context.MODE_PRIVATE)

    @Before
    @After
    fun forgetAttempts() {
        preferences.edit().clear().commit()
    }

    @Test
    fun oneRenderThatNeverReturnedIsForgiven() {
        FilamentSupport.beginRenderAttempt(context)

        assertTrue("one unfinished attempt should not cost the coin", FilamentSupport.attemptsLookSafe(context))
    }

    @Test
    fun twoRendersThatNeverReturnedRetireTheCoin() {
        FilamentSupport.beginRenderAttempt(context)
        FilamentSupport.beginRenderAttempt(context)

        assertFalse(
            "a device that killed two renders should be left on the flat coin",
            FilamentSupport.attemptsLookSafe(context),
        )
    }

    @Test
    fun aNewBuildIsAFreshChance() {
        FilamentSupport.beginRenderAttempt(context)
        FilamentSupport.beginRenderAttempt(context)
        assertFalse(FilamentSupport.attemptsLookSafe(context))

        // What an upgrade looks like from here: the record was written by some
        // other build. Without this the coin could never come back, and two
        // renders killed by a user swiping the app away would retire it for
        // good.
        preferences.edit().putInt("recorded_for_version", -1).commit()

        assertTrue(
            "a version the record was not written for should start clean",
            FilamentSupport.attemptsLookSafe(context),
        )
    }

    @Test
    fun aFrameThatCameBackClearsTheSlate() {
        FilamentSupport.beginRenderAttempt(context)
        FilamentSupport.renderSucceeded(context)
        FilamentSupport.beginRenderAttempt(context)
        FilamentSupport.renderSucceeded(context)
        FilamentSupport.beginRenderAttempt(context)

        assertTrue(
            "attempts that finished should not accumulate against the device",
            FilamentSupport.attemptsLookSafe(context),
        )
    }
}
