package com.futo.notes.ui

import android.widget.Toast
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.DriveFileMove
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.futo.notes.NoteMutationOutcome
import com.futo.notes.NotesStore
import com.futo.notes.shouldCompleteNoteAction
import com.futo.notes.ui.components.ConfirmDialog
import com.futo.notes.ui.components.FolderPickerSheet
import com.futo.notes.ui.components.FutoTopBar
import com.futo.notes.ui.components.NewFolderDialog
import com.futo.notes.ui.components.NoteCard
import com.futo.notes.ui.components.pressScale
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.launch

/**
 * One folder's contents [list.md "Folder browsing"]: its immediate subfolders
 * above its own notes, in a single scrolling list. `folder` is "" at the vault
 * root, which IS the home screen — there is no drawer and no flat "all notes"
 * view. Tapping a subfolder row pushes another instance of this screen for that
 * folder, mirroring the iOS `FolderContentsView` recursion.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun NoteListScreen(
    store: NotesStore,
    state: NoteListState,
    folder: String,
    onOpenNote: (String) -> Unit,
    onCreate: (String) -> Unit,
    onOpenFolder: (String) -> Unit,
    onFolderMoved: (from: String, to: String) -> Unit,
    onOpenSearch: () -> Unit,
    onOpenSettings: () -> Unit,
    onBack: () -> Unit,
) {
    val c = FutoTheme.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val listState = state.scrollStateFor(folder)
    val isRoot = folder.isEmpty()

    // Row actions [list.md]: long-press targets, hoisted so the dialogs/sheet
    // live outside the LazyColumn items.
    var deleteTarget by remember { mutableStateOf<String?>(null) }
    var moveTarget by remember { mutableStateOf<String?>(null) }
    var newFolderDialog by remember { mutableStateOf(false) }
    var renameFolderTarget by remember { mutableStateOf<String?>(null) }
    var moveFolderTarget by remember { mutableStateOf<String?>(null) }
    var confirmDeleteFolder by remember { mutableStateOf<String?>(null) }

    val scrolled by remember(listState) {
        derivedStateOf {
            listState.firstVisibleItemIndex > 0 || listState.firstVisibleItemScrollOffset > 4
        }
    }

    val subfolders = store.subfolders(folder)
    val notes = store.notesIn(folder)
    val title = if (isRoot) "Notes" else folder.substringAfterLast('/')

    Scaffold(
        containerColor = c.surface,
        topBar = {
            FutoTopBar(
                title = { Text(title, style = FutoType.title, color = c.textPrimary) },
                navigationIcon = {
                    // The root folder is the stack floor [nav.md], so it shows no
                    // up affordance; a pushed folder pops exactly like Back.
                    if (!isRoot) {
                        IconButton(onClick = onBack) {
                            Icon(
                                Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = "Back",
                                tint = c.textSecondary,
                            )
                        }
                    }
                },
                actions = {
                    IconButton(onClick = onOpenSearch) {
                        Icon(Icons.Filled.Search, contentDescription = "Search", tint = c.textSecondary)
                    }
                    // Settings lived at the bottom of the removed drawer; it is
                    // now a top-bar gear on every folder screen, mirroring iOS.
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Filled.Settings, contentDescription = "Settings", tint = c.textSecondary)
                    }
                },
                modifier = if (scrolled) Modifier.drawWithContent {
                    drawContent()
                    val stroke = 1.dp.toPx()
                    val y = size.height - stroke / 2
                    drawLine(c.border, Offset(0f, y), Offset(size.width, y), stroke)
                } else Modifier,
            )
        },
        floatingActionButton = {
            // Expandable create menu [list.md]: New note / New folder, both
            // landing in THIS folder.
            var fabMenu by remember { mutableStateOf(false) }
            val interaction = remember { MutableInteractionSource() }
            val scale = pressScale(interaction, 0.97f)
            Box {
                FloatingActionButton(
                    onClick = { fabMenu = true },
                    interactionSource = interaction,
                    containerColor = c.accent,
                    contentColor = Color.White,
                    shape = RoundedCornerShape(FutoRadius.lg),
                    modifier = Modifier.padding(2.dp).graphicsLayer { scaleX = scale; scaleY = scale },
                ) {
                    Icon(Icons.Filled.Add, contentDescription = "Create")
                }
                DropdownMenu(expanded = fabMenu, onDismissRequest = { fabMenu = false }) {
                    DropdownMenuItem(
                        text = { Text("New note") },
                        leadingIcon = { Icon(Icons.Filled.Description, contentDescription = null, tint = c.textSecondary) },
                        onClick = {
                            fabMenu = false
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
                            // `createNote` is suspend (FFI write on IO). Launch on the
                            // composable's main scope; the navigate callback runs after
                            // it returns (resumes on Main, safe for Compose state).
                            scope.launch {
                                // Consume the explicit outcome: open the note only on a
                                // committed create, and SAY SO when it failed. A silent
                                // no-op here is what github#13 reports.
                                when (val outcome = store.createNote("Untitled", folder)) {
                                    is NoteMutationOutcome.Committed -> {
                                        if (atTop) listState.requestScrollToItem(0)
                                        onCreate(outcome.value)
                                    }
                                    NoteMutationOutcome.Failed ->
                                        Toast.makeText(
                                            context,
                                            "Couldn't create note. Try again.",
                                            Toast.LENGTH_SHORT,
                                        ).show()
                                }
                            }
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("New folder") },
                        leadingIcon = { Icon(Icons.Filled.CreateNewFolder, contentDescription = null, tint = c.textSecondary) },
                        onClick = {
                            fabMenu = false
                            newFolderDialog = true
                        },
                    )
                }
            }
        },
    ) { padding ->
        // hasBootstrapped distinguishes "still scanning" from "really empty"
        // (M1) — flashing the empty state on a cold start reads as data loss.
        if (store.hasBootstrapped && subfolders.isEmpty() && notes.isEmpty()) {
            Box(Modifier.padding(padding).fillMaxSize()) { EmptyState(isRoot = isRoot) }
        } else {
            LazyColumn(
                state = listState,
                contentPadding = PaddingValues(
                    start = 16.dp,
                    end = 16.dp,
                    top = padding.calculateTopPadding() + 8.dp,
                    bottom = 96.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                // Folders are a BLOCK above the notes, never interleaved. The
                // engine emits `folders` from a BTreeSet, so this prefix filter
                // arrives alphabetical; notes keep engine order verbatim
                // (ADR-0001 — no shell comparator).
                items(subfolders, key = { "folder:$it" }) { child ->
                    var menu by remember { mutableStateOf(false) }
                    Box {
                        FolderCard(
                            path = child,
                            onClick = { onOpenFolder(child) },
                            onLongClick = { menu = true },
                        )
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(
                                text = { Text("Rename") },
                                leadingIcon = { Icon(Icons.Filled.Edit, contentDescription = null, tint = c.textSecondary) },
                                onClick = { menu = false; renameFolderTarget = child },
                            )
                            DropdownMenuItem(
                                text = { Text("Move to Folder…") },
                                leadingIcon = { Icon(Icons.AutoMirrored.Filled.DriveFileMove, contentDescription = null, tint = c.textSecondary) },
                                onClick = { menu = false; moveFolderTarget = child },
                            )
                            DropdownMenuItem(
                                text = { Text("Delete folder", color = c.danger) },
                                leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null, tint = c.danger) },
                                onClick = { menu = false; confirmDeleteFolder = child },
                            )
                        }
                    }
                }
                items(notes, key = { "note:${it.id}" }) { note ->
                    // Long-press actions menu on each card [list.md].
                    var menu by remember { mutableStateOf(false) }
                    Box {
                        NoteCard(
                            note,
                            onClick = { onOpenNote(note.id) },
                            onLongClick = { menu = true },
                        )
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(
                                text = { Text("Move to Folder…") },
                                leadingIcon = { Icon(Icons.AutoMirrored.Filled.DriveFileMove, contentDescription = null, tint = c.textSecondary) },
                                onClick = { menu = false; moveTarget = note.id },
                            )
                            DropdownMenuItem(
                                text = { Text("Delete") },
                                leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null, tint = c.danger) },
                                onClick = { menu = false; deleteTarget = note.id },
                            )
                        }
                    }
                }
            }
        }
    }

    deleteTarget?.let { id ->
        ConfirmDialog(
            title = "Delete this note?",
            body = "This action cannot be undone.",
            confirmLabel = "Delete",
            onConfirm = {
                deleteTarget = null
                scope.launch {
                    val outcome = store.delete(id)
                    if (shouldCompleteNoteAction(outcome)) {
                        Toast.makeText(context, "Note deleted", Toast.LENGTH_SHORT).show()
                    } else {
                        Toast.makeText(
                            context,
                            "Couldn't delete note. It remains in your notes.",
                            Toast.LENGTH_SHORT,
                        ).show()
                    }
                }
            },
            onDismiss = { deleteTarget = null },
        )
    }

    if (moveTarget != null) {
        FolderPickerSheet(
            store = store,
            onDismiss = { moveTarget = null },
            onPick = { destination, isNew ->
                val id = moveTarget ?: return@FolderPickerSheet
                scope.launch {
                    when (store.moveNote(id, destination, createFolder = isNew)) {
                        is NoteMutationOutcome.Committed -> {
                            moveTarget = null
                            Toast.makeText(
                                context,
                                "Moved to ${destination.ifEmpty { "Root" }}",
                                Toast.LENGTH_SHORT,
                            ).show()
                        }
                        NoteMutationOutcome.Failed -> Toast.makeText(
                            context,
                            "Couldn't move note. It remains in its current folder.",
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
                        newFolderDialog = false
                    } else {
                        Toast.makeText(
                            context,
                            "Couldn't create folder. Try again.",
                            Toast.LENGTH_SHORT,
                        ).show()
                    }
                }
            },
            onDismiss = { newFolderDialog = false },
        )
    }

    renameFolderTarget?.let { target ->
        val parent = target.substringBeforeLast('/', "")
        NewFolderDialog(
            parent = parent,
            store = store,
            initialName = target.substringAfterLast('/'),
            title = "Rename folder",
            confirmLabel = "Rename",
            excludePath = target,
            onCreate = { newPath ->
                renameFolderTarget = null
                scope.launch {
                    val finalFolder = store.renameFolder(target, newPath)
                    if (finalFolder != null) {
                        onFolderMoved(target, finalFolder)
                        Toast.makeText(context, "Folder renamed", Toast.LENGTH_SHORT).show()
                    } else {
                        Toast.makeText(context, "Couldn't rename folder", Toast.LENGTH_SHORT).show()
                    }
                }
            },
            onDismiss = { renameFolderTarget = null },
        )
    }

    moveFolderTarget?.let { target ->
        FolderPickerSheet(
            store = store,
            title = "Move \"${target.substringAfterLast('/')}\"",
            excludePaths = listOf(target),
            allowCreate = false,
            onDismiss = { moveFolderTarget = null },
            onPick = { destination, _ ->
                moveFolderTarget = null
                scope.launch {
                    val finalFolder = store.moveFolder(target, destination)
                    if (finalFolder != null) {
                        onFolderMoved(target, finalFolder)
                        Toast.makeText(
                            context,
                            "Moved to ${destination.ifEmpty { "Root" }}",
                            Toast.LENGTH_SHORT,
                        ).show()
                    } else {
                        Toast.makeText(
                            context,
                            "Couldn't move folder — nothing was changed",
                            Toast.LENGTH_SHORT,
                        ).show()
                    }
                }
            },
        )
    }

    confirmDeleteFolder?.let { target ->
        ConfirmDialog(
            title = "Delete this folder?",
            body = "Notes inside it will be moved to the parent folder.",
            confirmLabel = "Delete",
            onConfirm = {
                confirmDeleteFolder = null
                scope.launch {
                    // MOVE-UP delete [list.md]: Rust bails atomically, so a
                    // null here means the folder (and its notes) are untouched.
                    // The deleted folder leaves `store.folders`, and
                    // AppNavigation's retainFolders effect drops any route into
                    // it — no explicit pop needed here.
                    val moved = store.deleteFolder(target)
                    if (moved != null) {
                        Toast.makeText(context, folderDeletedToast(moved), Toast.LENGTH_SHORT).show()
                    } else {
                        Toast.makeText(context, "Couldn't delete folder — nothing was changed", Toast.LENGTH_SHORT).show()
                    }
                }
            },
            onDismiss = { confirmDeleteFolder = null },
        )
    }
}

/** Toast body for a MOVE-UP folder delete [list.md]. Pluralizes the
 *  moved-note count ("moved 1 note" / "moved N notes") — pinned by
 *  FolderDeleteToastTest. */
internal fun folderDeletedToast(moved: UInt): String =
    "Folder deleted; moved $moved " + if (moved == 1u) "note" else "notes"

/** Rank changes re-pin only an at-top viewport; the four-pixel allowance
 *  absorbs overscroll settling without disturbing deep scrolls [list.md]. */
internal fun isAtListTop(firstVisibleItemIndex: Int, firstVisibleItemScrollOffset: Int): Boolean =
    firstVisibleItemIndex == 0 && firstVisibleItemScrollOffset <= 4

/**
 * A subfolder row in the folder list. Sits in the same 16.dp gutter as
 * [NoteCard] but reads as a folder: folder icon, name, trailing chevron. Long
 * press opens Rename / Move to Folder… / Delete folder — the action set the
 * drawer's folder rows used to carry [list.md "Folder browsing"].
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FolderCard(
    path: String,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    val c = FutoTheme.colors
    val name = path.substringAfterLast('/')
    val interaction = remember { MutableInteractionSource() }
    val scale = pressScale(interaction, pressedScale = 0.99f)

    Surface(
        shape = RoundedCornerShape(FutoRadius.md),
        color = c.surface,
        border = BorderStroke(1.dp, c.border),
        modifier = Modifier
            .fillMaxWidth()
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .clip(RoundedCornerShape(FutoRadius.md))
            .combinedClickable(
                interactionSource = interaction,
                indication = LocalIndication.current,
                onClick = onClick,
                onLongClick = onLongClick,
            )
            // A stable, path-qualified description so automation can find one
            // folder row among several with the same leaf name.
            .semantics { contentDescription = "Folder $path" },
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 15.dp),
        ) {
            Icon(Icons.Filled.Folder, contentDescription = null, tint = c.accent, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(12.dp))
            Text(
                text = name,
                style = FutoType.title.copy(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = c.textMuted,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

/**
 * Empty state, distinguishing the vault root from an empty folder the way iOS
 * does [list.md "Folder browsing"].
 */
@Composable
private fun EmptyState(isRoot: Boolean) {
    val c = FutoTheme.colors
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
                modifier = Modifier.size(72.dp).background(c.surfaceSunken, RoundedCornerShape(FutoRadius.lg)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (isRoot) Icons.Filled.Description else Icons.Filled.Folder,
                    contentDescription = null,
                    tint = c.textMuted,
                    modifier = Modifier.size(30.dp),
                )
            }
            Spacer(Modifier.height(16.dp))
            Text(
                if (isRoot) "No notes yet" else "Empty folder",
                style = FutoType.title,
                color = c.textPrimary,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                "Tap + to add a note or folder.",
                style = FutoType.small,
                color = c.textTertiary,
            )
        }
    }
}
