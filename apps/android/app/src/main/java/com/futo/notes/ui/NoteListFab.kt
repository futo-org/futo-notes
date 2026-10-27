package com.futo.notes.ui

import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.Icons
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.futo.notes.createNote
import com.futo.notes.localization.Localization
import com.futo.notes.NoteMutationOutcome
import com.futo.notes.NotesStore
import com.futo.notes.puppet.puppetSection
import com.futo.notes.ui.components.pressScale
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async

/** The one primary create action of [NoteListScreen]: a new note in [folder]. */
@Composable
internal fun NewNoteFab(
    store: NotesStore,
    folder: String,
    listState: LazyListState,
    scope: CoroutineScope,
    context: Context,
    localization: Localization,
    onCreate: (String) -> Unit,
) {
    val c = FutoTheme.colors
    // ONE plain FAB: New note, in THIS folder, one tap (github#5 — quick
    // capture never sits behind a menu). New folder lives in the top
    // app bar as an action icon, the Material 3 home for a secondary
    // create action (Files by Google does the same). [list.md]
    val interaction = remember { MutableInteractionSource() }
    val scale = pressScale(interaction, 0.97f)
    FloatingActionButton(
        onClick = { createNote(store, folder, listState, scope, context, localization, onCreate) },
        interactionSource = interaction,
        containerColor = c.accent,
        contentColor = Color.White,
        shape = RoundedCornerShape(FutoRadius.lg),
        modifier = Modifier
            .padding(2.dp)
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .puppetSection("bottom bar"),
    ) {
        Icon(
            Icons.Filled.Add,
            contentDescription = localization.localizedText("notes.newNote"),
        )
    }
}

// The New note button: a note in THIS folder, opened in the editor. Answers the new
// note's id, or null when the store refused it and the toast said so.
internal fun createNote(
    store: NotesStore,
    folder: String,
    listState: LazyListState,
    scope: CoroutineScope,
    context: Context,
    localization: Localization,
    onCreate: (String) -> Unit,
): Deferred<String?> {
    // `createNote`'s reload inserts the new note at index 0
    // while this list is STILL composed (the editor push hasn't
    // removed it yet), so LazyColumn's key-based anchoring would
    // keep the old top row pinned and park the new note above
    // the viewport — corrupting the position the return-to-list
    // re-pin later reads. Capture at-top-ness NOW (the last
    // measure reflects the user's real position) and QUEUE a
    // top snap for the next measure. requestScrollToItem, NOT
    // scrollToItem: scrollToItem force-remeasures immediately —
    // before recomposition has delivered the reloaded list to
    // the LazyColumn — so it re-records the OLD top row as the
    // key anchor and the next real measure follows it down
    // anyway. requestScrollToItem defers the snap to the next
    // measure (which runs AFTER the recomposition carrying the
    // new list) and disables key anchoring for it.
    val atTop = isAtListTop(
        listState.firstVisibleItemIndex,
        listState.firstVisibleItemScrollOffset,
    )
    // `createNote` is suspend (FFI write on IO). Run it on the
    // composable's main scope; the navigate callback runs after
    // it returns (resumes on Main, safe for Compose state).
    return scope.async {
        // Consume the explicit outcome: open the note only on a
        // committed create, and SAY SO when it failed. A silent
        // no-op here is what github#13 reports.
        when (val outcome = store.createNote("Untitled", folder)) {
            is NoteMutationOutcome.Committed -> {
                if (atTop) listState.requestScrollToItem(0)
                onCreate(outcome.value)
                outcome.value
            }
            NoteMutationOutcome.Failed -> {
                Toast.makeText(
                    context,
                    localization.localizedText("notes.errors.createFailed"),
                    Toast.LENGTH_SHORT,
                ).show()
                null
            }
        }
    }
}
