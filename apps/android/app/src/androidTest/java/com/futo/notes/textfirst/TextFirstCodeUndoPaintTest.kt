package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.KeyEvent
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/** Area 12 verifier (12.5): a block that Undo selects again is painted as a fresh selection is, its tint alone. */
class TextFirstCodeUndoPaintTest {
    @Test fun undoThatSelectsABlockPaintsOnlyItsTint() = textFirstSession("intro\n\n```go\nfirst\n```\n\nend") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        val start = view.editableText.indexOf("first")
        withTimeout(5_000) { while (view.codeChrome.areaOf(start, CodeBlockAction.SELECT_BLOCK) == null) delay(20) }
        val area = view.codeChrome.areaOf(start, CodeBlockAction.SELECT_BLOCK)!!
        tapNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop - view.scrollY + area.centerY())
        withTimeout(5_000) { while (view.selectedCodeBlock == null) delay(20) }
        delay(300)
        val l = view.layout
        val x = view.totalPaddingLeft + ((l.getPrimaryHorizontal(start) + l.getPrimaryHorizontal(start + 5)) / 2).toInt()
        val y = view.totalPaddingTop - view.scrollY + l.getLineBaseline(l.getLineForOffset(start)) - 4
        fun pixel(): Int {
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(bitmap))
            return bitmap.getPixel(x, y)
        }
        val fresh = pixel()
        val selected = view.selectedCodeBlock
        view.onKeyDown(KeyEvent.KEYCODE_TAB, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_TAB))
        withTimeout(5_000) { while (view.selectedCodeBlock != null) delay(20) }
        c.undo()
        withTimeout(5_000) { while (view.selectedCodeBlock == null) delay(20) }
        delay(500)
        assertEquals(selected, view.selectedCodeBlock)
        assertEquals("Undo's selected block is painted differently from a fresh one", fresh, pixel())
    }
}
