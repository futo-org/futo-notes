package com.futo.notes.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.window.Dialog
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Regression for github#23: a dialog-hosted text field lost focus moments
 * after the keyboard opened, closing it (see [ClearFocusOnImeDismiss]). IME
 * visibility is asserted from the activity window, so the test fails loudly
 * if the environment never shows a real keyboard instead of going green
 * without exercising anything.
 */
@RunWith(AndroidJUnit4::class)
class DialogImeDismissTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun dialogFieldKeepsFocusAndKeyboardWhileImeShows() {
        var activityImeVisible = false
        compose.setContent {
            val imeVisible = imeTargetVisible()
            SideEffect { activityImeVisible = imeVisible }
            Dialog(onDismissRequest = {}) {
                Column {
                    ClearFocusOnImeDismiss(imeVisible)
                    var name by remember { mutableStateOf("") }
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        modifier = Modifier.testTag("name"),
                    )
                }
            }
        }
        repeat(3) {
            compose.onNodeWithTag("name").performClick()
            compose.onNodeWithTag("name").assertIsFocused()
            compose.waitUntil(timeoutMillis = 5_000) { activityImeVisible }
            // Real clock: the phantom hide fired as the IME's show animation
            // settled, which the compose test clock does not drive.
            Thread.sleep(1_500)
            compose.waitForIdle()
            compose.onNodeWithTag("name").assertIsFocused()
            compose.waitUntil(timeoutMillis = 1_000) { activityImeVisible }
        }
    }
}
