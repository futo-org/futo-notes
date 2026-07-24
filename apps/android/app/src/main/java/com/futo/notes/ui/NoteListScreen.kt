package com.futo.notes.ui

import android.widget.Toast
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.automirrored.filled.DriveFileMove
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberDrawerState
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.futo.notes.NoteMutationOutcome
import com.futo.notes.NotesStore
import com.futo.notes.shouldCompleteNoteAction
import com.futo.notes.ui.components.ConfirmDialog
import com.futo.notes.ui.components.FolderPickerSheet
import com.futo.notes.ui.components.MicroLabel
import com.futo.notes.ui.components.NewFolderDialog
import com.futo.notes.ui.components.NoteCard
import com.futo.notes.ui.components.pressScale
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.launch

private const val ALL = "__all" // sentinel; real folders are never empty+this

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NoteListScreen(
    store: NotesStore,
    // Hoisted to MainActivity so the scroll position survives navigation
    // [list.md:59] — this screen leaves composition whenever another screen
    // is pushed, so a screen-local rememberLazyListState would reset on pop.
    listState: LazyListState,
    onOpenNote: (String) -> Unit,
    onCreate: (String) -> Unit,
    onOpenSearch: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val c = FutoTheme.colors
    val context = LocalContext.current
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var currentFolder by remember { mutableStateOf(ALL) } // ALL = all notes

    // Row actions [list.md:62 + 71]: long-press targets, hoisted so the
    // dialogs/sheet live outside the LazyColumn items.
    var deleteTarget by remember { mutableStateOf<String?>(null) }
    var moveTarget by remember { mutableStateOf<String?>(null) }
    var newFolderDialog by remember { mutableStateOf(false) }
    var renameFolderTarget by remember { mutableStateOf<String?>(null) }
    var moveFolderTarget by remember { mutableStateOf<String?>(null) }
    var confirmDeleteFolder by remember { mutableStateOf<String?>(null) }

    val scrolled by remember {
        derivedStateOf {
            listState.firstVisibleItemIndex > 0 || listState.firstVisibleItemScrollOffset > 4
        }
    }

    val notes = if (currentFolder == ALL) store.notes else store.notesIn(currentFolder)
    val folderName = if (currentFolder == ALL) "All notes" else currentFolder.substringAfterLast('/')

    ModalNavigationDrawer(
        drawerState = drawerState,
        scrimColor = c.surfaceInverse.copy(alpha = 0.38f),
        drawerContent = {
            LibraryDrawer(
                store = store,
                currentFolder = currentFolder,
                onSelectFolder = {
                    currentFolder = it
                    scope.launch { drawerState.close() }
                },
                onRenameFolder = { renameFolderTarget = it },
                onMoveFolder = { moveFolderTarget = it },
                onDeleteFolder = { confirmDeleteFolder = it },
                onSettings = {
                    scope.launch { drawerState.close() }
                    onOpenSettings()
                },
            )
        },
    ) {
        Scaffold(
            containerColor = c.surface,
            topBar = {
                TopAppBar(
                    title = { Text(folderName, style = FutoType.title, color = c.textPrimary) },
                    navigationIcon = {
                        IconButton(onClick = { scope.launch { drawerState.open() } }) {
                            Icon(Icons.Filled.Menu, contentDescription = "Folders", tint = c.textSecondary)
                        }
                    },
                    actions = {
                        IconButton(onClick = onOpenSearch) {
                            Icon(Icons.Filled.Search, contentDescription = "Search", tint = c.textSecondary)
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = if (scrolled) c.surface else Color.Transparent,
                        scrolledContainerColor = c.surface,
                    ),
                    modifier = if (scrolled) Modifier.border(width = 1.dp, color = c.border) else Modifier,
                )
            },
            floatingActionButton = {
                // Expandable create menu [list.md:78]: New note / New folder.
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
                                val folder = if (currentFolder == ALL) "" else currentFolder
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
                                    store.createNote("Untitled", folder)?.let { id ->
                                        if (atTop) listState.requestScrollToItem(0)
                                        onCreate(id)
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
            if (notes.isEmpty()) {
                Box(Modifier.padding(padding).fillMaxSize()) { EmptyState() }
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
                    items(notes, key = { it.id }) { note ->
                        // Long-press actions menu on each card [list.md:62].
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
            onPick = { folder, isNew ->
                val id = moveTarget ?: return@FolderPickerSheet
                scope.launch {
                    when (store.moveNote(id, folder, createFolder = isNew)) {
                        is NoteMutationOutcome.Committed -> {
                            moveTarget = null
                            Toast.makeText(
                                context,
                                "Moved to ${folder.ifEmpty { "Root" }}",
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
            parent = if (currentFolder == ALL) "" else currentFolder,
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
                        currentFolder = rebaseFolderPath(currentFolder, target, finalFolder)
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
                        currentFolder = rebaseFolderPath(currentFolder, target, finalFolder)
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

    confirmDeleteFolder?.let { folder ->
        ConfirmDialog(
            title = "Delete this folder?",
            body = "Notes inside it will be moved to the parent folder.",
            confirmLabel = "Delete",
            onConfirm = {
                confirmDeleteFolder = null
                scope.launch {
                    // MOVE-UP delete [list.md:121]: Rust bails atomically, so a
                    // null here means the folder (and its notes) are untouched.
                    val moved = store.deleteFolder(folder)
                    if (moved != null) {
                        if (currentFolder == folder || currentFolder.startsWith("$folder/")) currentFolder = ALL
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

/** Toast body for a MOVE-UP folder delete [list.md:121]. Pluralizes the
 *  moved-note count ("moved 1 note" / "moved N notes") — pinned by
 *  FolderDeleteToastTest. */
internal fun folderDeletedToast(moved: UInt): String =
    "Folder deleted; moved $moved " + if (moved == 1u) "note" else "notes"

/** Rank changes re-pin only an at-top viewport; the four-pixel allowance
 *  absorbs overscroll settling without disturbing deep scrolls [list.md:41,59]. */
internal fun isAtListTop(firstVisibleItemIndex: Int, firstVisibleItemScrollOffset: Int): Boolean =
    firstVisibleItemIndex == 0 && firstVisibleItemScrollOffset <= 4

internal fun rebaseFolderPath(current: String, from: String, to: String): String = when {
    current == from -> to
    current.startsWith("$from/") -> "$to/${current.removePrefix("$from/")}"
    else -> current
}

@Composable
private fun LibraryDrawer(
    store: NotesStore,
    currentFolder: String,
    onSelectFolder: (String) -> Unit,
    onRenameFolder: (String) -> Unit,
    onMoveFolder: (String) -> Unit,
    onDeleteFolder: (String) -> Unit,
    onSettings: () -> Unit,
) {
    val c = FutoTheme.colors
    var folderMenu by remember { mutableStateOf<String?>(null) }
    ModalDrawerSheet(
        drawerContainerColor = c.surface,
        modifier = Modifier.width(300.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(start = 20.dp, top = 22.dp, end = 20.dp, bottom = 18.dp),
        ) {
            Box(
                modifier = Modifier.size(38.dp).background(c.accent, RoundedCornerShape(9.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Description, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.width(12.dp))
            Text("FUTO Notes", style = FutoType.title.copy(fontWeight = FontWeight.SemiBold), color = c.textPrimary)
        }

        MicroLabel("Library", modifier = Modifier.padding(start = 28.dp, bottom = 6.dp))

        // "All notes" + one row per folder path (with counts).
        FolderRow(
            label = "All notes",
            icon = Icons.Filled.Layers,
            count = store.notes.size,
            selected = currentFolder == ALL,
            onClick = { onSelectFolder(ALL) },
        )
        store.folders.forEach { folder ->
            Box {
                FolderRow(
                    label = folder,
                    icon = Icons.Filled.Folder,
                    count = store.notesIn(folder).size,
                    selected = currentFolder == folder,
                    onClick = { onSelectFolder(folder) },
                    onLongClick = { folderMenu = folder },
                )
                DropdownMenu(expanded = folderMenu == folder, onDismissRequest = { folderMenu = null }) {
                    DropdownMenuItem(
                        text = { Text("Rename") },
                        leadingIcon = {
                            Icon(
                                Icons.Filled.Edit,
                                contentDescription = null,
                                tint = c.textSecondary,
                            )
                        },
                        onClick = {
                            folderMenu = null
                            onRenameFolder(folder)
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Move to Folder…") },
                        leadingIcon = {
                            Icon(
                                Icons.AutoMirrored.Filled.DriveFileMove,
                                contentDescription = null,
                                tint = c.textSecondary,
                            )
                        },
                        onClick = {
                            folderMenu = null
                            onMoveFolder(folder)
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Delete folder", color = c.danger) },
                        leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null, tint = c.danger) },
                        onClick = {
                            folderMenu = null
                            onDeleteFolder(folder)
                        },
                    )
                }
            }
        }

        Spacer(Modifier.weight(1f))
        HorizontalDivider(color = c.border)
        NavigationDrawerItem(
            icon = { Icon(Icons.Filled.Settings, contentDescription = null) },
            label = { Text("Settings", style = FutoType.body) },
            selected = false,
            onClick = onSettings,
            colors = NavigationDrawerItemDefaults.colors(
                unselectedIconColor = c.textMuted,
                unselectedTextColor = c.textSecondary,
            ),
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
        )
    }
}

/**
 * Drawer folder row. NavigationDrawerItem exposes no long-press, and folder
 * rows need one (Delete folder [list.md:121]) — so this is a visual clone of
 * it built on combinedClickable, using the same selected/unselected colors.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FolderRow(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    count: Int,
    selected: Boolean,
    onClick: () -> Unit,
    onLongClick: (() -> Unit)? = null,
) {
    val c = FutoTheme.colors
    Surface(
        color = if (selected) c.surfaceSelected else Color.Transparent,
        shape = RoundedCornerShape(FutoRadius.pill),
        modifier = Modifier
            .padding(horizontal = 12.dp)
            .fillMaxWidth()
            .height(56.dp)
            .clip(RoundedCornerShape(FutoRadius.pill))
            .combinedClickable(onClick = onClick, onLongClick = onLongClick),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
        ) {
            Icon(icon, contentDescription = null, tint = if (selected) c.accent else c.textMuted)
            Spacer(Modifier.width(12.dp))
            Text(
                label,
                style = FutoType.body.copy(fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal),
                color = if (selected) c.textAccent else c.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(12.dp))
            Text(
                count.toString(),
                style = FutoType.caption,
                color = if (selected) c.textAccent else c.textMuted,
            )
        }
    }
}

@Composable
private fun EmptyState() {
    val c = FutoTheme.colors
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
                modifier = Modifier.size(72.dp).background(c.surfaceSunken, RoundedCornerShape(FutoRadius.lg)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Description, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(30.dp))
            }
            Spacer(Modifier.height(16.dp))
            Text("Nothing here yet", style = FutoType.title, color = c.textPrimary)
            Spacer(Modifier.height(4.dp))
            Text("Start a note and your thoughts will gather.", style = FutoType.small, color = c.textTertiary)
        }
    }
}
