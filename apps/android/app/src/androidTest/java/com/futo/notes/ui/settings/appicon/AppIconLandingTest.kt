package com.futo.notes.ui.settings.appicon

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.MainActivity
import com.futo.notes.Prefs
import com.futo.notes.license.LicenseFixture
import com.futo.notes.license.LicenseLinkActivity
import com.futo.notes.license.LicenseStorage
import com.futo.notes.storage.StorageMode
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The landing after activation (docs/spec/license.md § Deep link), through the
 * real app: a `futonotes://license/…` link delivered the way the browser
 * delivers it lands on the App icon picker over Settings, with the one-time
 * header, and reopening the picker shows the plain grid.
 *
 * This drives the app's own preferences (the license is stored where the app
 * reads it), so it runs only on a claimed emulator; [restore] puts back what it
 * found.
 */
@RunWith(AndroidJUnit4::class)
class AppIconLandingTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val prefs = context.getSharedPreferences(Prefs.FILE, Context.MODE_PRIVATE)
    private val storedMode = prefs.getString(Prefs.STORAGE_MODE, null)
    private val storedLicense = LicenseStorage(prefs).read()

    @Before fun unlicensedWithAVault() {
        // App storage: no first-run storage choice to land behind.
        prefs.edit().putString(Prefs.STORAGE_MODE, StorageMode.APP.name).commit()
        LicenseStorage(prefs).clear()
        // The Settings row is found by the current icon's name.
        runBlocking { AppIconController(context).reset() }
    }

    @After fun restore() {
        prefs.edit().apply {
            if (storedMode == null) remove(Prefs.STORAGE_MODE) else putString(Prefs.STORAGE_MODE, storedMode)
        }.commit()
        val storage = LicenseStorage(prefs)
        storedLicense?.let(storage::write) ?: storage.clear()
    }

    private fun assertLandedOnThePicker() {
        compose.waitUntil(15_000) {
            compose.onAllNodesWithTag("app-icon-landing").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("app-icon-landing").assertIsDisplayed()
        compose.onNodeWithTag("app-icon-footnote").assertDoesNotExist()
    }

    @Test fun aColdStartLinkLandsOnThePickerOnce() {
        val link = Intent(Intent.ACTION_VIEW, Uri.parse(LicenseFixture.deepLink))
            .setClass(context, MainActivity::class.java)
        ActivityScenario.launch<MainActivity>(link).use {
            assertLandedOnThePicker()
            // The header lives only for that presentation.
            // System Back reaches the picker's own window first.
            InstrumentationRegistry.getInstrumentation().uiAutomation
                .performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
            compose.waitUntil(5_000) {
                compose.onAllNodesWithTag("app-icon-landing").fetchSemanticsNodes().isEmpty()
            }
            compose.onNodeWithText("Standard").performScrollTo().performClick()
            compose.waitUntil(5_000) {
                compose.onAllNodesWithTag("app-icon-futo").fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithTag("app-icon-landing").assertDoesNotExist()
        }
    }

    @Test fun aLinkFromTheBrowserLandsOnTheRunningApp() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val launches = instrumentation.addMonitor(MainActivity::class.java.name, null, false)
        context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val main = instrumentation.waitForMonitorWithTimeout(launches, 15_000)
        try {
            compose.waitUntil(15_000) {
                compose.onAllNodesWithContentDescription("Settings").fetchSemanticsNodes().isNotEmpty()
            }
            // The browser's path: the trampoline hands the link to the running activity.
            context.startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse(LicenseFixture.deepLink))
                    .setClass(context, LicenseLinkActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            assertLandedOnThePicker()
            // Delivered to the running activity (onNewIntent), not a second one.
            assertEquals(1, launches.hits)
        } finally {
            main?.finish()
            instrumentation.removeMonitor(launches)
        }
    }
}
