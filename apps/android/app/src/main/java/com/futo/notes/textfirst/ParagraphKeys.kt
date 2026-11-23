package com.futo.notes.textfirst

import android.view.KeyEvent
import uniffi.futo_notes_ffi.EditorParagraphKey

/** The engine's paragraph key for a hardware key, or null when the key is not one. */
internal fun paragraphKeyFor(keyCode: Int, event: KeyEvent): EditorParagraphKey? = when (keyCode) {
    KeyEvent.KEYCODE_DEL -> EditorParagraphKey.BACKSPACE
    KeyEvent.KEYCODE_FORWARD_DEL -> EditorParagraphKey.DELETE
    KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER ->
        if (event.isShiftPressed) EditorParagraphKey.SHIFT_ENTER else EditorParagraphKey.ENTER
    KeyEvent.KEYCODE_TAB -> if (event.isShiftPressed) EditorParagraphKey.SHIFT_TAB else EditorParagraphKey.TAB
    else -> null
}

/** A hardware key the engine takes: a paragraph key, or a typed character without Ctrl or Alt. */
internal fun engineKey(engine: EditorEngine, keyCode: Int, event: KeyEvent): Boolean {
    val paragraphKey = paragraphKeyFor(keyCode, event)
    if (paragraphKey != null) {
        engine.handler.post { engine.key(paragraphKey) }
        return true
    }
    val char = event.unicodeChar
    if (char != 0 && !event.isCtrlPressed && !event.isAltPressed) {
        val typed = String(Character.toChars(char))
        engine.handler.post { engine.imeCommit(typed) }
        return true
    }
    return false
}
