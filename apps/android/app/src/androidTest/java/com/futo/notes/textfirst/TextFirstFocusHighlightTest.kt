package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * With a hardware keyboard the window leaves touch mode, and Android draws its default focus highlight, a grey film,
 * over a focused view that has no background of its own: the whole note turned grey. The caret already shows focus.
 */
class TextFirstFocusHighlightTest {
    @After fun backToTouchMode() { InstrumentationRegistry.getInstrumentation().setInTouchMode(true) }

    @Test fun aFocusedNoteOutOfTouchModeIsNotGreyed() = textFirstSession("a line of text") { c ->
        val view = c.view
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        withContext(Dispatchers.Main) { view.requestFocus() }
        delay(300)
        val corner = withContext(Dispatchers.Main) {
            Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
                .also { Canvas(it).apply { drawColor(Color.WHITE); view.draw(this) } }
                .getPixel(view.width - 2, view.height - 2)
        }
        assertEquals("the focused note is drawn under a film", Integer.toHexString(Color.WHITE), Integer.toHexString(corner))
    }
}
