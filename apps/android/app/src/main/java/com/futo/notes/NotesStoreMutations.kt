package com.futo.notes

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/** Write one note and consume the complete committed mutation. */
suspend fun NotesStore.write(id: String, content: String, ownerToken: Long? = null): NoteMutationOutcome<Unit> =
    try {
        check(ownerToken == null || pendingEditor.owns(ownerToken)) { "Editor was retired by reset" }
        runMutationTransaction {
            val retainedAtAdmission = pendingEditor.retainedSnapshot(id)
            val mutation = withCore { core.write(id, content) }
            applyMutation(mutation)
            pendingEditor.completeSnapshot(retainedAtAdmission)
            signalLocalChange()
            NoteMutationOutcome.Committed(Unit)
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        android.util.Log.e("NotesStore", "write failed for $id", e)
        NoteMutationOutcome.Failed
    }

/** Create one note and report an explicit outcome, like every other note
 *  mutation here. It used to return `String?`, which the FAB consumed as
 *  `?.let { open(it) }` — so ANY failure (a Rust `NoteError`, a poisoned
 *  vault-mutation lock, storage paused for migration) left the user looking
 *  at an unchanged list with no note, no editor, and no message. That is
 *  exactly what github#13 reports ("nothing visible happens"), and it is
 *  also why the report carries no evidence: only logcat knew. The failure is
 *  now surfaced the way New Folder's already is. */
suspend fun NotesStore.createNote(title: String, folder: String = ""): NoteMutationOutcome<String> =
    try {
        runMutationTransaction {
            val mutation = withCore { core.createNote(title, folder, "") }
            applyMutation(mutation)
            val createdId = mutation.finalId ?: title
            editorDraftCoordinator.reopen(createdId)
            signalLocalChange()
            NoteMutationOutcome.Committed(createdId)
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        android.util.Log.e("NotesStore", "createNote failed in folder '$folder'", e)
        NoteMutationOutcome.Failed
    }

suspend fun NotesStore.delete(id: String, ownerToken: Long? = null): NoteMutationOutcome<Unit> {
    if (ownerToken != null && !pendingEditor.owns(ownerToken)) return NoteMutationOutcome.Failed
    currentCoroutineContext().ensureActive()
    val identity = editorDraftCoordinator.beginIdentityMutation(id)
    val pendingFlushes = editorDraftTail
    return try {
        pendingFlushes?.join()
        if (ownerToken != null && !pendingEditor.owns(ownerToken)) return NoteMutationOutcome.Failed
        runMutationTransaction {
            val mutation = withCore { core.delete(id) }
            applyMutation(mutation)
            pendingEditor.discardNote(id)
            editorDraftCoordinator.finishIdentityMutation(identity, committed = true)
            signalLocalChange()
            NoteMutationOutcome.Committed(Unit)
        }
    } catch (e: CancellationException) {
        editorDraftCoordinator.finishIdentityMutation(identity, committed = false)
        throw e
    } catch (e: Exception) {
        editorDraftCoordinator.finishIdentityMutation(identity, committed = false)
        android.util.Log.e("NotesStore", "delete failed", e)
        NoteMutationOutcome.Failed
    }
}

/** Fire-and-forget delete for the editor's `onDispose` (can't suspend; the
 *  composable's scope is already gone). Runs on the store's scope, which
 *  outlives the screen — used to discard an untouched quick-capture note on
 *  back-out (NoteEditorScreen.kt onDispose). Mirrors [flushAsync]. */
fun NotesStore.deleteAsync(id: String, ownerToken: Long? = null) {
    if (ownerToken != null && !pendingEditor.owns(ownerToken)) return
    scope.launch { delete(id, ownerToken = ownerToken) }
}

suspend fun NotesStore.rename(oldId: String, newId: String, draft: PendingDraft? = null, ownerToken: Long? = null): NoteMutationOutcome<CommittedNote> {
    if (ownerToken != null && !pendingEditor.owns(ownerToken)) return NoteMutationOutcome.Failed
    currentCoroutineContext().ensureActive()
    val identity = editorDraftCoordinator.beginIdentityMutation(oldId)
    val pendingFlushes = editorDraftTail
    return try {
        pendingFlushes?.join()
        if (ownerToken != null && !pendingEditor.owns(ownerToken)) return NoteMutationOutcome.Failed
        runMutationTransaction {
            val mutation = withCore {
                if (draft == null) core.rename(oldId, newId)
                else core.saveDraftAs(oldId, newId, draft.base, draft.content)
            }
            val finalId = mutation.finalId ?: oldId
            applyMutation(mutation)
            pendingEditor.retargetRetainedNote(oldId, finalId)
            editorDraftCoordinator.finishIdentityMutation(identity, committed = true)
            editorDraftCoordinator.reopen(finalId)
            signalLocalChange()
            NoteMutationOutcome.Committed(CommittedNote(finalId, mutation.finalBody))
        }
    } catch (e: CancellationException) {
        editorDraftCoordinator.finishIdentityMutation(identity, committed = false)
        throw e
    } catch (e: Exception) {
        editorDraftCoordinator.finishIdentityMutation(identity, committed = false)
        android.util.Log.e("NotesStore", "rename failed", e)
        NoteMutationOutcome.Failed
    }
}

suspend fun NotesStore.moveNote(
    id: String,
    toFolder: String,
    createFolder: Boolean = false,
    draft: PendingDraft? = null,
    ownerToken: Long? = null,
): NoteMutationOutcome<CommittedNote> {
    if (ownerToken != null && !pendingEditor.owns(ownerToken)) return NoteMutationOutcome.Failed
    currentCoroutineContext().ensureActive()
    val identity = editorDraftCoordinator.beginIdentityMutation(id)
    val pendingFlushes = editorDraftTail
    return try {
        pendingFlushes?.join()
        if (ownerToken != null && !pendingEditor.owns(ownerToken)) return NoteMutationOutcome.Failed
        runMutationTransaction {
            val mutation = withCore {
                if (draft != null) {
                    core.moveDraft(id, toFolder, draft.base, draft.content, createFolder)
                } else if (createFolder) {
                    core.moveNoteToNewFolder(id, toFolder)
                } else {
                    core.moveNote(id, toFolder)
                }
            }
            val finalId = mutation.finalId ?: id
            applyMutation(mutation)
            pendingEditor.retargetRetainedNote(id, finalId)
            editorDraftCoordinator.finishIdentityMutation(identity, committed = true)
            editorDraftCoordinator.reopen(finalId)
            signalLocalChange()
            NoteMutationOutcome.Committed(CommittedNote(finalId, mutation.finalBody))
        }
    } catch (e: CancellationException) {
        editorDraftCoordinator.finishIdentityMutation(identity, committed = false)
        throw e
    } catch (e: Exception) {
        editorDraftCoordinator.finishIdentityMutation(identity, committed = false)
        android.util.Log.e("NotesStore", "moveNote failed", e)
        NoteMutationOutcome.Failed
    }
}

suspend fun NotesStore.createFolder(path: String): NoteMutationOutcome<Unit> =
    try {
        runMutationTransaction {
            val mutation = withCore { core.createFolder(path) }
            applyMutation(mutation)
            signalLocalChange()
            NoteMutationOutcome.Committed(Unit)
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        android.util.Log.e("NotesStore", "createFolder failed", e)
        NoteMutationOutcome.Failed
    }

suspend fun NotesStore.renameFolder(from: String, to: String): String? =
    try {
        runMutationTransaction {
            val mutation = withCore { core.renameFolder(from, to) }
            applyMutation(mutation)
            signalLocalChange()
            mutation.finalFolder ?: to
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        android.util.Log.e("NotesStore", "renameFolder failed $from -> $to", e)
        null
    }

suspend fun NotesStore.moveFolder(from: String, destinationParent: String): String? =
    try {
        runMutationTransaction {
            val mutation = withCore { core.moveFolder(from, destinationParent) }
            applyMutation(mutation)
            signalLocalChange()
            mutation.finalFolder ?: from
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        android.util.Log.e(
            "NotesStore",
            "moveFolder failed $from -> $destinationParent",
            e,
        )
        null
    }

/** MOVE-UP folder delete (Tauri parity, [list.md]): notes under
 *  [path] move to the parent (Rust bails atomically — if ANY move fails
 *  nothing is deleted), wikilinks are relinked, then the folder tree goes.
 *  Returns the moved-note count, or null when the FFI rejected the delete
 *  (the folder is left intact). */
suspend fun NotesStore.deleteFolder(path: String): UInt? =
    try {
        runMutationTransaction {
            val mutation = withCore { core.deleteFolder(path) }
            applyMutation(mutation)
            signalLocalChange()
            mutation.removed.size.toUInt()
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        android.util.Log.e("NotesStore", "deleteFolder failed for $path", e)
        null
    }
