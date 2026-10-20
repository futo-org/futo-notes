package com.futo.notes

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File

sealed interface NoteMutationOutcome<out T> {
    data class Committed<T>(val value: T) : NoteMutationOutcome<T>
    data object Failed : NoteMutationOutcome<Nothing>
}

/**
 * A committed rename or move: the note's final id, and — only when the
 * engine's relink rewrote the note's OWN links (a self-link) — the body it left
 * on disk. The editor saved a draft carrying the old link text and the relink
 * then changed it, so the editor's baseline must become this body, not the
 * draft (RC-71: the pre-relink baseline made the next save read the relink as a
 * peer's edit and park a conflict copy). Mirrors iOS `CommittedNote`.
 */
data class CommittedNote(val id: String, val relinkedBody: String?)

/** What the editor holds after a rename/move whose relink rewrote its own body. */
data class RelinkRebase(
    /** The baseline: what the file now holds. */
    val savedContent: String,
    /** The editor's text. */
    val content: String,
    /** Push [content] into the live editor (selection-preserving adopt). */
    val adoptIntoEditor: Boolean,
)

/**
 * [flushed] is the draft the engine saved before it relinked; [live] is what
 * the editor holds now; [relinkedBody] is the file after the relink.
 *
 * The file is the baseline whatever the editor holds. When nothing was typed
 * since the snapshot the editor adopts the file, so it shows the relinked link
 * text. A draft typed while the workflow committed is kept (the same
 * rebase-and-keep the desktop session applies): it still carries the old link
 * text and is saved over the file without a conflict copy (RC-70). Mirrors iOS
 * `rebasedOnRelink`.
 */
internal fun rebasedOnRelink(flushed: String, live: String, relinkedBody: String?): RelinkRebase {
    if (relinkedBody == null || relinkedBody == flushed) {
        return RelinkRebase(flushed, live, adoptIntoEditor = false)
    }
    if (live != flushed) return RelinkRebase(relinkedBody, live, adoptIntoEditor = false)
    return RelinkRebase(relinkedBody, relinkedBody, adoptIntoEditor = true)
}

/**
 * Run [action] and, if it fails, delete [file] before propagating — the F8
 * rule for a just-saved editor image that never got consumed. [action] is
 * `NotesStore.saveImageIntoVault`'s `useSavedImage`: a timed-out or
 * unavailable WebView insertion (`EditorWebView.insertImageAndWait`, F3)
 * throws, and per spec a stale or failed completion leaves no orphaned blob
 * in the vault (docs/spec/editor.md, "A delayed image completion belongs to
 * the note it was started on"). `CancellationException` is deleted-then-
 * rethrown, never swallowed, so a cancelled caller is still told it was
 * cancelled — catching plain `Exception` around this used to eat it.
 *
 * Free of `NotesStore`'s FFI-backed `core` and `Main`-dispatcher init, so
 * this is assertable in a plain JVM test unlike `saveImageIntoVault` itself.
 */
internal suspend fun deleteImageOnFailure(file: File, action: suspend () -> Unit) {
    try {
        action()
    } catch (e: CancellationException) {
        file.delete()
        throw e
    } catch (e: Exception) {
        file.delete()
        throw e
    }
}

internal fun confirmedSavedContent(
    previousSavedContent: String,
    writtenContent: String,
    outcome: NoteMutationOutcome<Unit>,
): String = when (outcome) {
    is NoteMutationOutcome.Committed -> writtenContent
    NoteMutationOutcome.Failed -> previousSavedContent
}

internal fun shouldCompleteNoteAction(outcome: NoteMutationOutcome<*>): Boolean =
    outcome is NoteMutationOutcome.Committed

internal fun shouldContinueDeleteAfterEditorWrite(
    hasPendingChanges: Boolean,
    outcome: NoteMutationOutcome<Unit>?,
): Boolean = !hasPendingChanges || outcome is NoteMutationOutcome.Committed

internal suspend fun <T> runMutationTransaction(
    transaction: suspend () -> T,
): T {
    currentCoroutineContext().ensureActive()
    return withContext(NonCancellable) {
        transaction()
    }
}
