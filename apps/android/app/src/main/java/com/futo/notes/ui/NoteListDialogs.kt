package com.futo.notes.ui

import android.content.Context
import android.widget.Toast
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
    // What the delete dialogs' Delete does.
    fun toast(key: String, arguments: Map<String, Any> = emptyMap()) =
        Toast.makeText(context, localization.localizedText(key, arguments), Toast.LENGTH_SHORT).show()
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
                            Toast.makeText(
                                context,
                                if (destination.isEmpty()) {
                                    localization.localizedText("notes.movedToRoot")
                                } else {
                                    localization.localizedText(
                                        "notes.movedTo",
                                        mapOf("destination" to destination),
                                    )
                                },
                                Toast.LENGTH_SHORT,
                            ).show()
                        }
                        NoteMutationOutcome.Failed -> Toast.makeText(
                            context,
                            localization.localizedText("notes.errors.moveFailed"),
                            Toast.LENGTH_SHORT,
                        ).show()
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
                        Toast.makeText(
                            context,
                            localization.localizedText("folders.errors.createFailed"),
                            Toast.LENGTH_SHORT,
                        ).show()
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
                        Toast.makeText(
                            context,
                            localization.localizedText("folders.renamed"),
                            Toast.LENGTH_SHORT,
                        ).show()
                    } else {
                        Toast.makeText(
                            context,
                            localization.localizedText("folders.errors.renameFailed"),
                            Toast.LENGTH_SHORT,
                        ).show()
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
                        Toast.makeText(
                            context,
                            if (destination.isEmpty()) {
                                localization.localizedText("folders.movedToRoot")
                            } else {
                                localization.localizedText(
                                    "folders.movedTo",
                                    mapOf("destination" to destination),
                                )
                            },
                            Toast.LENGTH_SHORT,
                        ).show()
                    } else {
                        Toast.makeText(
                            context,
                            localization.localizedText("folders.errors.moveFailed"),
                            Toast.LENGTH_SHORT,
                        ).show()
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
