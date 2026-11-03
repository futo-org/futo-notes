package com.futo.notes.textfirst

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.DriveFileMove
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.ui.components.FutoMenu
import com.futo.notes.ui.components.TopBar
import com.futo.notes.ui.theme.FutoTheme

/** The text-first note screen's top bar: back, share, and the ⋯ menu (move, copy path, delete). */
@Composable
internal fun TextFirstTopBar(
    onBack: () -> Unit,
    onShare: () -> Unit,
    onMove: () -> Unit,
    onCopyPath: () -> Unit,
    onDelete: () -> Unit,
) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    var actionsMenu by remember { mutableStateOf(false) }
    TopBar(
        title = {},
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, localization.localizedText("common.actions.back"), tint = c.textSecondary)
            }
        },
        actions = {
            IconButton(onClick = onShare) {
                Icon(Icons.Filled.Share, localization.localizedText("notes.actions.share"), tint = c.textSecondary)
            }
            IconButton(onClick = { actionsMenu = true }) {
                Icon(Icons.Filled.MoreVert, localization.localizedText("notes.actions.moreAccessibilityLabel"), tint = c.textSecondary)
            }
            FutoMenu(expanded = actionsMenu, onDismissRequest = { actionsMenu = false }) {
                DropdownMenuItem(
                    text = { Text(localization.localizedText("notes.actions.moveToFolderEllipsis")) },
                    leadingIcon = { Icon(Icons.AutoMirrored.Filled.DriveFileMove, null, tint = c.textSecondary) },
                    onClick = { actionsMenu = false; onMove() },
                )
                DropdownMenuItem(
                    text = { Text(localization.localizedText("notes.actions.copyFilePath")) },
                    leadingIcon = { Icon(Icons.Filled.ContentCopy, null, tint = c.textSecondary) },
                    onClick = { actionsMenu = false; onCopyPath() },
                )
                DropdownMenuItem(
                    text = { Text(localization.localizedText("notes.actions.deleteNote")) },
                    leadingIcon = { Icon(Icons.Filled.Delete, null, tint = c.danger) },
                    onClick = { actionsMenu = false; onDelete() },
                )
            }
        },
    )
}
