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
    deleteTarget?.let { id ->
        ConfirmDialog(
            title = localization.localizedText("notes.delete.thisNoteQuestion"),
            body = localization.localizedText("notes.delete.recoverableWarning"),
            confirmLabel = localization.localizedText("common.actions.delete"),
            onConfirm = {
                onDeleteTargetChange(null)
                scope.launch {
                    val outcome = store.delete(id)
                    if (shouldCompleteNoteAction(outcome)) {
                        Toast.makeText(
                            context,
                            localization.localizedText("notes.deleted"),
                            Toast.LENGTH_SHORT,
                        ).show()
                    } else {
                        Toast.makeText(
                            context,
                            localization.localizedText("notes.errors.deleteFailed"),
                            Toast.LENGTH_SHORT,
                        ).show()
                    }
                }
            },
            onDismiss = { onDeleteTargetChange(null) },
        )
    }

    if (moveTarget != null) {
        FolderPickerSheet(
            store = store,
            onDismiss = { onMoveTargetChange(null) },
            onPick = { destination, isNew ->
                val id = moveTarget ?: return@FolderPickerSheet
                scope.launch {
                    when (store.moveNote(id, destination, createFolder = isNew)) {
                        is NoteMutationOutcome.Committed -> {
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
                }
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
            allowCreate = false,
            onDismiss = { onMoveFolderTargetChange(null) },
            onPick = { destination, _ ->
                onMoveFolderTargetChange(null)
                scope.launch {
                    val finalFolder = store.moveFolder(target, destination)
                    if (finalFolder != null) {
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
                }
            },
        )
    }

    confirmDeleteFolder?.let { target ->
        ConfirmDialog(
            title = localization.localizedText("folders.delete.thisFolderQuestion"),
            body = localization.localizedText("folders.delete.moveContentsWarning"),
            confirmLabel = localization.localizedText("common.actions.delete"),
            onConfirm = {
                onConfirmDeleteFolderChange(null)
                scope.launch {
                    // MOVE-UP delete [list.md]: Rust bails atomically, so a
                    // null here means the folder (and its notes) are untouched.
                    // The deleted folder leaves `store.folders`, and
                    // AppNavigation's retainFolders effect drops any route into
                    // it — no explicit pop needed here.
                    val moved = store.deleteFolder(target)
                    if (moved != null) {
                        val message = folderDeletedMessage(moved)
                        Toast.makeText(
                            context,
                            localization.localizedText(message.path, message.arguments),
                            Toast.LENGTH_SHORT,
                        ).show()
                    } else {
                        Toast.makeText(
                            context,
                            localization.localizedText("folders.errors.deleteFailed"),
                            Toast.LENGTH_SHORT,
                        ).show()
                    }
                }
            },
            onDismiss = { onConfirmDeleteFolderChange(null) },
        )
    }
}
