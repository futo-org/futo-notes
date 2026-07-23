package com.futo.notes.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Home
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.futo.notes.NotesStore
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType

/**
 * "Move to folder" bottom-sheet picker [list.md:62, list.md:71]: a Root row,
 * one row per folder (full path, like the drawer), and an inline "New Folder…"
 * that names a folder and picks it in one step. [onPick] receives the chosen
 * folder path ("" = root) and whether it must be created as part of the move.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FolderPickerSheet(
    store: NotesStore,
    onPick: (folder: String, isNew: Boolean) -> Unit,
    onDismiss: () -> Unit,
) {
    val c = FutoTheme.colors
    var newFolder by remember { mutableStateOf(false) }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = c.surface) {
        Column(
            modifier = Modifier
                .heightIn(max = 480.dp)
                .verticalScroll(rememberScrollState())
                .padding(bottom = 24.dp),
        ) {
            MicroLabel("Move to folder", Modifier.padding(start = 24.dp, bottom = 8.dp))
            SheetRow(label = "Root", icon = Icons.Filled.Home) { onPick("", false) }
            store.folders.forEach { folder ->
                SheetRow(label = folder, icon = Icons.Filled.Folder) { onPick(folder, false) }
            }
            HorizontalDivider(color = c.border, modifier = Modifier.padding(vertical = 6.dp))
            SheetRow(
                label = "New Folder…",
                icon = Icons.Filled.CreateNewFolder,
                tint = c.textAccent,
                labelColor = c.textAccent,
            ) { newFolder = true }
        }
    }

    if (newFolder) {
        NewFolderDialog(
            parent = "",
            store = store,
            onCreate = { path ->
                newFolder = false
                onPick(path, true)
            },
            onDismiss = { newFolder = false },
        )
    }
}

@Composable
private fun SheetRow(
    label: String,
    icon: ImageVector,
    tint: Color = FutoTheme.colors.textMuted,
    labelColor: Color = FutoTheme.colors.textPrimary,
    onClick: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 24.dp, vertical = 14.dp),
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(14.dp))
        Text(label, style = FutoType.body, color = labelColor)
    }
}
