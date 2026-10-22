package com.futo.notes.puppet

import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import com.futo.notes.NotesStore
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * Where a row spanning `offset until offset + size` sits after the least scroll that shows it
 * whole inside `top until bottom`: where it is when it already fits; at the top edge when it is
 * above (or taller than the window); at the bottom edge when it is below.
 */
internal fun revealedOffset(offset: Int, size: Int, top: Int, bottom: Int): Int = when {
    offset >= top && offset + size <= bottom -> offset
    offset < top || size > bottom - top -> top
    else -> bottom - size
}

/**
 * Scroll the least distance that shows item [index] whole, instantly; true when the list moved.
 * The window is the list's content area: below its top padding (here, the top bar) and above
 * its bottom padding (the FAB's clearance).
 */
private suspend fun LazyListState.revealItem(index: Int): Boolean {
    val info = layoutInfo
    val bottom = info.viewportSize.height - info.beforeContentPadding - info.afterContentPadding
    fun item() = layoutInfo.visibleItemsInfo.firstOrNull { it.index == index }
    val shown = item()
    val delta = if (shown != null) {
        shown.offset - revealedOffset(shown.offset, shown.size, 0, bottom)
    } else {
        // Not composed: jumping to it puts it at the top edge, which is also where a row from
        // above belongs. A row from below then backs down to the bottom edge.
        val below = index > (info.visibleItemsInfo.lastOrNull()?.index ?: -1)
        scrollToItem(index)
        val placed = item()
        if (below && placed != null) placed.offset - revealedOffset(bottom, placed.size, 0, bottom) else 0
    }
    if (delta != 0) scrollBy(delta.toFloat())
    if (shown != null && delta == 0) return false
    awaitLayout()
    return true
}

/** Past the next frame's layout pass, so a reply describes the list as it is now drawn. */
private suspend fun awaitLayout() = suspendCancellableCoroutine { continuation ->
    Choreographer.getInstance().postFrameCallback {
        Handler(Looper.getMainLooper()).post { continuation.resume(Unit) }
    }
}

/**
 * A list screen's rows for the agent: which notes and folders it shows ([rows], in item order,
 * after [leadingItems] header items), so OpenNote and OpenFolder act only on a row a user could
 * tap here and `/tree` can say which of them are on screen, and `ScrollToRow {"noteId"} |
 * {"path"}`, a convenience that brings one into view.
 */
@Composable
internal fun PuppetListRows(
    list: LazyListState,
    store: NotesStore,
    leadingItems: Int = 0,
    rows: () -> List<String>,
) = PuppetVerbScope(listRows = rows) {
    listOf(
        PuppetVerb("ScrollToRow", optional = listOf("noteId", "path"), convenience = true) { arguments ->
            val noteId = arguments.optString("noteId").trim()
            val path = arguments.optString("path").trim()
            if (noteId.isEmpty() == path.isEmpty()) {
                throw PuppetVerbRefusal(400, "ScrollToRow takes exactly one of noteId or path")
            }
            val tag = if (noteId.isNotEmpty()) noteRowTag(noteId) else folderRowTag(path)
            val shown = rows()
            rowRefusal(tag, shown, store.notes, store.folders)?.let { throw it }
            mapOf("moved" to list.revealItem(leadingItems + shown.indexOf(tag)))
        },
    )
}
