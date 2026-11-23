package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.KeyEvent
import android.view.View
import android.widget.EditText
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A header field follows the note it is part of: its history, the block moving under it, focus leaving the note. */
class TextFirstCodeHeaderFieldFollowTest {
    private suspend fun holdLanguage(c: TextFirstController, codeText: String): EditText {
        val view = c.view
        view.isFocusableInTouchMode = true
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val start = view.editableText.indexOf(codeText)
        withTimeout(5_000) { while (view.codeChrome.areaOf(start, CodeBlockAction.LANGUAGE_LABEL) == null) delay(20) }
        val area = view.codeChrome.areaOf(start, CodeBlockAction.LANGUAGE_LABEL)!!
        holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop - view.scrollY + area.centerY())
        return openHeaderField(view)
    }

    private fun undoIn(field: EditText) {
        field.onKeyPreIme(KeyEvent.KEYCODE_Z, KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_Z, 0, KeyEvent.META_CTRL_ON))
    }

    @Test fun anUndoWithNothingToUndoLeavesTheFieldWriting() = textFirstSession("```js\nconst a = 1\n```\n\nafter") { c ->
        val field = holdLanguage(c, "const a")
        undoIn(field)
        delay(300)
        field.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!.commitText("go", 1)
        withTimeout(5_000) { while (c.sourceText() == "```js\nconst a = 1\n```\n\nafter") delay(50) }
        assertEquals("```go\nconst a = 1\n```\n\nafter", c.sourceText())
    }

    @Test fun anUndoThatMovesTheBlockClosesTheField() = textFirstSession("x\n\n```js\na\n```\n\n```py\nb\n```") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        c.select(0)
        withTimeout(5_000) { while (view.selectionStart != 0) delay(20) }
        textFirstIme(c) { commitText("hello ", 1) }
        withTimeout(5_000) { while (!c.sourceText()!!.startsWith("hello")) delay(20) }
        val field = holdLanguage(c, "a\n")
        undoIn(field)
        undoIn(field)
        withTimeout(5_000) { while (c.sourceText()!!.startsWith("hello")) delay(20) }
        withTimeout(5_000) { while (field.isAttachedToWindow) delay(20) }
        assertEquals("x\n\n```js\na\n```\n\n```py\nb\n```", c.sourceText())
    }

    @Test fun focusLeavingTheNoteClosesTheField() = textFirstSession("```js\nconst a = 1\n```\n\nafter") { c ->
        c.view.isFocusableInTouchMode = true
        c.view.requestFocus()
        withTimeout(5_000) { while (!c.focused) delay(20) }
        val field = holdLanguage(c, "const a")
        assertTrue("opening the field is not leaving the note", c.focused)
        val elsewhere = EditText(c.view.context)
        (c.view.parent as android.view.ViewGroup).addView(elsewhere)
        elsewhere.requestFocus()
        withTimeout(5_000) { while (field.isAttachedToWindow) delay(20) }
        assertFalse(c.view.hasFocus())
        // The controller's focus is what shows the editor toolbar: the note's skipped blur must reach it.
        withTimeout(5_000) { while (c.focused) delay(20) }
    }

    @Test fun aVeryNarrowNoteStillDrawsANamedBlock() = textFirstSession("```js name:a-very-long-file-name-for-the-block.go\nx\n```") { c ->
        val view = c.view
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        view.measure(View.MeasureSpec.makeMeasureSpec(view.totalPaddingLeft + view.totalPaddingRight + 8, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(2000, View.MeasureSpec.EXACTLY))
        view.layout(0, 0, view.measuredWidth, 2000)
        view.draw(Canvas(Bitmap.createBitmap(view.measuredWidth, 2000, Bitmap.Config.ARGB_8888)))
    }

    /** Review bug 5: a field that cannot find its host leaves nothing half open (labels, blur and caret reveal stay normal). */
    @Test fun aFieldWithNoHostOpensNothing() = textFirstSession("```js name:a.js\nconst a = 1\n```\n\nafter") { c ->
        val view = c.view
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val host = view.parent as android.view.ViewGroup
        val column = android.widget.LinearLayout(view.context)
        host.removeView(view)
        column.addView(view)
        host.addView(column)
        view.codeTouch.headerField.open(view.editableText.indexOf("const"), CodeHeaderField.Kind.NAME, "js", "a.js", selectAll = false)
        assertEquals(null, view.codeTouch.headerField.openField)
    }

    /**
     * Review bug 3, the in-flight case: a keystroke typed while an engine change above the block is not yet in the view
     * is refused, not written against the moved offset; the field then closes on that change.
     */
    @Test fun aKeystrokeAgainstAnUnappliedChangeIsNotMisapplied() = textFirstSession("x\n\n```js\na\n```\n\n```py\nb\n```") { c ->
        val field = holdLanguage(c, "a\n")
        val engine = c.view.engine!!
        val blocked = java.util.concurrent.CountDownLatch(1)
        val resume = java.util.concurrent.CountDownLatch(1)
        engine.handler.post { blocked.countDown(); resume.await(10, java.util.concurrent.TimeUnit.SECONDS) }
        blocked.await(10, java.util.concurrent.TimeUnit.SECONDS)
        // Deleting the three characters above slides the py block's code start onto the js block's old one.
        engine.handler.post { engine.replace(0, 3, "", uniffi.futo_notes_ffi.EditorInputAction.TYPING) }
        field.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!.commitText("go", 1)
        resume.countDown()
        withTimeout(5_000) { while (c.sourceText()!!.startsWith("x")) delay(20) }
        withTimeout(5_000) { while (field.isAttachedToWindow) delay(20) }
        delay(300)
        assertEquals("```js\na\n```\n\n```py\nb\n```", c.sourceText())
    }

    /** Review leftover of bug 2: after Ctrl+Z with nothing to undo, a typed space stays (a guard: it did not reproduce). */
    @Test fun aSpaceTypedAfterAnEmptyUndoStays() = textFirstSession("```js name:my\nconst a = 1\n```\n\nafter") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val start = view.editableText.indexOf("const")
        withTimeout(5_000) { while (view.codeChrome.areaOf(start, CodeBlockAction.NAME_FIELD) == null) delay(20) }
        val area = view.codeChrome.areaOf(start, CodeBlockAction.NAME_FIELD)!!
        holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop - view.scrollY + area.centerY())
        val field = openHeaderField(view)
        undoIn(field)
        delay(300)
        field.setSelection(field.length())
        val input = field.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!
        input.commitText(" ", 1)
        delay(300)
        input.commitText("x", 1)
        withTimeout(5_000) { while (!c.sourceText()!!.contains("name:")) delay(20) }
        delay(300)
        assertEquals("my x", field.text.toString())
    }
}
