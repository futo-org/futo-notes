package com.futo.notes.textfirst

import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import org.junit.Assert.*
import org.junit.Test

/** Native key selection keeps Android's modifier state and anchor/focus. */
class TextFirstSelectionKeysTest {
    @Test fun keyboardSelectionModeExtendsAndReleasesInTheNoteAndCell() {
        for ((cell, shift) in listOf(false to KeyEvent.KEYCODE_SHIFT_LEFT, false to KeyEvent.KEYCODE_SHIFT_RIGHT,
            true to KeyEvent.KEYCODE_SHIFT_LEFT, true to KeyEvent.KEYCODE_SHIFT_RIGHT)) {
            val source = if (cell) "| Meeting | Owner |\n| --- | --- |\n" else "Meeting\n"
            textFirstSession(source) { c ->
                val offset = if (cell) 2 else 0
                if (cell) assertTrue(c.selectDisplayRange(offset, offset + 7)) else c.select(7)
                assertEquals(source, c.sourceText())
                if (cell) {
                    val field = c.cellView!!
                    (c.view.parent as android.view.ViewGroup).addView(field,
                        android.view.ViewGroup.LayoutParams(android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                            android.view.ViewGroup.LayoutParams.WRAP_CONTENT))
                    field.requestFocus()
                    field.measure(android.view.View.MeasureSpec.makeMeasureSpec(c.view.width, android.view.View.MeasureSpec.EXACTLY),
                        android.view.View.MeasureSpec.makeMeasureSpec(c.view.height, android.view.View.MeasureSpec.AT_MOST))
                    field.layout(0, 0, field.measuredWidth, field.measuredHeight)
                    assertTrue(field.isAttachedToWindow)
                    assertNotNull(field.layout)
                }
                val connection = (if (cell) c.cellView!! else c.view).onCreateInputConnection(EditorInfo())!!
                suspend fun key(code: Int, action: Int = KeyEvent.ACTION_DOWN) =
                    textFirstIme(c, cell, connection) { sendKeyEvent(KeyEvent(action, code)) }
                suspend fun range(start: Int, end: Int) {
                    assertEquals(source, c.sourceText())
                    val field = if (cell) c.cellView!! else c.view
                    assertEquals(start, minOf(field.selectionStart, field.selectionEnd))
                    assertEquals(end, maxOf(field.selectionStart, field.selectionEnd))
                    assertEquals(offset + start, minOf(c.view.selectionStart, c.view.selectionEnd))
                    assertEquals(offset + end, maxOf(c.view.selectionStart, c.view.selectionEnd))
                }
                // A grid tap opens the whole cell; Gboard End chooses its caret.
                if (cell) textFirstIme(c, cell, connection) { setSelection(7, 7) }
                range(7, 7)
                // Gboard's Text editing Select button holds a standalone Shift.
                key(shift)
                key(KeyEvent.KEYCODE_DPAD_LEFT)
                key(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.ACTION_UP)
                range(6, 7)
                key(KeyEvent.KEYCODE_DPAD_LEFT)
                key(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.ACTION_UP)
                range(5, 7)
                key(KeyEvent.KEYCODE_DPAD_RIGHT)
                key(KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.ACTION_UP)
                range(6, 7)
                key(shift, KeyEvent.ACTION_UP)
                key(KeyEvent.KEYCODE_DPAD_RIGHT)
                key(KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.ACTION_UP)
                range(7, 7)
                // Hardware modifier release must not overtake a queued native press.
                val field = if (cell) c.cellView!! else c.view
                field.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, shift))
                field.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, shift))
                textFirstIme(c, cell, connection) {} // Drain queued engine→native work before its selection callback.
                field.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_LEFT))
                field.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_LEFT))
                textFirstIme(c, cell, connection) {}
                range(6, 6)
                field.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_RIGHT))
                field.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_RIGHT))
                textFirstIme(c, cell, connection) {}
                range(7, 7)
                textFirstIme(c, cell, connection) { commitText("!", 1) }
                assertEquals(if (cell) "| Meeting! | Owner |\n| --- | --- |\n" else "Meeting!\n", c.sourceText())
                c.undo()
                range(7, 7)
                if (cell) {
                    assertTrue(c.selectDisplayRange(12, 17))
                    assertEquals(source, c.sourceText())
                    assertEquals("Owner", c.cellView!!.text.toString())
                    assertEquals(0, c.cellView!!.selectionStart)
                    assertEquals(5, c.cellView!!.selectionEnd)
                    assertTrue(c.selectDisplayRange(0))
                    assertEquals(source, c.sourceText())
                    textFirstIme(c, cell, connection) { sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, shift)) }
                    assertEquals(source, c.sourceText())
                    assertEquals(0, android.text.method.MetaKeyKeyListener.getMetaState(field.editableText, KeyEvent.META_SHIFT_ON))
                    assertEquals(0, c.view.selectionStart)
                    assertEquals(0, c.view.selectionEnd)
                }
            }
        }
    }

}
