package com.futo.notes.textfirst

import android.graphics.PointF
import android.os.SystemClock
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class TextFirstPhotoDropTravelTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun warmCachedPhotoHasNoDropTravel(): Unit = dropBesidePhoto(evict = false)
    @Test fun warmEvictedPhotoKeepsItsSpanAndRowHeight(): Unit = dropBesidePhoto(evict = true)

    private fun dropBesidePhoto(evict: Boolean) {
        val prefix = "---\nname: fixture\n---\n# Heading\n" + (1..20).joinToString("") { "lead row $it\n" }
        val suffix = (1..20).joinToString("") { "\ntail row $it" }
        val before = prefix + "moving row\n![](a.jpg)\nbetween\n![](b.jpg)\nafter" + suffix
        val expected = prefix + "![](a.jpg)\nbetween\nmoving row\n![](b.jpg)\nafter" + suffix
        compose.openDragScreen(before, mapOf("a.jpg" to cameraJpeg(4000, 3000), "b.jpg" to cameraJpeg(3392, 2544))) {
            compose.waitUntil(5_000) { ui { photoSpans().all { it.bitmap != null } && photoSpans().size == 2 } }
            val cache = PhotoCacheFixture(view.images)
            val photosBefore = ui { photoSpans() }
            val keyA = "a.jpg@${ui { view.contentWidth() }}"
            val keyB = "b.jpg@${ui { view.contentWidth() }}"
            check(cache.bitmaps.get(keyA) != null && cache.bitmaps.get(keyB) != null)
            Log.i("PhotoDropTravel", "heap=${Runtime.getRuntime().maxMemory()} cache=${cache.bitmaps.maxSize()} width=${ui { view.contentWidth() }} bytes=${photosBefore.map { it.bitmap?.byteCount }}")
            if (evict) {
                val retainedBytes = checkNotNull(cache.bitmaps.get(keyB)).byteCount
                val originalCapacity = cache.bitmaps.maxSize()
                cache.bitmaps.resize(retainedBytes)
                cache.bitmaps.resize(originalCapacity)
                check(cache.bitmaps.get(keyA) == null && cache.bitmaps.get(keyB) != null)
            }
            val initialHeight = ui {
                val source = checkNotNull(view.boundaryY(BlockSlot(offsetOf("moving row"), false)))
                view.scrollTo(0, (source - 330f).toInt())
                view.layout.height
            }
            val from = at(offsetOf("moving row"))
            down(from)
            compose.waitUntil(2_000) { lifted }
            val target = ui { BlockSlot(view.editableText.getSpanStart(photosBefore[1]), false) }
            val release = carryUntil(from, 24f, view.width * 0.8f, limit = 140) { report?.gap == target }
            hold(Slide.SLIDE_MS + 60)
            assertEquals(target, report?.gap)
            val expectedTop = checkNotNull(report?.copy).top
            val photoHeights = ui { photosBefore.map { checkNotNull(view.imageRect(it)).height() } }
            cache.pauseDecodes()
            try {
                val snapshots = recordEvictedDrop(release, cache, photosBefore)
                saved(expected)
                val first = snapshots.first()
                val final = snapshots.last()
                for (frame in snapshots) Log.i("PhotoDropTravel", "evict=$evict $frame")
                Log.i("PhotoDropTravel", "evict=$evict beforeHeight=$initialHeight expectedTop=$expectedTop heights=$photoHeights")
                assertTrue("tracked the resized or retained row through 500ms", final.ms >= 500)
                assertTrue("drop changed note height: ${snapshots.map { it.height }.distinct()}", snapshots.all { it.height == initialHeight })
                assertTrue("drop changed photo heights", snapshots.all { it.photoHeights == photoHeights })
                assertTrue("drop scrolled", snapshots.all { it.scrollY == first.scrollY })
                assertTrue("the block stays at its preview top", snapshots.all { frame ->
                    frame.blockTop?.let { abs(it - expectedTop) <= 1f } == true
                })
                val committed = snapshots.filter { it.committed }
                assertTrue("captured the committed layout", committed.isNotEmpty())
                assertTrue("committed photo tops stay still", committed.all { it.photoTops == final.photoTops })
                if (evict) ui { photosBefore.zip(photoSpans()).forEach { (before, after) -> assertSame(before, after) } }
            } finally {
                cache.resumeDecodes()
            }
        }
    }

    @Test
    fun dropAfterTheLastPhotoUsesItsActualBottom(): Unit =
        compose.openDragScreen("intro\nmoving row\nlast text\n![](a.jpg)", mapOf("a.jpg" to png(300, 225))) {
            compose.waitUntil(5_000) { ui { photoSpans().singleOrNull()?.bitmap != null } }
            val source = at(offsetOf("moving row"))
            down(source)
            compose.waitUntil(2_000) { lifted }
            val slot = ui { BlockSlot(view.length() - 1, true) }
            val release = carryUntil(source, 12f, view.width * 0.8f) { report?.gap == slot }
            hold(Slide.SLIDE_MS + 60)
            val preview = checkNotNull(report?.copy).top
            up(release)
            saved("intro\nlast text\n![](a.jpg)\nmoving row")
            compose.waitUntil(2_000) { !lifted }
            val landed = ui { viewInWindow() + checkNotNull(view.boundaryY(BlockSlot(offsetOf("moving row"), false))) - view.scrollY }
            Log.i("PhotoDropTravel", "note-end preview=$preview final=$landed")
            assertEquals("final-photo slot predicts where the moved row lands", preview, landed, 1f)
        }

    private fun BlockDragRig.photoSpans(): List<TfImage> =
        view.editableText.getSpans(0, view.length(), TfImage::class.java).sortedBy { it.destination }

    private data class DropFrame(
        val ms: Long,
        val scrollY: Int,
        val height: Int,
        val blockTop: Float?,
        val photoTops: List<Float>,
        val photoHeights: List<Float>,
        val originalSpans: List<Boolean>,
        val decoded: List<Boolean>,
        val committed: Boolean,
        val landing: Boolean,
    )

    private fun BlockDragRig.recordEvictedDrop(
        release: PointF, cache: PhotoCacheFixture, originals: List<TfImage>,
    ): List<DropFrame> {
        val frames = mutableListOf<DropFrame>()
        ui {
            val started = SystemClock.uptimeMillis()
            var committed = false
            view.onApplyMeasured = applied@{ _, update ->
                if (update.drop == null) return@applied
                committed = true
                view.postDelayed(cache::resumeDecodes, 120)
            }
            view.onRenderFrame = {
                val time = SystemClock.uptimeMillis() - started
                val images = photoSpans()
                val origin = viewInWindow() - view.scrollY
                val preview = view.blockLift.drag?.reflow?.report()
                val blockTop = preview?.copy?.top ?: view.boundaryY(BlockSlot(view.editableText.indexOf("moving row"), false))?.plus(origin)
                val photoRects = images.map { checkNotNull(view.imageRect(it)) }
                frames += DropFrame(time, view.scrollY, view.layout.height, blockTop, photoRects.map { it.top + origin },
                    photoRects.map { it.height() }, originals.zip(images).map { (old, new) -> old === new },
                    images.map { it.bitmap != null }, committed, preview?.landing == true)
                if (time < 500) view.postInvalidateOnAnimation()
            }
            view.postInvalidateOnAnimation()
        }
        try {
            up(release)
            compose.waitUntil(3_000) { ui { (frames.lastOrNull()?.ms ?: 0) >= 500 } }
            return ui { frames.toList() }
        } finally {
            ui { view.onApplyMeasured = null; view.onRenderFrame = null }
        }
    }
}
