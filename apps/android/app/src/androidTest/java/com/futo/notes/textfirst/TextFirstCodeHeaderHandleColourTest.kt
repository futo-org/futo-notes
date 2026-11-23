package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.drawable.Drawable
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/** Verifier (job 11): a code block's name field drew purple selection handles; they take the note's accent, as the note's do. */
class TextFirstCodeHeaderHandleColourTest {
    /** The colour at the drawable's most opaque pixel. */
    private fun inkOf(drawable: Drawable): Int {
        val width = drawable.intrinsicWidth.coerceAtLeast(8)
        val height = drawable.intrinsicHeight.coerceAtLeast(8)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        drawable.setBounds(0, 0, width, height)
        drawable.draw(Canvas(bitmap))
        var best = 0
        for (y in 0 until height) for (x in 0 until width) {
            val pixel = bitmap.getPixel(x, y)
            if (Color.alpha(pixel) > Color.alpha(best)) best = pixel
        }
        return best or 0xff000000.toInt()
    }

    // The handle getters and setters are API 29: before it the theme's handles show (CaretAndHandleTint).
    @androidx.test.filters.SdkSuppress(minSdkVersion = 29)
    @Test fun theNameFieldsHandlesTakeTheNotesAccent() = textFirstSession("```js name:short.js\nconst a = 1\n```\n\nafter") { c ->
        val view = c.view
        withTimeout(5_000) { while (view.codeChrome.areaOf(0, CodeBlockAction.NAME_FIELD) == null) delay(20) }
        val area = view.codeChrome.areaOf(0, CodeBlockAction.NAME_FIELD)!!
        holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop - view.scrollY + area.centerY())
        val field = openHeaderField(view)
        withTimeout(5_000) { while (field.height <= 1) delay(20) }
        val accent = view.style.linkColor or 0xff000000.toInt()
        for ((name, handle) in listOf("left" to field.textSelectHandleLeft, "right" to field.textSelectHandleRight, "middle" to field.textSelectHandle)) {
            assertEquals("the $name handle's colour", Integer.toHexString(accent), Integer.toHexString(inkOf(handle!!)))
        }
    }
}
