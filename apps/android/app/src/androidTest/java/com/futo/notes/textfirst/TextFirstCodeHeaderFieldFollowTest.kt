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
        val field = holdLanguage(c, "const a")
        val elsewhere = EditText(c.view.context)
        (c.view.parent as android.view.ViewGroup).addView(elsewhere)
        elsewhere.requestFocus()
        withTimeout(5_000) { while (field.isAttachedToWindow) delay(20) }
        assertFalse(c.view.hasFocus())
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
}
