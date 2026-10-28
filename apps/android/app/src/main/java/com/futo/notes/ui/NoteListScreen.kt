package com.futo.notes.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.DriveFileMove
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import com.futo.notes.BuildConfig
import com.futo.notes.NotesStore
import com.futo.notes.puppet.PuppetListRows
import com.futo.notes.puppet.PuppetVerb
import com.futo.notes.puppet.PuppetVerbRefusal
import com.futo.notes.puppet.PuppetVerbScope
import com.futo.notes.puppet.puppetMenuFor
import com.futo.notes.puppet.folderRowTag
import com.futo.notes.puppet.noteRowTag
import com.futo.notes.puppet.rowRefusal
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.LocalizedMessage
import com.futo.notes.ui.components.FutoMenu
import com.futo.notes.ui.components.NoteSortMenu
import com.futo.notes.ui.components.NoteCard
import com.futo.notes.ui.components.TopBar
import com.futo.notes.ui.components.createFolderShortcut
import com.futo.notes.ui.components.pickFolderShortcut
import com.futo.notes.ui.components.renameFolderShortcut
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType

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
    val localization = LocalLocalization.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val listState = state.scrollStateFor(folder)
    val isRoot = folder.isEmpty()

    // Row actions [list.md]: long-press targets, hoisted so the dialogs/sheet
    // live outside the LazyColumn items. `menuRow` is the row whose long-press menu is
    // open (its tag, ListRows.kt): one at a time, as a menu takes every touch.
    var menuRow by remember { mutableStateOf<String?>(null) }
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
    // The first frame this list draws after it is (re)composed — the end of a
    // note's exit as the user sees it (CloseLedger; a no-op outside an exit).
    // Compiled out of release builds.
    if (BuildConfig.DEBUG) LaunchedEffect(Unit) { withFrameNanos { CloseLedger.end() } }
    val title = if (isRoot) localization.localizedText("notes.heading") else folder.substringAfterLast('/')
    val rows = { subfolders.map(::folderRowTag) + notes.map { noteRowTag(it.id) } }
    PuppetListRows(listState, store, rows = rows)

    // The FAB, the top bar's buttons, and a row's long-press, which opens its menu: only
    // on a row of this list, as a finger can only hold a row it can see.
    PuppetVerbScope {
        fun openMenu(tag: String): Map<String, Any?> {
            rowRefusal(tag, rows(), store.notes, store.folders)?.let { throw it }
            menuRow = tag
            return emptyMap()
        }
        listOf(
            PuppetVerb("CreateNote", controls = listOf("notes.newNote")) {
                val id = createNote(store, folder, listState, scope, context, localization, onCreate).await()
                    ?: throw PuppetVerbRefusal(500, "the store refused the create")
                mapOf("noteId" to id)
            },
            PuppetVerb(
                "OpenCreateFolderDialog",
                optional = listOf("name"),
                controls = listOf("folders.newFolder"),
                shortcuts = createFolderShortcut,
            ) {
                newFolderDialog = true
            },
            PuppetVerb(
                "OpenNoteContextMenu",
                required = listOf("noteId"),
                optional = listOf("item"),
                shortcuts = mapOf("item" to listOf("\$" to emptyMap())),
            ) { arguments -> openMenu(noteRowTag(arguments.getString("noteId"))) },
            PuppetVerb(
                "OpenFolderContextMenu",
                required = listOf("path"),
                optional = listOf("item"),
                shortcuts = mapOf("item" to listOf("\$" to emptyMap())),
            ) { arguments -> openMenu(folderRowTag(arguments.getString("path"))) },
            PuppetVerb("OpenSearch", controls = listOf("search.heading")) { onOpenSearch() },
            PuppetVerb("OpenSettings", controls = listOf("settings.heading")) { onOpenSettings() },
        )
    }
    // A row's open menu: a popup that takes every touch, so its items, acting on that row,
    // are all a person can reach. A Delete asks first, in the dialog it opens, which its own
    // ConfirmDialog or DismissDialog answers (ConfirmDialog.kt's; `answer` is the CLI pressing one).
    PuppetVerbScope(modal = true) {
        val row = menuRow?.takeIf { it in rows() } ?: return@PuppetVerbScope emptyList()
        val name = row.substringAfter(':')
        val close = PuppetVerb("CloseContextMenu") {
            menuRow = null
        }
        if (row.startsWith("note:")) {
            listOf(
                PuppetVerb(
                    "MoveNoteToFolder",
                    optional = listOf("targetPath"),
                    controls = listOf("notes.actions.moveToFolderEllipsis"),
                    shortcuts = pickFolderShortcut,
                ) {
                    menuRow = null
                    moveTarget = name
                },
                PuppetVerb(
                    "DeleteNote",
                    optional = listOf("answer"),
                    controls = listOf("common.actions.delete"),
                ) {
                    menuRow = null
                    deleteTarget = name
                    mapOf("noteId" to name)
                },
                close,
            )
        } else {
            listOf(
                PuppetVerb(
                    "RenameFolder",
                    optional = listOf("name"),
                    controls = listOf("common.actions.rename"),
                    shortcuts = renameFolderShortcut,
                ) {
                    menuRow = null
                    renameFolderTarget = name
                },
                PuppetVerb(
                    "MoveFolderToFolder",
                    optional = listOf("targetPath"),
                    controls = listOf("folders.actions.moveToFolderEllipsis"),
                    shortcuts = pickFolderShortcut,
                ) {
                    menuRow = null
                    moveFolderTarget = name
                },
                PuppetVerb(
                    "DeleteFolder",
                    optional = listOf("answer"),
                    controls = listOf("folders.actions.deleteFolder"),
                ) {
                    menuRow = null
                    confirmDeleteFolder = name
                    mapOf("path" to name)
                },
                close,
            )
        }
    }

    Scaffold(
        containerColor = c.surface,
        topBar = {
            TopBar(
                title = { Text(title, style = FutoType.title, color = c.textPrimary) },
                navigationIcon = {
                    // The root folder is the stack floor [nav.md], so it shows no
                    // up affordance; a pushed folder pops exactly like Back.
                    if (!isRoot) {
                        IconButton(onClick = onBack) {
                            Icon(
                                Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = localization.localizedText("common.actions.back"),
                                tint = c.textSecondary,
                            )
                        }
                    }
                },
                actions = {
                    // New folder, created in THIS folder — the secondary create
                    // action; the FAB is the primary one. [list.md]
                    IconButton(onClick = { newFolderDialog = true }) {
                        Icon(
                            Icons.Filled.CreateNewFolder,
                            contentDescription = localization.localizedText("folders.newFolder"),
                            tint = c.textSecondary,
                        )
                    }
                    NoteSortMenu(sortOrder = store.sortOrder, onPick = store::selectSortOrder)
                    IconButton(onClick = onOpenSearch) {
                        Icon(
                            Icons.Filled.Search,
                            contentDescription = localization.localizedText("search.heading"),
                            tint = c.textSecondary,
                        )
                    }
                    // Settings lived at the bottom of the removed drawer; it is
                    // now a top-bar gear on every folder screen, mirroring iOS.
                    IconButton(onClick = onOpenSettings) {
                        Icon(
                            Icons.Filled.Settings,
                            contentDescription = localization.localizedText("settings.heading"),
                            tint = c.textSecondary,
                        )
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
            NewNoteFab(
                store = store,
                folder = folder,
                listState = listState,
                scope = scope,
                context = context,
                localization = localization,
                onCreate = onCreate,
            )
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
                    Box {
                        FolderCard(
                            path = child,
                            onClick = { onOpenFolder(child) },
                            onLongClick = { menuRow = folderRowTag(child) },
                        )
                        FutoMenu(
                            expanded = menuRow == folderRowTag(child),
                            onDismissRequest = { menuRow = null },
                            modifier = Modifier.puppetMenuFor(folderRowTag(child)),
                        ) {
                            DropdownMenuItem(
                                text = { Text(localization.localizedText("common.actions.rename")) },
                                leadingIcon = { Icon(Icons.Filled.Edit, contentDescription = null, tint = c.textSecondary) },
                                onClick = { menuRow = null; renameFolderTarget = child },
                            )
                            DropdownMenuItem(
                                text = { Text(localization.localizedText("folders.actions.moveToFolderEllipsis")) },
                                leadingIcon = { Icon(Icons.AutoMirrored.Filled.DriveFileMove, contentDescription = null, tint = c.textSecondary) },
                                onClick = { menuRow = null; moveFolderTarget = child },
                            )
                            DropdownMenuItem(
                                text = {
                                    Text(
                                        localization.localizedText("folders.actions.deleteFolder"),
                                        color = c.danger,
                                    )
                                },
                                leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null, tint = c.danger) },
                                onClick = { menuRow = null; confirmDeleteFolder = child },
                            )
                        }
                    }
                }
                items(notes, key = { "note:${it.id}" }) { note ->
                    // Long-press actions menu on each card [list.md].
                    Box {
                        NoteCard(
                            note,
                            onClick = { onOpenNote(note.id) },
                            onLongClick = { menuRow = noteRowTag(note.id) },
                        )
                        FutoMenu(
                            expanded = menuRow == noteRowTag(note.id),
                            onDismissRequest = { menuRow = null },
                            modifier = Modifier.puppetMenuFor(noteRowTag(note.id)),
                        ) {
                            DropdownMenuItem(
                                text = { Text(localization.localizedText("notes.actions.moveToFolderEllipsis")) },
                                leadingIcon = { Icon(Icons.AutoMirrored.Filled.DriveFileMove, contentDescription = null, tint = c.textSecondary) },
                                onClick = { menuRow = null; moveTarget = note.id },
                            )
                            DropdownMenuItem(
                                text = { Text(localization.localizedText("common.actions.delete")) },
                                leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null, tint = c.danger) },
                                onClick = { menuRow = null; deleteTarget = note.id },
                            )
                        }
                    }
                }
            }
        }
    }

    NoteListDialogs(
        store = store,
        folder = folder,
        scope = scope,
        context = context,
        localization = localization,
        deleteTarget = deleteTarget,
        onDeleteTargetChange = { deleteTarget = it },
        moveTarget = moveTarget,
        onMoveTargetChange = { moveTarget = it },
        newFolderDialog = newFolderDialog,
        onNewFolderDialogChange = { newFolderDialog = it },
        renameFolderTarget = renameFolderTarget,
        onRenameFolderTargetChange = { renameFolderTarget = it },
        moveFolderTarget = moveFolderTarget,
        onMoveFolderTargetChange = { moveFolderTarget = it },
        confirmDeleteFolder = confirmDeleteFolder,
        onConfirmDeleteFolderChange = { confirmDeleteFolder = it },
        onFolderMoved = onFolderMoved,
    )
}

/** Toast body for a MOVE-UP folder delete [list.md]. Pluralizes the
 *  moved-note count ("moved 1 note" / "moved N notes"). */
internal fun folderDeletedMessage(moved: UInt): LocalizedMessage = LocalizedMessage(
    "folders.delete.movedNotes",
    mapOf("count" to moved.toLong()),
)

/** Rank changes re-pin only an at-top viewport; the four-pixel allowance
 *  absorbs overscroll settling without disturbing deep scrolls [list.md]. */
internal fun isAtListTop(firstVisibleItemIndex: Int, firstVisibleItemScrollOffset: Int): Boolean =
    firstVisibleItemIndex == 0 && firstVisibleItemScrollOffset <= 4
