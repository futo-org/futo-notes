package com.futo.notes.textfirst

import android.text.Selection
import android.view.KeyEvent
import uniffi.futo_notes_ffi.EditorBlockCommand

/**
 * Keys on a block selected as one object name a destination instead of stepping through it
 * (!300 cb 858-876): Up to the end of the line above, Down to the start of the line below, Left
 * to the start of its code, Right to the end of it; a block with no code has no inside, so Left
 * and Right mean Up and Down. Down on a block that ends the note opens a line below it (Mason's
 * pick). Mod-Enter and Mod-Shift-Enter open a line below and above. A press with nowhere to go is
 * still consumed. Returns whether the key was taken.
 */
internal fun TextFirstEditText.selectedBlockKey(keyCode: Int, event: KeyEvent): Boolean {
    val block = selectedCodeBlock ?: return false
    val engine = engine ?: return false
    val (start, end) = block
    val textEnd = length() - TextFirstEditText.END_SENTINEL.length
    val empty = start == end
    val up = keyCode == KeyEvent.KEYCODE_DPAD_UP || (empty && keyCode == KeyEvent.KEYCODE_DPAD_LEFT)
    val down = keyCode == KeyEvent.KEYCODE_DPAD_DOWN || (empty && keyCode == KeyEvent.KEYCODE_DPAD_RIGHT)
    val enter = keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER
    when {
        enter && event.isCtrlPressed -> engine.openCodeBlockLine(start,
            if (event.isShiftPressed) EditorBlockCommand.OpenLineBeforeCodeBlock else EditorBlockCommand.OpenLineAfterCodeBlock)
        event.isShiftPressed || event.isCtrlPressed || event.isAltPressed -> return false
        up -> if (start > 0) Selection.setSelection(editableText, start - 1)
        down -> if (end < textEnd) Selection.setSelection(editableText, end + 1)
            else engine.openCodeBlockLine(start, EditorBlockCommand.OpenLineAfterCodeBlock)
        keyCode == KeyEvent.KEYCODE_DPAD_LEFT -> Selection.setSelection(editableText, start)
        keyCode == KeyEvent.KEYCODE_DPAD_RIGHT -> Selection.setSelection(editableText, end)
        else -> return false
    }
    return true
}
