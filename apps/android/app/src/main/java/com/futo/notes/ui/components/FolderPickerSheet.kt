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
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Home
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.futo.notes.NotesStore
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType

/**
 * "Move to folder" bottom-sheet picker [list.md]: a Root row and one row per folder (full
 * path, like the drawer). [onPick] receives the chosen folder path ("" = root).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FolderPickerSheet(
    store: NotesStore,
    onPick: (folder: String) -> Unit,
    onDismiss: () -> Unit,
    title: String? = null,
    excludePaths: List<String> = emptyList(),
) {
    val localization = LocalLocalization.current
    val destinations = eligibleFolderDestinations(store.folders, excludePaths)

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = FutoTheme.colors.surface) {
        Column(
            modifier = Modifier
                .heightIn(max = 480.dp)
                .verticalScroll(rememberScrollState())
                .padding(bottom = 24.dp),
        ) {
            MicroLabel(
                title ?: localization.localizedText("folders.movePickerHeading"),
                Modifier.padding(start = 24.dp, bottom = 8.dp),
            )
            SheetRow(
                label = localization.localizedText("folders.root"),
                icon = Icons.Filled.Home,
                onClick = { onPick("") },
            )
            destinations.forEach { folder ->
                SheetRow(label = folder, icon = Icons.Filled.Folder, onClick = { onPick(folder) })
            }
        }
    }
}

internal fun eligibleFolderDestinations(
    folders: List<String>,
    excludePaths: List<String>,
): List<String> = folders.filter { folder ->
    excludePaths.none { excluded -> folder == excluded || folder.startsWith("$excluded/") }
}

@Composable
private fun SheetRow(label: String, icon: ImageVector, onClick: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 24.dp, vertical = 14.dp),
    ) {
        Icon(icon, contentDescription = null, tint = FutoTheme.colors.textMuted, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(14.dp))
        Text(label, style = FutoType.body, color = FutoTheme.colors.textPrimary)
    }
}
