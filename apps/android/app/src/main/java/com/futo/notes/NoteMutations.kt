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

/**
 * Run [action] and, if it fails, delete [file] before propagating — the F8
 * rule for a just-saved editor image that never got consumed. [action] is
 * `NotesStore.saveImageIntoVault`'s `useSavedImage`: a timed-out or
 * unavailable native document insertion
 * throws, and per spec a stale or failed completion leaves no orphaned blob
 * in the vault (docs/spec/editor.md, "A delayed image completion belongs to
 * the note it was started on"). `CancellationException` is deleted-then-
 * rethrown, never swallowed, so a canceled caller is still told it was
 * canceled — catching plain `Exception` around this used to eat it.
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

internal fun shouldCompleteNoteAction(outcome: NoteMutationOutcome<*>): Boolean =
    outcome is NoteMutationOutcome.Committed

internal suspend fun <T> runMutationTransaction(
    transaction: suspend () -> T,
): T {
    currentCoroutineContext().ensureActive()
    return withContext(NonCancellable) {
        transaction()
    }
}
