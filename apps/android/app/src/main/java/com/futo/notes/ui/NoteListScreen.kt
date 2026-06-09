package com.futo.notes.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.DrawerValue
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.futo.notes.NotesStore
import com.futo.notes.ui.components.MicroLabel
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
    onOpenNote: (String) -> Unit,
    onCreate: (String) -> Unit,
    onOpenSearch: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val c = FutoTheme.colors
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    var currentFolder by remember { mutableStateOf(ALL) } // ALL = all notes

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
                val interaction = remember { MutableInteractionSource() }
                val scale = pressScale(interaction, 0.97f)
                FloatingActionButton(
                    onClick = {
                        val folder = if (currentFolder == ALL) "" else currentFolder
                        // `createNote` is suspend (FFI write on IO). Launch on the
                        // composable's main scope; the navigate callback runs after
                        // it returns (resumes on Main, safe for Compose state).
                        scope.launch { store.createNote("Untitled", folder)?.let(onCreate) }
                    },
                    interactionSource = interaction,
                    containerColor = c.accent,
                    contentColor = Color.White,
                    shape = RoundedCornerShape(FutoRadius.lg),
                    modifier = Modifier.padding(2.dp).graphicsLayer { scaleX = scale; scaleY = scale },
                ) {
                    Icon(Icons.Filled.Add, contentDescription = "New note")
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
                        NoteCard(note, onClick = { onOpenNote(note.id) })
                    }
                }
            }
        }
    }
}

@Composable
private fun LibraryDrawer(
    store: NotesStore,
    currentFolder: String,
    onSelectFolder: (String) -> Unit,
    onSettings: () -> Unit,
) {
    val c = FutoTheme.colors
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
            FolderRow(
                label = folder,
                icon = Icons.Filled.Folder,
                count = store.notesIn(folder).size,
                selected = currentFolder == folder,
                onClick = { onSelectFolder(folder) },
            )
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

@Composable
private fun FolderRow(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    count: Int,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val c = FutoTheme.colors
    NavigationDrawerItem(
        icon = { Icon(icon, contentDescription = null) },
        label = {
            Text(
                label,
                style = FutoType.body.copy(fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal),
            )
        },
        badge = { Text(count.toString(), style = FutoType.caption) },
        selected = selected,
        onClick = onClick,
        colors = NavigationDrawerItemDefaults.colors(
            selectedContainerColor = c.surfaceSelected,
            selectedIconColor = c.accent,
            selectedTextColor = c.textAccent,
            selectedBadgeColor = c.textAccent,
            unselectedIconColor = c.textMuted,
            unselectedTextColor = c.textSecondary,
            unselectedBadgeColor = c.textMuted,
        ),
        modifier = Modifier.padding(horizontal = 12.dp),
    )
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
