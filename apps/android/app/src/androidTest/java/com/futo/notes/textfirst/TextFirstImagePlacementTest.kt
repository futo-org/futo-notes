package com.futo.notes.textfirst

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/** The engine fits a placed selection out of images (place_selection); the view shows what it answers. */
class TextFirstImagePlacementTest {
    private suspend fun ready(c: TextFirstController): Pair<Int, Int> {
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val e = view.editableText
        val image = e.getSpans(0, e.length, TfImage::class.java).single()
        return e.getSpanStart(image) to e.getSpanEnd(image)
    }

    @Test fun aCaretPlacedInsideAnImageGoesToItsNearerEdge() = textFirstSession("before ![inline](missing.png) after") { c ->
        val (start, end) = ready(c)
        c.view.setSelection(start + 3)
        withTimeout(5_000) { while (c.view.selectionStart != start) delay(20) }
        assertEquals(start to start, c.view.selectionStart to c.view.selectionEnd)
        c.view.setSelection(end - 2)
        withTimeout(5_000) { while (c.view.selectionStart != end) delay(20) }
        assertEquals(end to end, c.view.selectionStart to c.view.selectionEnd)
    }

    @Test fun aRangeEndingInsideAnImageTakesItWhole() = textFirstSession("before ![inline](missing.png) after") { c ->
        val (start, end) = ready(c)
        c.view.setSelection(2, start + 5)
        withTimeout(5_000) { while (c.view.selectionEnd != end) delay(20) }
        assertEquals(2 to end, c.view.selectionStart to c.view.selectionEnd)
    }
}
