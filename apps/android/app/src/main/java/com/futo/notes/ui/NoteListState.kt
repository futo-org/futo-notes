package com.futo.notes.ui

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.remember

/** The vault root's folder path — the home screen [list.md "Folder browsing"]. */
internal const val ROOT_FOLDER = ""

/**
 * Scroll position per folder screen, hoisted out of the composition.
 *
 * Each folder screen is its own nav-stack entry (`Screen.Folder`), so its
 * `LazyColumn` leaves the composition whenever a note, Search, Settings, or a
 * deeper folder is pushed. A `rememberLazyListState()` inside the screen would
 * therefore lose the scroll position on every round trip — hence this holder,
 * created once in `AppNavigation` and keyed by folder path.
 *
 * Only the ROOT folder's state is saveable: activity recreation starts a fresh
 * route stack at the root [nav.md], so no deeper folder's scroll position is
 * observable afterwards.
 */
@Stable
internal class NoteListState(rootScrollState: LazyListState) {
    private val scrollStates = mutableMapOf(ROOT_FOLDER to rootScrollState)

    /** The scroll state for `folder`, created on first visit. */
    fun scrollStateFor(folder: String): LazyListState =
        scrollStates.getOrPut(folder) { LazyListState() }

    /**
     * Forget the scroll position of every folder that no longer exists, so a
     * path reused later (a folder recreated, or a `-2` collision resolution
     * landing on a stale name) starts at the top rather than at a position
     * measured for different content. The root is never forgotten.
     */
    fun retainFolders(folders: Collection<String>) {
        val keep = folders.toSet()
        scrollStates.keys.retainAll { it == ROOT_FOLDER || it in keep }
    }

    /** Re-key scroll positions onto a renamed or moved folder's new paths. */
    fun followFolderMove(from: String, to: String) {
        val moved = scrollStates.keys
            .filter { it != ROOT_FOLDER && rebaseFolderPath(it, from, to) != it }
            .associateWith { rebaseFolderPath(it, from, to) }
        moved.forEach { (old, new) ->
            scrollStates.remove(old)?.let { scrollStates[new] = it }
        }
    }
}

@Composable
internal fun rememberNoteListState(): NoteListState {
    // rememberLazyListState is itself rememberSaveable-backed, so the root
    // list's scroll position survives activity recreation [nav.md].
    val rootScrollState = rememberLazyListState()
    return remember(rootScrollState) { NoteListState(rootScrollState) }
}

internal fun rebaseFolderPath(current: String, from: String, to: String): String = when {
    current == from -> to
    current.startsWith("$from/") -> "$to/${current.removePrefix("$from/")}"
    else -> current
}
