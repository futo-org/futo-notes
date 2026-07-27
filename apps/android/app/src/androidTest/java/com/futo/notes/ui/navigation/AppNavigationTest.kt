package com.futo.notes.ui.navigation

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.material3.Text
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

    @Test
    fun selectedFolderSurvivesNavigationAndRestorationUntilBootstrapRemovesIt() {
        var hasBootstrapped by mutableStateOf(true)
        var folderPaths by mutableStateOf(listOf("Projects"))
        val restoration = StateRestorationTester(compose)

        restoration.setContent {
            AppNavigation(
                hasBootstrapped = hasBootstrapped,
                availableFolderPaths = folderPaths,
            ) { screen, navigator, noteListState ->
                when (screen) {
                    Screen.List -> Column {
                        Text(
                            text = noteListState.selectedFolderPath ?: "All notes",
                            modifier = Modifier.testTag("selected-folder"),
                        )
                        Button(
                            onClick = { noteListState.selectFolder("Projects") },
                            modifier = Modifier.testTag("select-projects"),
                        ) {
                            Text("Select Projects")
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

        compose.onNodeWithTag("select-projects").performClick()
        compose.onNodeWithTag("selected-folder").assertTextEquals("Projects")

        compose.onNodeWithTag("open-note").performClick()
        compose.onNodeWithTag("go-back").assertIsDisplayed().performClick()
        compose.onNodeWithTag("selected-folder").assertTextEquals("Projects")

        compose.onNodeWithTag("open-note").performClick()
        compose.runOnIdle {
            hasBootstrapped = false
            folderPaths = emptyList()
        }
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithTag("selected-folder").assertTextEquals("Projects")

        compose.runOnIdle { hasBootstrapped = true }
        compose.onNodeWithTag("selected-folder").assertTextEquals("All notes")
    }
}
