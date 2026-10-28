package com.futo.notes.ui

import android.content.Context
import androidx.compose.runtime.Composable
import com.futo.notes.NoteMutationOutcome
import com.futo.notes.NotesStore
import com.futo.notes.localization.Localization
import com.futo.notes.shouldCompleteNoteAction
import com.futo.notes.ui.components.ConfirmDialog
import com.futo.notes.ui.components.FolderPickerSheet
import com.futo.notes.ui.components.NewFolderDialog
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import com.futo.notes.createFolder
import com.futo.notes.delete
import com.futo.notes.deleteFolder
import com.futo.notes.moveFolder
import com.futo.notes.moveNote
import com.futo.notes.renameFolder

/**
 * The row-action dialogs and sheets of [NoteListScreen] [list.md]: delete and
 * move a note, create / rename / move / delete a folder. Each target is owned by
 * the screen (its row menus set it); this only reads it and asks to clear it.
 */
@Composable
internal fun NoteListDialogs(
    store: NotesStore,
    folder: String,
    scope: CoroutineScope,
    context: Context,
    localization: Localization,
    deleteTarget: String?,
    onDeleteTargetChange: (String?) -> Unit,
    moveTarget: String?,
    onMoveTargetChange: (String?) -> Unit,
    newFolderDialog: Boolean,
    onNewFolderDialogChange: (Boolean) -> Unit,
    renameFolderTarget: String?,
    onRenameFolderTargetChange: (String?) -> Unit,
    moveFolderTarget: String?,
    onMoveFolderTargetChange: (String?) -> Unit,
    confirmDeleteFolder: String?,
    onConfirmDeleteFolderChange: (String?) -> Unit,
    onFolderMoved: (from: String, to: String) -> Unit,
) {
    fun toast(key: String, arguments: Map<String, Any> = emptyMap()) =
        showToast(context, localization.localizedText(key, arguments))
    // What the delete dialogs' Delete does.
    suspend fun deleteNote(id: String) {
        toast(if (shouldCompleteNoteAction(store.delete(id))) "notes.deleted" else "notes.errors.deleteFailed")
    }
    suspend fun deleteFolder(path: String) {
        // MOVE-UP delete [list.md]: Rust bails atomically, so a null here means the folder
        // (and its notes) are untouched. The deleted folder leaves `store.folders`, and
        // AppNavigation's retainFolders effect drops any route into it — no explicit pop.
        val moved = store.deleteFolder(path)
        if (moved == null) {
            toast("folders.errors.deleteFailed")
        } else {
            val message = folderDeletedMessage(moved)
            toast(message.path, message.arguments)
        }
    }

    deleteTarget?.let { id ->
        ConfirmDialog(
            title = localization.localizedText("notes.delete.thisNoteQuestion"),
            body = localization.localizedText("notes.delete.recoverableWarning"),
            confirmLabelKey = "common.actions.delete",
            onConfirm = {
                onDeleteTargetChange(null)
                deleteNote(id)
            },
            onDismiss = { onDeleteTargetChange(null) },
        )
    }

    if (moveTarget != null) {
        FolderPickerSheet(
            store = store,
            onDismiss = { onMoveTargetChange(null) },
            onPick = { destination ->
                val id = moveTarget ?: return@FolderPickerSheet null
                val moved = CompletableDeferred<Boolean>()
                scope.launch {
                    when (store.moveNote(id, destination)) {
                        is NoteMutationOutcome.Committed -> {
                            moved.complete(true)
                            onMoveTargetChange(null)
                            if (destination.isEmpty()) {
                                toast("notes.movedToRoot")
                            } else {
                                toast("notes.movedTo", mapOf("destination" to destination))
                            }
                        }
                        NoteMutationOutcome.Failed -> toast("notes.errors.moveFailed")
                    }
                }.invokeOnCompletion { moved.complete(false) }
                moved
            },
        )
    }

    if (newFolderDialog) {
        NewFolderDialog(
            parent = folder,
            store = store,
            onCreate = { path ->
                scope.launch {
                    if (shouldCompleteNoteAction(store.createFolder(path))) {
                        onNewFolderDialogChange(false)
                    } else {
                        toast("folders.errors.createFailed")
                    }
                }
            },
            onDismiss = { onNewFolderDialogChange(false) },
        )
    }

    renameFolderTarget?.let { target ->
        val parent = target.substringBeforeLast('/', "")
        NewFolderDialog(
            parent = parent,
            store = store,
            initialName = target.substringAfterLast('/'),
            title = localization.localizedText("folders.renameHeading"),
            confirmLabel = localization.localizedText("common.actions.rename"),
            excludePath = target,
            renaming = true,
            onCreate = { newPath ->
                onRenameFolderTargetChange(null)
                scope.launch {
                    val finalFolder = store.renameFolder(target, newPath)
                    if (finalFolder != null) {
                        onFolderMoved(target, finalFolder)
                        toast("folders.renamed")
                    } else {
                        toast("folders.errors.renameFailed")
                    }
                }
            },
            onDismiss = { onRenameFolderTargetChange(null) },
        )
    }

    moveFolderTarget?.let { target ->
        FolderPickerSheet(
            store = store,
            title = localization.localizedText(
                "folders.moveNamedHeading",
                mapOf("folderName" to target.substringAfterLast('/')),
            ),
            excludePaths = listOf(target),
            onDismiss = { onMoveFolderTargetChange(null) },
            onPick = { destination ->
                onMoveFolderTargetChange(null)
                val moved = CompletableDeferred<Boolean>()
                scope.launch {
                    val finalFolder = store.moveFolder(target, destination)
                    if (finalFolder != null) {
                        moved.complete(true)
                        onFolderMoved(target, finalFolder)
                        if (destination.isEmpty()) {
                            toast("folders.movedToRoot")
                        } else {
                            toast("folders.movedTo", mapOf("destination" to destination))
                        }
                    } else {
                        toast("folders.errors.moveFailed")
                    }
                }.invokeOnCompletion { moved.complete(false) }
                moved
            },
        )
    }

    confirmDeleteFolder?.let { target ->
        ConfirmDialog(
            title = localization.localizedText("folders.delete.thisFolderQuestion"),
            body = localization.localizedText("folders.delete.moveContentsWarning"),
            confirmLabelKey = "common.actions.delete",
            onConfirm = {
                onConfirmDeleteFolderChange(null)
                deleteFolder(target)
            },
            onDismiss = { onConfirmDeleteFolderChange(null) },
        )
    }
}
