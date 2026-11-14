package com.futo.notes.textfirst

import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.EditorInlineFormat

/** Native key selection keeps Android's modifier state and anchor/focus. */
class TextFirstSelectionKeysTest {
    @Test fun firstKeyboardSelectionKeepsItsAnchorAfterTypingIntoANewNote() =
        textFirstSession("") { c ->
            c.view.isFocusableInTouchMode = true
            c.view.showKeyboard()
            assertTrue(c.view.isAttachedToWindow)
            assertTrue(c.view.isFocused)
            assertTrue(c.view.hasWindowFocus())
            assertNotNull(c.view.layout)
            val connection = c.view.onCreateInputConnection(EditorInfo())!!
            // A new note is focused automatically. Do not prime its native
            // selection controller with a body tap or an explicit selection.
            textFirstIme(c, connection = connection) { commitText("pack", 1) }
            assertEquals("pack", c.sourceText())
            assertEquals(4, c.view.selectionStart)
            assertEquals(4, c.view.selectionEnd)
            textFirstIme(c, connection = connection) {
                sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_SHIFT_LEFT))
                sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_LEFT))
                sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_LEFT))
            }
            assertEquals("pack", c.sourceText())
            assertEquals(4, c.view.selectionStart)
            assertEquals(3, c.view.selectionEnd)
            textFirstIme(c, connection = connection) {
                sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_LEFT))
                sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_LEFT))
            }
            assertEquals("pack", c.sourceText())
            assertEquals(4, c.view.selectionStart)
            assertEquals(2, c.view.selectionEnd)
        }

    @Test fun styleSlicesKeepTheNewerNativeSelectionAndResetAppliesCanonicalSelection() =
        textFirstSession("Label box\n") { c ->
            c.select(6, 9)
            assertEquals("Label box\n", c.sourceText())
            var formatted: UiUpdate? = null
            c.view.onApplyMeasured = { _, update -> formatted = update }
            c.format(EditorInlineFormat.BOLD)
            assertEquals("Label **box**\n", c.sourceText())
            val windows = checkNotNull(formatted).windows
            c.select(9)
            assertEquals("Label **box**\n", c.sourceText())
            val connection = c.view.onCreateInputConnection(EditorInfo())!!
            textFirstIme(c, connection = connection) {
                sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_SHIFT_LEFT))
                repeat(3) {
                    sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_LEFT))
                    sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_LEFT))
                }
            }
            assertEquals("Label **box**\n", c.sourceText())
            assertEquals(9, c.view.selectionStart)
            assertEquals(6, c.view.selectionEnd)
            // A queued style slice has no authority over this newer native selection.
            c.view.apply(UiUpdate(c.view.appliedSeq, null, emptyList(), 0, 0, -1, -1, windows, 0L, styleOnly = true))
            assertEquals(9, c.view.selectionStart)
            assertEquals(6, c.view.selectionEnd)
            assertEquals("Label **box**\n", c.sourceText())
            // The renderer also accepts an empty delta at the displayed end.
            c.view.apply(UiUpdate(c.view.appliedSeq, null, listOf(TextEdit(10, 10, "")), 6, 9, -1, -1, windows, 0L))
            assertEquals(9, c.view.selectionStart)
            assertEquals(6, c.view.selectionEnd)
            // A new renderer context does carry its canonical selection, even at the same bounds.
            c.view.apply(UiUpdate(c.view.appliedSeq + 1, "Label box\n", emptyList(), 6, 9, -1, -1, windows, 0L))
            assertEquals(6, c.view.selectionStart)
            assertEquals(9, c.view.selectionEnd)
            c.select(3)
            assertEquals("Label **box**\n", c.sourceText())
            assertEquals(3, c.view.selectionStart)
            assertEquals(3, c.view.selectionEnd)
        }

    @Test fun formattingKeepsTheKeyboardSelectionAnchor() {
        for ((format, marker) in listOf(EditorInlineFormat.BOLD to "**", EditorInlineFormat.ITALIC to "*",
            EditorInlineFormat.STRIKE to "~~", EditorInlineFormat.CODE to "`")) {
            textFirstSession("Label box\n") { c ->
                c.select(9)
                assertEquals("Label box\n", c.sourceText())
                val connection = c.view.onCreateInputConnection(EditorInfo())!!
                suspend fun key(code: Int, action: Int = KeyEvent.ACTION_DOWN) =
                    textFirstIme(c, connection = connection) { sendKeyEvent(KeyEvent(action, code)) }
                key(KeyEvent.KEYCODE_SHIFT_LEFT)
                repeat(3) { key(KeyEvent.KEYCODE_DPAD_LEFT); key(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.ACTION_UP) }
                assertEquals("Label box\n", c.sourceText())
                assertEquals(9, c.view.selectionStart)
                assertEquals(6, c.view.selectionEnd)
                var applied: UiUpdate? = null
                c.view.onApplyMeasured = { _, update -> applied = update }
                c.format(format)
                assertEquals("Label ${marker}box$marker\n", c.sourceText())
                assertEquals("Label box\n" + TextFirstEditText.END_SENTINEL, c.view.text.toString())
                val context = "$format reset=${applied?.reset != null} edits=${applied?.edits?.size} styleOnly=${applied?.styleOnly}"
                assertEquals(context, 9, c.view.selectionStart)
                assertEquals(context, 6, c.view.selectionEnd)
                key(KeyEvent.KEYCODE_DPAD_LEFT)
                key(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.ACTION_UP)
                assertEquals("Label ${marker}box$marker\n", c.sourceText())
                assertEquals(9, c.view.selectionStart)
                assertEquals(5, c.view.selectionEnd)
                key(KeyEvent.KEYCODE_DPAD_RIGHT)
                key(KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.ACTION_UP)
                key(KeyEvent.KEYCODE_SHIFT_LEFT, KeyEvent.ACTION_UP)
                textFirstIme(c, connection = connection) { commitText("crate", 1) }
                assertEquals("Label ${marker}crate$marker\n", c.sourceText())
                assertEquals(11, c.view.selectionStart)
                assertEquals(11, c.view.selectionEnd)
                c.undo()
                assertEquals("Label ${marker}box$marker\n", c.sourceText())
                assertEquals(6, c.view.selectionStart)
                assertEquals(9, c.view.selectionEnd)
                c.undo()
                assertEquals("Label box\n", c.sourceText())
            }
        }
    }

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
