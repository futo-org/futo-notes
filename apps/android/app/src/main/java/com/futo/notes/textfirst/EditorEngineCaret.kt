package com.futo.notes.textfirst

import android.util.Log
import uniffi.futo_notes_ffi.EditorByteRange
import uniffi.futo_notes_ffi.EditorSessionException

/** The toolbar's state at the caret: carried formats and the caret's block. Editor thread. */
internal fun EditorEngine.refreshCaretState() {
    val s = session ?: return
    try {
        refreshCompletion()
        val formats = s.activeFormats().toSet()
        val at = mirror.toByte(mirror.selStart).toULong()
        // The last key's projection usually holds the caret; one fewer engine call.
        val projection = lastProjection?.takeIf { it.revision == rev && it.range.start <= at && at <= it.range.end }
            ?: s.project(rev, EditorByteRange(at, at))
        val block = projection.blocks.lastOrNull { it.range.start <= at && at <= it.range.end }
        val state = CaretState(
            formats = formats,
            heading = block?.heading?.toInt() ?: 0,
            quote = (block?.quoteDepth ?: 0u) > 0u,
            list = block?.list?.let { list ->
                when {
                    list.checked != null -> ListMarker.Task
                    list.number != null -> ListMarker.Ordered
                    else -> ListMarker.Bullet
                }
            },
            code = block?.code == true,
        )
        ui.post { sink.onCaretState(state) }
    } catch (e: EditorSessionException) {
        Log.d("TextFirstEngine", "caret state skipped: $e")
    }
}
