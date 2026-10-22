package com.futo.notes.puppet

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import com.futo.notes.NotesStore
import com.futo.notes.ui.navigation.Screen

// Release builds register nothing: the screens keep their call sites and the
// verbs they build are dropped here. Signatures must match the debug source set.

@Composable
internal fun PuppetScreen(@Suppress("UNUSED_PARAMETER") screen: Screen, content: @Composable () -> Unit) =
    content()

@Composable
@Suppress("UNUSED_PARAMETER")
internal fun PuppetVerbScope(
    modal: Boolean = false,
    listRows: (() -> List<String>)? = null,
    verbs: () -> List<PuppetVerb>,
) = Unit

@Composable
@Suppress("UNUSED_PARAMETER")
internal fun PuppetListRows(list: LazyListState, store: NotesStore, leadingItems: Int = 0, rows: () -> List<String>) = Unit

@Composable
@Suppress("UNUSED_PARAMETER")
internal fun PuppetOpenNote(noteId: String, loaded: Boolean) = Unit

@Suppress("UNUSED_PARAMETER")
internal fun recordPuppetCopy(text: String) = Unit

@Suppress("UNUSED_PARAMETER")
internal fun recordPuppetOpen(url: String) = Unit
