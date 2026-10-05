package com.futo.notes.ui.navigation

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.mutableStateListOf
import com.futo.notes.ui.NoteListState
import org.junit.Assert.assertEquals
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
