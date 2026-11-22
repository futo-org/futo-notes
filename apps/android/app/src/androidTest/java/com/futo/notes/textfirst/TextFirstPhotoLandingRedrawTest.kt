package com.futo.notes.textfirst

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

    /** The note again with only its photo's style: the photo forgets its bitmap and asks the loader anew. */
    private fun TextFirstEditText.applyPhotoUnloaded() {
        val text = editableText
        val length = text.length - 1
        val original = text.getSpans(0, length(), TfImage::class.java).single()
        val style = SpanSpec.Image(text.getSpanStart(original), text.getSpanEnd(original), original.destination, original.alt, original.vault, original.remote)
        apply(UiUpdate(appliedSeq + 1, text.subSequence(0, length).toString(), emptyList(), 0, 0, -1, -1,
            listOf(StyleWindow(0, length, listOf(style))), 0L))
    }

    @Test fun rowsBelowAPhotoThatLandsLateAreDrawnWhereTheyAreLaidOut() = compose.openDragScreen("![](p.png)\n$rows", mapOf("p.png" to png(800, 600))) {
        fun photo() = view.editableText.getSpans(0, view.length(), TfImage::class.java).single()
        compose.waitUntil(5_000) { ui { photo().bitmap != null } }
        val loaded = ui { view.layout.height }
        val cache = PhotoCacheFixture(view.images)
        cache.bitmaps.evictAll()
        cache.photoSizes.clear()
        cache.pauseDecodes()
        try {
            ui { view.applyPhotoUnloaded() }
            compose.waitUntil(3_000) { ui { photo().bitmap == null && view.layout.height < loaded } }
            // The photo off the screen above, the rows below it on screen and drawn.
            ui { view.scrollTo(0, view.totalPaddingTop + view.layout.getLineTop(view.layout.getLineForOffset(rowAt(view.text.toString(), 30)))) }
            SystemClock.sleep(600)
            screenshot().recycle()
            cache.resumeDecodes()
            compose.waitUntil(5_000) { ui { photo().bitmap != null } }
            SystemClock.sleep(600)
            assertTrue("the photo's row grew when it landed", ui { view.layout.height } > loaded - 2)
            // Every drawn block, stale or not, against the same rows redrawn from scratch: any row left where it was differs.
            val (top, bottom) = ui {
                val l = view.layout
                val at = IntArray(2).also(view::getLocationOnScreen)
                fun lineOf(n: Int) = l.getLineForOffset(rowAt(view.text.toString(), n))
                val origin = at[1] + view.totalPaddingTop - view.scrollY
                (origin + l.getLineTop(lineOf(31))) to (origin + l.getLineBottom(lineOf(44)))
            }
            val live = screenshot()
            // An appearance span over every row drops every cached block; it draws nothing itself.
            ui {
                val redraw = object : android.text.style.CharacterStyle() { override fun updateDrawState(tp: android.text.TextPaint) = Unit }
                view.editableText.setSpan(redraw, 0, view.length(), android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                view.editableText.removeSpan(redraw)
            }
            SystemClock.sleep(600)
            val fresh = screenshot()
            try {
                var differing = 0
                for (y in top until bottom) for (x in 0 until live.width) if (live.getPixel(x, y) != fresh.getPixel(x, y)) differing++
                assertEquals("rows 31-44 are drawn as a redraw from scratch draws them (differing pixels)", 0, differing)
            } finally { live.recycle(); fresh.recycle() }
        } finally {
            cache.resumeDecodes()
        }
    }

    /** Sol: a decode for the width the view had before landing after the one for its new width would shrink the photo. */
    @Test fun aPhotoDecodedForAnOldWidthLandingLastIsDropped() = compose.openDragScreen("![](p.png)\n$rows", mapOf("p.png" to png(2000, 600))) {
        fun photo() = view.editableText.getSpans(0, view.length(), TfImage::class.java).single()
        compose.waitUntil(5_000) { ui { photo().bitmap != null } }
        val cache = PhotoCacheFixture(view.images)
        cache.bitmaps.evictAll()
        cache.photoSizes.clear()
        cache.pauseDecodes()
        try {
            ui { view.applyPhotoUnloaded() }
            compose.waitUntil(3_000) { ui { photo().bitmap == null } }
            // A narrower window (split screen). The new width's decode is ready at once; the old width's waits behind the
            // paused decodes.
            val content = ui { view.rootView.findViewById<android.view.ViewGroup>(android.R.id.content) }
            val narrowBy = ui { view.width * 2 / 5 }
            val newContent = ui { view.contentWidth() } - narrowBy
            val forNewWidth = android.graphics.Bitmap.createBitmap(newContent, newContent * 3 / 10, android.graphics.Bitmap.Config.ARGB_8888)
            cache.bitmaps.put(ui { photo().destination } + "@" + newContent, forNewWidth)
            ui { content.setPadding(0, 0, narrowBy, 0) }
            compose.waitUntil(3_000) { ui { photo().bitmap === forNewWidth } }
            cache.resumeDecodes()
            SystemClock.sleep(800)
            org.junit.Assert.assertSame("the photo keeps the decode for its new width", forNewWidth, ui { photo().bitmap })
        } finally {
            cache.resumeDecodes()
        }
    }
}
