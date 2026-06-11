package com.futo.notes.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.FormatIndentDecrease
import androidx.compose.material.icons.automirrored.filled.FormatIndentIncrease
import androidx.compose.material.icons.automirrored.filled.FormatListBulleted
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.FormatBold
import androidx.compose.material.icons.filled.FormatItalic
import androidx.compose.material.icons.filled.FormatListNumbered
import androidx.compose.material.icons.filled.FormatQuote
import androidx.compose.material.icons.filled.FormatStrikethrough
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.KeyboardHide
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.Title
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.futo.notes.ui.theme.FutoTheme

/**
 * Native Compose rendering of the shared toolbar manifest (ToolbarSpec.kt —
 * GENERATED from packages/editor/src/toolbar.ts, the single source of truth
 * for items/order/labels/visibility across all three apps). The Android
 * counterpart of iOS's EditorToolbarView: a 44 dp bar of horizontally
 * scrollable button groups with hairline separators, plus a fixed dismiss
 * chevron at the right edge. Docked above the soft keyboard by the editor
 * screen's `imePadding`, shown only while the editor is focused.
 *
 * This composable owns NO editing behavior: every tap is handed to [perform],
 * which the editor screen routes over the bridge (`FutoEditor.exec`) into the
 * same markdownToolbar.ts commands the web toolbar runs.
 */
@Composable
fun EditorToolbar(
    onListLine: Boolean,
    perform: (ToolbarItemSpec) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = FutoTheme.colors
    Column(modifier.fillMaxWidth().background(c.surface)) {
        HorizontalDivider(thickness = 0.5.dp, color = c.border)
        Row(
            modifier = Modifier.fillMaxWidth().height(44.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                modifier = Modifier
                    .weight(1f)
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ToolbarSpec.groups.forEachIndexed { index, group ->
                    if (index > 0) {
                        VerticalDivider(
                            thickness = 1.dp,
                            color = c.border,
                            modifier = Modifier.height(20.dp).padding(horizontal = 0.dp),
                        )
                    }
                    group.forEach { item ->
                        if (!item.onlyOnListLine || onListLine) {
                            ToolbarButton(item, tint = c.textPrimary, perform = perform)
                        }
                    }
                }
            }
            VerticalDivider(thickness = 0.5.dp, color = c.border, modifier = Modifier.height(44.dp))
            ToolbarButton(ToolbarSpec.dismiss, tint = c.textSecondary, perform = perform)
        }
    }
}

@Composable
private fun ToolbarButton(
    item: ToolbarItemSpec,
    tint: Color,
    perform: (ToolbarItemSpec) -> Unit,
) {
    IconButton(onClick = { perform(item) }, modifier = Modifier.size(44.dp)) {
        Icon(
            imageVector = materialIcon(item.material),
            contentDescription = item.label,
            tint = tint,
            modifier = Modifier.size(22.dp),
        )
    }
}

/**
 * Manifest `material` name (a Material Symbols id) → the closest ImageVector
 * in compose material-icons-extended. The renderer owns this mapping, like the
 * web toolbar's lucide ICONS map — the manifest stays library-agnostic.
 * (`format_h1` has no extended-set vector; `Title` is the conventional stand-in.)
 */
private fun materialIcon(name: String): ImageVector = when (name) {
    "format_bold" -> Icons.Filled.FormatBold
    "format_italic" -> Icons.Filled.FormatItalic
    "format_strikethrough" -> Icons.Filled.FormatStrikethrough
    "format_h1" -> Icons.Filled.Title
    "format_quote" -> Icons.Filled.FormatQuote
    "format_list_bulleted" -> Icons.AutoMirrored.Filled.FormatListBulleted
    "format_list_numbered" -> Icons.Filled.FormatListNumbered
    "checklist" -> Icons.Filled.Checklist
    "format_indent_decrease" -> Icons.AutoMirrored.Filled.FormatIndentDecrease
    "format_indent_increase" -> Icons.AutoMirrored.Filled.FormatIndentIncrease
    "photo_camera" -> Icons.Filled.PhotoCamera
    "image" -> Icons.Filled.Image
    "keyboard_hide" -> Icons.Filled.KeyboardHide
    else -> Icons.Filled.Title
}
