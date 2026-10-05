package com.futo.notes.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.hasImeAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Return in the note title moves on into the body [list.md]. The screen hands
 * [NoteTitleField] `EditorHost.focusEditor` as `onReturn`; what this pins is
 * that both kinds of Return reach it and that neither puts a newline in the
 * title. Whether the keyboard then stays up is a device check (the WebView's
 * IME handoff is not something a Compose test can host).
 */
@RunWith(AndroidJUnit4::class)
class NoteTitleFieldTest {
    @get:Rule
    val compose = createComposeRule()

    private var returns = 0

    private fun showField() {
        compose.setContent {
            var value by remember { mutableStateOf(TextFieldValue("")) }
            NoteTitleField(
                value = value,
                onValueChange = { value = it },
                placeholder = "Untitled",
                enabled = true,
                onReturn = { returns++ },
                modifier = Modifier.testTag(TAG),
            )
        }
        compose.onNodeWithTag(TAG).performClick()
        compose.onNodeWithTag(TAG).performTextInput("Groceries")
    }

    @Test
    fun theKeyboardActionKeyMovesOnIntoTheBody() {
        showField()
        compose.onNodeWithTag(TAG).assert(hasImeAction(ImeAction.Next))

        compose.onNodeWithTag(TAG).performImeAction()

        assertEquals(1, returns)
        compose.onNodeWithTag(TAG).assert(hasText("Groceries"))
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun aHardwareEnterMovesOnIntoTheBodyWithoutANewline() {
        showField()

        compose.onNodeWithTag(TAG).performKeyInput { pressKey(Key.Enter) }

        assertEquals(1, returns)
        compose.onNodeWithTag(TAG).assert(hasText("Groceries"))
    }

    private companion object {
        const val TAG = "title"
    }
}
