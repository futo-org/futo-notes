package com.futo.notes

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import uniffi.futo_notes_ffi.FlushDisposition

/** Keep a native editor's leave commit alive after its screen leaves composition. */
fun NotesStore.launchEditorLeave(block: suspend () -> Unit): Job {
    val job = scope.launch { block() }
    if (!job.isCompleted) {
        editorLeaves += job
        job.invokeOnCompletion { editorLeaves -= job }
    }
    return job
}

/** A reopened note must wait for the native session just left to finish saving. */
suspend fun NotesStore.awaitEditorLeaves() {
    while (true) {
        val pending = editorLeaves.firstOrNull() ?: break
        pending.join()
    }
}

/** Persist-or-park an explicitly supplied snapshot through the generic Rust workflow. */
suspend fun NotesStore.flushDraft(draft: PendingDraft, ownerToken: Long? = null): FlushDisposition? =
    if (ownerToken != null && !editorDraftOwnership.owns(ownerToken)) null else try {
        runMutationTransaction {
            val result = withCore { core.flushDraft(draft.id, draft.base, draft.content) }
            result.mutation?.let {
                applyMutation(it)
                signalLocalChange()
            }
            result.disposition
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        android.util.Log.e("NotesStore", "flush failed for ${draft.id}", e)
        null
    }

fun NotesStore.claimDraftOwnership(): Long = editorDraftOwnership.claim()

/** Main-thread projection of the registered native sessions' pending saves. */
fun NotesStore.unsavedNoteIds(): List<String> =
    nativeEditorDrafts.values.mapNotNull { it.unsavedNoteId() }.distinct().sorted()

/** Settle native sessions before a language recreation or an explicit saved-file read. */
suspend fun NotesStore.checkpointNativeEditors(): Boolean {
    if (isVaultMigrationStarted) return false
    awaitEditorLeaves()
    return checkpointNativeDrafts(nativeEditorDrafts.values.toList())
}
