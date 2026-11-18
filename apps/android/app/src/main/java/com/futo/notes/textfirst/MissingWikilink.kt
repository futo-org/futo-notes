package com.futo.notes.textfirst

import android.content.Context
import com.futo.notes.NoteMutationOutcome
import com.futo.notes.NotesStore
import com.futo.notes.createNote
import com.futo.notes.localization.Localization
import com.futo.notes.ui.showToast
import uniffi.futo_notes_ffi.splitId

/**
 * Following a wikilink no note answers creates the note it names and opens it as a new note, so leaving it untouched
 * deletes it again (Mason's desktop rule; desktop createNoteLoader `noteToOpen`). The store picks a free id.
 */
internal suspend fun openMissingWikilink(
    store: NotesStore,
    target: String,
    localization: Localization,
    context: Context,
    onOpenCreatedNote: (String) -> Unit,
) {
    val parts = splitId(target)
    when (val outcome = store.createNote(parts.title, parts.folder)) {
        is NoteMutationOutcome.Committed -> onOpenCreatedNote(outcome.value)
        NoteMutationOutcome.Failed ->
            showToast(context, localization.localizedText("notes.errors.createFailed"))
    }
}
