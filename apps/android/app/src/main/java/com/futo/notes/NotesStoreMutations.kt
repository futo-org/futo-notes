package com.futo.notes

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** Write one note and consume the complete committed mutation. */
suspend fun NotesStore.write(id: String, content: String, ownerToken: Long? = null): NoteMutationOutcome<Unit> =
    try {
        check(ownerToken == null || editorDraftOwnership.owns(ownerToken)) { "Editor was retired by reset" }
        runMutationTransaction {
            val mutation = withCore { core.write(id, content) }
            applyMutation(mutation)
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
    if (ownerToken != null && !editorDraftOwnership.owns(ownerToken)) return NoteMutationOutcome.Failed
    currentCoroutineContext().ensureActive()
    return try {
        runMutationTransaction {
            val mutation = withCore { core.delete(id) }
            applyMutation(mutation)
            signalLocalChange()
            NoteMutationOutcome.Committed(Unit)
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        android.util.Log.e("NotesStore", "delete failed", e)
        NoteMutationOutcome.Failed
    }
}

suspend fun NotesStore.rename(oldId: String, newId: String, draft: PendingDraft? = null, ownerToken: Long? = null): NoteMutationOutcome<CommittedNote> {
    if (ownerToken != null && !editorDraftOwnership.owns(ownerToken)) return NoteMutationOutcome.Failed
    currentCoroutineContext().ensureActive()
    return try {
        runMutationTransaction {
            val mutation = withCore {
                if (draft == null) core.rename(oldId, newId)
                else core.saveDraftAs(oldId, newId, draft.base, draft.content)
            }
            val finalId = mutation.finalId ?: oldId
            applyMutation(mutation)
            signalLocalChange()
            NoteMutationOutcome.Committed(CommittedNote(finalId, mutation.finalBody))
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        android.util.Log.e("NotesStore", "rename failed", e)
        NoteMutationOutcome.Failed
    }
}

suspend fun NotesStore.moveNote(
    id: String,
    toFolder: String,
    draft: PendingDraft? = null,
    ownerToken: Long? = null,
): NoteMutationOutcome<CommittedNote> {
    if (ownerToken != null && !editorDraftOwnership.owns(ownerToken)) return NoteMutationOutcome.Failed
    currentCoroutineContext().ensureActive()
    return try {
        runMutationTransaction {
            val mutation = withCore {
                if (draft != null) {
                    core.moveDraft(id, toFolder, draft.base, draft.content)
                } else {
                    core.moveNote(id, toFolder)
                }
            }
            val finalId = mutation.finalId ?: id
            applyMutation(mutation)
            signalLocalChange()
            NoteMutationOutcome.Committed(CommittedNote(finalId, mutation.finalBody))
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
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
