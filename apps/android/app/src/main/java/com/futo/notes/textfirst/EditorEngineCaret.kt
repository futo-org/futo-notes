package com.futo.notes.textfirst

import android.util.Log
import uniffi.futo_notes_ffi.EditorSessionException

/** One canonical selection query; Kotlin only maps engine facts to toolbar identifiers. */
internal fun EditorEngine.refreshCaretState() {
    val s = session ?: return
    try {
        refreshCompletion()
        val selected = s.toolbarState()
        val state = CaretState(
            formats = selected.formats.toSet(),
            heading = selected.heading?.toInt() ?: 0,
            quote = selected.quote,
            list = when (selected.list) {
                uniffi.futo_notes_ffi.EditorToolbarList.BULLET -> ListMarker.Bullet
                uniffi.futo_notes_ffi.EditorToolbarList.ORDERED -> ListMarker.Ordered
                uniffi.futo_notes_ffi.EditorToolbarList.TASK -> ListMarker.Task
                null -> null
            },
            code = selected.code,
            mixed = selected.mixed,
            disabled = buildSet {
                if (!selected.inlineAllowed) addAll(listOf("bold", "italic", "strikethrough", "link"))
                if (!selected.canIndent) add("indent")
                if (!selected.canOutdent) add("outdent")
                if (!selected.canUndo) add("undo")
                if (!selected.canRedo) add("redo")
            },
        )
        ui.post { sink.onCaretState(state) }
    } catch (e: EditorSessionException) {
        Log.d("TextFirstEngine", "caret state skipped: $e")
    }
}
