package com.futo.notes.textfirst

import android.graphics.Color
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * The tester's F4: a note reopened at a mid-note scroll drew rows over each other. A photo above the screen decoded
 * after the rows below it were drawn, its row grew without changing the line count, and the rows' drawn blocks stayed
 * where they were. On the real screen every row is drawn where the layout has it once the photo lands.
 */
class TextFirstPhotoLandingRedrawTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    // Rows of different lengths, so a row drawn at another row's height shows on the screen.
    private val rows = (1..80).joinToString("\n") { "row $it" + " x".repeat((it % 5) * 4) }

    /** Where row [n] starts in [text]. */
    private fun rowAt(text: String, n: Int): Int = text.indexOf("\nrow $n" + if (n % 5 == 0) "\n" else " ") + 1

    @Test fun rowsBelowAPhotoThatLandsLateAreDrawnWhereTheyAreLaidOut() = compose.openDragScreen("![](p.png)\n$rows", mapOf("p.png" to png(800, 600))) {
        fun photo() = view.editableText.getSpans(0, view.length(), TfImage::class.java).single()
        compose.waitUntil(5_000) { ui { photo().bitmap != null } }
        val loaded = ui { view.layout.height }
        val cache = PhotoCacheFixture(view.images)
        cache.bitmaps.evictAll()
        cache.photoSizes.clear()
        cache.pauseDecodes()
        try {
            ui {
                val text = view.editableText
                val length = text.length - 1
                val original = photo()
                val style = SpanSpec.Image(text.getSpanStart(original), text.getSpanEnd(original), original.destination, original.alt, original.vault, original.remote)
                view.apply(UiUpdate(view.appliedSeq + 1, text.subSequence(0, length).toString(), emptyList(), 0, 0, -1, -1,
                    listOf(StyleWindow(0, length, listOf(style))), 0L))
            }
            compose.waitUntil(3_000) { ui { photo().bitmap == null && view.layout.height < loaded } }
            // The photo off the screen above, the rows below it on screen and drawn.
            ui { view.scrollTo(0, view.totalPaddingTop + view.layout.getLineTop(view.layout.getLineForOffset(rowAt(view.text.toString(), 30)))) }
            SystemClock.sleep(600)
            screenshot().recycle()
            cache.resumeDecodes()
            compose.waitUntil(5_000) { ui { photo().bitmap != null } }
            SystemClock.sleep(600)
            assertTrue("the photo's row grew when it landed", ui { view.layout.height } > loaded - 2)
            val shot = screenshot()
            try {
                val checks = ui {
                    val l = view.layout
                    val at = IntArray(2).also(view::getLocationOnScreen)
                    (34..40).map { n ->
                        val line = l.getLineForOffset(rowAt(view.text.toString(), n))
                        val y = at[1] + view.totalPaddingTop - view.scrollY + (l.getLineTop(line) + l.getLineBottom(line)) / 2
                        Triple(n, y, (at[0] + view.totalPaddingLeft + l.getLineMax(line)).toInt())
                    }
                }
                for ((n, y, right) in checks) {
                    // The rightmost ink across the row's middle band.
                    var ink = -1
                    for (yy in y - 12..y + 12) for (x in 0 until shot.width) {
                        val p = shot.getPixel(x, yy)
                        if (Color.red(p) < 140 && Color.green(p) < 140 && Color.blue(p) < 140) ink = maxOf(ink, x)
                    }
                    assertEquals("row $n is drawn where it is laid out (its text's right edge)", right.toFloat(), ink.toFloat(), 12f)
                }
            } finally { shot.recycle() }
        } finally {
            cache.resumeDecodes()
        }
    }
}
