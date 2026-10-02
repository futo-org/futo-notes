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

    private fun showSheet() {
        val controller = AppIconController(icons)
        compose.setContent {
            var shown by remember { mutableStateOf(false) }
            val scope = rememberCoroutineScope()
            ProvideLocalization("en") { FutoNotesTheme {
                Button(onClick = { shown = true }, modifier = Modifier.testTag("settings")) { Text("Settings") }
                if (shown) AppIconSheet(controller, onSelect = { icon -> scope.launch { controller.select(icon) } }) { shown = false }
            } }
        }
        compose.onNodeWithTag("settings").performClick()
        compose.onNodeWithText("App icon").assertIsDisplayed()
    }

    @Test fun selectionStaysOpenAndBackReturnsToSettings() {
        showSheet()
        compose.onNodeWithText("Light / Standard").performClick()
        compose.waitForIdle()
        assertEquals(0, icons.calls)
        compose.onNodeWithText("FUTO").performScrollTo().performClick()
        compose.waitUntil(5000) { icons.active == AppIcon.FUTO }
        compose.onNodeWithText("App icon").assertIsDisplayed()
        compose.onNodeWithText("FUTO").assertIsSelected()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithText("App icon").assertDoesNotExist()
        compose.onNodeWithTag("settings").assertIsDisplayed()
        assertEquals(AppIcon.FUTO, icons.active)
        assertFalse(compose.activity.isFinishing)
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
}
