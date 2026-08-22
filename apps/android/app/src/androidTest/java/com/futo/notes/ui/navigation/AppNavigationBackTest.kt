package com.futo.notes.ui.navigation

import androidx.activity.ComponentActivity
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * System Back against the real dispatcher, not just the navigator's API.
 * github#28: the Storage location picker was drawn over the shell instead of
 * being pushed onto the stack, so Back operated on the screen it was covering —
 * the first press popped Settings behind the still-visible picker and the
 * second finished the activity.
 */
@RunWith(AndroidJUnit4::class)
class AppNavigationBackTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun systemBackFromStorageLocationReturnsToSettingsWithoutFinishingTheActivity() {
        compose.setContent {
            AppNavigation(hasBootstrapped = true, availableFolderPaths = emptyList()) { screen, navigator, _ ->
                when (screen) {
                    Screen.List -> Button(
                        onClick = navigator::openSettings,
                        modifier = Modifier.testTag("open-settings"),
                    ) { Text("Settings") }

                    Screen.Settings -> Button(
                        onClick = navigator::openStorageLocation,
                        modifier = Modifier.testTag("open-storage"),
                    ) { Text("Storage location") }

                    Screen.StorageLocation -> Text(
                        "Where should your notes live?",
                        modifier = Modifier.testTag("storage-picker"),
                    )

                    else -> Text(screen.toString())
                }
            }
        }

        compose.onNodeWithTag("open-settings").performClick()
        compose.onNodeWithTag("open-storage").performClick()
        compose.onNodeWithTag("storage-picker").assertIsDisplayed()

        pressBack()

        compose.onNodeWithTag("open-storage").assertIsDisplayed()
        assertFalse(compose.activity.isFinishing)

        pressBack()

        compose.onNodeWithTag("open-settings").assertIsDisplayed()
        assertFalse(compose.activity.isFinishing)
    }

    private fun pressBack() {
        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
    }
}
