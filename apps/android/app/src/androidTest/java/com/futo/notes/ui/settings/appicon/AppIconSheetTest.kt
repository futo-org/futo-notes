package com.futo.notes.ui.settings.appicon

import androidx.activity.ComponentActivity
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.futo.notes.ui.theme.FutoNotesTheme
import com.futo.notes.localization.ProvideLocalization
import uniffi.futo_notes_ffi.LicenseAction
import uniffi.futo_notes_ffi.LicenseInclusion
import kotlinx.coroutines.launch
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AppIconSheetTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val icons = object : AppIconSystem {
        var active = AppIcon.LIGHT_STANDARD
        var calls = 0
        override fun enabled(icon: AppIcon) = icon == active
        override fun apply(changes: List<Pair<AppIcon, Boolean>>) {
            active = changes.first { it.second }.first
            calls++
        }
    }

    private val licensed = setOf(LicenseInclusion.APP_ICON)
    private val linkOut = listOf(LicenseAction.BUY, LicenseAction.ENTER_KEY, LicenseAction.LOST_KEY)
    private var bought = 0
    private var alreadyPaid = 0

    /** The license answers are passed in as Rust gives them; the rule itself is Rust's. */
    private fun showSheet(
        includes: Set<LicenseInclusion>? = licensed,
        rowActions: List<LicenseAction> = listOf(LicenseAction.REMOVE),
        includesState: MutableState<Set<LicenseInclusion>?>? = null,
    ) {
        val controller = AppIconController(icons)
        compose.setContent {
            var shown by remember { mutableStateOf(false) }
            val scope = rememberCoroutineScope()
            ProvideLocalization("en") { FutoNotesTheme {
                Button(onClick = { shown = true }, modifier = Modifier.testTag("settings")) { Text("Settings") }
                if (shown) AppIconSheet(
                    controller,
                    includes = includesState?.value ?: includes,
                    rowActions = rowActions,
                    onSelect = { icon -> scope.launch { controller.select(icon) } },
                    onBuy = { bought++ },
                    onAlreadyPaid = { alreadyPaid++; shown = false },
                ) { shown = false }
            } }
        }
        compose.onNodeWithTag("settings").performClick()
        compose.onNodeWithText("App icon").assertIsDisplayed()
    }

    @Test fun confirmedSelectionStaysOpenAndBackReturnsToSettings() {
        showSheet()
        compose.onNodeWithText("Standard").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Change app icon to \"Standard\"?").assertDoesNotExist()
        assertEquals(0, icons.calls)
        compose.onNodeWithText("FUTO").performScrollTo().performClick()
        compose.onNodeWithText("Change app icon to \"FUTO\"?").assertIsDisplayed()
        compose.onNodeWithText("FUTO Notes may close to apply the new icon.", substring = true).assertIsDisplayed()
        assertEquals(0, icons.calls)
        compose.onNodeWithText("Change").performClick()
        compose.waitUntil(5000) { icons.active == AppIcon.FUTO }
        compose.onNodeWithText("Change app icon to \"FUTO\"?").assertDoesNotExist()
        compose.onNodeWithText("App icon").assertIsDisplayed()
        compose.onNodeWithText("FUTO").assertIsSelected()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithText("App icon").assertDoesNotExist()
        compose.onNodeWithTag("settings").assertIsDisplayed()
        assertEquals(AppIcon.FUTO, icons.active)
        assertEquals(1, icons.calls)
        assertFalse(compose.activity.isFinishing)
    }

    @Test fun cancelledSelectionChangesNothing() {
        showSheet()
        compose.onNodeWithText("FUTO").performScrollTo().performClick()
        compose.onNodeWithText("Change app icon to \"FUTO\"?").assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Change app icon to \"FUTO\"?").assertDoesNotExist()
        compose.onNodeWithText("App icon").assertIsDisplayed()
        assertEquals(0, icons.calls)
        assertEquals(AppIcon.LIGHT_STANDARD, icons.active)
        compose.onNodeWithText("Standard").assertIsSelected()
    }

    @Test fun systemBackDismissesOnlyTheModalSheet() {
        showSheet()
        // Real Android system Back is delivered to the modal dialog's window.
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
            .uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        compose.waitUntil(5000) {
            compose.onAllNodesWithText("App icon").fetchSemanticsNodes().isEmpty()
        }
        compose.onNodeWithTag("settings").assertIsDisplayed()
        assertFalse(compose.activity.isFinishing)
    }

    @Test fun unlicensedLinkOutCoinsTilesAsksWithBuyAndNeverChangesTheIcon() {
        showSheet(includes = emptySet(), rowActions = linkOut)
        compose.onNodeWithTag("app-icon-footnote").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Purchasing a FUTO Notes license unlocks the ability to change the app icon.", substring = true)
            .assertExists()
        // The current tile is a no-op, never an ask.
        compose.onNodeWithTag("app-icon-light-standard").performScrollTo().performClick()
        compose.onNodeWithTag("app-icon-ask-title").assertDoesNotExist()
        // A coined tile is announced as included, and opens the ask, not the OS change.
        compose.onNodeWithTag("app-icon-futo")
            .assertContentDescriptionContains("FUTO, included with a license")
            .performScrollTo().performClick()
        compose.onNodeWithTag("app-icon-ask-title").assertIsDisplayed().assertTextEquals("Included with a license")
        compose.onNodeWithText("Change app icon to \"FUTO\"?").assertDoesNotExist()
        compose.onNodeWithTag("app-icon-ask-buy").assertTextEquals("Buy a license").performClick()
        assertEquals(1, bought)
        compose.onNodeWithTag("app-icon-ask-not-now").performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithTag("app-icon-ask-title").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithText("App icon").assertIsDisplayed()
        assertEquals(0, icons.calls)
        assertEquals(AppIcon.LIGHT_STANDARD, icons.active)
    }

    @Test fun expiredAsksTheSameWithRenew() {
        showSheet(includes = emptySet(), rowActions = listOf(LicenseAction.RENEW, LicenseAction.ENTER_KEY, LicenseAction.LOST_KEY))
        compose.onNodeWithTag("app-icon-dark-standard").performScrollTo().performClick()
        compose.onNodeWithTag("app-icon-ask-buy").assertTextEquals("Renew")
        assertEquals(0, icons.calls)
    }

    @Test fun keyOnlyAsksForTheKeyWithNoBuyAndNoUnlock() {
        showSheet(includes = emptySet(), rowActions = listOf(LicenseAction.ENTER_KEY))
        compose.onNodeWithText("Choosing an app icon is included with a FUTO Notes license.", substring = true)
            .performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("unlocks", substring = true).assertDoesNotExist()
        compose.onNodeWithTag("app-icon-website").performScrollTo().performClick()
        compose.onNodeWithTag("app-icon-ask-body")
            .assertTextEquals("Have a FUTO Notes license? Enter your key to activate it on this device.")
        compose.onNodeWithTag("app-icon-ask-buy").assertDoesNotExist()
        compose.onNodeWithText("Lost your key?").assertDoesNotExist()
        compose.onNodeWithTag("app-icon-ask-already-paid").assertTextEquals("I already paid").performClick()
        assertEquals(1, alreadyPaid)
        compose.waitUntil(5000) { compose.onAllNodesWithText("App icon").fetchSemanticsNodes().isEmpty() }
        assertEquals(0, icons.calls)
    }

    @Test fun licensedKeepsCoinsWithoutAFootnoteAndChangesTheIcon() {
        showSheet()
        compose.onNodeWithTag("app-icon-footnote").assertDoesNotExist()
        compose.onNodeWithTag("app-icon-futo").assertContentDescriptionContains("FUTO, included with a license")
        compose.onNodeWithTag("app-icon-light-standard").assertContentDescriptionEquals("Standard")
    }

    @Test fun aLicenseArrivingWhileAskingDropsTheAskAndLetsTheTileChange() {
        val includes = mutableStateOf<Set<LicenseInclusion>?>(emptySet())
        showSheet(rowActions = linkOut, includesState = includes)
        compose.onNodeWithTag("app-icon-futo").performScrollTo().performClick()
        compose.onNodeWithTag("app-icon-ask-title").assertIsDisplayed()
        includes.value = licensed
        compose.waitUntil(5000) { compose.onAllNodesWithTag("app-icon-ask-title").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithTag("app-icon-footnote").assertDoesNotExist()
        compose.onNodeWithTag("app-icon-futo").performScrollTo().performClick()
        compose.onNodeWithText("Change app icon to \"FUTO\"?").assertIsDisplayed()
    }

    @Test fun anUnreadLicenseShowsNoAskAndTapsDoNothing() {
        showSheet(includes = null, rowActions = emptyList())
        compose.onNodeWithTag("app-icon-footnote").assertDoesNotExist()
        compose.onNodeWithTag("app-icon-futo").performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("app-icon-ask-title").assertDoesNotExist()
        compose.onNodeWithText("Change app icon to \"FUTO\"?").assertDoesNotExist()
    }
}
