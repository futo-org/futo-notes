package com.futo.notes.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.Localization
import com.futo.notes.ui.components.FutoMenu
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType

@Composable
internal fun LanguageMenu(
    localization: Localization,
    selectedLanguageTag: String?,
    onSelect: (String?) -> Unit,
) {
    val c = FutoTheme.colors
    val systemOption = localization.localizedText("settings.language.systemOption")
    val options = listOf<Pair<String?, String>>(null to systemOption) +
        localization.availableLanguages.map { it.tag to it.nativeName }
    var expanded by remember { mutableStateOf(false) }
    Box {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.clickable { expanded = true },
        ) {
            Text(
                options.firstOrNull { it.first == selectedLanguageTag }?.second ?: systemOption,
                color = c.textMuted,
            )
            Icon(
                Icons.Filled.ArrowDropDown,
                contentDescription = null,
                tint = c.textMuted,
                modifier = Modifier.size(20.dp),
            )
        }
        FutoMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            for ((languageTag, name) in options) {
                DropdownMenuItem(
                    text = { Text(name) },
                    onClick = {
                        expanded = false
                        if (languageTag != selectedLanguageTag) onSelect(languageTag)
                    },
                )
            }
        }
    }
}

/// SYNCED / LOCAL pill shown on the single "Sync" row.
@Composable
internal fun SyncBadge(connected: Boolean) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    val badge = if (connected) {
        localization.localizedText("settings.sync.syncedBadge")
    } else {
        localization.localizedText("settings.sync.localBadge")
    }
    val badgeColor = if (connected) c.success else c.textMuted
    Surface(color = badgeColor.copy(alpha = 0.14f), shape = RoundedCornerShape(FutoRadius.pill)) {
        Text(
            badge,
            style = FutoType.micro,
            color = badgeColor,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun Segmented(options: List<String>, selectedIndex: Int, onSelect: (Int) -> Unit) {
    val c = FutoTheme.colors
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        options.forEachIndexed { i, label ->
            SegmentedButton(
                selected = selectedIndex == i,
                onClick = { onSelect(i) },
                modifier = Modifier.weight(1f),
                shape = SegmentedButtonDefaults.itemShape(index = i, count = options.size),
                colors = SegmentedButtonDefaults.colors(
                    activeContainerColor = c.surfaceSelected,
                    activeContentColor = c.textAccent,
                    inactiveContainerColor = Color.Transparent,
                    inactiveContentColor = c.textSecondary,
                    activeBorderColor = c.accent,
                    inactiveBorderColor = c.border,
                ),
            ) {
                Text(label, style = FutoType.small)
            }
        }
    }
}
