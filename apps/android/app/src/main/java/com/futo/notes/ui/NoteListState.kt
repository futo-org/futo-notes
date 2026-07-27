package com.futo.notes.ui

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable

@Stable
internal class NoteListState(
    val scrollState: LazyListState,
    private val selectedFolderPathState: MutableState<String?> = mutableStateOf(null),
) {
    var selectedFolderPath: String?
        get() = selectedFolderPathState.value
        private set(value) {
            selectedFolderPathState.value = value
        }

    fun selectFolder(path: String?) {
        require(path == null || path.isNotEmpty()) {
            "A selected folder path must be non-empty; null represents All notes"
        }
        selectedFolderPath = path
    }

    fun followFolderMove(from: String, to: String) {
        selectedFolderPath = selectedFolderPath?.let { rebaseFolderPath(it, from, to) }
    }

    fun handleFolderDeleted(path: String) {
        val selected = selectedFolderPath ?: return
        if (selected == path || selected.startsWith("$path/")) {
            selectedFolderPath = null
        }
    }

    fun retainAvailableFolderPaths(paths: List<String>) {
        val selected = selectedFolderPath ?: return
        if (selected !in paths) {
            selectedFolderPath = null
        }
    }
}

@Composable
internal fun rememberNoteListState(
    hasBootstrapped: Boolean,
    availableFolderPaths: List<String>,
): NoteListState {
    val scrollState = rememberLazyListState()
    val selectedFolderPathState = rememberSaveable {
        mutableStateOf<String?>(null)
    }
    val state = remember(scrollState, selectedFolderPathState) {
        NoteListState(scrollState, selectedFolderPathState)
    }
    LaunchedEffect(hasBootstrapped, availableFolderPaths) {
        if (hasBootstrapped) {
            state.retainAvailableFolderPaths(availableFolderPaths)
        }
    }
    return state
}

internal fun rebaseFolderPath(current: String, from: String, to: String): String = when {
    current == from -> to
    current.startsWith("$from/") -> "$to/${current.removePrefix("$from/")}"
    else -> current
}
