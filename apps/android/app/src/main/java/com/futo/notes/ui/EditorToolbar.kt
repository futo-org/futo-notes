package com.futo.notes.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.Title
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.futo.notes.ui.theme.FutoTheme

/** Toolbar button tap target / nominal icon-slot width — matches iOS. */
private val BUTTON_SIZE = 44.dp

/** Width of the soft edge fade that eases the peeking icon's cut edge. */
private val FADE_WIDTH = 10.dp

/**
 * Native Compose rendering of the shared toolbar manifest (ToolbarSpec.kt —
 * GENERATED from packages/editor/src/toolbar.ts, the single source of truth
 * for items/order/labels/visibility across all three apps). The Android
 * counterpart of iOS's EditorToolbarView: a 44 dp bar of horizontally
 * scrollable button groups with hairline separators, plus a fixed dismiss
 * chevron at the right edge. Docked above the soft keyboard by the editor
 * screen's `imePadding`, shown only while the editor is focused.
 *
 * Scroll affordance ("snapped peek"): the trailing edge would otherwise cut
 * cleanly at an arbitrary point on the icon grid (mid-icon on some screens, in
 * a gap on others), so it's not obvious the bar scrolls. We MEASURE the button
 * positions + viewport width and add a trailing inset that clips whichever icon
 * sits at the edge to ~half — the same partial-icon peek on any width/density.
 * This is the deterministic twin of the iOS `computeSnap`; here the geometry
 * comes from `onGloballyPositioned` rather than SwiftUI's scroll geometry.
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
    val density = LocalDensity.current
    val scrollState = rememberScrollState()

    // Measured layout. Button x is taken relative to the viewport Box (window x
    // minus the Box's window x); at rest (scroll 0) that equals the content
    // position. `positionInWindow` is used because `positionInParent` isn't
    // available in this Compose version. The positions live in a plain map and a
    // `measureTick` counter signals changes — writing to a SnapshotStateMap from
    // onGloballyPositioned does NOT reliably restart the recompute effect.
    val buttonLefts = remember { mutableMapOf<String, Float>() }
    var measureTick by remember { mutableIntStateOf(0) }
    var slotPx by remember { mutableFloatStateOf(0f) }
    var boxWindowX by remember { mutableFloatStateOf(0f) }
    var snapInset by remember { mutableStateOf(0.dp) }

    // Recompute the snap only while the bar is at rest (scroll == 0), where the
    // measured positions equal content positions. The snap is a fixed layout
    // inset, so it must not jitter as the user scrolls.
    LaunchedEffect(slotPx, measureTick, onListLine, scrollState.value) {
        if (scrollState.value == 0 && slotPx > 0f && buttonLefts.size > 1) {
            val lefts = buttonLefts.values.sorted()
            val insetPx = computeToolbarSnapPx(
                lefts = lefts,
                slot = slotPx,
                buttonPx = with(density) { BUTTON_SIZE.toPx() },
                trailingPadPx = with(density) { 8.dp.toPx() },
            )
            snapInset = with(density) { insetPx.toDp() }
        }
    }

    val canScrollLeading = scrollState.value > 0
    val canScrollTrailing = scrollState.value < scrollState.maxValue

    Column(modifier.fillMaxWidth().background(c.surface)) {
        HorizontalDivider(thickness = 0.5.dp, color = c.border)
        Row(
            modifier = Modifier.fillMaxWidth().height(44.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // The scroll viewport (slot). Its width is constant regardless of
            // `snapInset` (the inset lives INSIDE this Box), which is what makes
            // the snap converge instead of feeding back.
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .onGloballyPositioned {
                        slotPx = it.size.width.toFloat()
                        boxWindowX = it.positionInWindow().x
                        measureTick++
                    },
            ) {
                Row(
                    // `.padding(end = snapInset)` OUTSIDE horizontalScroll narrows
                    // the viewport (the freed strip is bar-colored), clipping the
                    // edge icon; `.padding(horizontal = 8)` INSIDE is content pad.
                    modifier = Modifier
                        .fillMaxHeight()
                        .padding(end = snapInset)
                        .horizontalScroll(scrollState)
                        .padding(horizontal = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ToolbarSpec.groups.forEachIndexed { index, group ->
                        if (index > 0) {
                            VerticalDivider(
                                thickness = 1.dp,
                                color = c.border,
                                modifier = Modifier.height(20.dp),
                            )
                        }
                        group.forEach { item ->
                            if (!item.onlyOnListLine || onListLine) {
                                ToolbarButton(
                                    item,
                                    tint = c.textPrimary,
                                    perform = perform,
                                    modifier = Modifier.onGloballyPositioned {
                                        buttonLefts[item.id] = it.positionInWindow().x - boxWindowX
                                        measureTick++
                                    },
                                )
                            }
                        }
                    }
                }
                // Edge fades. The trailing fade rides the SNAPPED viewport edge
                // (offset in by `snapInset`); both pass touches through.
                if (canScrollLeading) {
                    Box(
                        Modifier.align(Alignment.CenterStart).fillMaxHeight().width(FADE_WIDTH)
                            .background(Brush.horizontalGradient(listOf(c.surface, Color.Transparent)))
                    )
                }
                if (canScrollTrailing) {
                    Box(
                        Modifier.align(Alignment.CenterEnd).padding(end = snapInset)
                            .fillMaxHeight().width(FADE_WIDTH)
                            .background(Brush.horizontalGradient(listOf(Color.Transparent, c.surface)))
                    )
                }
            }
            VerticalDivider(thickness = 0.5.dp, color = c.border, modifier = Modifier.height(44.dp))
            ToolbarButton(ToolbarSpec.dismiss, tint = c.textSecondary, perform = perform)
        }
    }
}

/**
 * Trailing inset that clips the edge button to ~55% of its width, so a partial
 * icon always peeks at the trailing edge. Pure function of the measured layout
 * — deterministic across widths/densities. Mirrors the iOS `computeSnap`: when
 * a button already straddles the edge by a sensible amount we add NO inset
 * (zero gap); we only inset to rescue a too-thin sliver or a cut that fell in
 * the gap between icons. All inputs/outputs in px.
 */
private fun computeToolbarSnapPx(
    lefts: List<Float>,
    slot: Float,
    buttonPx: Float,
    trailingPadPx: Float,
): Float {
    val target = buttonPx * 0.55f
    val minPeek = buttonPx * 0.30f
    val maxPeek = buttonPx * 0.85f
    if (slot <= 1f || lefts.size < 2) return 0f

    // No overflow → nothing to peek.
    val contentWidth = (lefts.lastOrNull() ?: 0f) + buttonPx + trailingPadPx
    if (contentWidth <= slot + 1f) return 0f

    val edge = lefts.lastOrNull { it <= slot } ?: return 0f
    val shown = slot - edge
    val inset = if (shown < buttonPx) {
        // `edge` straddles the trailing edge — it IS the peeking icon.
        when {
            shown in minPeek..maxPeek -> 0f // natural peek already good
            shown > maxPeek -> shown - target // nearly whole: clip to target
            else -> {
                val prev = lefts.lastOrNull { it + buttonPx <= slot }
                if (prev != null) (slot - (prev + target)) else 0f // sliver: clip previous
            }
        }
    } else {
        // `edge` fully visible, cut fell in the gap after it → clip it to target.
        slot - (edge + target)
    }
    return inset.coerceAtLeast(0f)
}

@Composable
private fun ToolbarButton(
    item: ToolbarItemSpec,
    tint: Color,
    perform: (ToolbarItemSpec) -> Unit,
    modifier: Modifier = Modifier,
) {
    IconButton(onClick = { perform(item) }, modifier = modifier.size(BUTTON_SIZE)) {
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
    "link" -> Icons.Filled.Link
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
