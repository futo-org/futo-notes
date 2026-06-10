package com.futo.notes.ui.components

import android.text.format.DateUtils
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.futo.notes.NoteItem
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType

/**
 * The note card from the design board: Paper, 1.dp hairline, signature 12.dp
 * radius, 16×15.dp padding. Row 1 title (17/600) + relative time; Row 2 snippet
 * (small/tertiary, 2 lines); Row 3 tag pills. Press → scale 0.99f.
 *
 * Backed by the FFI-derived [NoteItem] (no pin: the Rust model carries no
 * pinned flag). Long-press (when wired) opens the row actions menu
 * [list.md:62] — Surface's own onClick overload has no long-press, so the
 * card uses combinedClickable on the modifier instead.
 */
@OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
@Composable
fun NoteCard(
    note: NoteItem,
    onClick: () -> Unit,
    showFolder: Boolean = false,
    modifier: Modifier = Modifier,
    onLongClick: (() -> Unit)? = null,
) {
    val c = FutoTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val scale = pressScale(interaction, pressedScale = 0.99f)

    Surface(
        shape = RoundedCornerShape(FutoRadius.md),
        color = c.surface,
        border = BorderStroke(1.dp, c.border),
        modifier = modifier
            .fillMaxWidth()
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .clip(RoundedCornerShape(FutoRadius.md))
            .combinedClickable(
                interactionSource = interaction,
                indication = LocalIndication.current,
                onClick = onClick,
                onLongClick = onLongClick,
            ),
    ) {
        Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 15.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = note.title,
                    style = FutoType.title.copy(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
                    color = c.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.size(8.dp))
                Text(
                    text = relativeTime(note.modifiedMs),
                    style = FutoType.caption,
                    color = c.textMuted,
                    maxLines = 1,
                )
            }

            if (showFolder && note.folder.isNotEmpty()) {
                Spacer(Modifier.height(2.dp))
                Text(note.folder, style = FutoType.caption, color = c.textMuted, maxLines = 1)
            }

            if (note.preview.isNotBlank()) {
                Spacer(Modifier.height(4.dp))
                Text(
                    text = note.preview,
                    style = FutoType.small,
                    color = c.textTertiary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            if (note.tags.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    note.tags.take(4).forEach { TagPill(it) }
                }
            }
        }
    }
}

private fun relativeTime(timeMs: Long): String {
    if (timeMs <= 0L) return ""
    return DateUtils.getRelativeTimeSpanString(
        timeMs,
        System.currentTimeMillis(),
        DateUtils.MINUTE_IN_MILLIS,
    ).toString()
}
