package com.futo.notes.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.futo.notes.NoteSortPreference
import com.futo.notes.R
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import uniffi.futo_notes_ffi.NoteSortKey
import uniffi.futo_notes_ffi.NoteSortOrder

@Composable
fun NoteSortMenu(sortOrder: NoteSortOrder, onPick: (NoteSortOrder) -> Unit) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    var expanded by remember { mutableStateOf(false) }
    Box {
        // Picking deliberately leaves the menu open so key and direction are one visit.
        IconButton(onClick = { expanded = true }) {
            Icon(
                painterResource(R.drawable.ic_sort_descending),
                contentDescription = localization.localizedText("notes.sort.heading"),
                tint = c.textSecondary,
            )
        }
        FutoMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            SortMenuHeading(localization.localizedText("notes.sort.heading"))
            listOf(NoteSortKey.NAME, NoteSortKey.LAST_MODIFIED).forEach { key ->
                SortMenuItem(
                    label = localization.localizedText(NoteSortPreference.keyLabelPath(key)),
                    selected = sortOrder.key == key,
                    onClick = { onPick(NoteSortPreference.withKey(key, sortOrder)) },
                )
            }
            SortMenuHeading(localization.localizedText("notes.sort.orderHeading"))
            NoteSortPreference.directions(sortOrder.key).forEach { direction ->
                SortMenuItem(
                    label = localization.localizedText(
                        NoteSortPreference.directionLabelPath(sortOrder.key, direction),
                    ),
                    selected = sortOrder.direction == direction,
                    onClick = { onPick(NoteSortOrder(sortOrder.key, direction)) },
                )
            }
        }
    }
}

@Composable
private fun SortMenuHeading(label: String) {
    MicroLabel(
        label,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 2.dp),
    )
}

@Composable
private fun SortMenuItem(label: String, selected: Boolean, onClick: () -> Unit) {
    val c = FutoTheme.colors
    DropdownMenuItem(
        modifier = Modifier.semantics { this.selected = selected },
        text = {
            Text(
                label,
                style = FutoType.body,
                color = if (selected) c.textPrimary else c.textSecondary,
            )
        },
        trailingIcon = {
            if (selected) {
                Icon(
                    Icons.Filled.Check,
                    contentDescription = null,
                    tint = c.accent,
                    modifier = Modifier.size(18.dp),
                )
            }
        },
        contentPadding = PaddingValues(horizontal = 16.dp),
        onClick = onClick,
    )
}
