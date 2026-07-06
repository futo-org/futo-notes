package com.futo.notes.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.futo.notes.NotesStore
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import uniffi.futo_notes_ffi.sanitizeTitle

/**
 * Name dialog for a new folder under [parent] ("" = root) [list.md:78]. The
 * name is sanitized by the SAME Rust filename rules as a note title (a folder
 * name is a path segment); empty and case-insensitive-duplicate sibling names
 * can't be created. Confirm hands back the FULL folder path.
 */
@Composable
fun NewFolderDialog(
    parent: String,
    store: NotesStore,
    onCreate: (path: String) -> Unit,
    onDismiss: () -> Unit,
) {
    val c = FutoTheme.colors
    var name by remember { mutableStateOf("") }
    val raw = name.trim()
    val clean = sanitizeTitle(raw)
    // sanitizeTitle falls back to "Untitled" when the input strips to nothing
    // (its note-title contract: "", "///", "..."). Creating then would
    // silently make a folder the user never named (2026-07-02 QA) — treat it
    // as invalid. Literally typing "Untitled" stays allowed.
    val sanitizesAway = clean == "Untitled" && raw != "Untitled"
    val duplicate = clean.isNotEmpty() && store.subfolders(parent)
        .any { it.substringAfterLast('/').equals(clean, ignoreCase = true) }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.surface,
        title = { Text("New folder", style = FutoType.title, color = c.textPrimary) },
        text = {
            Column {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it.replace("\n", "") },
                    label = { Text("Name") },
                    singleLine = true,
                    shape = RoundedCornerShape(FutoRadius.md),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (duplicate) {
                    Text(
                        "A folder with this name already exists",
                        style = FutoType.caption,
                        color = c.danger,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                } else if (sanitizesAway && raw.isNotEmpty()) {
                    Text(
                        "Enter a valid folder name",
                        style = FutoType.caption,
                        color = c.danger,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
            }
        },
        confirmButton = {
            // Disabled visual must match the disabled behavior [list.md:182]: a
            // hardcoded accent color would override TextButton's disabled
            // content color and make an inert Create look tappable.
            val canCreate = clean.isNotEmpty() && !duplicate && !sanitizesAway
            TextButton(
                enabled = canCreate,
                onClick = { onCreate(if (parent.isEmpty()) clean else "$parent/$clean") },
            ) { Text("Create", color = if (canCreate) c.textAccent else c.textMuted) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel", color = c.textSecondary) }
        },
    )
}
