package com.futo.notes.textfirst

import android.util.Log
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test

class TextFirstPhotoReloadTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun aFreshSpanReservesTheEvictedBitmapSizeBeforeItsDecode(): Unit = openWarmPhoto { original, cache ->
        val before = ui { view.layout.height to checkNotNull(view.imageRect(original)).height() }
        cache.bitmaps.evictAll()
        cache.pauseDecodes()
        try {
            val drawn = ui {
                val text = view.editableText
                val length = text.length - 1
                val style = SpanSpec.Image(text.getSpanStart(original), text.getSpanEnd(original),
                    original.destination, original.alt, original.vault, original.remote)
                val nextFrame = view.onNextPhotoFrame()
                view.apply(UiUpdate(
                    seq = view.appliedSeq + 1, reset = text.subSequence(0, length).toString(), edits = emptyList(),
                    selStart = 0, selEnd = 0, composingStart = -1, composingEnd = -1,
                    windows = listOf(StyleWindow(0, length, listOf(style))), inputUptimeNanos = 0L,
                ))
                val recreated = photoSpan()
                assertNotSame(original, recreated)
                assertNull(recreated.bitmap)
                nextFrame
            }
            val pending = drawn.poll(2, java.util.concurrent.TimeUnit.SECONDS)!!
            cache.resumeDecodes()
            compose.waitUntil(3_000) { ui { photoSpan().bitmap != null } }
            val decoded = ui { view.layout.height to checkNotNull(view.imageRect(photoSpan())).height() }
            Log.i("PhotoDropTravel", "reset before=$before pending=$pending decoded=$decoded")
            assertEquals("a decoded image's row height is independent of bitmap residency", before, pending)
            assertEquals(before, decoded)
        } finally {
            cache.resumeDecodes()
        }
    }

    private fun openWarmPhoto(check: BlockDragRig.(TfImage, PhotoCacheFixture) -> Unit): Unit =
        compose.openDragScreen("intro\n![](a.jpg)" + (1..50).joinToString("") { "\ntail row $it" },
            mapOf("a.jpg" to cameraJpeg(4000, 3000))) {
            compose.waitUntil(5_000) { ui { photoSpan().bitmap != null } }
            val photo = ui { photoSpan() }
            check(photo, PhotoCacheFixture(view.images))
        }

    private fun BlockDragRig.photoSpan(): TfImage =
        view.editableText.getSpans(0, view.length(), TfImage::class.java).single()

    private fun TextFirstEditText.onNextPhotoFrame(): java.util.concurrent.ArrayBlockingQueue<Pair<Int, Float>> {
        val result = java.util.concurrent.ArrayBlockingQueue<Pair<Int, Float>>(1)
        onRenderFrame = {
            onRenderFrame = null
            val photo = editableText.getSpans(0, length(), TfImage::class.java).single()
            result.offer(layout.height to checkNotNull(imageRect(photo)).height())
        }
        invalidate()
        return result
    }
}
