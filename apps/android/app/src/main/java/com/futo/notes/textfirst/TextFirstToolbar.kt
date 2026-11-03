package com.futo.notes.textfirst

import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.runtime.Composable
import com.futo.notes.ui.EditorToolbar
import com.futo.notes.ui.ToolbarItemAction
import uniffi.futo_notes_ffi.EditorBlockCommand
import uniffi.futo_notes_ffi.EditorInlineFormat


/**
 * The keyboard toolbar, shown while the editor has focus and the keyboard is
 * up. Its own composable so the keyboard's per-frame inset animation
 * recomposes only this slot, not the whole note screen (measured: the screen
 * recomposing every animation frame dominated keyboard open/close).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun TextFirstToolbarSlot(controller: TextFirstController, onPickImage: (String) -> Unit) {
    if (!controller.focused || !WindowInsets.isImeVisible) return
    val caret = controller.caret
    EditorToolbar(
        onListLine = caret.list != null,
        inContainer = caret.list != null || caret.quote,
        activeFormats = toolbarActive(caret),
        disabledFormats = setOf("link"),
        hiddenItems = setOf("paragraph"),
        perform = { item ->
            when (val action = item.action) {
                ToolbarItemAction.Exec -> runToolbar(controller, item.id)
                is ToolbarItemAction.PickImage -> onPickImage(action.source)
                ToolbarItemAction.Dismiss -> controller.view.hideKeyboard()
            }
        },
    )
}


/** The toolbar ids lit at the caret (ToolbarSpec ids). */
internal fun toolbarActive(caret: CaretState): Set<String> = buildSet {
    if (EditorInlineFormat.BOLD in caret.formats) add("bold")
    if (EditorInlineFormat.ITALIC in caret.formats) add("italic")
    if (EditorInlineFormat.STRIKE in caret.formats) add("strikethrough")
    when {
        caret.code -> add("code-block")
        caret.heading in 1..3 -> add("heading-${caret.heading}")
        caret.list == null && !caret.quote -> add("paragraph")
    }
    if (caret.quote) add("quote")
    when (caret.list) {
        ListMarker.Bullet -> add("bullet-list")
        ListMarker.Ordered -> add("ordered-list")
        ListMarker.Task -> add("task-list")
        null -> Unit
    }
}

/** Toolbar item → engine command. The engine owns every rule; this is a name map. */
internal fun runToolbar(controller: TextFirstController, id: String) {
    when (id) {
        "undo" -> controller.undo()
        "redo" -> controller.redo()
        "bold" -> controller.format(EditorInlineFormat.BOLD)
        "italic" -> controller.format(EditorInlineFormat.ITALIC)
        "strikethrough" -> controller.format(EditorInlineFormat.STRIKE)
        "paragraph" -> controller.block(EditorBlockCommand.Heading(0u))
        "heading-1" -> controller.block(EditorBlockCommand.Heading(1u))
        "heading-2" -> controller.block(EditorBlockCommand.Heading(2u))
        "heading-3" -> controller.block(EditorBlockCommand.Heading(3u))
        "quote" -> controller.block(EditorBlockCommand.Quote)
        "code-block" -> controller.block(EditorBlockCommand.CodeBlock)
        "bullet-list" -> controller.block(EditorBlockCommand.BulletList)
        "ordered-list" -> controller.block(EditorBlockCommand.OrderedList)
        "task-list" -> controller.block(EditorBlockCommand.TaskList)
        "indent" -> controller.block(EditorBlockCommand.Indent)
        "outdent" -> controller.block(EditorBlockCommand.Outdent)
    }
}
