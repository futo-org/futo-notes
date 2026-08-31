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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.unit.IntOffset
import com.futo.notes.ui.NoteListState
import com.futo.notes.ui.isAtListTop
import com.futo.notes.ui.rebaseFolderPath
import com.futo.notes.ui.rememberNoteListState
import com.futo.notes.ui.theme.FutoMotion

internal sealed interface Screen {
    /**
     * A folder's contents — subfolders above notes [list.md "Folder browsing"].
     * `path` is a full vault-relative folder path; `""` is the vault root, which
     * IS the home screen (there is no separate flat "all notes" screen). Tapping
     * a subfolder row pushes another `Folder`, exactly like the iOS
     * `Route.folder` / `FolderContentsView` recursion.
     */
    data class Folder(val path: String) : Screen

    data class Editor(val noteId: String, val autoFocus: Boolean) : Screen
    data object Search : Screen
    data object Settings : Screen
    data object StorageLocation : Screen
    data object Sync : Screen
}

/** The vault root folder route — the stack floor [nav.md]. */
internal val RootFolder = Screen.Folder("")

/**
 * One rendered stack position. AnimatedContent animates on `depth` so a
 * folder→folder push slides forward and its pop slides back; comparing screen
 * TYPES cannot tell those apart (both are `Screen.Folder`).
 */
internal data class NavEntry(val depth: Int, val screen: Screen)

/**
 * Rebase every folder route sitting under a renamed or moved ancestor, so the
 * screen you are looking at follows its folder instead of going dead
 * [list.md "Folder browsing"]. Pure — unit-tested by AppNavStackTest.
 */
internal fun rebaseFolderRoutes(stack: List<Screen>, from: String, to: String): List<Screen> =
    stack.map { screen ->
        if (screen is Screen.Folder && screen.path.isNotEmpty()) {
            Screen.Folder(rebaseFolderPath(screen.path, from, to))
        } else {
            screen
        }
    }

/**
 * Drop every folder route whose folder no longer exists, leaving the nearest
 * surviving ancestor on the stack (the root route is never dropped, so the
 * stack floor holds). A folder deleted locally or by a sync pull takes its
 * descendants with it — they are absent from `folders` too — so one filter
 * covers both the delete and the post-bootstrap reconciliation the drawer era
 * split across `handleFolderDeleted` and `retainAvailableFolderPaths`.
 *
 * Non-folder routes above a pruned folder are KEPT: a sync pull that deletes
 * the folder you happen to be inside must not eject you from the note you have
 * open — it only changes where Back lands. Pure — unit-tested by AppNavStackTest.
 */
internal fun pruneFolderRoutes(stack: List<Screen>, folders: Set<String>): List<Screen> =
    stack.filterNot { it is Screen.Folder && it.path.isNotEmpty() && it.path !in folders }

@Stable
internal class AppNavigator internal constructor(
    private val stack: SnapshotStateList<Screen>,
    private val noteListState: NoteListState,
) {
    internal val currentScreen: Screen
        get() = stack.last()

    internal val currentEntry: NavEntry
        get() = NavEntry(stack.size, stack.last())

    internal val canGoBack: Boolean
        get() = stack.size > 1

    /** The folder whose contents are showing, or null on a non-folder screen. */
    internal val currentFolder: String?
        get() = (currentScreen as? Screen.Folder)?.path

    fun openFolder(path: String) {
        require(path.isNotEmpty()) { "The root folder is the stack floor, not a push target" }
        val current = currentScreen
        if (current is Screen.Folder && current.path == path) return
        stack.add(Screen.Folder(path))
    }

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

    /**
     * Settings -> Storage location. A PUSH, not an overlay: the picker is a
     * full-screen surface, and presenting it outside the stack left Back pointing
     * at the Settings entry hidden underneath it, so the first Back popped
     * Settings invisibly and the next fell through to the OS and finished the
     * activity (github#28).
     */
    fun openStorageLocation() {
        stack.add(Screen.StorageLocation)
    }

    /** Follow a renamed or moved folder on every stacked folder route. */
    fun followFolderMove(from: String, to: String) {
        replaceStack(rebaseFolderRoutes(stack, from, to))
        noteListState.followFolderMove(from, to)
    }

    /** Drop folder routes for folders that no longer exist. */
    fun retainFolders(folders: Collection<String>) {
        replaceStack(pruneFolderRoutes(stack, folders.toSet()))
        noteListState.retainFolders(folders)
    }

    private fun replaceStack(next: List<Screen>) {
        if (next == stack.toList()) return
        stack.clear()
        stack.addAll(next)
    }

    fun goBack() {
        if (!canGoBack) return
        stack.removeAt(stack.lastIndex)
        val folder = currentFolder
        if (folder != null) {
            // Prevent key anchoring from hiding rows inserted above an at-top viewport.
            val scrollState = noteListState.scrollStateFor(folder)
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
    val noteListState = rememberNoteListState()
    // Activity recreation starts a fresh route stack at the vault root [nav.md]:
    // `remember`, not `rememberSaveable`. Only the root list's scroll position is
    // restored (NoteListState), which is all a root-only stack can show.
    val stack = remember { mutableStateListOf<Screen>(RootFolder) }
    val navigator = remember(stack, noteListState) {
        AppNavigator(stack, noteListState)
    }

    LaunchedEffect(hasBootstrapped, availableFolderPaths) {
        if (hasBootstrapped) {
            navigator.retainFolders(availableFolderPaths)
        }
    }

    BackHandler(enabled = navigator.canGoBack, onBack = navigator::goBack)

    AnimatedContent(
        targetState = navigator.currentEntry,
        transitionSpec = {
            val forward = targetState.depth > initialState.depth
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
    ) { entry ->
        content(entry.screen, navigator, noteListState)
    }
}
