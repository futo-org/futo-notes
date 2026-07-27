package com.futo.notes.ui.navigation

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.unit.IntOffset
import com.futo.notes.ui.NoteListState
import com.futo.notes.ui.isAtListTop
import com.futo.notes.ui.rememberNoteListState
import com.futo.notes.ui.theme.FutoMotion

internal sealed interface Screen {
    data object List : Screen
    data class Editor(val noteId: String, val autoFocus: Boolean) : Screen
    data object Search : Screen
    data object Settings : Screen
    data object Sync : Screen
}

@Stable
internal class AppNavigator internal constructor(
    private val stack: SnapshotStateList<Screen>,
    private val noteListState: NoteListState,
) {
    internal val currentScreen: Screen
        get() = stack.last()

    internal val canGoBack: Boolean
        get() = stack.size > 1

    fun openNote(noteId: String) {
        val current = currentScreen
        if (current is Screen.Editor && current.noteId == noteId) return
        stack.add(Screen.Editor(noteId, autoFocus = false))
    }

    fun openCreatedNote(noteId: String) {
        stack.add(Screen.Editor(noteId, autoFocus = true))
    }

    fun openSearch() {
        stack.add(Screen.Search)
    }

    fun openSettings() {
        stack.add(Screen.Settings)
    }

    fun openSync() {
        stack.add(Screen.Sync)
    }

    fun goBack() {
        if (!canGoBack) return
        stack.removeAt(stack.lastIndex)
        if (currentScreen is Screen.List) {
            // Prevent key anchoring from hiding rows inserted above an at-top viewport.
            val scrollState = noteListState.scrollState
            if (isAtListTop(
                    scrollState.firstVisibleItemIndex,
                    scrollState.firstVisibleItemScrollOffset,
                )
            ) {
                scrollState.requestScrollToItem(0)
            }
        }
    }
}

@Composable
internal fun AppNavigation(
    hasBootstrapped: Boolean,
    availableFolderPaths: List<String>,
    content: @Composable (
        screen: Screen,
        navigator: AppNavigator,
        noteListState: NoteListState,
    ) -> Unit,
) {
    val noteListState = rememberNoteListState(
        hasBootstrapped = hasBootstrapped,
        availableFolderPaths = availableFolderPaths,
    )
    val stack = remember { mutableStateListOf<Screen>(Screen.List) }
    val navigator = remember(stack, noteListState) {
        AppNavigator(stack, noteListState)
    }

    BackHandler(enabled = navigator.canGoBack, onBack = navigator::goBack)

    AnimatedContent(
        targetState = navigator.currentScreen,
        transitionSpec = {
            val forward = targetState !is Screen.List
            val fade = tween<Float>(FutoMotion.Base, easing = FutoMotion.EaseSoft)
            val slide = tween<IntOffset>(FutoMotion.Base, easing = FutoMotion.EaseSoft)
            if (forward) {
                (slideInHorizontally(slide) { it / 6 } + fadeIn(fade)) togetherWith fadeOut(fade)
            } else {
                fadeIn(fade) togetherWith
                    (slideOutHorizontally(slide) { it / 6 } + fadeOut(fade))
            }
        },
        label = "route",
    ) { screen ->
        content(screen, navigator, noteListState)
    }
}
