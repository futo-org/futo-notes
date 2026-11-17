package com.futo.notes.textfirst

import android.view.KeyEvent

/** A hardware keyboard's Ctrl shortcuts: undo and redo, bold and italic, select all, copy, cut and paste. */
internal fun TextFirstEditText.shortcutKey(engine: EditorEngine, keyCode: Int, event: KeyEvent): Boolean {
    if (!event.isCtrlPressed) return false
    when (keyCode) {
        KeyEvent.KEYCODE_Z -> { if (event.isShiftPressed) engine.redo() else engine.undo(); return true }
        KeyEvent.KEYCODE_Y -> { engine.redo(); return true }
        KeyEvent.KEYCODE_B -> { engine.toggleFormat(uniffi.futo_notes_ffi.EditorInlineFormat.BOLD); return true }
        KeyEvent.KEYCODE_I -> { engine.toggleFormat(uniffi.futo_notes_ffi.EditorInlineFormat.ITALIC); return true }
        KeyEvent.KEYCODE_A -> { engine.selectAll(); return true }
        KeyEvent.KEYCODE_C -> { onTextContextMenuItem(android.R.id.copy); return true }
        KeyEvent.KEYCODE_X -> { onTextContextMenuItem(android.R.id.cut); return true }
        KeyEvent.KEYCODE_V -> { onTextContextMenuItem(android.R.id.paste); return true }
    }
    return false
}
