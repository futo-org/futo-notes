package com.futo.notes.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.Icons
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.puppet.folderRowTag
import com.futo.notes.ui.components.NoteCard
import com.futo.notes.ui.components.pressScale
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType

/**
 * A subfolder row in the folder list. Sits in the same 16.dp gutter as
 * [NoteCard] but reads as a folder: folder icon, name, trailing chevron. Long
 * press opens Rename / Move to Folder… / Delete folder — the action set the
 * drawer's folder rows used to carry [list.md "Folder browsing"].
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun FolderCard(
    path: String,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    val name = path.substringAfterLast('/')
    val interaction = remember { MutableInteractionSource() }
    val scale = pressScale(interaction, pressedScale = 0.99f)

    Surface(
        shape = RoundedCornerShape(FutoRadius.md),
        color = c.surface,
        border = BorderStroke(1.dp, c.border),
        modifier = Modifier
            .fillMaxWidth()
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .clip(RoundedCornerShape(FutoRadius.md))
            .combinedClickable(
                interactionSource = interaction,
                indication = LocalIndication.current,
                onClick = onClick,
                onLongClick = onLongClick,
            )
            // A stable, path-qualified description so automation can find one
            // folder row among several with the same leaf name.
            .semantics {
                contentDescription = localization.localizedText(
                    "folders.rowAccessibilityLabel",
                    mapOf("folderName" to path),
                )
            }
            .testTag(folderRowTag(path)),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 15.dp),
        ) {
            Icon(Icons.Filled.Folder, contentDescription = null, tint = c.accent, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(12.dp))
            Text(
                text = name,
                style = FutoType.title.copy(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = c.textMuted,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

/**
 * Empty state, distinguishing the vault root from an empty folder the way iOS
 * does [list.md "Folder browsing"].
 */
@Composable
internal fun EmptyState(isRoot: Boolean) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
                modifier = Modifier.size(72.dp).background(c.surfaceSunken, RoundedCornerShape(FutoRadius.lg)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (isRoot) Icons.Filled.Description else Icons.Filled.Folder,
                    contentDescription = null,
                    tint = c.textMuted,
                    modifier = Modifier.size(30.dp),
                )
            }
            Spacer(Modifier.height(16.dp))
            Text(
                localization.localizedText(
                    if (isRoot) "notes.list.rootEmptyHeading" else "notes.list.folderEmptyHeading",
                ),
                style = FutoType.title,
                color = c.textPrimary,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                localization.localizedText("notes.list.android.emptyActionHint"),
                style = FutoType.small,
                color = c.textTertiary,
            )
        }
    }
}
