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
        // Projection coordinates describe committed text. A provisional word
        // may be longer, but its opening range still identifies its block.
        val at = mirror.toByte(mirror.overlay?.start ?: mirror.selStart).toULong()
        // Ask for this caret's block: the broader edit window can also contain
        // a following plain block sharing a hidden fence's display boundary.
        val projection = s.project(rev, EditorByteRange(at, at))
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
