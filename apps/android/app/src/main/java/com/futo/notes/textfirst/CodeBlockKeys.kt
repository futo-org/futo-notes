package com.futo.notes.textfirst

import android.text.Selection
import android.view.KeyEvent
import uniffi.futo_notes_ffi.EditorBlockCommand
import uniffi.futo_notes_ffi.EditorParagraphKey

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
        // An empty block at the note's edge has no line to stop on: the selection stays (cb 868-869, P144).
        up -> if (start > 0 && !isEmptyBlockAtEdge(start - 1)) Selection.setSelection(editableText, start - 1)
        down -> if (end < textEnd) { if (!isEmptyBlockAtEdge(end + 1)) Selection.setSelection(editableText, end + 1) }
            else engine.openCodeBlockLine(start, EditorBlockCommand.OpenLineAfterCodeBlock)
        keyCode == KeyEvent.KEYCODE_DPAD_LEFT -> Selection.setSelection(editableText, start)
        keyCode == KeyEvent.KEYCODE_DPAD_RIGHT -> Selection.setSelection(editableText, end)
        else -> return false
    }
    return true
}

/**
 * Mod-Enter on a code line opens a blank line below it and Mod-Shift-Enter one above it, the caret
 * on it (!300 cb 859-860, ed 841-842): the caret goes to the line's end (or start) and the engine's
 * Enter, which in code carries the line's leading spaces, makes the line. Returns whether it acted.
 */
internal fun TextFirstEditText.codeLineKey(keyCode: Int, event: KeyEvent): Boolean {
    if (keyCode != KeyEvent.KEYCODE_ENTER && keyCode != KeyEvent.KEYCODE_NUMPAD_ENTER || !event.isCtrlPressed) return false
    if (selectionStart != selectionEnd || selectedCodeBlock != null) return false
    val engine = engine ?: return false
    val e = editableText ?: return false
    val caret = selectionStart
    if (e.getSpans(caret, caret, TfCodeBlock::class.java).isEmpty()) return false
    var lineStart = caret
    while (lineStart > 0 && e[lineStart - 1] != '\n') lineStart--
    var lineEnd = caret
    while (lineEnd < e.length && e[lineEnd] != '\n') lineEnd++
    if (event.isShiftPressed) {
        // Enter after the line's indent: the indent stays on the new line above and Enter copies it to the line below,
        // so both keep it, as Ctrl+Enter's line does (P091); one Undo step.
        var indentEnd = lineStart
        while (indentEnd < lineEnd && (e[indentEnd] == ' ' || e[indentEnd] == '\t')) indentEnd++
        Selection.setSelection(e, indentEnd)
        engine.handler.post { engine.key(EditorParagraphKey.ENTER) }
        engine.hostSelect(indentEnd, indentEnd)
    } else {
        Selection.setSelection(e, lineEnd)
        engine.handler.post { engine.key(EditorParagraphKey.ENTER) }
    }
    return true
}

/** Whether [offset] is the line of an empty code block that opens or ends the note. */
private fun TextFirstEditText.isEmptyBlockAtEdge(offset: Int): Boolean {
    val e = editableText ?: return false
    return e.getSpans(offset, offset, TfCodeBlock::class.java).any { span ->
        span.line.block.start == span.line.block.end && e.getSpanStart(span) == offset &&
            (offset == 0 || e.getSpanEnd(span) >= length() - TextFirstEditText.END_SENTINEL.length)
    }
}

/** Shift-Tab at the very start of a block's first code line walks back to its language field (cb 198-199, P220). */
internal fun TextFirstEditText.codeStartBackTab(keyCode: Int, event: KeyEvent): Boolean {
    if (keyCode != KeyEvent.KEYCODE_TAB || !event.isShiftPressed || selectionStart != selectionEnd || selectedCodeBlock != null) return false
    val e = editableText ?: return false
    val caret = selectionStart
    val first = e.getSpans(caret, caret, TfCodeBlock::class.java).any { it.line.first && e.getSpanStart(it) == caret }
    if (!first) return false
    openLanguageFieldAt(caret)
    return true
}

