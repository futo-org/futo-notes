package com.futo.notes.ui.navigation

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AppNavigationTest {
    @get:Rule
    val compose = createComposeRule()

    /**
     * A folder screen is a nav-stack entry: pushing one and popping it is
     * ordinary Back, a note pushed on top of it returns to that folder, and a
     * folder that leaves the vault (deleted locally or by a sync pull) pops to
     * the nearest surviving ancestor [nav.md].
     */
    @Test
    fun folderScreenPushesPopsAndVanishesWithItsFolder() {
        var hasBootstrapped by mutableStateOf(true)
        var folderPaths by mutableStateOf(listOf("Projects", "Projects/Plans"))

        compose.setContent { navHarness(hasBootstrapped, folderPaths) }

        compose.onNodeWithTag("current-folder").assertTextEquals("<root>")

        compose.onNodeWithTag("open-projects").performClick()
        compose.onNodeWithTag("current-folder").assertTextEquals("Projects")

        compose.onNodeWithTag("open-plans").performClick()
        compose.onNodeWithTag("current-folder").assertTextEquals("Projects/Plans")

        // A note pushed from a folder screen returns to THAT folder, not the root.
        compose.onNodeWithTag("open-note").performClick()
        compose.onNodeWithTag("go-back").assertIsDisplayed().performClick()
        compose.onNodeWithTag("current-folder").assertTextEquals("Projects/Plans")

        // The deepest folder leaves the vault → pop to its surviving parent.
        compose.runOnIdle { folderPaths = listOf("Projects") }
        compose.onNodeWithTag("current-folder").assertTextEquals("Projects")

        // Before the first scan lands, an empty folder list proves nothing and
        // must not pop the user out of a folder; once it has, the folder goes.
        compose.runOnIdle { hasBootstrapped = false }
        compose.runOnIdle { folderPaths = emptyList() }
        compose.onNodeWithTag("current-folder").assertTextEquals("Projects")

        compose.runOnIdle { hasBootstrapped = true }
        compose.onNodeWithTag("current-folder").assertTextEquals("<root>")
    }

    /** A rename or move of the folder being browsed keeps the screen on it. */
    @Test
    fun theBrowsedFolderFollowsARename() {
        compose.setContent { navHarness(true, listOf("Projects", "Projects/Plans")) }

        compose.onNodeWithTag("open-projects").performClick()
        compose.onNodeWithTag("open-plans").performClick()
        compose.onNodeWithTag("rename-projects").performClick()
        compose.onNodeWithTag("current-folder").assertTextEquals("Archive/Projects/Plans")
    }

    /**
     * Activity recreation starts a fresh route stack at the vault root [nav.md]
     * — a deep folder stack is NOT restored, so the user always comes back to a
     * screen that is guaranteed to exist.
     */
    @Test
    fun activityRecreationReturnsToTheRootFolder() {
        val restoration = StateRestorationTester(compose)
        restoration.setContent { navHarness(true, listOf("Projects", "Projects/Plans")) }

        compose.onNodeWithTag("open-projects").performClick()
        compose.onNodeWithTag("current-folder").assertTextEquals("Projects")

        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithTag("current-folder").assertTextEquals("<root>")
    }

    @Test
    fun activityRecreationReturnsToSettings() {
        val restoration = StateRestorationTester(compose)
        restoration.setContent { routeHarness() }

        compose.onNodeWithTag("open-settings").performClick()
        compose.onNodeWithTag("current-screen").assertTextEquals(Screen.Settings.toString())

        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithTag("current-screen").assertTextEquals(Screen.Settings.toString())
    }

    @Test
    fun activityRecreationRestoresSyncUnderneathSettingsSoBackReturnsThere() {
        val restoration = StateRestorationTester(compose)
        restoration.setContent { routeHarness() }

        compose.onNodeWithTag("open-settings").performClick()
        compose.onNodeWithTag("open-sync").performClick()
        compose.onNodeWithTag("current-screen").assertTextEquals(Screen.Sync.toString())

        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithTag("current-screen").assertTextEquals(Screen.Sync.toString())

        compose.onNodeWithTag("go-back-route").performClick()
        compose.onNodeWithTag("current-screen").assertTextEquals(Screen.Settings.toString())
    }

    @Composable
    private fun routeHarness() {
        AppNavigation(
            hasBootstrapped = true,
            availableFolderPaths = emptyList(),
        ) { screen, navigator, _ ->
            Column {
                Text(text = screen.toString(), modifier = Modifier.testTag("current-screen"))
                Button(
                    onClick = navigator::openSettings,
                    modifier = Modifier.testTag("open-settings"),
                ) {
                    Text("Open settings")
                }
                Button(
                    onClick = navigator::openSync,
                    modifier = Modifier.testTag("open-sync"),
                ) {
                    Text("Open sync")
                }
                Button(
                    onClick = navigator::goBack,
                    modifier = Modifier.testTag("go-back-route"),
                ) {
                    Text("Back")
                }
            }
        }
    }

    @Composable
    private fun navHarness(hasBootstrapped: Boolean, folderPaths: List<String>) {
        AppNavigation(
            hasBootstrapped = hasBootstrapped,
            availableFolderPaths = folderPaths,
        ) { screen, navigator, _ ->
            when (screen) {
                is Screen.Folder -> Column {
                    Text(
                        text = screen.path.ifEmpty { "<root>" },
                        modifier = Modifier.testTag("current-folder"),
                    )
                    Button(
                        onClick = { navigator.openFolder("Projects") },
                        modifier = Modifier.testTag("open-projects"),
                    ) {
                        Text("Open Projects")
                    }
                    Button(
                        onClick = { navigator.openFolder("Projects/Plans") },
                        modifier = Modifier.testTag("open-plans"),
                    ) {
                        Text("Open Plans")
                    }
                    Button(
                        onClick = { navigator.followFolderMove("Projects", "Archive/Projects") },
                        modifier = Modifier.testTag("rename-projects"),
                    ) {
                        Text("Rename Projects")
                    }
                    Button(
                        onClick = { navigator.openNote("Projects/Plan") },
                        modifier = Modifier.testTag("open-note"),
                    ) {
                        Text("Open note")
                    }
                }

                is Screen.Editor -> Button(
                    onClick = navigator::goBack,
                    modifier = Modifier.testTag("go-back"),
                ) {
                    Text("Back")
                }

                else -> Text(screen.toString())
            }
        }
    }
}
