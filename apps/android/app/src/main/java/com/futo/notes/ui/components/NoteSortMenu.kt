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
import com.futo.notes.puppet.PuppetVerb
import com.futo.notes.puppet.PuppetVerbRefusal
import com.futo.notes.puppet.PuppetVerbScope
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import uniffi.futo_notes_ffi.NoteSortKey
import uniffi.futo_notes_ffi.NoteSortOrder
import uniffi.futo_notes_ffi.SortDirection

@Composable
fun NoteSortMenu(sortOrder: NoteSortOrder, onPick: (NoteSortOrder) -> Unit) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    var expanded by remember { mutableStateOf(false) }
    // The sort button, and while its menu is open one pick from it, as a tap on its row makes:
    // a key keeps the list's position (newest first stays first), a direction applies to the
    // key in use. The same verbs as desktop's sort menu. The open menu is a popup that takes
    // every touch, so its rows (and the button's close) are all a person can reach.
    fun toggle() = PuppetVerb("ToggleSortMenu", controls = listOf("notes.sort.heading")) {
        expanded = !expanded
    }
    PuppetVerbScope { listOf(toggle()) }
    PuppetVerbScope(modal = true) {
        if (!expanded) return@PuppetVerbScope emptyList()
        listOf(
            toggle(),
            PuppetVerb("SetSortOrder", optional = listOf("key", "direction")) { arguments ->
                if (arguments.optString("key").isEmpty() == arguments.optString("direction").isEmpty()) {
                    throw PuppetVerbRefusal(400, "one pick at a time: {\"key\":…} or {\"direction\":…}")
                }
                var order = sortOrder
                arguments.optString("key").ifEmpty { null }?.let { name ->
                    val key = when (name) {
                        "name" -> NoteSortKey.NAME
                        "lastModified" -> NoteSortKey.LAST_MODIFIED
                        else -> throw PuppetVerbRefusal(400, "key is name or lastModified, not $name")
                    }
                    order = NoteSortPreference.withKey(key, order)
                }
                arguments.optString("direction").ifEmpty { null }?.let { name ->
                    val direction = when (name) {
                        "ascending" -> SortDirection.ASCENDING
                        "descending" -> SortDirection.DESCENDING
                        else -> throw PuppetVerbRefusal(400, "direction is ascending or descending, not $name")
                    }
                    order = NoteSortOrder(order.key, direction)
                }
                onPick(order)
            },
        )
    }
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
