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

/**
 * The keys that move in the note. One the note cannot make (Up at its start, PageDown at its end) is still the note's:
 * unhandled, the window would move focus to the title (area 13 verifier, P303).
 */
internal val NOTE_MOVE_KEYS = setOf(
    KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
    KeyEvent.KEYCODE_PAGE_UP, KeyEvent.KEYCODE_PAGE_DOWN, KeyEvent.KEYCODE_MOVE_HOME, KeyEvent.KEYCODE_MOVE_END,
)
