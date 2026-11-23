package com.futo.notes.textfirst

import android.util.Log
import uniffi.futo_notes_ffi.EditorSessionException
import uniffi.futo_notes_ffi.EditorToolbarCommand

/** Each toolbar item the engine's `allowed` list gates: an item is disabled when its command is left out. */
private val TOOLBAR_ITEMS = listOf(
    EditorToolbarCommand.BOLD to listOf("bold"),
    EditorToolbarCommand.ITALIC to listOf("italic"),
    EditorToolbarCommand.STRIKE to listOf("strikethrough"),
    EditorToolbarCommand.LINK to listOf("link"),
    EditorToolbarCommand.HEADING to listOf("heading-1", "heading-2", "heading-3"),
    EditorToolbarCommand.QUOTE to listOf("quote"),
    EditorToolbarCommand.BULLET_LIST to listOf("bullet-list"),
    EditorToolbarCommand.ORDERED_LIST to listOf("ordered-list"),
    EditorToolbarCommand.TASK_LIST to listOf("task-list"),
    EditorToolbarCommand.CODE_BLOCK to listOf("code-block"),
    EditorToolbarCommand.IMAGE to listOf("camera", "image"),
)

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
                val allowed = selected.allowed.toSet()
                for ((command, items) in TOOLBAR_ITEMS) if (command !in allowed) addAll(items)
                if (!selected.canIndent) add("indent")
                if (!selected.canOutdent) add("outdent")
                if (!selected.canUndo) add("undo")
                if (!selected.canRedo) add("redo")
                // Android's one guard (TextFirstController.block): on a block selected as one object the engine allows
                // the code toggle and would unwrap the block; Mason chose the button disabled there instead (9A).
                if (mirror.selectedBlock != null) add("code-block")
            },
        )
        ui.post { sink.onCaretState(state) }
    } catch (e: EditorSessionException) {
        Log.d("TextFirstEngine", "caret state skipped: $e")
    }
}
