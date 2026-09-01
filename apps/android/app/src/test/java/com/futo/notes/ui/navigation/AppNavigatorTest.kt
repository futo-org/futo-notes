package com.futo.notes.ui.navigation

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.mutableStateListOf
import com.futo.notes.ui.NoteListState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The stack is what decides where Back goes, so a screen that is not on it has
 * no Back destination. github#28: the Storage location picker was presented as
 * a full-screen overlay OUTSIDE the stack, so Back operated on the Settings
 * entry hidden underneath it — one press popped Settings invisibly and the next
 * fell through to the OS and finished the activity.
 */
class AppNavigatorTest {
    private fun navigator() = AppNavigator(
        mutableStateListOf(Screen.Folder("")),
        NoteListState(LazyListState()),
    )

    @Test
    fun `storage location is pushed from settings, so back returns to settings`() {
        val navigator = navigator()
        navigator.openSettings()

        navigator.openStorageLocation()

        assertEquals(Screen.StorageLocation, navigator.currentScreen)
        // Back is intercepted here rather than falling through to the OS.
        assertTrue(navigator.canGoBack)

        navigator.goBack()

        assertEquals(Screen.Settings, navigator.currentScreen)
        // ...and the Settings entry it was covering is still there, so the next
        // Back returns to the root folder instead of exiting the app.
        assertTrue(navigator.canGoBack)

        navigator.goBack()

        assertEquals(Screen.Folder(""), navigator.currentScreen)
        assertFalse(navigator.canGoBack)
    }

    @Test
    fun `settings survives a storage location round trip`() {
        val navigator = navigator()
        navigator.openSettings()
        navigator.openStorageLocation()
        // Cancel is the same verb as Back (MainActivity wires both to goBack).
        navigator.goBack()
        navigator.openStorageLocation()
        navigator.goBack()

        assertEquals(Screen.Settings, navigator.currentScreen)
    }
}
