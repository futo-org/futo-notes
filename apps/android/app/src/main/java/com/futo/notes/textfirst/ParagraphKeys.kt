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
