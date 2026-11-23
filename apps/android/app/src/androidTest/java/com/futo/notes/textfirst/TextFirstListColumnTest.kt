package com.futo.notes.textfirst

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Where a list item's marker is drawn and where its continued lines hang: both follow the item's text, not the row's left edge. */
class TextFirstListColumnTest {
    private suspend fun laidOut(c: TextFirstController, markers: Int) = withTimeout(5_000) {
        while (withContext(Dispatchers.Main) { c.view.layout == null || c.view.editableText.getSpans(0, c.view.length(), TfListMarker::class.java).size < markers }) delay(20)
    }

    /** Spec mobile/lists.md: wrapped and continued rows hang at the item's text, whatever the width of its number. */
    @Test fun aContinuedLineHangsAtAWideNumbersText() = textFirstSession("999. item\n     continued line\n1000. next\n      more\n1. one\n   two\n\nend") { c ->
        laidOut(c, 3)
        withContext(Dispatchers.Main) {
            val view = c.view
            val l = view.layout
            val e = view.editableText
            fun x(word: String) = l.getPrimaryHorizontal(e.indexOf(word))
            assertTrue("the wide number's text is past one list step", x("item") > view.style.listIndent)
            assertEquals("999.", x("item"), x("continued"), 0.5f)
            assertEquals("1000.", x("next"), x("more"), 0.5f)
            assertEquals("1.", x("one"), x("two"), 0.5f)
        }
    }

    /** Spec mobile/lists.md: a tap on a task's drawn checkbox toggles it, also inside a nested quote. */
    @Test fun aCheckboxInANestedQuoteIsDrawnWhereItsHitAreaIs() = textFirstSession("> - [ ] q\n>> - [ ] task\n> - b\n\nend") { c ->
        laidOut(c, 3)
        val (shot, runs) = withContext(Dispatchers.Main) {
            val view = c.view
            val l = view.layout
            val bitmap = android.graphics.Bitmap.createBitmap(view.width, view.height, android.graphics.Bitmap.Config.ARGB_8888)
            view.draw(android.graphics.Canvas(bitmap))
            val runs = listOf("q", "task", "b").map { word ->
                val at = l.getLineStart(l.getLineForOffset(view.editableText.indexOf(word)))
                val right = l.getPrimaryHorizontal(at + 1) + view.totalPaddingLeft
                val width = view.editableText.getSpans(at, at + 1, TfListMarker::class.java).single().width
                val line = l.getLineForOffset(at)
                val y = view.totalPaddingTop - view.scrollY + (l.getLineTop(line) + l.getLineBottom(line)) / 2f
                Triple(right - width, right, y)
            }
            bitmap to runs
        }
        try {
            val background = shot.getPixel(1, runs[0].third.toInt())
            for ((left, right, y) in runs) {
                // Ink in the marker's column, none in the half step left of it (where the quote gutter's marker was drawn).
                var inside = 0
                for (x in left.toInt() until right.toInt()) for (dy in -12..12 step 2) if (shot.getPixel(x, y.toInt() + dy) != background) inside++
                assertTrue("the marker at $left is drawn in its column", inside > 0)
            }
        } finally { shot.recycle() }
    }
}
